# DEPLOY — putting this edge layer on a different Cloudflare account

Everything here is currently deployed to the account that owns the `ramaaz.dev`
zone. This file is what you need to stand it up somewhere else — a new account,
a new zone, a staging environment, or a handover to someone else's
infrastructure.

Read [CLAUDE.md](CLAUDE.md) §0 first if you have not. The short version: the
two sibling apps are the source of truth, and several constraints below exist
because of how *they* behave, not because of how Cloudflare behaves. Skipping
one of those does not produce an error — it produces a subtly broken site.

---

## 0. What actually gets deployed

| Thing | Where | Needs secrets? |
|---|---|---|
| `trydos-proxy` Worker | `workers/proxy/` | **Yes — 7 backend URLs** |
| `trydos-ingest` Worker | `workers/ingest/` | No |
| Cache / WAF / rate-limit rules | `infra/` (Terraform) | Cloudflare API token |

The two Workers are independent. You can deploy either without the other, and
neither depends on the Terraform. The Terraform is media-only and touches a
different hostname entirely.

**They must stay separate Workers.** Same repo is fine; same isolate is not.
`trydos-ingest` is the highest-volume path in the app and must not share a
failure domain with the code that handles `MARKET-TOKEN` (CLAUDE.md §6, §3.19).

---

## 1. Prerequisites

```bash
node -v          # 20+
pnpm -v          # 10.26+ (repo pins packageManager)
npx wrangler -v  # 4.x
```

- A Cloudflare account with the target zone already added and its nameservers
  live.
- **Workers Paid — $5/mo.** Not optional. Free is 100k requests/day and trydos
  alone was already ~138k edge req/day before `/ingest` moved onto Workers
  (CLAUDE.md §4.1). Free also caps CPU at 10 ms/invocation.
- `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` exported.

Install and confirm the repo is healthy before touching anything remote:

```bash
pnpm install
pnpm test:all      # 101 unit + 30 proxy-worker + 12 ingest-worker
pnpm typecheck
```

If those do not pass locally, deploying is guesswork.

---

## 2. What you MUST change — hardcoded to the current deployment

These are the values specific to *this* account and hostname. Nothing warns you
if you miss one.

### 2.1 Route patterns and Worker names — both `wrangler.jsonc` files

`workers/proxy/wrangler.jsonc`:

```jsonc
"name": "trydos-proxy",
"routes": [
  { "pattern": "trydos.ramaaz.dev/api/proxy",      "zone_name": "ramaaz.dev" },
  { "pattern": "trydos.ramaaz.dev/api/proxy-edge", "zone_name": "ramaaz.dev" }
]
```

`workers/ingest/wrangler.jsonc`:

```jsonc
"name": "trydos-ingest",
"routes": [
  { "pattern": "trydos.ramaaz.dev/ingest/*",      "zone_name": "ramaaz.dev" },
  { "pattern": "trydos.ramaaz.dev/ingest-edge/*", "zone_name": "ramaaz.dev" }
]
```

Change the hostname and `zone_name` in all four patterns. Keep the `-edge`
shadow routes — section 5 explains why they earn their keep.

### 2.2 🔴 The proxy Worker MUST share a hostname with the app

Not a preference. trydos's auth cookies are **host-only** — no `Domain`
attribute is set anywhere (CLAUDE.md §3.4, verified against `trydos/proxy.ts:43`
and the cookie setters). A Worker on a sibling subdomain would never receive
`MARKET-TOKEN`, and every authenticated request would silently downgrade to a
guest response.

So `api.example.com/proxy` does **not** work if the app is on
`www.example.com`. It has to be a route pattern on the app's own hostname.

Widening cookie scope with a `Domain` attribute to work around this is a
security downgrade. Don't.

### 2.3 🔴 PostHog region — `packages/shared/src/ingest.ts`

```ts
export const INGEST_ASSETS_HOST = "https://eu-assets.i.posthog.com";
export const INGEST_EVENTS_HOST = "https://eu.i.posthog.com";
```

These are **EU cloud**. If the target project is on US cloud they must become
`https://us-assets.i.posthog.com` and `https://us.i.posthog.com`.

This fails quietly-ish: you get 401s from PostHog rather than a crash, and
events simply never appear in the project. Check which region the project is on
before deploying, not after wondering where the data went.

Self-hosted PostHog: set both to the same instance host.

### 2.4 Service tokens must match the app — `packages/shared/src/services.ts`

`SERVICE_TOKENS` mirrors `trydos/utils/serviceTokens.ts`. The browser sends
these on `x-proxy-server`, so both sides must agree exactly. If you are pairing
this with a different or forked trydos, diff the two files.

They are obfuscation, not access control — the forward map ships to the browser
anyway — so a mismatch is a functional break, not a security one. It presents
as every proxied request returning 503.

