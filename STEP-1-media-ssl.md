# Step 1 — Move media off Flexible SSL

**Owner:** server admin (Apache on `13.233.124.226`), then this repo
**Status:** blocked on the origin. Do NOT flip the Cloudflare setting first.
**Risk if done wrong:** media goes down zone-wide for images and video.

---

## The problem

The zone is on `ssl = flexible` (verified via API 2026-08-24). Cloudflare
therefore fetches media from the origin over **plain HTTP**, and the
Cloudflare→origin leg is unencrypted.

## Why you cannot just switch it

Probed 2026-08-24:

```
openssl s_client -connect 13.233.124.226:443 -servername media.ramaaz.dev

issuer   = C = US, O = Let's Encrypt, CN = R3
subject  = CN = t-bot.trydos.tech          <-- wrong hostname
notAfter = Apr 21 20:28:03 2024 GMT        <-- expired over two years ago
SAN      = DNS:t-bot.trydos.tech           <-- no media.ramaaz.dev
```

Certificate selection happens at the TLS handshake from SNI, **before** any
HTTP-level IP ACL. So this is what Cloudflare would see too — it is not an
artefact of probing from a non-Cloudflare address.

Apache fell back to a default vhost for an unrelated site. **There is no HTTPS
vhost for `media.ramaaz.dev` on the origin at all.**

| Mode | Result today |
|---|---|
| Flexible (current) | works — this is why media is up |
| Full | accepts the bad cert, but 443 is not serving the media app, so expect 404s |
| Full (strict) | **526, media down** |

## How much does this matter?

Less than it first appears. Flexible means the Cloudflare→origin leg is
cleartext, but for media that payload is **public product images**. Nothing
secret crosses it.

The serious Flexible problem is elsewhere: CLAUDE.md §3.11 records ~60 proxied
backends on the same zone-wide Flexible setting, and `/api/proxy` injects
`Authorization: Bearer <jwt>` into requests to them. Those tokens cross the
public internet in cleartext. **Fix those before this.**

---

## Steps

### 1. Issue a Cloudflare Origin CA certificate

Dashboard → SSL/TLS → Origin Server → Create Certificate.

- Hostnames: `media.ramaaz.dev`, `media_server.ramaaz.dev`
  (keep the second until step 3 of [STEP-3](STEP-3-retire-media-server-host.md)
  is done and traffic on it is zero)
- Free, valid 15 years, trusted only by Cloudflare — which is exactly what is
  wanted here.

### 2. Add the Apache HTTPS vhost

On the origin, a `:443` vhost for both names using the cert from step 1,
proxying to the app on `localhost:3000` the same way the existing `:80` vhost
does. **Copy the existing port-80 vhost's config** rather than writing a new
one, so the IP ACL and proxy settings carry over unchanged.

### 3. Verify BEFORE touching Cloudflare

```bash
# Should now show the Cloudflare Origin CA cert, not t-bot.trydos.tech
openssl s_client -connect 13.233.124.226:443 -servername media.ramaaz.dev </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates

# Should return the media app's 200, not Apache's default-vhost 404
curl -sSkI --connect-to media.ramaaz.dev:443:13.233.124.226:443 \
  https://media.ramaaz.dev/health
```

Both must pass. If the second still 404s, the vhost is not routing to the app
and flipping Cloudflare would break media.

### 4. Only then, the Cloudflare rule

⚠️ **Do NOT add a `cloudflare_ruleset` with phase `http_config_settings` to
`infra/`.** Cloudflare allows one entrypoint ruleset per phase per zone, and
that phase is already occupied:

```
http_config_settings   default   7a9da505d12b4c3e99d0a7ac8847b456
```

That ruleset holds the existing Configuration Rule that puts
**`trydos.ramaaz.dev` on Strict** (CLAUDE.md §3.12). A Terraform resource in
the same phase would replace it, and losing it puts trydos back into an
`ERR_TOO_MANY_REDIRECTS` loop — the storefront goes down.

Two safe options:

- **Dashboard (simplest):** Rules → Configuration Rules → add a second rule
  alongside the trydos one, matching
  `http.host in {"media.ramaaz.dev" "media_server.ramaaz.dev"}`, setting
  SSL to **Full (strict)**. Free includes 10 Configuration Rules.
- **Terraform (only if you want it in code):** `terraform import` ruleset
  `7a9da505d12b4c3e99d0a7ac8847b456` first, add the media rule alongside the
  existing trydos rule in the same resource, then `plan` and confirm the
  trydos rule shows **no change** before applying.

### 5. Verify after

```bash
curl -sSI https://media.ramaaz.dev/health          # 200, not 526
curl -sSI https://trydos.ramaaz.dev/gb-en          # still 200 — trydos rule intact
```

## Rollback

Delete the media Configuration Rule in the dashboard. Effective in seconds; the
hostname falls back to the zone default of Flexible, which is the working state
today.

## Unrelated finding, worth passing on

The origin's default `:443` vhost is serving a certificate that expired
**2024-04-21** for `t-bot.trydos.tech`. Not part of this project, but other
sites on that host may be broken.
