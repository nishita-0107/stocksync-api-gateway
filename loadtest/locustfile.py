"""
Locust load test for the StockSync inventory platform (through the API gateway).

Each simulated user is one of the platform's business clients, using its own API key:
  StorefrontUser  online-shop customers: browse stock, view items, place orders (ship)   [most traffic]
  ScannerUser     warehouse handhelds: receive, transfer, cycle-count adjust
  SupplierUser    partner supplier: occasional deliveries (receive), checks low-stock list
  OpsUser         one operations admin: summary + consistency audit

At start it creates its own SKUs (LT-<run>-NN, category "Load test") and stocks them; at the end
it runs the ledger audit and sets a non-zero exit code if stock levels are inconsistent.

Business outcomes are reported, not hidden:
  409 insufficient_stock  -> counted as success (correct "sold out" answer), tallied separately
  429 rate limited        -> failure "429 rate limited (<role>)"
  403 forbidden           -> failure (a client tried something its role may not do)

Run (web UI at http://localhost:8089):
  python -m locust -f loadtest/locustfile.py --host http://localhost:8080
Headless:
  python -m locust -f loadtest/locustfile.py --host http://localhost:8080 --headless -u 50 -r 10 -t 60s --html loadtest/report.html
"""
import os
import random
import time
import uuid
from collections import Counter

import requests
from locust import HttpUser, between, constant, events, task

ADMIN_KEY = os.getenv("ADMIN_KEY", "demo-admin-key")
KEYS = {
    "storefront": os.getenv("STOREFRONT_KEY", "demo-storefront-key"),
    "scanner": os.getenv("SCANNER_KEY", "demo-scanner-key"),
    "supplier": os.getenv("SUPPLIER_KEY", "demo-supplier-key"),
    "admin": ADMIN_KEY,
}
N_SKUS = int(os.getenv("LT_SKUS", "10"))
OPENING = int(os.getenv("LT_OPENING", "100"))  # units per SKU per warehouse
RUN = time.strftime("%H%M%S")
PREFIX = f"LT-{RUN}-"

SKUS: list[str] = []
SEEDED_SKUS: list[str] = []
WAREHOUSES: list[str] = []
outcomes = Counter()  # business outcomes: sold, sold_out, received, ...


# ---------------------------------------------------------------- setup / teardown
@events.test_start.add_listener
def create_test_data(environment, **_):
    host = environment.host.rstrip("/")
    s = requests.Session()
    s.headers["x-api-key"] = ADMIN_KEY
    WAREHOUSES[:] = [w["code"] for w in s.get(f"{host}/api/inventory/warehouses").json()["warehouses"]]
    SEEDED_SKUS[:] = [i["sku"] for i in s.get(f"{host}/api/inventory?limit=500").json()["items"] if not i["sku"].startswith(("LT-", "FS-"))]
    SKUS.clear()
    for n in range(1, N_SKUS + 1):
        sku = f"{PREFIX}{n:02d}"
        r = s.post(f"{host}/api/inventory", json={"sku": sku, "name": f"Load-test item {n}", "category": "Load test",
                                                   "unitCost": random.randint(5, 120), "reorderLevel": int(OPENING * 0.6)})
        r.raise_for_status()
        for wh in WAREHOUSES:
            s.post(f"{host}/api/stock/receive", json={"sku": sku, "warehouse": wh, "qty": OPENING, "reference": "load-test opening"}).raise_for_status()
        SKUS.append(sku)
    print(f"[setup] created {len(SKUS)} SKUs ({PREFIX}01..) x {OPENING} units in {', '.join(WAREHOUSES)}")


@events.test_stop.add_listener
def audit(environment, **_):
    host = environment.host.rstrip("/")
    r = requests.get(f"{host}/api/stock/audit", params={"skuPrefix": PREFIX}, headers={"x-api-key": ADMIN_KEY})
    body = r.json() if r.ok else {}
    ok = bool(body.get("consistent"))
    print("\n[business outcomes] " + ", ".join(f"{k}={v}" for k, v in sorted(outcomes.items())))
    print(f"[audit] {'PASS' if ok else 'FAIL'}: {body.get('checked')} stock levels checked, "
          f"{len(body.get('mismatches', []))} ledger mismatches, {len(body.get('negative', []))} negative")
    if not ok:
        environment.process_exit_code = 1


