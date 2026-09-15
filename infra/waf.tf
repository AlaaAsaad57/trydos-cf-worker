# WAF custom rules. Free plan allows FIVE.
#
# All three rules and the rate limit are enabled. Three of the five Free
# custom rules are used; two are kept spare on purpose, because on a five-rule
# budget having no room to respond to an incident is itself a risk.
#
# The rate limit is deliberately loose (100 req / 10s / IP on upload paths).
# Carrier NAT in SY/IQ/LB puts many real customers behind one address, so a
# tight IP limit false-positives on precisely this userbase. The authoritative
# limits stay in the app, Redis-backed and per-identity (src/app.js:158-163).
#
# None of these are enforceable if the origin is reachable directly. Verified
# 2026-08-24: ports 3000 and 4001 both time out from the internet, so
# Cloudflare is the only public path in. Grafana on 3001 is still exposed and
# is NOT covered by any rule here (CLAUDE.md §3.10).

resource "cloudflare_ruleset" "media_waf" {
  zone_id = var.zone_id
  name    = "media protection"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [
    {
      ref         = "block_public_metrics"
      description = "Prometheus scrape is world-readable at the origin"
      enabled     = false
      expression  = "(${local.media_host_match}) and (http.request.uri.path eq \"/metrics\")"
      action      = "block"
      # Verified 2026-08-24: GET /metrics returns 200 with the full scrape, no
      # API key. Cause is the legacy allowlist in MediaServing
      # src/middleware/auth.js:49, which returns before the key check.
      #
      # This rule closes it from the internet. It does NOT fix the origin --
      # anything inside the network still reaches it unauthenticated. The app
      # fix is tracked in CLAUDE.md §3.10.
    },
    {
      ref         = "block_known_upload_auth_bypass"
      description = "Query-string bypass of the upload API-key check"
      enabled     = true
      expression  = <<-EOT
        (${local.media_host_match})
        and (http.request.method ne "GET")
        and (starts_with(http.request.uri.path, "/upload") or starts_with(http.request.uri.path, "/file/upload"))
        and (http.request.uri.query contains "/image/upload/"
             or http.request.uri.query contains "/video/upload/"
             or http.request.uri.query contains "/media/upload/"
             or http.request.uri.query contains "/file/upload/")
      EOT
      action      = "block"
      # MediaServing src/middleware/auth.js:41-47 tests `request.url`, query
      # string included, so `POST /upload?x=/image/upload/` skips the API-key
      # check entirely. That file records this as an accepted risk for the
      # migration window, not an oversight.
      #
      # This is a STOPGAP for the internet-facing case only. Do not treat the
      # hole as closed, and do not remove the cutover ticket because of it.
    },
    {
      ref         = "block_writes_on_read_paths"
      description = "Read-only media routes accept only GET and HEAD"
      enabled     = true
      expression  = "(${local.media_host_match}) and (not (http.request.method in {\"GET\" \"HEAD\" \"OPTIONS\"})) and ${trimspace(local.media_read_paths)}"
      action      = "block"
    },
  ]
}

# Rate limiting: ONE rule on Free, 10-second window, IP-only.
#
# Spent on the upload paths because those are the expensive ones (Sharp,
# ffmpeg, S3 multipart). The threshold is deliberately loose: carrier NAT in
# SY/IQ/LB puts many real customers behind one address, so a tight IP limit
# produces false positives on precisely this userbase. The authoritative
# limits stay in the app, Redis-backed and per-identity
# (MediaServing src/app.js:158-163).
resource "cloudflare_ruleset" "media_rate_limit" {
  zone_id = var.zone_id
  name    = "media upload rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [
    {
      ref         = "upload_flood"
      description = "Coarse flood ceiling on upload paths"
      enabled     = true
      expression  = "(${local.media_host_match}) and (starts_with(http.request.uri.path, \"/upload\") or starts_with(http.request.uri.path, \"/gated\"))"
      action      = "block"

      ratelimit = {
        # cf.colo.id is REQUIRED by the API, not optional: rate-limit
        # counting happens per colo. Removing it returns error 20155.
        # "IP-only" on Free means no other IDENTITY characteristic (no
        # header, cookie or JA3) -- it does not mean ip.src alone.
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 10
        requests_per_period = 100
        mitigation_timeout  = 10 # Free is locked to 10; 60 returns "not entitled"
      }
    },
  ]
}
