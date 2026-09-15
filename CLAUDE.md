# cf-worker

Cloudflare edge layer for two existing apps: **trydos** (Next.js storefront on Vercel)
and **MediaServing** (Fastify media processing/delivery on EC2).

Nothing here is live yet. This repo is the edge layer only — it does not contain
either app.

---

## 0. The rule that outranks everything else in this file

**Source of truth is the code in the two sibling repos, never their docs, and
never this file.**

| Repo | Path from here |
|---|---|
| trydos | `../trydos` |
| MediaServing | `../../MediaServing` |

Both repos carry a lot of Markdown (`FETCH-ARCHITECTURE.md`, `REFRESH-FLOWS.md`,
`CLOUDFRONT_CDN_ROLLOUT.md`, `plan.md`, `undestood-plan.md`, …). Those docs are
**hints about where to look, not statements of fact.** Several are already stale
relative to the code.

Before you assert that either app behaves a certain way:

1. Open the actual source file and read it.
2. Cite it as `path:line` in whatever you write.
3. If you could not verify it in code, say so explicitly — write it under
   §5 Open questions instead of stating it as fact.

Every claim in §3 below carries a `path:line`. Keep it that way. If you add a
claim without one, you are guessing, and a guess in this file becomes a
production edge rule three steps later.

**Do not modify `../trydos` or `../../MediaServing`.** This repo is the focus
until explicitly told otherwise. When work here implies a change over there,
write it down as a required change; do not make it.

---

## 1. Why this exists

Two goals, in this order:

1. **Cost + scale.** Target is ~1M visitors in production. The April invoice
   (`../trydos/vercel-invoice.txt`) shows $60.86 usage, of which $54.56 is
   Fast Origin Transfer ($25.43) + Fluid Provisioned Memory ($17.61) + Fluid
   Active CPU ($11.52). All three scale with traffic. Cloudflare's free egress
   plus cached HTML is the lever.
2. **Security.** One place to put WAF rules, rate limits and bot rules in front
   of both origins — as an outer layer, never as a replacement for the
   app-level checks that already exist.

Middleware CPU on Vercel bills $0.13. Moving the middleware is **not** about
that $0.13; it is about the fact that while the locale/redirect decision lives
at the origin, Cloudflare cannot cache HTML at all.

---

## 2. Agreed scope and order

1. **Media delivery to Cloudflare** — highest value, lowest risk.
2. **Middleware + HTML caching together** — neither half pays without the other.
3. **`/api/proxy` as a Worker** — easy and cheap, but shaves invocations, not
   origin transfer.

Not in scope until the above land: touching either app's source, moving uploads,
moving the auth/refresh routes.

---

## 3. Verified facts (read from code)

### 3.1 trydos — `/api/proxy`

- Route is **POST-only**, one handler: `../trydos/app/api/proxy/route.ts:66`.
- Client call site is `../trydos/utils/fetchData.ts:549` — always
  `POST /api/proxy`, `credentials: "include"`, with request metadata in headers
  (`fetchData.ts:525-530`): `x-proxy-server` (an **opaque service token**, not a
  service name), `x-proxy-url`, `x-proxy-method`, `x-country`, `x-language`,
  optional `x-seller-id`, and `x-need-decode: "true"` (hardcoded).
- Security guards in the route, all of which must survive any port:
  - `fullyDecode()` — bounded repeat-decode loop (`route.ts:37`).
  - `escapesHost()` — rejects targets not starting with a single `/`
    (`route.ts:61`).
  - Resolved URL must stay on the base origin **and** under the base path
    prefix (`route.ts:145-152`).
  - `SEND_OTP` is blocked outright, checked against raw, decoded, and resolved
    forms (`route.ts:168-177`).
  - Upstream fetch uses `credentials: "omit"` — cookies are never forwarded
    (`route.ts:227`).
- Failure is deliberately uniform: `proxyFailure()` returns 503 for both an
  unknown service and a failed upstream, so service names cannot be probed
  (`route.ts:24`).

### 3.2 trydos — token handling is portable

- `../trydos/utils/server/tokenManager.ts` is 436 lines and imports **no JWT
  library** — no `jsonwebtoken`, no verify, no decode. Its only parsing is
  `decodeURIComponent` + `JSON.parse` on a cookie (`tokenManager.ts:274`).
- Its only Next-specific dependency is `cookies` from `next/headers`
  (`tokenManager.ts:1`).
- **Consequence:** porting to a Worker means replacing `cookies()` with parsing
  the `Cookie` header. There is no Node-only crypto dependency to work around.

### 3.3 trydos — the proxy does not refresh

- Per `../trydos/REFRESH-FLOWS.md` the 401→refresh path is client-driven: the
  client receives the 401 and then calls `/api/auth/refresh` itself.
  `route.ts` contains no refresh call — confirmed by reading the handler.
- **Consequence:** moving `/api/proxy` does not drag refresh, single-flighting,
  or the logout guard onto Cloudflare. Those routes stay on Vercel.
- ⚠️ Doc-derived, only partly code-verified. Re-read
  `../trydos/app/api/auth/refresh/route.ts` and
  `../trydos/utils/server/authRefresh.ts` before building on this.

### 3.4 trydos — auth cookies are host-only

- No `domain` attribute is set on auth cookies anywhere in the cookie setters
  (grepped `utils/cookie-manager*`, `utils/server/*.ts`,
  `app/api/auth/login/route.ts` — no match).
- `COOKIE_OPTIONS` in `../trydos/proxy.ts:43` likewise sets no `domain`.
- **Consequence:** a Worker on a *different subdomain* would never receive
  `MARKET-TOKEN`. The proxy Worker must run on the **same hostname** via a route
  pattern. Adding a `Domain` attribute to widen cookie scope is a security
  downgrade and is not an acceptable workaround.

### 3.5 trydos — middleware

- `../trydos/proxy.ts`, ~700 lines. Locale/country/language resolution, geo-IP,
  bot detection, cookie writes, logout guard, redirect-loop guards, staging gate.
- No network calls: the country list is hardcoded (`proxy.ts:88`,
  `getCachedCountries`). Pure string/cookie work.
- Deliberately avoids importing `cookie-manager` so it never pulls in the
  Node-only `jsonwebtoken` (`proxy.ts:38-40`).
- Matcher (`proxy.ts:674`) excludes `/api`, static folders, sitemaps, and — via
  its `missing:` clause — prefetches, server actions and router-state-tree
  requests. **Cloudflare has no equivalent of `missing:`;** it has to be
  rebuilt as a cache-rule expression.
- `STAGING_GATE` flag (`proxy.ts:27`) and its matcher are coupled only by a
  comment. Nothing enforces they agree.

### 3.6 MediaServing — actual route table

Read from `src/api/*.js`; all registered without a prefix
(`../../MediaServing/src/app.js:264-273`).

| Method | Path | File |
|---|---|---|
| GET | `/:resourceType/upload/*` | `transform.js:912` |
| GET | `/file/upload/*` | `files.js:257` |
| GET | `/chat/file/*` | `chat.js:221` |
| GET | `/health` | `app.js:254` |
| POST | `/upload` | `upload.js:177` |
| POST | `/upload/bulk` | `upload.js:307` |
| POST | `/upload/excel` | `files.js:149` |
| POST | `/gated/ticket` | `ticket.js:63` |
| POST | `/gated/upload` | `gatedUpload.js:125` |
| POST | `/gated/upload/bulk` | `gatedUpload.js:227` |
| POST | `/gated/upload/excel` | `gatedUpload.js:311` |
| POST | `/gated/chat/upload_file` | `chat.js:131` |

Cache-eligible at the edge: the four GETs. Everything else is a write path and
must not be proxied through Cloudflare (see §4.2).

### 3.7 MediaServing — auth and its known hole

- `../../MediaServing/src/middleware/auth.js` — static `x-api-key`, with gated
  paths and `/chat/file/` checked against the **parsed pathname** first.
- The legacy allowlist below them tests `request.url` **including the query
  string**, so `POST /upload?x=/image/upload/` skips the key check entirely.
  This is documented in the file as an accepted migration-window risk, not an
  oversight — `auth.js:41-47`.
- **Consequence:** an edge rule may mask this as a stopgap. It is not the fix,
  and this repo must not pretend it is.

### 3.8 MediaServing — sizes that collide with Cloudflare

From `../../MediaServing/.env.production` and the code:

- `UPLOAD_EXCEL_MAX_FILE_SIZE_MB=512` (`files.js:82`) — over every Cloudflare
  plan below Enterprise.
