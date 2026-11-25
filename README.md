# Smart API Gateway and Traffic Management System

A single entry point in front of several backend microservices. It authenticates clients, rate-limits them, caches responses in **Redis**, load-balances across healthy instances, and isolates failing instances with circuit breakers. Every request is logged to **PostgreSQL** through a **message queue and workers**. A live dashboard shows all of this.

The business domain behind the gateway is **inventory management**: an `inventory` service (SKU catalog, stock per warehouse) and a `stock` service (receive / ship / transfer / adjust). A second dashboard shows stock levels, reorder alerts and movement throughput, and a load-test script checks that the system stays correct under concurrent load.

**Stack:** Node.js 22 · Express 5 · Redis 7 (cache, rate limits, queue broker, metrics) · BullMQ · PostgreSQL 16 · Docker Compose


## Business context

**StockSync** is a multi-warehouse inventory platform for a retailer with three warehouses. Several kinds of clients reach it through the API gateway, and each one may only do its own job:

| Client (API key role) | Who | Allowed | Rate limit (burst / per sec) |
|---|---|---|---|
| `storefront` (`demo-storefront-key`) | the online shop | read stock, **ship** customer orders | 1000 / 300: customer traffic, flash sales |
| `supplier` (`demo-supplier-key`) | partner supplier "acme-supplies" | read stock, **receive** deliveries | 30 / 5: low-volume partner integration |
| `scanner` (`demo-scanner-key`) | warehouse handheld scanners | receive, ship, **transfer, adjust**, create items | 200 / 50 |
| `admin` (`demo-admin-key`) | operations team | everything, including deletes, audit and dashboards | 1000 / 500 |

Each rule is set per route in [services.json](gateway/config/services.json) (`"permissions"`). A supplier trying to ship, or the storefront trying to adjust stock, gets `403 forbidden` at the gateway before the request reaches a backend.

**Why each gateway feature exists, in business terms**

| Feature | Business reason |
|---|---|
| Rate limiting per client role | A flash sale on the storefront must not starve the warehouse scanners, and a buggy supplier integration must not flood the system |
| Permissions per role | Suppliers can only book deliveries; the storefront cannot change stock counts |
| Redis cache | The storefront checks stock levels constantly; those reads shouldn't all hit the database |
| Load balancing + health checks + circuit breaker | Orders keep flowing when one inventory server crashes or slows down |
| Idempotency keys | A scanner on flaky Wi-Fi that retries a "receive 50 boxes" never books the delivery twice |
| Atomic stock updates + ledger | Stock is never oversold, even when hundreds of customers buy the last units at the same moment |
| Async request logs (queue → workers → Postgres) | An audit trail of who changed what, without slowing down orders |

---

## Architecture

```
                   ┌────────────────────────────── API GATEWAY (:8080) ──────────────────────────────┐
 Client ──HTTP──▶  │ request-id → logging → route match → auth → rate limit → Redis cache → proxy     │
 (API key / JWT)   │                                       (API key/JWT) (token bucket) (GET, TTL)  │     │
                   │                                                                               ▼     │
                   │                         load balancer (round-robin / least-connections)             │
                   │                         + health checker + circuit breaker per instance             │
                   └──────────┬──────────────────────────────────────────────┬───────────────────────────┘
                              │ request logs (batched)                       │ proxied traffic
                              ▼                                              ▼
                       ┌──────────────┐                           ┌──────────┐  ┌──────────┐
   Redis ◀────────────▶│ queue: logs  │                          │inventory-1│  │ stock-1 │
   - response cache    └──────┬───────┘                          │inventory-2│  │ stock-2 │
   - rate-limit buckets       ▼                                  │inventory-3│  └────┬────┘
                                                                 └─────┬─────┘       │
                                                                       └──▶ PostgreSQL ◀┘
                                                                       (schema "inventory")
   - metrics counters  ┌──────────────────────────┐               └──────────┘
   - BullMQ broker     │ WORKERS (x2): bulk-insert │──────▶ PostgreSQL (request_logs)
                       │ logs, retry, retention    │
                       └──────────────────────────┘
```

