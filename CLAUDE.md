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

**Status: deferred by the user 2026-08-24.** Both this and the exposed Grafana
on `:3001` were raised and consciously set aside. Recorded here so the decision
is visible rather than forgotten; the WAF rule in `infra/waf.tf` stays written
and unapplied until someone revisits it. Do not re-raise as a new finding.

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
| Rate limiting rules | 1, 10s window, IP-only | |
| Durable Objects | available, SQLite backend only | 100k req/day |

**Workers Paid is $5/mo + $0.30/M requests and is assumed from day one.** Free
cannot hold either workload. Free is for zone setup and DNS only.

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

### Deferred

- Migrate the five env vars off `media_server.ramaaz.dev` to
  `media.ramaaz.dev` (§3.10).
- Make HTML cacheable: stop sending `no-store`, move cookie-setting off the
  cached path (§5).

---

## 6. Working agreements

- No secrets in this repo. `.dev.vars` and `.env*` are gitignored; use
  `wrangler secret` for real values.
- Media worker and proxy worker stay **separate Workers**. Same repo is fine;
  same isolate is not — image param parsing must not run next to market tokens.
- Port security guards verbatim with tests before trusting them. `/api/proxy` is
  hardened against SSRF; a sloppy rewrite turns it into an open relay carrying
  Bearer tokens.
- When something here turns out to be wrong, fix this file in the same change.