### 2.5 Terraform variables — `infra/`

- `zone_id` — goes in `infra/terraform.tfvars`, which is **gitignored**. Create
  it; it does not come with the repo.
- `media_hostnames` in `infra/main.tf` defaults to the `ramaaz.dev` media hosts.
  Override it in your tfvars.
- The API token goes in `CLOUDFLARE_API_TOKEN`, never in a tfvars file.

---

## 3. Zone settings that will break things if you skip them

### 3.1 🔴 SSL/TLS mode vs. a Vercel origin

If the zone is on **Flexible**, Cloudflare fetches the origin over plain HTTP,
Vercel unconditionally redirects HTTP→HTTPS, and Cloudflare follows it back into
itself. Result is `ERR_TOO_MANY_REDIRECTS` and the storefront is down
(CLAUDE.md §3.11).

Two ways out:

- Zone is yours alone → set SSL/TLS to **Full (strict)** zone-wide. Simplest.
- Zone has other origins that depend on Flexible → a **Configuration Rule**
  scoped to `http.host eq "<app hostname>"` setting SSL to Full (strict). Free
  includes 10 Configuration Rules. This is what `ramaaz.dev` does, because ~60
  other origins share that zone.

Deploy the rule **before** you turn the record orange. The dashboard will warn
that the rule may not apply while the record is grey — that warning is expected
and you deploy past it.

### 3.2 🔴 Geo headers must be fixed in the app first

Once Cloudflare proxies the hostname, the connecting IP is a Cloudflare edge IP.
`x-vercel-ip-country` and `ipAddress()` then resolve every visitor to the PoP's
country (CLAUDE.md §5a). The app must prefer `cf-ipcountry` and
`cf-connecting-ip`, falling back to the Vercel values.

That change is backward-compatible — with a grey-clouded record the CF headers
are simply absent — so ship it **before** the DNS flip, not after.

In trydos this is already done (`proxy.ts`, `getGeoCountry` / `getClientIp`). On
a fresh app, check it.

### 3.3 Browser Integrity Check

`browser_check` is on by default and can challenge mobile and API clients once
the app is proxied. Overridable per-path with a Configuration Rule if it bites.

---

## 4. Deploy

### 4.1 The ingest Worker — do this one first

No secrets, no app coupling beyond the PostHog region, and it is the easiest to
verify. Good confidence-builder.

```bash
cd workers/ingest
npx wrangler deploy
```

### 4.2 The proxy Worker

Secrets first, or the Worker deploys and answers 503 to everything (a missing
base URL is treated as a proxy failure, deliberately — CLAUDE.md §3.1).

```bash
cd workers/proxy
bash scripts/put-secrets.sh /path/to/trydos/.env.production
npx wrangler secret list        # expect 7
npx wrangler deploy
```

The script reads each value and pipes it to `wrangler secret put` over stdin —
values are never printed, never echoed, never in shell history. Only names are
logged. The seven:

```
BACKEND_URL  GO_BACKEND_URL  ELASTIC_BACKEND_URL
NEXT_PUBLIC_CHAT_BACKEND_URL  STORIES_BACKEND_URL
COMMENT_BACKEND_URL  WALLET_BACKEND_URL
```

### 4.3 Terraform (media rules — optional, and only if you have a media origin)

```bash
cd infra
export CLOUDFLARE_API_TOKEN=...
terraform init
terraform plan       # READ EVERY LINE
terraform apply
```

**Read the plan properly.** Terraform deletes rules it does not know about. On a
zone that already has cache or WAF rules, `import` them first or you will delete
someone's configuration. On `ramaaz.dev` the plan was `3 to add, 0 to change,
0 to destroy` precisely because the zone had no custom rulesets — do not assume
yours is the same.

Free-plan entitlement errors only surface at `apply`, never at `plan`, because
`plan` is client-side. CLAUDE.md §4.3 lists the four that bit us: rate-limit
characteristics, mitigation timeout, `not in` syntax, and the `Matches` operator
being Business-only. Budget for discovering them one at a time.

---

## 5. Verify — and use the shadow routes

Both Workers keep an `-edge` shadow route. Bind the shadow route **first**,
compare it against whatever serves the path today, and only then add the real
route. That is how both cutovers here were done (CLAUDE.md §3.13, §3.19), and it
costs nothing to keep.

**The tell for which implementation answered:** the Next.js routes emit
`x-vercel-id`; the Workers do not.

Replace `HOST` with your hostname.

### Ingest

```bash
# Worker answered, not Vercel — expect NO x-vercel-id
curl -sSI https://HOST/ingest/static/array.js | grep -i x-vercel-id

# Payload identical to the origin route
curl -s https://HOST/ingest/static/array.js | wc -c

