# ⛔ NOT APPLIED. Enabled via the Cloudflare dashboard on 2026-08-24, not by
# terraform apply — the stored API token was rejected (code 1000, "Invalid API
# Token"), so this file has never been run against the zone.
#
# It is therefore a RECORD OF INTENT, not a description of live state. Before
# trusting it, either probe the zone (see "Verifying" at the bottom) or import:
#
#   terraform import cloudflare_zone_setting.early_hints <zone_id>/early_hints
#
# Do not `apply` this file without first confirming the four settings match
# what is actually set, or Terraform will happily write stale values back.

# Zone-wide performance settings.
#
# ⚠️ These are ZONE-WIDE. Unlike the rulesets in cache.tf and waf.tf, which are
# scoped to the media hostnames, every setting here applies to all ~60 proxied
# origins on ramaaz.dev (CLAUDE.md §3.11). Each is individually reversible by
# flipping value to "off", but none of them can be scoped to one hostname.
#
# State probed live 2026-08-24 before writing this file:
#
#   brotli       ALREADY ON  — GET /gb-en with `Accept-Encoding: br` returns
#                              `content-encoding: br`
#   http3        ALREADY ON  — responses carry `alt-svc: h3=":443"; ma=86400`
#                              on both trydos.ramaaz.dev and media.ramaaz.dev
#   early_hints  OFF         — no 103 in the response, confirmed with
#                              `curl -v --http2`
#   0rtt         UNKNOWN     — not observable from response headers
#
# brotli and http3 are declared anyway. They are already in the desired state,
# so the apply is a no-op for them; the point is that they become recorded and
# drift is visible in `plan` if anyone toggles them in the dashboard.

resource "cloudflare_zone_setting" "brotli" {
  zone_id    = var.zone_id
  setting_id = "brotli"
  value      = "on"
  # Already on — declared to pin it, not to change it.
}

resource "cloudflare_zone_setting" "http3" {
  zone_id    = var.zone_id
  setting_id = "http3"
  value      = "on"
  # Already on. QUIC is client opt-in via the alt-svc header, so a client that
  # does not speak HTTP/3 simply never uses it. No downside path here.
}

resource "cloudflare_zone_setting" "early_hints" {
  zone_id    = var.zone_id
  setting_id = "early_hints"
  value      = "on"
  # The real change in this file.
  #
  # Cloudflare harvests `Link: rel=preload` / `rel=preconnect` headers from
  # origin responses and replays them as a 103 on subsequent requests to the
  # same URL, so the browser starts fetching fonts and images while the origin
  # is still rendering the HTML.
  #
  # Worth enabling here specifically because trydos already emits them —
  # probed on /gb-en:
  #   preconnect  media_server.ramaaz.dev, googletagmanager
  #   preload     quicksand_variable font (ttf), Logo.svg, CartIcon.svg,
  #               questionIcon.svg, login.svg, Search.svg
  # A zone whose origins send no Link headers would get nothing from this.
  #
  # NOTE: the trydos HTML is `cf-cache-status: DYNAMIC` and `no-store`
  # (CLAUDE.md §5). Early Hints is expected to work regardless, because
  # Cloudflare caches the Link headers separately from the body — but that is
  # the one claim here not verified by probing. Confirm after apply by looking
  # for a 103 (see the verification block in README.md).
}

resource "cloudflare_zone_setting" "zero_rtt" {
  zone_id    = var.zone_id
  setting_id = "0rtt"
  value      = "on"
  # Saves a round trip on resumed TLS connections. Worth more here than for a
  # typical zone: customers are in SY/IQ/LB and the RTT to the nearest PoP is
  # not small.
  #
  # ⚠️ The security consideration is REPLAY. Data sent in the first flight can
  # be captured and re-sent by an on-path attacker, because it precedes the
  # handshake completing. Cloudflare restricts 0-RTT to idempotent requests and
  # marks them with an `Early-Data` header so an origin can reject them, which
  # is what makes this acceptable rather than reckless.
  #
  # ⚠️ That restriction is stated from general knowledge, NOT verified against
  # current Cloudflare docs or observed on this zone — same caveat class as
  # §4.3. If a non-idempotent path is ever found being served over early data,
  # turn this off first and ask questions after.
}

# ── Verifying ──────────────────────────────────────────────────────────────
#
# Early Hints — look for a 103 before the 200. Absence of a 103 on the FIRST
# request is expected: Cloudflare has to harvest the Link headers from an
# origin response before it can replay them, so probe the same URL twice.
#
#   curl -sS -v --http2 -o /dev/null https://trydos.ramaaz.dev/gb-en 2>&1 #     | grep -E '^< HTTP'
#   → want: "< HTTP/2 103" followed by "< HTTP/2 200"
#
# Brotli:
#   curl -sS -o /dev/null -D - -H 'Accept-Encoding: br' #        https://trydos.ramaaz.dev/gb-en 2>&1 | grep -i content-encoding
#   → want: content-encoding: br
#
# HTTP/3:
#   curl -sS -o /dev/null -D - https://trydos.ramaaz.dev/gb-en 2>&1 #     | grep -i alt-svc
#   → want: alt-svc: h3=":443"
#
# 0-RTT is not observable from response headers. Confirming it needs a TLS
# client that will send early data on a resumed session, e.g.
# `openssl s_client -connect trydos.ramaaz.dev:443 -sess_in <file> -early_data`.
# Reading the dashboard toggle is the practical check.