| Component | Responsibility |
|---|---|
| `gateway/src/server.js` | Gateway process: routing, middleware pipeline, proxy, admin API, dashboard |
| `gateway/src/worker.js` | Worker process (2 replicas): takes log batches from the queue, bulk-inserts them into Postgres, deletes old logs |
| `services/backend` | Inventory microservice image, run as `inventory` × 3 and `stock` × 2, with chaos controls. All instances share the `inventory` schema in Postgres |
| Redis | Response cache, distributed rate-limit buckets, metrics, BullMQ broker |
| PostgreSQL | Request logs: who called what, the status, latency, upstream instance and cache result |
| API keys | Defined in configuration (`API_KEYS` env var), not stored in a database |

---

## Features → where they live

| Requirement | Implementation |
|---|---|
| **Rate limiting** | Token bucket per client, run atomically in Redis by a Lua script ([rateLimiter.js](gateway/src/core/rateLimiter.js)). It uses Redis server time, so every gateway instance shares the same limits. Tiers: anonymous (by IP), free, pro, admin. Each service has a cost per request (stock movements cost 2 tokens). Returns `429` with `Retry-After` and `X-RateLimit-*` headers. **If Redis is down**, it falls back to in-memory buckets on each gateway, so upstreams stay protected. |
| **Caching (Redis)** | GET responses are cached in Redis with a TTL set per service ([cache.js](gateway/src/core/cache.js)). Any successful write to a service bumps a version key, which invalidates that service's whole cache in O(1) with no `KEYS`/`SCAN`. The `X-Cache: HIT/MISS/BYPASS` and `Age` headers show what happened, and `Cache-Control: no-cache` skips the cache. If Redis is slow or down, requests bypass the cache. |
| **Load balancing** | Round-robin, least-connections or random, chosen per service ([loadBalancer.js](gateway/src/core/loadBalancer.js)). Only instances that are healthy and have a non-open circuit are candidates. |
| **Health checks** | Every instance's `/health` is polled every 3s. An instance is marked down after 2 failed checks and up again after 2 successful ones, so a single blip doesn't flip it ([healthChecker.js](gateway/src/core/healthChecker.js)). |
| **Circuit breaker** | One breaker per instance, with CLOSED → OPEN after 5 consecutive failures, then HALF_OPEN after 10s with one trial request ([circuitBreaker.js](gateway/src/core/circuitBreaker.js)). |
| **Retries / timeouts** | Each upstream call has a timeout. Idempotent requests (GET/HEAD/OPTIONS) are retried on a **different** instance after network errors, timeouts or a 500/502/503/504. POST is never retried. The gateway returns `502`, `503` or `504` with a structured error ([proxy.js](gateway/src/core/proxy.js)). |
| **Message queue + workers + database** | The gateway buffers log entries in memory and sends them to a BullMQ queue in batches (200 entries or every 1s). Two worker processes take batches from the queue and bulk-insert them into PostgreSQL. A failed insert is retried with exponential backoff, up to 5 attempts. Writing logs therefore adds no latency to requests, and Postgres can be slow or briefly down without losing logs ([logBuffer.js](gateway/src/core/logBuffer.js), [worker.js](gateway/src/worker.js), [schema.sql](gateway/db/schema.sql)). |
| **Authentication** | `X-API-Key`, or a JWT from `POST /auth/token`. Keys come from configuration, and only their SHA-256 hashes are kept in memory ([auth.js](gateway/src/middleware/auth.js)). Each service sets auth to `required` or `optional`, and the admin API needs the `admin` tier. Credentials are stripped before a request reaches an upstream. |
| **Logging & monitoring** | Every request gets an `X-Request-Id`, which is passed to upstreams. Logs are structured JSON. Metrics include cluster-wide counters in Redis and p50/p95/p99 latency. The dashboards are at `/dashboard/` (gateway) and `/dashboard/inventory.html` (inventory), and `/health` and `/ready` serve as liveness and readiness probes. |
| **Graceful degradation & shutdown** | If Redis is down, the gateway reports `degraded` and keeps serving with local rate limits and no cache. On SIGTERM it drains in-flight requests and flushes buffered logs, and workers finish the batch they are inserting before exiting. |

