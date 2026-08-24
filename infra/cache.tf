# Cache rules for media delivery.
#
# ⚠️ REWRITTEN 2026-08-24 after probing the live zone. The previous version of
# this file was built on a cache KEY of path + `target`, which is
# ENTERPRISE-ONLY and cannot be applied on this zone. See CLAUDE.md §3.16.
#
# What Cloudflare actually allows on Free/Pro/Business for Cache Key:
#   - Ignore query string (all or nothing)   ✅ all plans
#   - Sort query string                      ✅ all plans
#   - Cache deception armor                  ✅ all plans
#   - Cache by device type                   ✅ all plans
#   - "No query parameters except <list>"    ❌ ENTERPRISE ONLY
#
# So `target` cannot be singled out. The design below works with the
# all-or-nothing toggle instead, by splitting the read paths into those that
# read no query parameter at all and those that read `target`.
#
# Deliberately NO Worker on this path: Workers run before cache, so a Worker
# here would be invoked on every image request including cache hits. Cache
# rules are unmetered. See CLAUDE.md §4.2.
#
# Free plan allows 10 cache rules. This file defines 4, one of them disabled.

resource "cloudflare_ruleset" "media_cache" {
  zone_id = var.zone_id
  name    = "media delivery cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  # Order matters: rules evaluate top-down and the LAST match wins in the
  # cache phase, so the crawler bypass must come after the caching rules.
  rules = [
    {
      # ── 1. Paths where no query parameter is read by the origin ─────────
      #
      # Verified by reading the handlers:
      #   /image/upload/*  transform.js:190,528 — `target` is read only in the
      #                    video branch; resourceType "image" never reaches it
      #                    (transform.js:351,372).
      #   /file/upload/*   files.js:257 — no request.query read in the handler.
      #                    The only `.query` in files.js is `folder` at :155,
      #                    inside the POST /upload/excel handler.
      #   /chat/file/*     chat.js:221 — zero `.query` reads in the whole file.
      #
      # Ignoring the query string here collapses ?cb=1, ?cb=2, ?cb=3 onto one
      # cache entry. Probed live: those are three separate edge MISSes today.
      #
      # `cache = true` is doing separate, load-bearing work: Cloudflare's
      # default extension list does not include .jfif, and real product images
      # use it — probed live, .jfif returns cf-cache-status: DYNAMIC and hits
      # the origin on every single request.
      ref         = "media_reads_no_query"
      description = "Cache image/file/chat reads, query string ignored"
      enabled     = true
      expression  = "(${local.media_host_match}) and (http.request.method in {\"GET\" \"HEAD\"}) and ${trimspace(local.media_paths_no_query)}"
      action      = "set_cache_settings"

      action_parameters = {
        cache = true

        cache_key = {
          ignore_query_strings_order = true
          custom_key = {
            query_string = {
              # "Ignore query string" — the all-plans toggle. NOT the
              # Enterprise `include` list.
              # ⚠️ Confirm this is how the provider spells it; if `plan`
              # rejects it, the dashboard equivalent is
              # Cache Key → Query String → "Ignore query string".
              exclude = { all = true }
            }
          }
        }

        # Origin sends `public, max-age=31536000, s-maxage=31536000, immutable`
        # (probed 2026-08-24 — NOT the 14400 recorded earlier in CLAUDE.md).
        # Respect it rather than second-guessing a one-year immutable hint.
        edge_ttl = { mode = "respect_origin" }

        # Keep serving the last good copy while the origin is unwell, rather
        # than passing a thundering herd to a box running Sharp and ffmpeg.
        serve_stale = { disable_stale_while_updating = false }
      }
    },

    {
      # ── 2. Video paths, where ?target= selects the variant ──────────────
      #
      # trydos genuinely uses this: StoryViewer.tsx:377 (?target=story),
      # services/story.ts:291 (?target=snapshot), utils/server/helpers.ts:210
      # (?target=preview). Ignoring the query string here would serve a
      # snapshot where a preview was asked for — a correctness bug worse than
      # the cache-busting it would prevent.
      #
      # /media/upload/* is included because transform.js:347 resolves
      # resourceType "media" to video when the path looks like video, so it
      # reaches the same ?target= branch.
      #
      # Cache-bust exposure is therefore ACCEPTED on these paths. It cannot be
      # closed without an Enterprise cache key. Severity is lower than it
      # looks: probed live, a busting request still gets `x-cache: HIT` from
      # the origin's own cache, so it costs EC2 egress and a request, not a
      # fresh ffmpeg run.
      ref         = "media_reads_video_target"
      description = "Cache video/media reads, query string preserved for ?target="
      enabled     = true
      expression  = "(${local.media_host_match}) and (http.request.method in {\"GET\" \"HEAD\"}) and ${trimspace(local.media_paths_video)}"
      action      = "set_cache_settings"

      action_parameters = {
        cache     = true
        cache_key = { ignore_query_strings_order = true }
        edge_ttl  = { mode = "respect_origin" }
        serve_stale = { disable_stale_while_updating = false }
      }
    },

    {
      # ── 3. Keep crawler responses out of the shared cache entry ────────
      #
      # OPTIONAL. Disabled by default -- turn it on only if you measure the
      # problem below actually costing something.
      #
      # transform.js:406 picks the image format from the User-Agent: JPEG for
      # social crawlers (transform.js:75-80), WebP for everyone else. The
      # response carries only `vary: Origin` and Cloudflare does not vary on
      # User-Agent, so on an f_auto URL whichever request warms the entry
      # decides the format for everybody. Reproduced in production, both
      # directions (CLAUDE.md §3.16).
      #
      # This does NOT affect social link previews. og:image URLs are built by
      # buildOgImageUrl (trydos utils/server/helpers.ts:69-77), which pins
      # f_jpg -- an explicit format, so the crawler-safe default never runs and
      # the User-Agent is irrelevant. Verified live.
      #
      # What is left is narrow: a crawler that scrapes in-page images rather
      # than og:image (Pinterest, Google-InspectionTool) can warm an f_auto
      # entry with JPEG, after which browsers get JPEG instead of WebP. That
      # costs ~25-35% more bytes and renders correctly.
      #
      # ⚠️ DO NOT ENABLE WITHOUT FIXING THE UA LIST FIRST.
      #
      # "whatsapp" is not only a crawler. WhatsApp's in-app browser puts
      # "WhatsApp" in the User-Agent of a REAL person browsing the store, and
      # Facebook's in-app browser is similar. Matching on it would send those
      # shoppers past the cache to the origin on every single image, and
      # in-app browsing is common in exactly the SY/IQ/LB markets this
      # business serves. The rule would cost real users latency to save a few
      # bytes for everyone else -- a bad trade.
      #
      # The same flaw exists at the origin: isSocialCrawler (transform.js:75)
      # matches the WhatsApp in-app browser too, so those users already get
      # JPEG instead of WebP. That is MediaServing's to fix, not this file's.
      #
      # To enable safely, first narrow the list to UAs that only ever belong
      # to bots (facebookexternalhit, twitterbot, linkedinbot, ...) and drop
      # the bare "whatsapp" / "pinterest" substrings.
      ref         = "media_crawler_bypass"
      description = "Bypass cache for social crawlers so UA-negotiated format is not shared"
      enabled     = false # optional optimisation -- see the note above
      expression  = "(${local.media_host_match}) and ${trimspace(local.social_crawler_ua)}"
      action      = "set_cache_settings"

      action_parameters = {
        cache = false
      }
    },

    {
      # ── 4. Write paths are never cached ────────────────────────────────
      ref         = "media_writes_bypass"
      description = "Never cache upload or gated paths"
      enabled     = true
      expression  = "(${local.media_host_match}) and (starts_with(http.request.uri.path, \"/upload\") or starts_with(http.request.uri.path, \"/gated\"))"
      action      = "set_cache_settings"

      action_parameters = {
        cache = false
      }
    },
  ]
}
