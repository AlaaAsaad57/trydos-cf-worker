# Step 4 — Lock the origin to Cloudflare

**Owner:** server admin / whoever holds AWS access
**Status:** not started. Contains the only item on this list that is exposed
**right now**.
**Blocks:** [STEP-1](STEP-1-media-ssl.md) — do this first.

---

## Why this is first

Every rule shipped in this repo — the WAF block on `/metrics`, the upload
bypass block, the rate limit — is enforced **at Cloudflare**. All of it is
worthless for any path that can reach the origin directly.

Current evidence says the origin is not trivially reachable, but the mechanism
was **inferred from behaviour, never read from the Apache config**
(CLAUDE.md §3.10). That is a weak foundation for three security rules.

---

## 4a. 🔴 Grafana on `:3001` — exposed right now

```
curl -sS http://13.233.124.226:3001/health   ->  302  (redirects to /login)
```

Confirmed reachable from the internet, 2026-08-24. It is a **separate service**
— it does not sit behind Apache or Cloudflare, so **no edge rule can protect
it.** The `/metrics` WAF rule does nothing for this.

This was deferred by the user earlier, and it is the one item where something
sensitive is directly reachable. It is also the same data `/metrics` exposes,
plus dashboards, plus a login form to attack.

**Fix — pick one:**

- **Security group (simplest):** restrict `:3001` to your office/VPN IPs, or
  close it entirely and reach Grafana over an SSH tunnel.
- **Cloudflare Tunnel + Access (best):** put Grafana behind a `cloudflared`
  tunnel on a hostname in the zone, gated by Cloudflare Access. Both are free.
  This also removes the need to open any inbound port at all.

**Verify:** `curl --max-time 10 http://13.233.124.226:3001/` should time out.

## 4b. Read the Apache config and confirm how the origin is protected

Probed 2026-08-24 with correct SNI and `Host`, straight to the origin IP:

```
curl -sSkI --connect-to media.ramaaz.dev:443:13.233.124.226:443 \
     https://media.ramaaz.dev/health
-> HTTP/2 404, server: Apache/2.4.67 (Debian)      # not the app
```

Yet Cloudflare gets a 200 from that same origin — so the vhost exists and is
**discriminating by client IP**. Most likely an Apache `Require ip` /
`mod_remoteip` ACL limited to Cloudflare ranges.

**Confirm it in the vhost config.** Two very different outcomes:

- If there is an explicit Cloudflare-range ACL — good, it is doing what we
  think, and 4c makes it durable.
- If the media vhost merely **lacks a default-server binding** and the 404 is
  Apache falling through — then adding any new vhost later silently opens the
  bypass, and the protection is accidental rather than designed.

Ports `3000` and `4001` both time out from the internet (verified 2026-08-24),
so the app is not directly exposed. Note `docker-compose.prod.yml:71` asks an
admin to open `4001` — **do not action that note.** See
[STEP-2](STEP-2-metrics-listener.md).

## 4c. Enable Authenticated Origin Pulls

An IP-range ACL drifts: Cloudflare adds ranges and the list goes stale. A
client certificate does not.

1. Cloudflare dashboard → SSL/TLS → Origin Server → **Authenticated Origin
   Pulls**, enable zone-wide or per-hostname.
2. On the origin, configure Apache to require and verify Cloudflare's client
   certificate (`SSLVerifyClient require`, `SSLCACertificateFile` pointing at
   Cloudflare's origin-pull CA).

⚠️ **Requires [STEP-1](STEP-1-media-ssl.md) to be done first.** AOP is a TLS
client-certificate mechanism on the Cloudflare→origin leg. While that leg is
plain HTTP under Flexible, there is no TLS handshake to present a certificate
in, so AOP has nothing to attach to.

So the real order is:

```
4a (Grafana)  ->  4b (read the config)  ->  STEP-1 (origin cert + vhost)  ->  4c (AOP)
```

**Verify AOP:** after enabling, a direct request to the origin over HTTPS
without the client cert should be refused at the TLS layer, while traffic
through Cloudflare continues to work.

---

## Also worth raising with whoever owns the zone

Not this project's to fix, but recorded so it is not lost (CLAUDE.md §3.11):

`ssl = flexible` is **zone-wide** across ~60 proxied backends. `/api/proxy`
injects `Authorization: Bearer <jwt>` into requests to those backends, so
those tokens cross the public internet in cleartext on the Cloudflare→origin
leg. That is a materially worse exposure than anything in this file, and it
predates this project.

Do not "just switch the zone to Full (strict)" — any origin without a working
HTTPS listener breaks the moment it changes. It has to be done per-hostname
with Configuration Rules, the same way `trydos.ramaaz.dev` was.
