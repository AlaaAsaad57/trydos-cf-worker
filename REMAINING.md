# Remaining work — edge layer

Everything Cloudflare-side is **done and verified**: media (CLAUDE.md §3.17),
the `/api/proxy` Worker (§3.14) and the PostHog `/ingest` Worker (§3.19).
What is left is listed here, one file per item.

None of it can be finished inside this repo. Every item needs either a
server-side change on the origin box, or an app change in `../trydos` /
`../../MediaServing`, which §0 of CLAUDE.md forbids editing from here.

## Status

| # | Item | Owner | Blocking? | File |
|---|---|---|---|---|
| 1 | Media on Flexible SSL — cannot move to Full (strict) | server admin | no | [STEP-1-media-ssl.md](STEP-1-media-ssl.md) |
| 2 | `/metrics` still open inside the network | MediaServing | no | [STEP-2-metrics-listener.md](STEP-2-metrics-listener.md) |
| 3 | Retire `media_server.ramaaz.dev` | trydos + MediaServing | no | [STEP-3-retire-media-server-host.md](STEP-3-retire-media-server-host.md) |
| 4 | Origin lock-down: Grafana exposed, AOP not enabled | server admin | **yes, for item 1** | [STEP-4-origin-lockdown.md](STEP-4-origin-lockdown.md) |
| 5 | PostHog `/ingest` follow-ups: replay, geo check, dead route | trydos | no | [STEP-5-posthog-ingest-followups.md](STEP-5-posthog-ingest-followups.md) |

## What is already live

Applied 2026-08-24, verified against production:

| Ruleset | Phase | Id |
|---|---|---|
| `media delivery cache` | `http_request_cache_settings` | `319e5667ae4040b8bba21ebb8f6b9e9d` |
| `media protection` | `http_request_firewall_custom` | `eca8b23256f740948fc4b624fd5b2490` |
| `media upload rate limit` | `http_ratelimit` | `ef020c4c6487456183bf8c9a64aea48e` |

Full before/after evidence is in CLAUDE.md §3.17.

Two Workers are also live on `trydos.ramaaz.dev`:

| Worker | Routes | Section |
|---|---|---|
| `trydos-proxy` | `/api/proxy`, `/api/proxy-edge` | §3.14 |
| `trydos-ingest` | `/ingest/*`, `/ingest-edge/*` | §3.19 |

Both roll back by deleting the route in the dashboard — the Next handlers are
still deployed underneath and take over in seconds.

Standing this up on a different Cloudflare account: [DEPLOY.md](DEPLOY.md).

## If you only do one thing

**Item 4, the Grafana exposure.** It is the only item on this list where
something sensitive is reachable from the internet *right now*, and unlike
`/metrics` no edge rule can help — Grafana on `:3001` bypasses Cloudflare
entirely.

## Suggested order

```
4 (Grafana)  ->  4 (AOP)  ->  1 (SSL)  ->  2 (/metrics)  ->  3 (hostname)
```

Items 2 and 3 are hygiene and can happen whenever. Item 1 depends on the
origin being properly locked to Cloudflare first, which is item 4.

Item 5 is independent of all of them and belongs to whoever owns trydos. Its
only ordering constraint is internal: confirm geo-IP (5b) before deleting the
Next route (5c).
