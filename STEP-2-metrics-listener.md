# Step 2 — Move `/metrics` onto its own internal listener

**Owner:** MediaServing (`../../MediaServing`) + whoever runs Prometheus
**Status:** not started. The internet-facing half is already closed.
**Risk if done wrong:** Grafana dashboards go blank.

---

## What is already done

`/metrics` is **blocked from the internet** by the WAF rule
`block_public_metrics` (live, verified 403 on both media hostnames — CLAUDE.md
§3.17). Committed as `e3821b9`.

## What is left

The WAF rule closes the door from outside. It does nothing about anything
already inside the network — `/metrics` is still served unauthenticated on the
app's own port.

## 🔴 Do NOT use the API key

Requiring `x-api-key` on `/metrics` was proposed and **rejected — user
decision, 2026-08-24.** Do not propose it again.

Two reasons it is the wrong shape:

1. It spreads the same static key the upload routes use into the monitoring
   stack.
2. It leaves `/metrics` sitting on the public app's port regardless.

## The right fix — and MediaServing already has the pattern

`src/worker.js:131-151` already serves the worker's metrics from its own
`http.createServer` bound to `WORKER_METRICS_PORT` (default 9091), completely
outside Fastify. `authHook` never runs for it, so no credential exists to leak.

The main app should do the same.

---

## Steps

### 1. Move the endpoint off Fastify

`src/middleware/metrics.js:150-158` currently registers `GET /metrics` on the
Fastify instance. Move it to a standalone `http.createServer` on its own port,
e.g. `APP_METRICS_PORT` (9090).

The worker-metrics aggregation lives in the same handler and moves with it —
it fetches `WORKER_METRICS_URL` (`src/middleware/metrics.js:67`) and appends
the result, so a single scrape target still returns both.

### 2. Remove it from the app and the allowlist

- Delete the `/metrics` route registration from the Fastify instance.
- Remove `request.url === "/metrics"` from the legacy allowlist at
  `src/middleware/auth.js:49`.

**Leave `/health` alone.** It is on the same allowlist, it is genuinely
harmless, and the Docker healthcheck depends on it
(`docker-compose.prod.yml:82`).

⚠️ Do not "tidy up" the rest of that allowlist while you are in there. The
comment above it at `auth.js:41-47` records the `request.url` query-string
bypass as a deliberate, accepted migration-window risk owned by a separate
cutover ticket. Changing it here without that decision is out of scope.

### 3. Bind it to loopback in compose

This is the part that makes it durable rather than another ACL to maintain:

```yaml
ports:
  - "127.0.0.1:9090:9090"     # NOT "9090:9090"
```

With loopback binding the port is unreachable from outside the host even if a
security-group rule changes later.

That matters here specifically: `docker-compose.prod.yml:71` carries an
"ADMIN: ensure port 4001 is open in the firewall / security-group rules" note.
It was never actioned — 4001 currently times out from the internet, verified
2026-08-24 — but if anyone ever actions it, an unbound metrics port would be
exposed with it.

### 4. Repoint Prometheus

`observability/prometheus/targets/media-serving.json` currently reads:

```json
"targets": [ "host.docker.internal:4001" ]
```

`4001` maps to the app's `3000` (`docker-compose.prod.yml:73`), which is why
the scrape currently goes through `authHook`. Change it to the new metrics
port, e.g. `host.docker.internal:9090`.

**All four changes must deploy together.** Steps 1-2 without step 4 blanks the
dashboards.

---

## Verify

```bash
# From the internet — still blocked by the WAF rule
curl -sS https://media.ramaaz.dev/metrics -o /dev/null -w "%{http_code}\n"   # 403

# From the origin host — should work, no key
curl -sS http://127.0.0.1:9090/metrics | head -5

# From the origin host, the OLD path — should now 401 or 404, not 200
curl -sS http://127.0.0.1:4001/metrics -o /dev/null -w "%{http_code}\n"

# Health must be untouched
curl -sS https://media.ramaaz.dev/health -o /dev/null -w "%{http_code}\n"    # 200
```

Then confirm Grafana still draws the media-serving dashboards, and that
`queue_*` worker metrics are still present — that is the check that the
aggregation moved intact.

## After this lands

The WAF rule becomes belt-and-braces rather than the only defence. Keep it.
