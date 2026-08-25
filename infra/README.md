# infra — Cloudflare rules as code

Cache rules, WAF rules and rate limiting for the `ramaaz.dev` zone.

## ✅ Applied 2026-08-24 — this is live, not a proposal

An earlier revision of this file said "do not apply yet" and "nothing here has
been validated against a real zone or even parsed". **Both statements are now
out of date.** Three rulesets were applied to `ramaaz.dev` with Terraform
1.15.9 / provider v5.23.0 and verified against production — full before/after
evidence in CLAUDE.md §3.17.

| Ruleset | Phase | Id |
|---|---|---|
| `media delivery cache` | `http_request_cache_settings` | `319e5667ae4040b8bba21ebb8f6b9e9d` |
| `media protection` | `http_request_firewall_custom` | `eca8b23256f740948fc4b624fd5b2490` |
| `media upload rate limit` | `http_ratelimit` | `ef020c4c6487456183bf8c9a64aea48e` |

The plan was `3 to add, 0 to change, 0 to destroy`, which is what made it safe:
the zone audit found **no pre-existing custom rulesets** (CLAUDE.md §3.11), so
there was nothing for Terraform to clobber.

`settings.tf` is the exception — it is **not** applied. Those four zone
settings were changed in the dashboard and the file is a record of intent. Read
its header before running it.

### ⛔ The warning still applies to any OTHER zone

**Terraform deletes rules it does not know about.** The apply above was safe
because the zone was empty of custom rules, not because apply is safe. On a
zone that already has cache or WAF rules:

1. Read the current state — a read-only API token (Zone:Read, Zone
   Settings:Read), or a paste of the Rules → Cache Rules and Security → WAF
   pages.
2. `terraform import` whatever exists, or confirm the rulesets are empty.
3. `terraform plan` and read every line.
4. Only then `apply`.

Deploying this to a different Cloudflare account: see [DEPLOY.md](../DEPLOY.md).

### Free-plan entitlements only fail at `apply`

`plan` is client-side, so it passes against limits the API will reject.
CLAUDE.md §4.3 lists the four that surfaced one at a time here — rate-limit
characteristics, mitigation timeout, `not in` syntax, and `Matches` being
Business-plan-only. Budget for that when adding rules.

## Provider version

Written for the **v5** Cloudflare provider, whose resource syntax differs from
v4 (rules are list-of-object attributes, not nested blocks). If `plan` reports
syntax errors, check the installed provider version first — that is the usual
cause.

## What is proposed, and why

### Cache (`cache.tf`)

**Rewritten 2026-08-24 after probing the live zone.** The first draft keyed the
cache on path + `target`. That is an **Enterprise-only** feature — Free, Pro and
Business get only an all-or-nothing "ignore query string" toggle — so the draft
could never have been applied. Full evidence in CLAUDE.md §3.16.

Four rules, out of the 10 Free allows:

| # | Rule | Why |
|---|---|---|
| 1 | Cache `/image/upload/`, `/file/upload/`, `/chat/file/`, query string ignored | Verified none of these handlers read a query param. Also forces caching of `.jfif`, which Cloudflare's default extension list misses — those hit EC2 on every request today |
| 2 | Cache `/video/upload/`, `/media/upload/`, query string kept | `?target=story\|snapshot\|preview` selects the variant. Ignoring it would serve the wrong bytes |
| 3 | Bypass cache for social-crawler UAs — **disabled by default** | Optional. The origin picks JPEG vs WebP off the User-Agent without varying on it, so an `f_auto` entry serves one format to all. Does **not** affect link previews — og:image already pins `f_jpg`. Enable only if the payload cost is worth a rule |
| 4 | Never cache `/upload` or `/gated` | Write paths |

Rule 1 is the one that pays: it closes the query-string cache-bust on the
highest-volume paths and forces `.jfif` to cache at all. Rule 3 was written up
as urgent in an earlier revision on the belief that it fixed broken social link
previews — **that was wrong.** trydos already pins `f_jpg` in og:image URLs
(`utils/server/helpers.ts:69-77`), so previews were never affected. It ships
disabled. See CLAUDE.md §3.16.

Edge TTL respects the origin, which now sends
`max-age=31536000, s-maxage=31536000, immutable` (not the 14400 recorded
earlier).

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
