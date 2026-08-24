# infra — Cloudflare rules as code

Cache rules, WAF rules and rate limiting for the `ramaaz.dev` zone.

## ⛔ Do not `apply` yet

The zone already has configuration that predates this repo — media has been
served through Cloudflare for some time (CLAUDE.md §3.10) and nobody has read
what rules exist. **Terraform deletes rules it does not know about.** A blind
`apply` against a live media zone is an outage.

Required order:

1. Read the current state. Either a read-only API token (Zone:Read, Zone
   Settings:Read) or a paste of the Rules → Cache Rules and Security → WAF
   pages.
2. `terraform import` whatever already exists, or confirm the rulesets are
   empty.
3. `terraform plan` and read every line of it.
4. Only then `apply`.

Nothing here has been validated against a real zone or even parsed — Terraform
is not installed in the authoring environment. Treat these files as a reviewed
proposal, not as working code, until a `plan` has run.

## Provider version

Written for the **v5** Cloudflare provider, whose resource syntax differs from
v4 (rules are list-of-object attributes, not nested blocks). If `plan` reports
syntax errors, check the installed provider version first — that is the usual
cause.

## What is proposed, and why

### Cache (`cache.tf`)

The important part is the **cache key**, not the TTL. Image transforms are
expressed in the path (`/image/upload/w_200/foo.jpg`) and video variants in a
single `target` query parameter (`src/api/transform.js:200`). If the cache key
includes the whole query string, then `?x=1`, `?x=2`, `?x=3` are three separate
misses, and each one is a Sharp or ffmpeg invocation on the origin EC2 box.
That is a trivially cheap way for anyone to burn origin CPU.

So the key is path + `target` only, and everything else in the query string is
ignored. At 1M visitors this matters more than any TTL choice.

Origin already sends `cache-control: max-age=14400`, so edge TTL respects the
origin rather than overriding it — changing that is a separate decision that
needs to know whether media filenames are content-addressed.

### WAF (`waf.tf`)

Free plan allows **5 custom rules and 1 rate-limiting rule**. Budget:

| # | Rule | Why |
|---|---|---|
| 1 | Block `/metrics` | Public Prometheus scrape, verified. CLAUDE.md §3.10 |
| 2 | Block the known upload auth bypass | `POST /upload?x=/image/upload/` skips the API-key check — a recorded, accepted risk in `auth.js:41-47`. This is a stopgap, **not** the fix |
| 3 | Block write methods on read-only paths | Defence in depth around the transform routes |
| 4 | *(unused — keep one spare)* | |
| 5 | *(unused — keep one spare)* | |

Two rules are left free deliberately. On a 5-rule budget, having no room to
respond to an incident is its own risk.

### Rate limiting

One rule, 10-second window, IP-only — that is the entire Free allowance.

Spent on the upload paths, since those are the expensive ones (Sharp, ffmpeg,
S3 multipart). The threshold is deliberately high: **carrier NAT in SY/IQ/LB
means many real users share one address**, so a tight IP limit produces false
positives on exactly the customers this business has. The authoritative limits
stay in the app, Redis-backed and per-identity
(`../../MediaServing/src/app.js:158-163`).

## Prerequisite: origin lock-down

None of this is enforceable if the origin can be reached directly. Current
evidence says it cannot (CLAUDE.md §3.10), but the mechanism is inferred from
behaviour rather than read from the Apache config. Confirm that before relying
on any rule here, and prefer Authenticated Origin Pulls over an IP-range ACL —
a client certificate does not drift as Cloudflare adds ranges.
