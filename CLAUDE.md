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

### Still open

1. **Which hostname serves the real storefront today?** `.env.production` sets
   `NEXT_PUBLIC_APP_URL=https://dev.trydos.com`, which currently serves the
   parking page. The Vercel project is `trydos-front`
   (`../trydos/.vercel/project.json`). Needs an answer from the user — every
   DNS and cache decision depends on it.
2. **Is `trydos.com` the intended production domain**, and is moving its
   nameservers to Cloudflare in scope?
3. What actually POSTs `multipart/form-data` through `/api/proxy`
   (`route.ts:196`). `FormData` is constructed in `services/auth.ts:939`,
   `services/order.ts:27,515`, `services/sellerDashboard/index.ts:337,444,585,757`,
   `services/story.ts:82`, `services/wallet/index.ts:260`,
   `components/Chat/chatsFunctions.tsx:521`. Not yet confirmed which of these
   route via `fetchData` (and therefore the proxy) versus fetch directly.
   Whatever does inherits the 100 MB cap.
4. Whether HTML is cacheable for anonymous users in practice — needs a real look
   at what varies on the `User-Data` cookie during render.

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
