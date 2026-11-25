"""
Stress test: find the breaking point ("crash-out") of the platform.

Same business users as locustfile.py, but the load climbs automatically in steps until the run ends:
  every STEP_SECONDS add STEP_USERS more users, up to MAX_USERS.
Watch the Charts tab: the point where response times shoot up and failures appear is the capacity limit.

  python -m locust -f loadtest/stress.py --host http://localhost:8080
  python -m locust -f loadtest/stress.py --host http://localhost:8080 --headless --html loadtest/report-stress.html

Tip: to see the backends saturate (instead of the gateway's rate limiter answering 429 first), restart the
gateway with high limits, e.g. in PowerShell:
  $env:RL_STOREFRONT_CAPACITY=100000; $env:RL_STOREFRONT_REFILL=100000; $env:RL_SCANNER_CAPACITY=100000; $env:RL_SCANNER_REFILL=100000
  docker compose up -d gateway
"""
import os

from locust import LoadTestShape

from locustfile import OpsUser, ScannerUser, StorefrontUser, SupplierUser  # noqa: F401  (user classes)

STEP_USERS = int(os.getenv("STEP_USERS", "50"))
STEP_SECONDS = int(os.getenv("STEP_SECONDS", "20"))
MAX_USERS = int(os.getenv("MAX_USERS", "600"))


class StepLoad(LoadTestShape):
    """50 users, then 100, 150, ... every 20 s; holds MAX_USERS for one extra step, then stops."""

    def tick(self):
        t = self.get_run_time()
        steps = MAX_USERS // STEP_USERS
        if t > STEP_SECONDS * (steps + 1):
            return None
        users = min(MAX_USERS, STEP_USERS * (int(t // STEP_SECONDS) + 1))
        return users, STEP_USERS  # (user count, spawn rate per second)