# Cookie stripping — THE contract. Build a 16 KB jar:
BIG="X=$(printf 'a%.0s' $(seq 16384))"
curl -so /dev/null -w "via worker: %{http_code}\n" -X POST \
  -H "content-type: application/json" -H "Cookie: $BIG" \
  -d '{"api_key":"YOUR_PUBLIC_KEY","distinct_id":"probe"}' \
  "https://HOST/ingest/flags/?v=2"
# -> 200. The same request straight to PostHog -> 400.
#    That difference IS the proof the cookie is being stripped.

# Method guard
curl -so /dev/null -w "%{http_code}\n" -X PUT https://HOST/ingest/i/v0/e/   # 405

# Assets cache; events must not
for i in 1 2 3 4 5 6; do
  curl -sS -o /dev/null -D - https://HOST/ingest/static/array.js | grep -i cf-cache-status
done
```

⚠️ **Judge caching by repetition, never one probe.** A colo holds many edge
servers each with its own cache, so single probes return MISS unpredictably even
when caching works fine (CLAUDE.md §3.17). Look for HIT appearing at all across
~8 requests.

⚠️ **`curl -I` is useless for cache checks on media** — Cloudflare does not serve
HEAD from cache, so every HEAD reports MISS. Use real GETs.

### Proxy

```bash
curl -so /dev/null -w "%{http_code}\n" -X GET  https://HOST/api/proxy   # 405
curl -so /dev/null -w "%{http_code}\n" -X POST https://HOST/api/proxy \
  -H "x-proxy-server: nope"                                            # 503, generic

# SSRF guards — each 400
for t in "@evil.tld/x" "//evil.tld/x" "/../../internal/admin" "orders/list"; do
  curl -so /dev/null -w "$t -> %{http_code}\n" -X POST https://HOST/api/proxy \
    -H "x-proxy-server: vv7qsd" -H "x-proxy-url: $t"
done

# OTP blocked raw, encoded and double-encoded — each 403
for t in "/auth/phone/send_otp" "/auth/phone/send%5Fotp" "/auth/phone/send%255Fotp"; do
  curl -so /dev/null -w "$t -> %{http_code}\n" -X POST https://HOST/api/proxy \
    -H "x-proxy-server: vv7qsd" -H "x-proxy-url: $t"
done
```

### Then check you did not move anything you did not mean to

```bash
curl -sSI https://HOST/api/auth/me | grep -i x-vercel-id   # SHOULD be present
curl -so /dev/null -w "%{http_code}\n" https://HOST/        # 307
curl -so /dev/null -w "%{http_code}\n" https://HOST/gb-en   # 200
```

### What you cannot verify from a terminal

- **PostHog geo-IP.** The ingest Worker sets `X-Forwarded-For` from
  `cf-connecting-ip`. Confirming it works needs `$geoip_country_code` on a real
  event in the PostHog UI. Tests cover it; production does not until someone
  looks (CLAUDE.md §3.19).
- **Authenticated proxy flows.** Bearer injection and the verified-user routing
  branch need a real session. Test from a browser after cutover.
- **Seller-dashboard multipart.** The one `FormData` path through the proxy. The
  Worker streams it where the Next route buffered via `formData()`. If product
  image uploads misbehave, suspect this first (CLAUDE.md §3.14).

---

## 6. Rollback

Both Workers roll back the same way, in seconds, with **no app deploy**:

> Cloudflare dashboard → Workers & Pages → `<worker>` → Settings → Domains &
> Routes → delete the production route.

Traffic falls straight back to the Next.js route of the same path, which is
still deployed underneath. Or remove the route from `wrangler.jsonc` and
`npx wrangler deploy`.

This only holds while the origin routes still exist. `trydos/app/api/proxy/` and
`trydos/app/ingest/[...path]/` are deliberately kept for exactly this reason.
**If you delete them, update this section and CLAUDE.md — a rollback instruction
that quietly stopped working is worse than none.**

Terraform:

```bash
terraform destroy -target=cloudflare_ruleset.<name>
```

---

## 7. Order of operations, end to end

For a genuinely fresh account:

```
1.  Zone added, nameservers live
2.  Workers Paid enabled
3.  App hostname added to the zone, DNS record GREY (proxied off)
4.  App deployed and serving on that hostname (cert issued)
5.  Geo fix shipped in the app                     <- §3.2, before the flip
6.  SSL set to Full (strict), or a Configuration Rule for the hostname
7.  DNS record flipped to ORANGE (proxied)         <- §3.1
8.  Verify: / redirects, /gb-en 200, no redirect loop
9.  Deploy Workers to their -edge shadow routes only
10. Compare shadow vs live; only then add the real routes
11. Terraform last, and only if there is a media origin
```

Steps 5 and 6 before step 7 is the part people get wrong. Both failures are
silent-ish: wrong geo looks like "everyone is in the wrong country", and the SSL
one takes the site down with a redirect loop that reads as an app bug.