# ---------------------------------------------------------------- shared helpers
class BusinessUser(HttpUser):
    abstract = True
    role = "admin"

    def on_start(self):
        self.client.headers["x-api-key"] = KEYS[self.role]

    def get(self, path, name):
        with self.client.get(path, name=name, catch_response=True) as r:
            self._judge(r)

    def move(self, kind, body, name=None):
        """Stock movement with an Idempotency-Key (safe to retry). 409 = correct business rejection."""
        with self.client.post(f"/api/stock/{kind}", json=body, name=name or f"POST /api/stock/{kind}",
                              headers={"idempotency-key": str(uuid.uuid4())}, catch_response=True) as r:
            if r.status_code in (200, 201):
                outcomes[{"ship": "sold", "receive": "received"}.get(kind, kind + "_ok")] += 1
                r.success()
            elif r.status_code == 409:
                outcomes["sold_out" if kind == "ship" else kind + "_rejected"] += 1
                r.success()
            else:
                self._judge(r)

    def _judge(self, r):
        if r.status_code == 429:
            r.failure(f"429 rate limited ({self.role})")
        elif r.status_code == 403:
            r.failure(f"403 forbidden ({self.role})")
        elif r.status_code >= 400 or r.status_code == 0:
            r.failure(f"HTTP {r.status_code}")
        else:
            r.success()


# ---------------------------------------------------------------- business clients
class StorefrontUser(BusinessUser):
    """Online-shop customers: mostly browsing (cached reads), some buy."""
    role = "storefront"
    weight = 6
    wait_time = between(0.2, 1.0)

    @task(5)
    def browse_catalog(self):
        cat = random.choice(["", "&category=Electronics", "&category=Safety", "&category=Load%20test"])
        self.get(f"/api/inventory?limit=50{cat}", "GET /api/inventory (browse)")

    @task(4)
    def view_item(self):
        sku = random.choice(SKUS) if random.random() < 0.6 else random.choice(SEEDED_SKUS)
        self.get(f"/api/inventory/{sku}", "GET /api/inventory/[sku]")

    @task(3)
    def place_order(self):
        self.move("ship", {"sku": random.choice(SKUS), "warehouse": random.choice(WAREHOUSES),
                           "qty": random.randint(1, 3), "reference": f"web-{uuid.uuid4().hex[:8]}"})


class ScannerUser(BusinessUser):
    """Warehouse handheld scanners: goods-in, moves between warehouses, cycle counts."""
    role = "scanner"
    weight = 3
    wait_time = between(0.5, 1.5)

    @task(4)
    def goods_in(self):
        self.move("receive", {"sku": random.choice(SKUS), "warehouse": random.choice(WAREHOUSES), "qty": random.randint(1, 5)})

    @task(3)
    def transfer(self):
        src, dst = random.sample(WAREHOUSES, 2)
        self.move("transfer", {"sku": random.choice(SKUS), "from": src, "to": dst, "qty": random.randint(1, 5)})

    @task(1)
    def cycle_count(self):
        self.move("adjust", {"sku": random.choice(SKUS), "warehouse": random.choice(WAREHOUSES),
                             "delta": random.choice([-2, -1, 1, 2]), "reason": "cycle count"})

    @task(2)
    def lookup(self):
        self.get(f"/api/inventory/{random.choice(SKUS)}", "GET /api/inventory/[sku]")


class SupplierUser(BusinessUser):
    """Partner supplier: low-volume integration (its rate limit is 30 burst / 5 per s)."""
    role = "supplier"
    weight = 1
    wait_time = between(2, 4)

    @task(2)
    def check_low_stock(self):
        self.get("/api/inventory?status=low,out&limit=100", "GET /api/inventory?status=low,out")

    @task(3)
    def deliver(self):
        self.move("receive", {"sku": random.choice(SKUS), "warehouse": random.choice(WAREHOUSES),
                              "qty": random.randint(20, 50), "reference": f"PO-{uuid.uuid4().hex[:6]}"},
                  name="POST /api/stock/receive (supplier delivery)")


class OpsUser(BusinessUser):
    """One operations admin watching the summary and running the consistency audit."""
    role = "admin"
    fixed_count = 1
    wait_time = constant(3)

    @task(3)
    def summary(self):
        self.get("/api/inventory/summary", "GET /api/inventory/summary")

    @task(1)
    def audit(self):
        self.get(f"/api/stock/audit?skuPrefix={PREFIX}", "GET /api/stock/audit")