---

## Run it

Prerequisites: Docker Desktop and Node.js 20 or newer (Node is only needed for the demo and load-test scripts).

```bash
docker compose up -d --build --remove-orphans   # gateway, 2 workers, 3 inventory + 2 stock instances, Redis, Postgres
docker compose ps
node scripts/demo.js                # guided walkthrough of every feature
```

Dashboards: **http://localhost:8080/dashboard/** (gateway control room) and **http://localhost:8080/dashboard/inventory.html** (inventory operations). Connect with `demo-admin-key`. The inventory dashboard also works with `demo-pro-key`.

`--remove-orphans` removes the `products-*` / `orders-*` containers left over from the earlier version.

API keys are set by `API_KEYS` in [docker-compose.yml](docker-compose.yml), in the format `key:tier:name`. The defaults are:

| Key | Tier | Burst / sustained |
|---|---|---|
| *(none)* | anonymous (per IP) | 10 / 1 per sec |
| `demo-free-key` | free | 20 / 5 per sec |
| `demo-pro-key` | pro | 200 / 50 per sec |
| `demo-admin-key` | admin | 1000 / 500 per sec |
| `demo-storefront-key` · `demo-supplier-key` · `demo-scanner-key` | business roles | see *Business context* |

To use your own keys, set them before starting, for example `API_KEYS="s3cret-key:admin:ops,team-key:pro:team"`, then run `docker compose up -d`.

Stop: `docker compose down` (add `-v` to also wipe the database and Redis data).

### Run the tests

```bash
cd gateway
npm install
npm test        # unit + integration tests: auth, circuit breaker, load balancer, rate limiter, proxy failover/retries/timeouts
```

### Run the gateway outside Docker (development)

```bash
docker compose up -d postgres redis
(cd services/backend && npm install)                # once: installs pg
node scripts/start-backends.js                       # inventory/stock backends on localhost:3001-3005
cd gateway
# PowerShell:
$env:SERVICES_CONFIG="config/services.local.json"; $env:REDIS_URL="redis://localhost:6380"; $env:DATABASE_URL="postgres://gateway:gateway@localhost:5433/gateway"
npm start          # in a second terminal (same env vars): npm run worker
```

---

## API reference

All errors share one shape: `{ "error": { "code", "message", "requestId", ... } }`.

### Proxied services

| Method & path | Upstream | Notes |
|---|---|---|
| `GET /api/inventory?category=&q=&status=low,out&warehouse=` | inventory-1..3 | auth optional for reads, round-robin, cached 5s |
| `GET /api/inventory/summary` | | totals, per-warehouse and per-category value, reorder alerts |
| `GET /api/inventory/warehouses` · `GET /api/inventory/:sku` | | cached |
| `POST /api/inventory` · `PATCH /api/inventory/:sku` | | create / update an item (authenticated client required) |
| `DELETE /api/inventory/:sku` | | admin tier only |
| `GET /api/inventory/slow?ms=4000` | | demonstrates the 3s timeout (returns 504) |
| `POST /api/stock/receive` `{sku, warehouse, qty}` | stock-1..2 | auth required, least-connections, cost 2 |
| `POST /api/stock/ship` `{sku, warehouse, qty}` | | `409 insufficient_stock` if not enough on hand |
| `POST /api/stock/transfer` `{sku, from, to, qty}` | | atomic move between warehouses |
| `POST /api/stock/adjust` `{sku, warehouse, delta, reason}` | | cycle-count correction |
| `GET /api/stock/movements?sku=&type=&status=` | | ledger history |
| `GET /api/stock/throughput?minutes=30` · `GET /api/stock/audit?skuPrefix=` | | dashboard chart · consistency audit |