- Default multipart ceiling 120 MB (`app.js:185`) — over Free/Pro's 100 MB.
- `UPLOAD_BULK_MAX_FILES=50` (`upload.js:172`), image/video 10 MB each
  (`upload.js:26-27`) — an aggregate bulk POST can far exceed 100 MB.
- App-level rate limits are Redis-backed and per-identity
  (`app.js:158-163`), e.g. `TRANSFORM_RATE_LIMIT_MAX=20000/min`. These stay
  authoritative; edge limits are the crude outer layer only.

### 3.9 Hostnames

- Media origin: `media_server.ramaaz.dev` (`MEDIA_PUBLIC_BASE_URL`,
  `PUBLIC_BASE_URL`), consumed by trydos as `NEXT_PUBLIC_BASE_MEDIA_URL` /
  `NEXT_PUBLIC_BASE_VIDEO_MEDIA_URL`.
- Backends are various `*.ramaaz.dev` hosts. **Do not copy their values into
  this repo** — read them from `../trydos/.env.*` when needed. Env var *names*
  are fine to reference here; values are not.
- ⚠️ `../trydos/.env.production` points at `*_develop` hosts and
  `NEXT_PUBLIC_APP_URL=https://dev.trydos.com`. Despite the filename this does
  **not** look like real production. Confirm the true production hostnames with
  the user before configuring any DNS.

### 3.10 Live infrastructure (probed 2026-08-24, and user-supplied DNS)

Cloudflare zone `ramaaz.dev`, both records **Proxied**, both to the same origin:

| Record | Type | Target |
|---|---|---|
| `media.ramaaz.dev` | A | `13.233.124.226` |
| `media_server.ramaaz.dev` | A | `13.233.124.226` |

- **`media.ramaaz.dev` already exists and works** — clean alias, no underscore,
  verified `200` through Cloudflare. Prefer it for all new work; treat
  `media_server.ramaaz.dev` as legacy to be retired once the apps stop
  referencing it (`NEXT_PUBLIC_BASE_MEDIA_URL`,
  `NEXT_PUBLIC_BASE_VIDEO_MEDIA_URL`, `NEXT_PUBLIC_MEDIA_SERVER_BASE_URL`,
  `PUBLIC_BASE_URL`, `MEDIA_PUBLIC_BASE_URL`).
- Origin `13.233.124.226` is AWS ap-south-1 and matches `GRAFANA_URL` in
  `../../MediaServing/.env.production`.

Origin exposure, probed directly against the IP:

| Port | Result |
|---|---|
| 80 / 443 | **Publicly reachable.** `Server: Apache/2.4.67 (Debian)`, 404 for unmatched vhost |
| 3000 (app `PORT`) | Connection times out — firewalled ✅ |
| 3001 (Grafana) | **Publicly reachable**, `302 → /login` ⚠️ |

**Cloudflare is NOT trivially bypassable — resolved 2026-08-24.**

`curl --resolve` is silently ignored when egress goes through an HTTP `CONNECT`
proxy, which is why the first attempts kept returning `cf-ray` and looked like a
bypass. `curl --connect-to` overrides the `CONNECT` target and gives a real
answer:

```
curl -sSkI --connect-to media.ramaaz.dev:443:13.233.124.226:443 \
     https://media.ramaaz.dev/health
→ HTTP/2 404, server: Apache/2.4.67 (Debian)     # not the app
```

Correct SNI, correct `Host`, straight to the origin IP — Apache answers **404**,
not the media app's 200. Port 80 behaves the same. Yet Cloudflare gets a 200
from this same origin, so the vhost does exist and is **discriminating by client
IP**. The most likely mechanism is an Apache `Require ip` / `mod_remoteip` ACL
restricted to Cloudflare ranges.

Two caveats before treating this as settled:

1. **The mechanism is inferred, not read.** Confirm it in the Apache vhost
   config. If the media vhost is protected by an explicit CF-range ACL, good.
   If it merely lacks a default-server binding, then adding any vhost later
   silently opens the bypass.
2. Without verification (`-k` removed) the TLS handshake fails, so the origin
   presents a cert not publicly trusted — consistent with a Cloudflare Origin CA
   certificate and Full (strict). Worth confirming the SSL/TLS mode is Full
   (strict) and not Flexible.

Authenticated Origin Pulls is still worth enabling: it replaces an IP-range ACL
(which changes as Cloudflare adds ranges) with a client certificate.

⚠️ Grafana on `:3001` is a **separate, genuinely exposed service** — it does not
sit behind Apache or Cloudflare. It should move behind Cloudflare Access or the
security group.

### 🔴 `/metrics` is public — verified 2026-08-24

`https://media.ramaaz.dev/metrics` returns the full Prometheus scrape to anyone,
no API key:

```
curl https://media.ramaaz.dev/metrics
→ 200, content-type: text/plain; version=0.0.4
  process_cpu_user_seconds_total 1945.4467500000064 ...
```

Cause is the legacy allowlist in `../../MediaServing/src/middleware/auth.js:49`,
which returns early for `request.url === "/metrics"` before the API-key check.
`/health` is allowlisted the same way, which is far less sensitive.

**Status: REVERSED 2026-08-24 — the user asked for it to be closed.** It was
deferred earlier that same day; that decision no longer stands for `/metrics`.
The exposed Grafana on `:3001` IS still deferred and no rule here covers it.

Closing it at the **edge**, not in the app, and the reason matters:

- `/metrics` is served by the same Fastify app on the same port
  (`src/middleware/metrics.js:153`, registered `src/app.js:241`).
- Prometheus scrapes `host.docker.internal:4001`
  (`observability/prometheus/targets/media-serving.json`), and
  `docker-compose.prod.yml:73` maps `"4001:3000"` — so the scrape goes through
  **the same `authHook`**. Removing `/metrics` from the allowlist would 401 the
  scrape and break the dashboards, unless the Prometheus config also learns the
  API key. That config is not in this repo.
- Port 4001 is **not** publicly reachable — probed 2026-08-24, times out from
  the internet, same as 3000. ⚠️ `docker-compose.prod.yml:71` carries an
  "ADMIN: ensure port 4001 is open in the firewall" note that was never
  actioned. Good. If anyone ever actions it, this WAF rule stops working and
  the origin is directly exposed.

So Cloudflare is the only public path to `/metrics`, and a WAF block closes it
without Prometheus noticing.

**The app-level fix must NOT use the API key — user decision, 2026-08-24.**
Requiring `x-api-key` on `/metrics` was proposed and rejected. Do not propose
it again. A scrape credential that is the same static key the upload routes
use is a bad trade: it spreads the key to the monitoring stack, and it still
leaves `/metrics` on the public app's port.

**The correct fix is a separate internal listener, and MediaServing already
has the pattern.** `src/worker.js:131-151` runs the worker's metrics on its own
`http.createServer` bound to `WORKER_METRICS_PORT` (9091) — outside Fastify,
so `authHook` never applies and no key is involved. The main app should do the
same:

1. Move the app's `/metrics` off Fastify onto its own listener, e.g.
   `APP_METRICS_PORT=9090`. It already aggregates the worker's metrics
   (`src/middleware/metrics.js:150-158`), so the aggregation moves with it.
2. Delete the `/metrics` route from Fastify and drop `/metrics` from the
   allowlist in `src/middleware/auth.js:49`. `/health` stays.
3. Bind it to loopback in compose — `"127.0.0.1:9090:9090"`, not `"9090:9090"`
   — so it is unreachable from outside the host even if a security-group rule
   changes later. This is the part that makes it durable rather than another
   ACL to maintain.
4. Repoint the Prometheus target from `host.docker.internal:4001` to
   `host.docker.internal:9090` in
   `observability/prometheus/targets/media-serving.json`.

After that the WAF rule becomes belt-and-braces rather than the only defence,
and it can stay.

⚠️ Not applied. This is a MediaServing change and §0 forbids editing that repo
without instruction; it also needs a deploy and a Prometheus config change to
land together.

This leaks request rates, route labels, error counts and process internals —
useful for sizing an attack and for inferring business volume. Two fixes, and
both are worth doing:

1. **Edge, now:** a WAF rule blocking `/metrics` (see `infra/waf.tf`). One rule
   of the five available on Free.
2. **App, properly:** require the API key for `/metrics`, or bind the metrics
   listener to a private interface. Prometheus scrapes it from inside the
   network, so this should not need public exposure at all — confirm how
   `observability/prometheus/targets` reaches it before changing.

