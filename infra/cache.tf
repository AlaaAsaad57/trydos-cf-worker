# Cache rules for media delivery.
#
# The cache KEY is the point of this file, not the TTL. Image transforms live
# in the path and video variants in a single `target` query parameter
# (MediaServing src/api/transform.js:200). If the whole query string keyed the
# cache, "?x=1", "?x=2", "?x=3" would be three misses and three Sharp/ffmpeg
# invocations on the origin -- a free way for anyone to burn origin CPU.
#
# Deliberately NO Worker on this path: Workers run before cache, so a Worker
# here would be invoked on every image request including cache hits. Cache
# rules are unmetered. See CLAUDE.md §4.2.

resource "cloudflare_ruleset" "media_cache" {
  zone_id = var.zone_id
  name    = "media delivery cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules = [
    {
      ref         = "media_reads_cached"
      description = "Cache media reads, keyed on path plus the target variant only"
      enabled     = true
      expression  = "(${local.media_host_match}) and (http.request.method in {\"GET\" \"HEAD\"}) and ${trimspace(local.media_read_paths)}"
      action      = "set_cache_settings"

      action_parameters = {
        cache = true

        cache_key = {
          ignore_query_strings_order = true
          custom_key = {
            query_string = {
              # Everything not listed here is ignored, so cache-busting
              # parameters collapse onto the same key instead of reaching
              # the origin.
              include = ["target"]
            }
          }
        }

        # Origin already sends cache-control: max-age=14400. Overriding that
        # is a separate decision that needs to know whether media filenames
        # are content-addressed -- until then, respect it.
        edge_ttl = {
          mode = "respect_origin"
        }

        # Keep serving the last good copy while the origin is unwell, rather
        # than passing a thundering herd to a box running Sharp and ffmpeg.
        serve_stale = {
          disable_stale_while_updating = false
        }
      }
    },
    {
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