Stock writes accept an `Idempotency-Key` header. Repeating a request with the same key returns the original result with `idempotent-replay: true` and is never applied twice. A successful stock write also purges the `inventory` cache (`"invalidates": ["inventory"]` in [services.json](gateway/config/services.json)).

Response headers: `X-Request-Id`, `X-Upstream-Instance`, `X-Upstream-Attempts`, `X-Cache`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Policy`, plus `Retry-After` on a 429.

### Auth
`POST /auth/token` with header `X-API-Key` returns `{ accessToken, tokenType: "Bearer", expiresIn }`.

### Admin (admin tier)
| | |
|---|---|
| `GET /admin/stats` | metrics, latency percentiles, instance state, log queue depth |
| `GET /admin/services` | instance health and circuit breakers |
| `GET /admin/logs?status=5xx&service=stock&client=demo-pro&limit=50` | request logs from Postgres |
| `POST /admin/cache/purge` | body `{ "service": "inventory" }`, or no body to purge every service |
| `POST /admin/instances/:id/chaos` | body `{ "down": true }`, `{ "failRate": 0.7 }`, `{ "latencyMs": 4000 }` or `{ "reset": true }` |

### Example requests (PowerShell: use `curl.exe`)
```bash
curl -i http://localhost:8080/api/inventory -H "x-api-key: demo-pro-key"
curl -i -X POST http://localhost:8080/api/stock/ship -H "x-api-key: demo-pro-key" -H "content-type: application/json" \
     -d "{\"sku\":\"ELE-1001\",\"warehouse\":\"WH-NORTH\",\"qty\":3}"
curl -i "http://localhost:8080/admin/logs?limit=5" -H "x-api-key: demo-admin-key"
```

---

## Demo scenarios (for evaluation)

1. **Rate limiting.** Run `node scripts/loadtest.js --key demo-free-key --concurrency 20 --duration 8`. Most requests return 429. About 60 succeed, which is the 20-request burst plus 5 req/s for 8 seconds. With `--key demo-pro-key` about 600 succeed (200 burst + 50 req/s).
2. **Caching.** Run the same load test against `/api/inventory`. The `Served by` line shows `cache` for most responses and latency drops. A stock movement causes the next inventory GET to miss the cache.
3. **Load balancing.** Step 3 of `demo.js` sends requests with `Cache-Control: no-cache`. They spread evenly over inventory-1, 2 and 3.
4. **Failover and circuit breaker.** On the dashboard, click **500s** on inventory-2. Its circuit turns OPEN, traffic keeps succeeding on the other instances, and after 10s it goes HALF_OPEN. Click **kill**, and the health checks mark the instance down within about 6s. Click **reset** to bring it back.
5. **Hard failure.** Run `docker compose stop inventory-1 inventory-2 inventory-3`, and `/api/inventory` returns `503 service_unavailable`. Run `docker compose start ...` and the instances rejoin on their own.
6. **Redis outage.** Run `docker compose stop redis`. `/ready` reports `degraded`, proxied traffic keeps flowing, and the `X-RateLimit-Mode: local-fallback` header appears. Run `docker compose start redis` to recover.
7. **Async logging under a database outage.** Run `docker compose stop postgres` and send some traffic. Requests still succeed, and the log batches wait in the queue. Run `docker compose start postgres`, and the workers insert the waiting batches.

---

## Inventory domain

| Concept | Where |
|---|---|
| Warehouses `WH-NORTH`, `WH-SOUTH`, `WH-EAST`, 24 seeded SKUs in 5 categories | seeded on first start ([db.js](services/backend/db.js)) |
| `stock_levels(sku, warehouse, qty CHECK qty >= 0)` | current stock |
| `movements` (append-only ledger, `status` ok/rejected, unique `idempotency_key`) | every receive, ship, transfer and adjust |

**Correctness under concurrency** ([stock.js](services/backend/stock.js)):
- **No overselling.** A ship is one conditional `UPDATE ... SET qty = qty - n WHERE qty >= n`, so the check and the decrement are a single atomic step. If no row is updated, the request gets `409` and is recorded as a *rejected* movement.
- **Atomic transfers without deadlocks.** Both rows are locked with `SELECT ... FOR UPDATE ORDER BY warehouse`, so opposite transfers (A→B and B→A) always lock in the same order.
- **Ledger = levels.** The level update and the ledger insert happen in one transaction. `GET /api/stock/audit` recomputes every level from the ledger.
- **Safe client retries.** The gateway never retries a POST, because it can't know whether the POST was applied. Clients can retry safely with an `Idempotency-Key`. A duplicate inserts nothing (`ON CONFLICT DO NOTHING`) and gets the original result back. A concurrent duplicate waits on the unique index.
- **Defence in depth.** Backends require the gateway's `x-gateway-client-id` header for writes and the `admin` tier for deletes. The gateway strips any client-supplied `x-gateway-*` headers.

## Inventory dashboard

`http://localhost:8080/dashboard/inventory.html` (or `http://localhost:8080/inventory`), refreshed every 3s. All data goes through the gateway, so it is cached, rate-limited and load-balanced like any client.

