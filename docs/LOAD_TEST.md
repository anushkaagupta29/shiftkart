# Load test: shift acceptance

**What it checks.** Many workers try to take the same shift at the same moment. Afterwards:
- exactly `headcount` people are booked;
- nobody is double-booked into overlapping shifts;
- no request fails with a server error;
- the ledger still sums to zero.

**How it runs.**
- [`apps/api/scripts/load-test.ts`](../apps/api/scripts/load-test.ts) boots the real API on `127.0.0.1` against the **local test database**, which is wiped first. It refuses any non-local database.
- It creates verified workers directly in the database (onboarding 1000 people through KYC would only test the mocks).
- It then fires real HTTP requests using Node's built-in `fetch`, so there is no k6 or other global install (SPEC said k6; D-086 explains why it's not used).

```bash
npm run load-test -w @shiftkart/api
WORKERS=3000 SLOTS=100 CONCURRENCY=200 npm run load-test -w @shiftkart/api
```

## Results (2026-10-24, Apple M4 laptop, 10 cores, Node 26, Postgres 16 in Docker, one API process, DB pool 20)

| Scenario | Requests | Concurrency | Throughput | p50 | p95 | p99 | Outcome |
|---|---|---|---|---|---|---|---|
| 1000 workers race for 50 slots | 1000 | 200 | 976 req/s | 172 ms | 333 ms | 368 ms | 50 × 201, 950 × `shift_full` |
| same | 1000 | 20 | 870 req/s | 19 ms | 33 ms | 105 ms | 50 × 201 |
| 3000 workers race for 100 slots | 3000 | 200 | 1003 req/s | 170 ms | 378 ms | 467 ms | 100 × 201, 2900 × `shift_full` |
| 1000 accepts over 20 shifts | 1000 | 200 | 877 req/s | 204 ms | 263 ms | 270 ms | 950 booked; the 50 race winners correctly refused (already working that day) |
| 3000 accepts over 20 shifts | 3000 | 200 | 879 req/s | 224 ms | 270 ms | 275 ms | 2900 booked; 100 correctly refused |
| Feed (shifts within 25 km) | 2000 | 20 / 200 | ~900 req/s | 22 / 189 ms | 31 / 304 ms | 40 / 313 ms | all 200 |

**Correctness held in every run:**
- 0 shifts over headcount;
- 0 overlapping double-bookings;
- 0 server errors;
- ledger balance 0.

## What the numbers mean
- A single API process on a laptop handles about **900–1000 requests/second** on the booking path.
  - Latency grows with queueing: about 20 ms at 20 in flight, about 200 ms at 200 in flight.
  - The bottleneck is the 20-connection Postgres pool plus the row lock on the hot shift. That lock is deliberate: it is what makes "last slot goes to exactly one person" true.
- Launch scale (one city, hundreds of shifts a day) is far below this. A popular shift with 1000 people tapping "Accept" in the same second still resolves in about a second, with everyone getting a clear answer.
- **Before scaling up:**
  - run 2+ API instances behind the load balancer (state is all in Postgres, so this works as-is);
  - size the pool to the database (`max_connections`), or put PgBouncer in front;
  - re-run this test against the staging database (needs your permission, see GO_LIVE.md).
- **Not measured here:**
  - real network latency to Mumbai;
  - TLS;
  - a managed database's I/O;
  - mobile clients on 2G/3G (covered functionally by the low-bandwidth tests, not for load).