### 3.12 ✅ `trydos.ramaaz.dev` is live behind Cloudflare (2026-08-24)

Rollout completed in this order, which is the order it has to happen in:

1. Configuration Rule — `http.host eq "trydos.ramaaz.dev"` → SSL/TLS mode
   **Strict**. Deployed past the dashboard's "this rule may not apply" warning,
   which is expected while the record is still grey.
2. trydos redeployed with the §5a geo fix.
3. DNS record flipped to **Proxied**.

Verified:

| Check | Result |
|---|---|
| `GET /` | `307 → /gb-en?no-country=true`, `server: cloudflare`, `cf-ray` present |
| `GET /gb-en` | `200` through Cloudflare — no redirect loop, so Strict is working |
| `media.ramaaz.dev/health` | `200`, unaffected by the scoped rule |
| `trydosv2.ramaaz.dev` | still answering — the other ~60 Flexible origins are untouched |

**⚠️ The geo fix is NOT verified. An earlier claim here that it was is
retracted.**

The reasoning was: the response sets `userIP=65.0.21.24`, the real client
address rather than a Cloudflare edge IP, therefore the `cf-connecting-ip`
branch must be live. **That does not follow.** `ipAddress()` from
`@vercel/functions` reads `x-forwarded-for`, and Cloudflare populates that
header with the real client IP anyway. The observation is consistent with the
fix being deployed *and* with it not being deployed, so it distinguishes
nothing.

Neither half is confirmed:

- `getClientIp` — unverifiable this way, per above.
- `getGeoCountry` — the probe originates in India, which is not a supported
  country, so `no-country=true` is the correct answer either way.

**How to actually verify:** load the site from a supported country
(sy/lb/tr/iq) and check the `location` header names that country rather than
`gb-en?no-country=true`. That is the only test that separates the two cases.