- KPIs: SKUs, units on hand, stock value, low-stock and out-of-stock counts, committed and rejected movements per minute
- Stacked chart of movements per minute by type (receive / ship / transfer / adjust / rejected) over the last 30 min, with hover detail
- Units by warehouse, stock value by category
- Reorder alerts with coverage bars. **Receive** pre-fills the movement form.
- A form to record a movement (sent with a fresh `Idempotency-Key`), a filterable stock-levels table, and a recent-movements feed showing which instance committed each movement

## Load testing

```bash
node scripts/inventory-loadtest.js                                  # 40 VUs, 30s, 5s ramp-up
node scripts/inventory-loadtest.js --vus 80 --duration 60 --skus 4  # more contention on fewer SKUs
node scripts/inventory-loadtest.js --rps 200 --duration 60          # fixed arrival rate (open model)
node scripts/inventory-loadtest.js --out scripts/reports/run.json --cleanup
```

**With Locust** (Python, live web UI with charts): [loadtest/locustfile.py](loadtest/locustfile.py) simulates the business clients, each with its own API key. Storefront customers browse and order, warehouse scanners receive, transfer and adjust, suppliers make deliveries, and one ops admin watches the summary and runs the audit. The file creates its own SKUs at start and runs the ledger audit at the end, exiting with code 1 if it fails. A 409 "sold out" counts as a correct business answer, while 429 and 403 show up as failures per role.

```powershell
python -m pip install -r loadtest/requirements.txt
python -m locust -f loadtest/locustfile.py --host http://localhost:8080      # then open http://localhost:8089
python -m locust -f loadtest/locustfile.py --host http://localhost:8080 --headless -u 50 -r 10 -t 60s --html loadtest/report.html
```

**Flash sale** (`node scripts/flash-sale.js --buyers 300 --stock 50`): the supplier delivers 50 units of a limited product, then 300 storefront customers try to buy one each at the same moment. Result on this machine: **exactly 50 sold**, 250 told "sold out" (409), stock ended at 0, and the ledger audit was consistent. Sales were committed by both stock instances in parallel (stock-1 = 20, stock-2 = 30), without overselling.

The script creates its own SKUs (`LT-<run>-NN`, category "Load test") and stocks them. Virtual users then run a weighted mix (`--mix browse=30,item=20,summary=5,movements=5,receive=12,ship=20,transfer=6,adjust=2`). Ships outnumber receives, so SKUs keep running out and concurrent ships compete for the last units. Write retries after a network error or 5xx reuse the same `Idempotency-Key`. Keep the inventory dashboard open during a run to watch it live. The script prints throughput, p50/p95/p99 per operation, status codes and the per-instance spread, then runs the **integrity checks** (it exits non-zero if any fail):

1. final stock == opening stock + every movement the client saw committed
2. server ledger audit: every level equals its ledger sum, and none is negative
3. 10 concurrent duplicates with one `Idempotency-Key` are applied exactly once
4. the oversell guard was exercised (`409 insufficient_stock` happened)

Sample result on Docker Desktop (Windows, one laptop), default settings with the `admin` key:

| | |
|---|---|
| Throughput before rate limiting | about 440 req/s, p50 73 ms, p95 120 ms, p99 149 ms, 0 failures |
| Spread | inventory-1/2/3 ≈ 2,236 each, stock-1/2 ≈ 2,294 each |
| Rate limiting | the admin bucket (1000 burst, 500/s) emptied after about 10s because stock writes cost 2 tokens; after that about 30% of requests got `429` |
| Integrity | all 4 checks passed. 906 ships/transfers were rejected for insufficient stock and no level went negative |
| Cache | about 0% hit ratio on `/api/inventory`: around 100 stock writes/s purge it continuously |

The last row is the main trade-off. Purging on every write gives read-your-writes consistency but makes the cache useless under heavy write load. Options are a TTL without write invalidation (reads up to 5s stale, while ships stay correct because the database enforces them), or per-SKU cache keys so a movement only purges what it changed. To measure the backends without rate limiting, raise `RL_ADMIN_CAPACITY` / `RL_ADMIN_REFILL` on the gateway.

---

## Design decisions & trade-offs

- **Token bucket over fixed window.** It allows short bursts while enforcing a sustained rate, and it has no spike at window boundaries. Running it as a Lua script keeps the read-modify-write atomic when several gateways share a bucket.
- **Version-key cache invalidation.** One `INCR` invalidates a whole service, and stale entries expire on their own TTL. The cost is some memory held by stale entries until they expire. Cache keys are built from the URL, so only responses that are the same for every client should be cached. That is why the cache is turned on for `inventory` only. Stock writes purge it too, so readers always see their own writes.
- **Fail-open vs fail-closed.** Redis is used for performance features, so when it is down the gateway degrades instead of failing.
- **Async logging through a queue.** Writing a log row on every request would tie the gateway's latency to Postgres. Instead, logs are batched, sent through a queue and bulk-inserted by workers. Logs are eventually consistent, and a bounded buffer drops entries rather than running out of memory.
- **API keys in configuration.** Keeping keys in config keeps the system simple and removes a database lookup from every request. The trade-off is that adding or revoking a key requires a restart.
- **Health checks plus circuit breakers.** Active health checks catch dead instances. Passive breakers react to real traffic within milliseconds, including instances that pass `/health` but fail actual requests.

### Scaling further
Rate limits, cache, metrics and the queue already live in Redis, so the gateway can run several replicas behind an L4 load balancer. Health and breaker state are per gateway by design, because each gateway judges its own view of each upstream. Workers can be scaled with `docker compose up -d --scale worker=4`. Next steps would be Redis Sentinel or Cluster for high availability, partitioning `request_logs` by day, and a Prometheus `/metrics` endpoint.

## Project layout
```
docker-compose.yml
gateway/
  config/services.json        service routes, instances, LB strategy, cache TTL, timeouts, retries
  db/schema.sql               PostgreSQL schema (request_logs; applied automatically under an advisory lock)
  public/index.html           gateway dashboard
  public/inventory.html       inventory dashboard
  src/server.js               gateway entry point
  src/worker.js               worker entry point (log ingestion + retention)
  src/app.js                  middleware pipeline
  src/core/                   rateLimiter, cache, loadBalancer, circuitBreaker, healthChecker, proxy, metrics, logBuffer
  src/middleware/             auth (API key + JWT), request id + logging
  src/routes/                 /auth, /admin
  test/                       node:test suites
services/backend/             inventory microservice (server.js, inventory.js, stock.js, db.js) with chaos endpoints
scripts/                      demo.js, loadtest.js, inventory-loadtest.js, start-backends.js
```