Open question this leaves: whether Vercel derives `x-vercel-ip-country` from
the TCP peer (Cloudflare's edge — the failure this fix anticipates) or from
`x-forwarded-for` (in which case geo may never have broken). Not established
either way. Do not assume the fix was necessary, and do not assume it was not.

The fix is committed on `main` as `e0472577`.

Still true after the flip, and expected: `cf-cache-status: DYNAMIC`, HTML still
`no-store` and still setting four cookies per response. Proxying changed
nothing about caching — that remains the §5 trydos-side work.

### 3.15 🐛 Fixed: double-encoded `User-Data` demoted verified users to guests

**Symptom:** a logged-in, phone-verified shopper got `x-market-backend: gateway`
on allow-listed paths, where the original Next route gave `core`. Reported from
the browser, reproduced exactly.

**Cause.** `User-Data` arrives **double-encoded** on the wire — the real value
starts `%257B%2522id%2522…`, i.e. `%25` → `%`, so `%257B` → `%7B` → `{`.
`setSecureCookieJSON` (`tokenManager.ts:254`) does
`encodeURIComponent(JSON.stringify(v))` and hands that to Next's cookie
serializer, which encodes again. Coming back, Next's reader decodes once and
`getSecureCookie` decodes a second time, so Next tolerates it. The Worker's
`readJsonCookie` decoded **once**, `JSON.parse` threw, the raw string was
returned, `hasValidPhone` found no `phone`, and the shopper was silently
treated as a guest.

Silent is the operative word: no error, no log, just the wrong backend.

**Proof, against production:**

| `User-Data` encoding | Worker (before fix) | Next |
|---|---|---|
| single | core | core |
| double — *what production actually sends* | **gateway** ❌ | core |

**Fix.** `readJsonCookie` now decodes until the value parses, bounded at five
passes, and **parses before decoding again** so a value whose JSON legitimately
contains percent sequences is never over-decoded. Verified after deploy: the
real cookie gives `core` on `/cart/add`, `/customer/info` and
`/web/home/startingSettings`, matching Next on all three.

Regression tests in `cookies.test.ts` cover double-encoded, single-encoded,
unencoded, and the over-decoding guard.

**Lesson for the rest of this port.** Synthetic fixtures agreed with the
original on all 8 routing combinations and still missed this, because the
fixture was single-encoded and production is not. Where a value's encoding is
decided by framework code rather than by us, test with a **captured production
value**, not a constructed one.

### 3.14 ✅ CUT OVER — the Worker serves `/api/proxy` (2026-08-24)

Version `b0da6da2-966c-4630-868c-a2cbe1ba02e0`, routes
`trydos.ramaaz.dev/api/proxy` and `/api/proxy-edge`.

**How to tell which implementation answered:** the Next route emits
`x-vercel-id`; the Worker does not. Before cutover `/api/proxy` carried
`x-vercel-id: bom1::iad1::…`; after, it is absent. That is the check to run if
anyone ever wonders whether a rollback took effect.

Verified after cutover: `/api/proxy` returns 200 with
`x-market-backend: gateway` and no `x-vercel-id`; the SSRF and OTP guards hold
on the real path; `/` still 307s and `/gb-en` still 200s; `/api/auth/me` still
carries `x-vercel-id`, confirming the other internal routes are untouched and
only this one path is intercepted.

**ROLLBACK** — delete the `/api/proxy` route in the Cloudflare dashboard
(Workers & Pages → `trydos-proxy` → Settings → Domains & Routes). Traffic falls
straight back to the Next route. No trydos deploy needed, effective in seconds.

⚠️ **Seller-dashboard multipart was never exercised before cutover** (§3.13
item 3). The Worker streams that body where the Next route buffered it via
`formData()`. If product image uploads misbehave, suspect this first and roll
back.

### 3.13 Proxy worker deployed to the shadow route (2026-08-24)

`trydos-proxy` live on **`trydos.ramaaz.dev/api/proxy-edge`**. 11.26 KiB upload,
3.53 KiB gzip, 4 ms startup. Version `779485c9-39b9-41aa-a73f-38e8e1db3f97`.
All seven backend URLs set as secrets from `trydos/.env.production`.

`/api/proxy` is untouched and still serving all real traffic.

**Guards verified against the live deployment**, no session needed:

| Case | Result |
|---|---|
| `GET` instead of `POST` | 405 |
| Unknown service token | 503, generic failure body |
| Empty target url | 400 |
| `@evil.tld/x`, `//evil.tld/x`, `/../../internal/admin`, `/%2F%2F…`, `/%252F%252F…`, `orders/list` | 400 each |
| `send_otp`, `send%5Fotp`, `send%255Fotp` | 403 each |

**Shadow comparison against `/api/proxy`** — identical on every branch tested:

| Request | Edge | Live |
|---|---|---|
| market `/web/home/startingSettings` | 200, gateway | 200, gateway |
| market `/orders/list` | 404, core | 404, core |
| market `/cart/cart_overview` | 401, gateway | 401, gateway |
| elastic, wallet | 404 | 404 |

The `startingSettings` payloads are **semantically identical** (parsed and
compared leaf by leaf). They differ by one byte on the wire because the Next
route re-serialises JSON via `NextResponse.json` while the Worker streams the
upstream bytes unchanged — expected, and the cheaper behaviour.

**Not yet covered, and needed before cutover:**

1. An authenticated flow with a real `MARKET-TOKEN` — bearer injection is only
   proven by unit and workerd tests, never against a live backend.
2. The verified-user branch (`User-Data` with a valid phone → core even on an
   allow-listed path).
3. Seller-dashboard multipart, the one `FormData` path through the proxy
   (§5.3). The Worker streams it rather than buffering via `formData()`.
4. The Firebase `auth_token` body injection — the single non-streaming case.

### 3.18 🔴 Media CANNOT move to Full (strict) — the origin has no cert for it

Probed 2026-08-24, `openssl s_client -connect 13.233.124.226:443 -servername
media.ramaaz.dev`:

```
issuer  = C = US, O = Let's Encrypt, CN = R3
subject = CN = t-bot.trydos.tech
notAfter= Apr 21 20:28:03 2024 GMT        <-- expired over two years ago
SAN     = DNS:t-bot.trydos.tech            <-- no media.ramaaz.dev
```

Cert selection happens at the TLS handshake from SNI, **before** any HTTP-level
IP ACL, so this is what Cloudflare would see too — it is not an artefact of
probing from a non-Cloudflare address. Apache fell back to a default vhost for
an unrelated site, which means **there is no HTTPS vhost for
`media.ramaaz.dev` on the origin at all.**

Consequences:

- **Full (strict) fails** — wrong CN, no matching SAN, and expired. Cloudflare
  would return 526 and media would be down.
- **Full (non-strict) is also unsafe here** — it would accept the bad cert, but
  the presented cert proves port 443 is not serving the media app, so requests
  would likely 404.
- **Flexible is currently the only mode that works.** That is why media works
  today.

So §5's "add a Configuration Rule for media like the one for trydos" is
**blocked on a server-side change**, not a Cloudflare change. Required order:

1. Issue a **Cloudflare Origin CA** certificate for `media.ramaaz.dev` (and
   `media_server.ramaaz.dev` while it still exists).
2. Add an Apache HTTPS vhost for those names using it.
3. Verify port 443 serves the media app, not the default vhost.
4. Only then add the Configuration Rule setting SSL to Full (strict).

**Priority is lower than it first looks.** Flexible means the Cloudflare→origin
leg is cleartext, but for media that payload is *public product images*. This
is not the §3.11 concern, where proxied backends carry
`Authorization: Bearer <jwt>` over the same cleartext leg. Fix those first if
anything.

⚠️ Also worth noting for whoever owns the box: the origin's default 443 vhost
is serving a **two-year-expired** certificate for `t-bot.trydos.tech`. That is
unrelated to this project but suggests other sites on that host may be broken.

### 3.17 ✅ APPLIED — media cache, WAF and rate limit are LIVE (2026-08-24)

Applied with Terraform 1.15.9, provider cloudflare/cloudflare v5.23.0. Plan was
`3 to add, 0 to change, 0 to destroy` — nothing pre-existing was touched, which
matches §3.11's finding that the zone had no custom rulesets.

| Ruleset | Phase | Id |
|---|---|---|
| `media delivery cache` | `http_request_cache_settings` | `319e5667ae4040b8bba21ebb8f6b9e9d` |
| `media protection` | `http_request_firewall_custom` | `eca8b23256f740948fc4b624fd5b2490` |
| `media upload rate limit` | `http_ratelimit` | `ef020c4c6487456183bf8c9a64aea48e` |

**Verified against production after apply:**

| Check | Before | After |
|---|---|---|
| `/metrics`, both hostnames | 200 + full scrape | **403** ✅ |
| `/health` | 200 | 200 — unaffected ✅ |
| `.jfif` product image | `DYNAMIC`, never cached | `HIT` ✅ |
| `?cb=902` on a URL warmed as `?cb=901` | MISS (own entry) | **HIT** — query string excluded from the key ✅ |
| `?target=` on `/video/upload/` | 4 distinct variants | 4 distinct variants — `no target` 346145 B mp4, `snapshot` 10464 B webp, `preview` 109711 B mp4, `webp` 8818 B webp ✅ |
| `POST /image/upload/...` | reached origin | **403** ✅ |
| `POST /upload?x=/image/upload/` | bypassed the API key | **403** ✅ |
| `POST /upload`, `POST /gated/ticket` | 401 from origin | 401 from origin — **not** over-blocked ✅ |

The `?target=` row is the important one. It is the check that rule 2 did not
collapse the video variants onto one cache entry; if it had, all four would
return identical bytes.

⚠️ **Measuring cache status needs repetition.** A colo holds many edge servers,
each with its own cache, so single probes return MISS unpredictably even when
caching works. `?cb=901` took 5 requests before it stuck. Judge by whether HIT
appears at all across ~8 requests, never by one response.

**ROLLBACK:** `terraform destroy -target=cloudflare_ruleset.<name>` in `infra/`,
or delete the ruleset in the dashboard. To reopen `/metrics` specifically:
`git revert e3821b9 && terraform apply`.

### 3.16 Media caching — probed live 2026-08-24

Probes used real `GET`s. **`curl -I` is useless here** — Cloudflare does not
serve HEAD from cache, so every HEAD reports `MISS` and the first round of
probing looked like nothing was cached at all.

**Baseline is healthier than §3.10 recorded.** `/image/upload/...` returns
`cf-cache-status: HIT` with `age:` climbing, on both media hostnames. The two
hostnames hold separate cache entries, as expected — host is part of the
default key.

⚠️ **§3.10's `max-age=14400` is stale.** The origin now sends
`cache-control: public, max-age=31536000, s-maxage=31536000, immutable`. A
poisoned or wrong entry therefore persists for a year, which raises the cost of
every bug below.

The storefront still emits **`media_server.ramaaz.dev`**, not `media.` — so any
rule must cover both hostnames until the five env vars move (§5a).

#### ⚠️ Crawler/browser format divergence — real, but NOT the link-preview bug

**A first version of this section claimed this "silently breaks Facebook/
WhatsApp link previews for every product". That was wrong and is retracted.**
The claim was made before reading `utils/server/helpers.ts`. og:image URLs are
already safe; see below.

The mechanism is real and reproducible. `transform.js:406` picks the image
format from the User-Agent — `isSocialCrawler()` at `transform.js:75-80` sends
JPEG to Facebook, WhatsApp, Telegram et al., WebP to everyone else. The
response carries only `vary: Origin`, and Cloudflare does not vary on
User-Agent, so on an `f_auto` URL **whichever request warms the entry decides
the format for everybody.** Reproduced against production, both directions,
same URL each time:

| Warmed by | Then requested by | Result |
|---|---|---|
| browser | `facebookexternalhit/1.1` | `image/webp`, **HIT** |
| `WhatsApp/2.23` | browser | `image/jpeg`, **HIT** |

**Why link previews are nevertheless fine.** Social crawlers fetch the og:image
URL, and every og:image URL is built by `buildOgImageUrl`
(`utils/server/helpers.ts:69-77`), which already rewrites the transform segment
to `w_1200,h_630,c_pad/f_jpg/q_90`. An explicit `f_jpg` means the format is
explicitly requested, so `transform.js:406`'s crawler-safe default never runs
and the User-Agent is irrelevant. Verified live — that URL returns
`image/jpeg` for Chrome, `facebookexternalhit` and `WhatsApp` alike.

All three og:image sites are covered:

- `serverRequests/product.tsx:325` — `buildOgImageUrl(GetImageUrl(...))`
- `serverRequests/meta/listing.tsx:270` — same helper
- `serverRequests/meta/home.ts:41` — a static `/opengraph-image.png` on the
  trydos origin, not a media URL at all

**What is actually left.** Only `f_auto` URLs diverge, and only crawlers that
scrape in-page images rather than og:image (Pinterest,
Google-InspectionTool) can warm one. The realistic consequence is a browser
being served JPEG where it could have had WebP — roughly 25-35% more bytes,
renders correctly. That is a payload regression, **not** a correctness bug, and
it does not justify treating rule 3 as urgent.

#### 🔴 `.jfif` product images are never edge-cached

`.jfif` is not in Cloudflare's default cacheable-extension list, so those URLs
return `cf-cache-status: DYNAMIC` and hit EC2 on **every** request. Real
product images use the extension (`product/1784451828831147.jfif`, live on the
storefront). An explicit `cache = true` cache rule overrides the extension list
and fixes it — this is probably the largest single origin-traffic win available.

#### 🔴 Custom cache keys are ENTERPRISE-ONLY — the old `cache.tf` was unbuildable

Cloudflare's cache-key availability table reads `Query string | No | No | No |
Yes`. Free, Pro *and* Business get only:

| Cache Key option | Free |
|---|---|
| Ignore query string (all or nothing) | ✅ |
| Sort query string | ✅ |
| Cache deception armor | ✅ |
| Cache by device type | ✅ |
| "No query parameters except `target`" | ❌ **Enterprise** |

The original `cache.tf` was built entirely on `query_string.include =
["target"]`. It could never have been applied. Rewritten to split the read
paths by whether the origin reads a query parameter at all:

- **Query string ignored** — `/image/upload/`, `/file/upload/`, `/chat/file/`.
  Verified no handler reads a query param: `target` is read only in the video
  branch (`transform.js:528`), which `resourceType: "image"` never reaches
  (`transform.js:351,372`); `chat.js` has zero `.query` reads; the only
  `.query` in `files.js` is `folder` at `:155`, inside the POST
  `/upload/excel` handler, not the GET at `:257`.
- **Query string preserved** — `/video/upload/`, `/media/upload/`. trydos
  really does use `?target=`: `StoryViewer.tsx:377` (`story`),
  `services/story.ts:291` (`snapshot`), `utils/server/helpers.ts:210`
  (`preview`). Ignoring it would serve a snapshot where a preview was asked
  for. `media` is included because `transform.js:347` resolves it to video.

#### Query-param cache busting is real, but milder than the old file claimed

`?cb=1`, `?cb=2`, `?cb=3` each produce an edge `MISS` today. But the origin
answers them `x-cache: HIT` from **its own** cache, so **no fresh Sharp/ffmpeg
run happens**. The cost is EC2 egress and request handling, not origin CPU. The
old `cache.tf` comment asserting "three Sharp/ffmpeg invocations" was wrong.

Closed on the image/file/chat paths by the ignore-query-string rule above.
**Accepted on the video paths** — it cannot be closed there without an
Enterprise cache key.

### 3.19 ✅ CUT OVER — the Worker serves `/ingest/*` (PostHog) (2026-08-25)

`trydos-ingest`, version `8d7eb772-9698-4eed-b617-af5a40f2ccbc`, routes
`trydos.ramaaz.dev/ingest/*` and `/ingest-edge/*`. 4.10 KiB upload, 1.73 KiB
gzip, 4 ms startup. A **separate Worker** from `trydos-proxy` per §6 — this is
the highest-volume path in the app and must not share an isolate, or a failure
domain, with the code that handles `MARKET-TOKEN`.

Ported from `../trydos/app/ingest/[...path]/route.ts` (an edge route handler,
**not** a `next.config` rewrite). Rules live in
`packages/shared/src/ingest.ts`; the handler is `workers/ingest/src/index.ts`.

**Why it was worth moving.** Every captured event, autocapture hit and
feature-flag call was one Vercel edge invocation plus transfer both ways — the
§1 cost lines. `../trydos/utils/posthog.ts:67-72` records that session replay
was **switched off specifically to cut that bill**: "session replay funnels a
continuous stream of chunks through the /ingest edge proxy (one edge invocation
+ data transfer per chunk), which dominated the bill." That constraint is gone.

**What the proxy does, unchanged from the Next route:**

- `/static/*` → `eu-assets.i.posthog.com`, everything else →
  `eu.i.posthog.com` (`route.ts:51-54`). Whole-segment match, so `staticfoo`
  is correctly an ingestion path.
- Strips `cookie, host, connection, content-length, transfer-encoding,
  accept-encoding` on the way up (`route.ts:26-33`).
- Strips `content-encoding, content-length, transfer-encoding, connection,
  set-cookie` on the way back (`route.ts:39-45`).
- Upstream unreachable → 502, empty body, never a throw (`route.ts:72`).

**Two deliberate differences from the Next route:**

1. **`X-Forwarded-For` is set explicitly from `cf-connecting-ip`.** On Vercel
   the header happened to be populated and was copied along; nothing does that
   for us in a Worker, and the failure would be silent — PostHog would
   geolocate every event to whichever Cloudflare PoP served it. Same class of
   bug as the §5a geo fix.
2. **The body is streamed** rather than buffered via `arrayBuffer()`, and
   `/static/*` fetches carry `cf: { cacheEverything: true }` with no `cacheTtl`
   so PostHog's own `public, max-age=14400` governs.

**Verified against production, shadow route first then after cutover:**

| Check | Result |
|---|---|
| `/ingest/static/array.js` | 200, **264388 bytes byte-identical** to the Next route, `x-vercel-id` absent |
| `/ingest/static/recorder.js` | 200 |
| `POST /ingest/flags/?v=2` with the real project key | 200, same JSON shape as Next (only `requestId` / `evaluatedAt` differ — per-request nonces) |
| **16 KB cookie** | **200 through us, `400` direct to `eu.i.posthog.com`** — the discriminator that proves the cookie is actually stripped |
| 8.5 KB cookie | 200 everywhere *including direct* — see the caveat below |
| `PUT` | 405, `allow: GET, HEAD, POST, OPTIONS` |
| `OPTIONS` | 200, forwarded rather than answered locally |
| asset cache ×6 | `HIT HIT HIT HIT REVALIDATED HIT` |
| `POST /ingest/flags/` ×3 | `DYNAMIC DYNAMIC DYNAMIC` — events are never cached ✅ |
| `/api/proxy` | still the Worker (no `x-vercel-id`) ✅ |
| `/api/auth/me` | still Next (`x-vercel-id` present) ✅ |
| `/gb-en`, `/` | 200, 307 — storefront untouched ✅ |

⚠️ **The original 400 could not be reproduced at the size the Next route's
comment implies.** `route.ts:6-10` says a logged-in user's jar "easily exceeds
~8 KB" and PostHog answers 400. At 8.5 KB PostHog answered **200** on a direct
call today; the threshold measured on 2026-08-25 is between 8.5 KB and 16 KB.
The proxy is still right — and stripping our auth cookies before they reach a
third party is worth doing on its own — but do not cite ~8 KB as the limit.

⚠️ **`X-Forwarded-For` is covered by tests, NOT verified in production.**
Confirming it needs `$geoip_country_code` on a real event in the PostHog UI,
which is not reachable from here. Do not record it as verified until someone
looks. (§3.12 is the standing lesson on why that distinction matters.)

**Parity note:** a bare `/ingest` (no trailing path) is not matched by the
`/ingest/*` route pattern, so it falls through to Vercel and Next renders it as
a `[lang]` segment — `x-matched-path: /[lang]`, 200 HTML. **The live `/ingest`
did exactly the same before the cutover**, so this is parity, not a regression.

**Tests:** 18 unit tests in `packages/shared/src/ingest.test.ts`, 12 handler
tests in `workers/ingest/test/ingest.worker.test.ts` (workerd). Repo total is
now 101 unit + 30 proxy-worker + 12 ingest-worker.

One design note worth keeping: `proxyIngest()` takes the fetcher as a
parameter. That seam exists for exactly one test — miniflare's outbound service
turns a thrown error into a 500 **response**, not a rejected `fetch`, so the
"analytics must never throw into the app" contract cannot be exercised any
other way. Production always uses the global `fetch`.

**ROLLBACK** — delete the `/ingest/*` route in the Cloudflare dashboard
(Workers & Pages → `trydos-ingest` → Settings → Domains & Routes), or remove it
from `workers/ingest/wrangler.jsonc` and redeploy. Traffic falls straight back
to the Next route, which is still deployed. No trydos deploy needed, effective
in seconds.

⚠️ **No rate limit covers `/ingest/*`.** It is an unauthenticated relay to
PostHog — anyone can POST arbitrary events into the project. That was equally
true of the Next route, so this is not a regression, but it is now cheap to
abuse. Free has exactly one rate-limiting rule and `media upload rate limit`
spent it (§3.17). Fixing it means Pro, or giving up the media limit.

### 3.20 ✅ The proxy Worker answers GET too (2026-09-01)

Version `f93e4001-f72e-4d22-97b8-d1433865b837`. `/api/proxy` now serves two
wire contracts, mirroring `../trydos/app/api/proxy/route.ts`:

| Contract | Metadata | Body |
|---|---|---|
| POST | `x-proxy-*` headers | forwarded, streamed |
| GET | query string `?s=&u=&c=&l=&d=&sid=` | none, `allowBody: false` |

The GET form exists so a `<link rel="preload">` can start a backend call while
the browser is still parsing the HTML. A preload issues a plain GET and can
carry no custom header, so the header contract is unreachable from one.

**🔴 A Cloudflare route pattern does NOT match a URL that has a query string.**

This is the finding worth keeping. The route was `trydos.ramaaz.dev/api/proxy`,
exact, with no wildcard. Measured 2026-09-01:

| Request | Answered by |
|---|---|
| `POST /api/proxy` | Worker |
| `GET /api/proxy` (no query) | Worker |
| `GET /api/proxy?s=…&u=…` | **Vercel** — `x-vercel-id` present |

So the entire GET contract was dead on arrival: every parameter it needs lives
in the query string, which is exactly what stopped the route matching. The fix
is the trailing `*` — `trydos.ramaaz.dev/api/proxy*`. Nothing else is swallowed,
because `app/api/proxy` is the only `/api/proxy*` route in trydos. One visible
side effect: `/api/proxyfoo` now returns the Worker's 503 instead of Vercel's
404.

Lesson, and it is the §3.15 lesson again: the code was correct and the tests
passed, and the feature still could not run, because the thing in front of it
never handed it the request. Test the deployed path, not just the handler.

**Verified live after deploy** (`/api/proxy`, both contracts):

| Check | GET | POST |
|---|---|---|
| Real stories call (`s=dw4nge`) | 200, byte-identical to POST | 200 |
| `/web/home/startingSettings` | — | 200, `x-market-backend: gateway` |
| Cross-site (`sec-fetch-site: cross-site`) | 503 | n/a |
| `origin: https://evil.tld` | 503 | n/a |
| `//evil.tld/x` | 400 | 400 |
| `/auth/phone/send_otp` (3 encodings) | 403 | 403 |
| Unknown service token | 503 | 503 |
| `PUT` | 405, `allow: GET, POST` | |

Untouched, re-probed: `/`, `/gb-en`, `/api/auth/me`, `/api/auth/refresh` all
still Vercel; `/ingest/*` still its own Worker; media still 200.

**Caching: the GET form is never cached, by three independent mechanisms.**
The Next route's own comment demands this, because the response can carry a
signed-in shopper's data — the Worker attaches their token from an HttpOnly
cookie.

1. Every response sets `Cache-Control: no-store`, including the 200s. Same as
   the Next route, so preload-reuse behaviour is unchanged from Vercel.
2. Workers run before cache and a Worker's response is not written to the edge
   cache. Probed: no `cf-cache-status` header at all across 6 identical GETs.
3. No cache rule covers `trydos.ramaaz.dev` — every rule in `infra/cache.tf` is
   scoped to `local.media_host_match` (§3.17).

Never add a cache rule that picks these up merely because they are GETs. If one
target endpoint is genuinely public, cache that endpoint by its target path.

**⚠️ Dormant until trydos ships.** The only caller is the home-page stories bar
(`../trydos/components/Home/Stories/StoriesBarClient.tsx:59`, `viaProxyGet:
true`), and it lives on the unmerged branch `ticket/homepage-cache-phase-2`
(commit `811c338f`), not `main`. Until that merges and deploys, no browser
sends a GET-form request. Deploying the Worker first is the safe order, not a
mistake: the Worker handles the path either way, and if it were the other way
round the GET traffic would land on Vercel and cost invocations.

⚠️ `ROLLBACK` is now weaker than §3.14 states. Deleting the route falls back to
the Next route, whose **GET handler is also only on that unmerged branch**. So
after trydos ships, rollback restores POST fully but GET only if the deployed
trydos build contains `811c338f`. Check that before rolling back.

Parity confirmed by reading both sides: the token maps in
`../trydos/utils/serviceTokens.ts` and `packages/shared/src/services.ts` are
identical on all seven services, and `buildProxyGetUrl`
(`../trydos/utils/proxyGetUrl.ts:43`) deliberately never sends `d=true`, so the
Worker's `needDecode` is correctly false on this path.

### 3.21 ✅ CI/CD on GitHub Actions — live and verified (2026-09-15)

⚠️ **If you are here to roll back a Worker, read the ROLLBACK note at the
bottom first.** Deleting a route in the dashboard no longer stays deleted on
its own — CI can re-create it.

Repo: https://github.com/AlaaAsaad57/trydos-cf-worker (**public**).
One workflow, `.github/workflows/ci.yml`, four jobs.

| Job | Runs on | Purpose |
|---|---|---|
| `test` | every PR **and** every push to `main` | typecheck + 144 tests + the selector's own 18 checks |
| `changes` | push to `main` only | decides which Worker to deploy |
| `deploy trydos-proxy` | push to `main`, if selected | `wrangler deploy` in `workers/proxy` |
| `deploy trydos-ingest` | push to `main`, if selected | `wrangler deploy` in `workers/ingest` |

Both deploy jobs declare `needs: [test, changes]`, so **no Worker deploys
unless every test passes**. The deploy rules live in
`.github/scripts/select-workers.sh`, which has 18 tests of its own that CI also
runs — the logic is testable on a laptop instead of only by pushing.
`packages/shared/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
`tsconfig.json` deploy both. An unreadable base commit deploys both, which is
the safe direction.

**🔴 The security property that matters, proved on a real run.** The repo is
public, so anyone can fork it and open a PR. On PR #1 the three non-test jobs
reported `conclusion: skipped` with **`steps: 0`** — they did not fail early,
they never executed. Checked five ways: `changes` is fenced to
`github.event_name == 'push' && github.ref == 'refs/heads/main'`; neither
deploy `if` uses `always()`; `pull_request_target` appears nowhere; `secrets.`
appears only inside the two deploy jobs; and `github.event.*` reaches the shell
through `env:`, never interpolated into a `run:` block.

**First deploy through CI, 2026-09-15** —
run https://github.com/AlaaAsaad57/trydos-cf-worker/actions/runs/34966743880

| Worker | Version id | Confirmed live by |
|---|---|---|
| `trydos-proxy` | `c9af0fd8-0847-4dd5-9f82-855b675c5587` | Cloudflare deployments API, 12:05:08Z |
| `trydos-ingest` | `953263e5-e3a3-4775-8301-4ca3329571f4` | Cloudflare deployments API, 12:05:05Z |

Verified after that deploy, against production:

| Check | Result |
|---|---|
| `POST /api/proxy` market `/web/home/startingSettings` | 200, `x-market-backend: gateway`, 2656 B |
| `GET /api/proxy?s=vv7qsd&u=…` (the §3.20 preload form) | 200, **byte-identical** to POST (`sha256 a1e7fbaf…`) |
| `//evil.tld/x` | 400 — SSRF guard holds |
| `send_otp`, `send%255Fotp` | 403 each — OTP guard holds |
| `/ingest/static/array.js` | 200, no `x-vercel-id` |
| `/gb-en` | 200, `x-vercel-id` present — Vercel control, site up |

**Three risks that could not be tested on Windows are now closed.** On
`ubuntu-latest`: `pnpm install --frozen-lockfile` succeeded cold in 3.7s, the
workerd suites passed (101 + 31 + 12), and `select-workers.test.sh` passed its
18 checks on Linux.

**⚠️ One real trap found and fixed.** The root `package.json` had
`pnpm --filter @cf/proxy-worker test`. **`pnpm --filter` exits 0 when nothing
matches** — measured, not assumed. So renaming a Worker package would have made
the test job go green *without running that Worker's tests*, and the deploy
would have proceeded untested. That defeats the one property the whole design
rests on. Both scripts now carry `--fail-if-no-match`, which exits 1 on no
match. Same lesson as §3.15 and §3.20: the code was fine and the thing around it
was not.

**Deliberately NOT here, both user decisions on 2026-09-15:**

- **Terraform.** State is local at `infra/terraform.tfstate`; `apply` stays
  manual. Git cannot lock, so a state file in the repo would let a local apply
  and a CI apply silently overwrite each other.
- **No approval gate.** A merge to `main` reaches live shopper traffic in about
  a minute. The tests are the only thing in between.

**⚠️ Three known gaps, all raised and deferred by the user:**

1. **`main` has no branch protection**, so a direct push skips review and
   deploys. A repo collaborator could also open a PR rewriting `ci.yml` to
   deploy on `pull_request`. That is not an escalation — write access already
   allows a direct push — but branch protection would close both.
2. **The two Cloudflare secrets are repo-level, not environment-level**, so the
   `production` environment's rules do not gate them. Moving them into the
   environment would stop any PR-triggered job reading them.
3. **No `.gitattributes`.** A contributor with `core.autocrlf=false` on Windows
   could commit CRLF and break the CI shell scripts in a way that looks like a
   bash bug. Blobs are clean LF today.

**Secrets in the repo:** `CLOUDFLARE_API_TOKEN` (account-owned, id
`52296368…`, Workers Scripts Edit + Workers Routes Edit) and
`CLOUDFLARE_ACCOUNT_ID`. The seven backend URL secrets are **unused** —
`wrangler deploy` keeps the secrets already on Cloudflare.

⚠️ **Verify an account-owned token with
`/accounts/{id}/tokens/verify`, never `/user/tokens/verify`.** The user
endpoint returns error 1000 "Invalid API Token" for a perfectly healthy
account-owned token, which is indistinguishable from a dead one. That cost an
hour here and produced a wrong conclusion that had to be retracted. Verifying
is also not enough — probe the endpoints a deploy actually uses.

**ROLLBACK** — CI never runs Terraform, that part still holds. But CI does run
`wrangler deploy`, and both `wrangler.jsonc` files declare `routes`. A deploy
re-applies those routes. Proof, from the real deploy log of run
`34966743880`:

```
Deployed trydos-proxy triggers (1.24 sec)
  trydos.ramaaz.dev/api/proxy* (zone name: ramaaz.dev)
Deployed trydos-ingest triggers (1.71 sec)
  trydos.ramaaz.dev/ingest/* (zone name: ramaaz.dev)
```

So deleting the route in the Cloudflare dashboard, as §3.14 and §3.19 say, is
now only **temporary**. The next push to `main` that qualifies for a deploy
(see the table above) puts the route back, silently, with live shopper auth
traffic behind it again.

A rollback that actually sticks needs one of these, not just the dashboard
delete:

- Disable the workflow: `gh workflow disable ci.yml`.
- Remove the route from the Worker's `wrangler.jsonc` and merge that change.
- Delete the route in the dashboard **and** disable the workflow in the same
  action, so nothing can race you.

### 3.11 Zone audit (read-only API token, 2026-08-24)

Zone `ramaaz.dev` — id `df0581418328bcb0b4cde6d982f5c3ea`, status active, plan
**Free Website** (confirms every Free limit in §4.1).

**🔴 `ssl = flexible`, zone-wide.** This is the single most important finding.

Consequences, in order of importance:

1. **`trydos.ramaaz.dev` must NOT be orange-clouded while this holds.** Flexible
   makes Cloudflare fetch the origin over plain HTTP; Vercel unconditionally
   redirects HTTP→HTTPS; Cloudflare follows it back into itself. Result is
   `ERR_TOO_MANY_REDIRECTS` and the storefront is down. The §C rollout step is
   blocked on this, not optional.
2. **Every proxied backend on this zone currently receives Cloudflare traffic
   over unencrypted HTTP.** There are ~60 proxied A records including
   `trydos_develop`, `trydosv2`, `trydos_wallet_develop`, `trydoschatnest`,
   `trydo_story`, `media`. The proxy injects `Authorization: Bearer <jwt>`
   (§3.1), so those tokens cross the public internet in cleartext on the
   Cloudflare→origin leg. This predates this project and is out of its scope,
   but it should be raised with whoever owns the zone.

**Do not "just switch it to Full (strict)".** The setting is zone-wide and ~60
origins depend on it. Any origin without a working HTTPS listener breaks the
moment it changes.

**The safe unblock is a Configuration Rule scoped to one hostname.** SSL/TLS
encryption mode is one of the 16 settings Configuration Rules can override, and
Free includes 10 Configuration Rules. So: one rule matching
`http.host eq "trydos.ramaaz.dev"` setting SSL to Full (strict), leaving every
other backend on Flexible. ⚠️ Cloudflare's docs do not state whether the SSL
setting specifically is Free-tier — unverified until the rule is actually
created.

**Other settings worth knowing:**

| Setting | Value | Why it matters |
|---|---|---|
| `ip_geolocation` | **on** | `CF-IPCountry` will be present — the §5a geo fix works |
| `browser_check` | **on** | Browser Integrity Check may challenge mobile/API clients once the app is proxied. Overridable per-path with a Configuration Rule |
| `always_use_https` | off | |
| `min_tls_version` | **1.0** | Weak, but zone-wide — changing it affects all ~60 origins |
| `security_level` | medium | |
| `cache_level` | aggressive | |
| `browser_cache_ttl` | 14400 | Matches the origin's `max-age=14400` on media |
| `rocket_loader`, `minify`, `polish`, `mirage` | off | Good — none of them will mangle app assets |

**Rulesets: there are NO custom rules on this zone.** Only three managed
rulesets. No custom WAF rules, no cache rules, no rate limiting, no transform
rules. So `infra/` has a clean slate — nothing to import, nothing for Terraform
to clobber. The §README warning about blind `apply` is now satisfied on the
"read the current state" requirement.

**DNS:** 122 records. `trydos.ramaaz.dev` is correctly grey-clouded
(`proxied: false`). Note heavy duplication — most backends exist as both
underscore and hyphen variants (`market_new` and `market-new`,
`chating_staging_trydos` and `chating-staging-trydos`, …). Tech debt, not this
project's to fix, but relevant if hostnames are ever migrated.

---

## 4. Cloudflare constraints (Free plan, verified against CF docs)

### 4.1 Free plan hard limits

| Limit | Free | Notes |
|---|---|---|
| Workers requests | 100k/day | Current trydos traffic is already ~138k edge req/day |
| Workers CPU | 10 ms/invocation | Paid: 30s default |
| Subrequests | 50/request | Proxy needs 1 |
| Worker memory | 128 MB | Same on paid |
| Request body | **100 MB (Free *and* Pro)** | Business 200 MB, Enterprise 500 MB |
| WAF custom rules | 5 | Pro 20 |
| Rate limiting rules | 1, 10s window, IP-only | See §4.3 — three of these were wrong |
| Durable Objects | available, SQLite backend only | 100k req/day |

**Workers Paid is $5/mo + $0.30/M requests and is assumed from day one.** Free
cannot hold either workload. Free is for zone setup and DNS only.

### 4.3 Free-plan limits the docs do not state — learned from API errors

All four were discovered only when `terraform apply` hit the real API. A plan
succeeds against any of them, because the plan is client-side. They surfaced
one at a time, each apply revealing the next — budget for that when adding
rules on Free.

| What was assumed | What the API actually says |
|---|---|
| Rate limiting is "IP-only", so `characteristics = ["ip.src"]` | **Error 20155** — `cf.colo.id` is *required*: "ratelimiting counting is processed at colocation level only". "IP-only" means no other *identity* characteristic (no header/cookie/JA3), not `ip.src` alone |
| `mitigation_timeout` is free to choose | **"not entitled to use a mitigation timeout different from 10"** — Free is locked to 10s |
| `http.request.method not in {...}` is valid | **Error 20127**, parse failure at the `not`. Wirefilter wants `not (http.request.method in {...})` — negate the whole comparison, not the operator |
| `matches "^/image/upload/"` works for path prefixes | **"not entitled: the use of operator Matches is not allowed, a Business plan or a WAF Advanced plan is required"**. Regex is Business+. Anchored `^/prefix/` patterns map exactly onto `starts_with(http.request.uri.path, "/prefix/")`, so this costs nothing here — but any rule needing real regex is off the table until Business |

Lesson, and it is the same one as §3.15: `terraform validate` and `terraform
plan` both pass on all three. Only `apply` tells the truth about plan
entitlements and expression syntax.

### 4.2 Structural constraints

- **Workers run before cache.** A Worker on a media route is invoked on every
  request, cache hit or not. Keep the hot media path Worker-free: Cache Rules
  and Transform Rules are unmetered and run before Workers. Use a Worker only
  where there is real logic (`/gated/*`, signing).
- **Uploads must not transit the Cloudflare proxy on any plan we would buy**
  (§3.8). Plan for a DNS-only (grey-cloud) hostname for the write paths, or
  presigned direct-to-S3.
- **Video hosted outside Cloudflare is restricted on the CDN** unless served via
  Stream/Images/R2, or Enterprise. `/video/upload/*` streams from S3 today.
  Options: leave video on CloudFront, or move objects to R2 (egress-free,
  ToS-clean, works with the existing `@aws-sdk/client-s3` code).
- **Purge by tag and by prefix are Enterprise-only.** On Free/Pro we purge by
  exact URL, so caching HTML means `/api/revalidate` must enumerate locale
  variants (~4 languages × ~5 countries per entity).
- **IP-only rate limiting fits this userbase badly.** Carrier NAT in SY/IQ/LB
  means shared IPs and false positives.
- **Bot Fight Mode (Free) is JS-challenge based** and will break mobile/API
  clients. Super Bot Fight Mode needs Pro.
- Edge rules are worthless unless the origins can *only* be reached through
  Cloudflare. Authenticated Origin Pulls and Tunnel are free; this is a
  prerequisite, not a follow-up.

---

## 5. Open questions

### Resolved 2026-08-24 by live probing

- ✅ **`ramaaz.dev` is already on Cloudflare.** Nameservers are
  `sara.ns.cloudflare.com` / `benedict.ns.cloudflare.com`. A Cloudflare account
  and zone already exist.
- ✅ **Underscore hostnames are not a blocker.** `media_server.ramaaz.dev`
  resolves to Cloudflare IPs (`188.114.96.6`, `2606:4700:…`) and serves over
  HTTPS today: `server: cloudflare`, `cf-ray` present, valid TLS. The
  CA/Browser underscore concern does not bite here.
- ✅ **Media is already proxied through Cloudflare, and is cacheable.**
  `GET /image/upload/...` returns `cf-cache-status: MISS` with
  `cache-control: max-age=14400`. So §2 step 1 is **not a migration** — it is
  cache-rule and cache-key tuning on an existing setup.
- ✅ **CloudFront was never deployed.** `cdn.ramaaz.dev` is NXDOMAIN.
  `CLOUDFRONT_CDN_ROLLOUT.md` is a request to DevOps that was never actioned —
  a direct example of why §0 exists.
- ✅ **`trydos.com` is registered and healthy, but its DNS points at registrar
  parking.** RDAP (Verisign): registrar Instra, registered 2024-07-14, expires
  **2027-07-14**, status `client transfer prohibited` (normal). Nameservers are
  `ns3/ns7.expirationwarning.net` — Instra's default parking NS. Both
  `trydos.com` and `dev.trydos.com` resolve to `51.195.17.68`, which serves an
  nginx `302 → /index.php` parking page. The domain is **not** expired; it was
  simply never pointed at the app.

- ✅ **Production is `https://trydos-rust.vercel.app/`** (user-confirmed
  2026-08-24). Not `dev.trydos.com`, despite `.env.production`. Middleware is
  live: `GET /` → `307 /gb-en?no-country=true`, `x-vercel-id: bom1`.
- ✅ **Only one `FormData` path transits `/api/proxy`**: seller-dashboard
  product update, `services/sellerDashboard/index.ts:830-838` — `fetchData`
  with `server: "market-dashboard"` and `body: formData`. Every other
  `FormData` site fetches an origin directly and bypasses the proxy:
  `services/auth.ts:945`, `services/order.ts:31`,
  `services/sellerDashboard/index.ts:349`, `services/story.ts:96`,
  `components/Chat/chatsFunctions.tsx:526` (all → media server `/gated/*`),
  and `services/wallet/index.ts:260` (→ wallet backend). So the 100 MB cap
  applies to product images only.
- ✅ **HTML is not cacheable today, and `User-Data` is not the reason.**
  `GET /gb-en` returns `cache-control: private, no-cache, no-store, max-age=0,
  must-revalidate`, sets four cookies on the response (`country`, `lang`,
  `language`, `userIP`), and carries `vary: rsc, next-router-state-tree,
  next-router-prefetch, next-router-segment-prefetch`. `x-vercel-cache: MISS`.
  Making HTML cacheable is therefore a **trydos change** (stop `no-store`, move
  cookie-setting off the cached path), not a Cloudflare rule.

### 🚧 Blocker: `*.vercel.app` cannot go behind Cloudflare

Cloudflare can only proxy hostnames in a zone you control. `trydos-rust.vercel.app`
is not one. Until a custom domain is attached to the Vercel project and its
nameservers moved to Cloudflare:

- **§2 step 2 (middleware + HTML caching) cannot start.**
- **§2 step 3 (proxy worker) cannot start** — and is doubly blocked, because the
  Worker must share a hostname with the host-only auth cookies (§3.4).
- §2 step 1 (media) is unaffected: it lives on `ramaaz.dev`, already on
  Cloudflare.

The domain decision is deferred by the user as of 2026-08-24. While it stays
deferred, media is the only workable track.

### Still open

1. **Custom domain for the Vercel project.** Hostname chosen 2026-08-24:
   **`trydos.ramaaz.dev`** — a CNAME in the existing Cloudflare zone, so no
   registrar or nameserver work is needed and `trydos.com` stays untouched
   until launch. Rollout is grey-cloud → Vercel cert → ship the geo fix
   (§5a) → orange-cloud. Until it is proxied, steps 2 and 3 stay blocked.
   The proxy Worker will bind to a route pattern on this hostname, which is
   what keeps the host-only auth cookies visible to it (§3.4).
2. **Existing Cloudflare zone config** (cache rules, WAF, rate limits on
   `ramaaz.dev`) — deferred by user. **Do not `terraform apply` against this
   zone until its current state has been read.** Terraform will happily delete
   rules it does not know about.
3. Minor, unrelated: `REDIS_URL=65.0.21.24` in both apps' env files is a public
   AWS ap-south-1 address that also serves as a NAT egress IP. Worth a sanity
   check by someone with infra access; not part of this project.

---

## 5a. Required trydos changes (identified here, applied there — not yet)

### ✅ APPLIED 2026-08-24 — geo headers, fixed ahead of the DNS flip

Both edits below are **applied in `../trydos` and passing, but not committed
there** — review and deploy is the user's call. `tests/proxy.test.ts`: 108
passing, up from 105, the three new ones covering CF-preferred, Vercel
fallback, and `XX` unknown.

- `proxy.ts` `getGeoCountry` — prefers `cf-ipcountry`, falls back to
  `x-vercel-ip-country`.
- `proxy.ts` `getClientIp` — prefers `cf-connecting-ip`, falls back to
  `ipAddress(req)`.

**This must be deployed before `trydos.ramaaz.dev` is orange-clouded.** The
original problem, kept for context:

### ⛔ Geo headers break when the orange cloud goes on — fix BEFORE proxying

`../trydos/proxy.ts:209` reads `x-vercel-ip-country`, which Vercel derives from
the **connecting IP**. Once Cloudflare proxies the hostname, the connecting IP
is a Cloudflare edge IP, so every visitor resolves to the PoP's country and
falls through to the `no-country=true` default (`proxy.ts:640-643`). Same
problem at `proxy.ts:284`, where `ipAddress(req)` from `@vercel/functions`
feeds the `userIP` cookie.

Fix, which must land **before** the record is orange-clouded:

- `getGeoCountry`: prefer `cf-ipcountry`, fall back to `x-vercel-ip-country`.
  Cloudflare sets `CF-IPCountry` on proxied zones by default.
- `ipAddress(req)`: prefer `cf-connecting-ip`, fall back to the current call.

Both are small and backward-compatible — with a grey-clouded record the CF
headers are simply absent and the existing behaviour holds, so the change is
safe to ship ahead of the DNS flip.

### ✅ Already done — og:image format is pinned

Recorded here only to stop it being "discovered" again. An earlier revision of
this file proposed pinning `f_jpg` in og:image URLs as a trydos change. **It is
already implemented**: `buildOgImageUrl` (`utils/server/helpers.ts:69-77`)
rewrites the transform segment to `w_1200,h_630,c_pad/f_jpg/q_90` and is used
at `serverRequests/product.tsx:325` and `serverRequests/meta/listing.tsx:270`.
Covered by tests at `tests/utils/server/helpers.test.ts:167-190`.

No trydos change is required for §3.16.

### Deferred

- Migrate the five env vars off `media_server.ramaaz.dev` to
  `media.ramaaz.dev` (§3.10).
- Make HTML cacheable: stop sending `no-store`, move cookie-setting off the
  cached path (§5).

---

## 5b. Handover — what is left

The remaining work is written up as one file per item in the repo root, with
[REMAINING.md](REMAINING.md) as the index:

| # | Item | Owner | File |
|---|---|---|---|
| 1 | Media on Flexible SSL — blocked, origin has no cert (§3.18) | server admin | `STEP-1-media-ssl.md` |
| 2 | `/metrics` open inside the network — separate listener, no API key (§3.10) | MediaServing | `STEP-2-metrics-listener.md` |
| 3 | Retire `media_server.ramaaz.dev` (§3.10) | trydos + MediaServing | `STEP-3-retire-media-server-host.md` |
| 4 | Origin lock-down: Grafana `:3001` exposed, AOP not enabled (§3.10, §3.11) | server admin | `STEP-4-origin-lockdown.md` |
| 5 | PostHog `/ingest` follow-ups: re-enable replay, confirm geo-IP, retire the dead Next route (§3.19) | trydos | `STEP-5-posthog-ingest-followups.md` |

Nothing on that list can be finished from this repo — every item is a
server-side change or an app change in `../trydos` / `../../MediaServing`,
which §0 forbids editing from here.

Order matters in one place: **item 4 comes before item 1.** Authenticated
Origin Pulls is a TLS client-certificate mechanism, so it needs the HTTPS
origin leg that item 1 builds — but item 1 is only worth doing once the origin
is genuinely locked to Cloudflare, which is item 4b. Read both files before
starting either.

## 6. Working agreements

- No secrets in this repo. `.dev.vars` and `.env*` are gitignored; use
  `wrangler secret` for real values.
- Media worker and proxy worker stay **separate Workers**. Same repo is fine;
  same isolate is not — image param parsing must not run next to market tokens.
- Port security guards verbatim with tests before trusting them. `/api/proxy` is
  hardened against SSRF; a sloppy rewrite turns it into an open relay carrying
  Bearer tokens.
- When something here turns out to be wrong, fix this file in the same change.
