terraform {
  required_version = ">= 1.9"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# Token is supplied via CLOUDFLARE_API_TOKEN, never in a .tfvars file.
provider "cloudflare" {}

variable "zone_id" {
  description = "Cloudflare zone id for ramaaz.dev"
  type        = string
}

variable "media_hostnames" {
  description = <<-EOT
    Hostnames serving MediaServing. Both exist today and point at the same
    origin; media_server.* is legacy and retires once the five env vars in
    trydos and MediaServing move to media.* (CLAUDE.md §3.10).
  EOT
  type        = list(string)
  default     = ["media.ramaaz.dev", "media_server.ramaaz.dev"]
}

locals {
  # Read routes, split by whether the origin reads a query parameter.
  # Route table read from src/api/*.js; see CLAUDE.md §3.6.

  # No query parameter is read by these handlers, so the whole query string
  # can be dropped from the cache key:
  #   /:resourceType/upload/*  transform.js:912 — resourceType is validated to
  #                            image|video|media at transform.js:347-354, and
  #                            ?target= is read only in the video branch (:528)
  #   /file/upload/*           files.js:257
  #   /chat/file/*             chat.js:221
  media_paths_no_query = <<-EOT
    (http.request.uri.path matches "^/image/upload/"
     or http.request.uri.path matches "^/file/upload/"
     or http.request.uri.path matches "^/chat/file/")
  EOT

  # These reach the ?target= branch, so the query string stays in the key.
  # "media" is here because transform.js:347 resolves it to video for
  # video-looking paths.
  media_paths_video = <<-EOT
    (http.request.uri.path matches "^/video/upload/"
     or http.request.uri.path matches "^/media/upload/")
  EOT

  # All read routes together. cache.tf needs them split by query-param
  # behaviour; waf.tf just needs "is this a read path", so it uses the union.
  media_read_paths = <<-EOT
    (${trimspace(local.media_paths_no_query)}
     or ${trimspace(local.media_paths_video)})
  EOT

  # Mirrors isSocialCrawler() at transform.js:75-80. That check is a
  # case-INSENSITIVE regex; Cloudflare's `contains` is case-SENSITIVE, so
  # match against lower(http.user_agent) or a crawler announcing itself as
  # "WHATSAPP" would slip through here while the origin still switches to
  # JPEG for it. If the origin's list changes, this must change with it.
  social_crawler_ua = <<-EOT
    (lower(http.user_agent) contains "facebookexternalhit"
     or lower(http.user_agent) contains "facebot"
     or lower(http.user_agent) contains "twitterbot"
     or lower(http.user_agent) contains "linkedinbot"
     or lower(http.user_agent) contains "slackbot"
     or lower(http.user_agent) contains "discordbot"
     or lower(http.user_agent) contains "whatsapp"
     or lower(http.user_agent) contains "telegrambot"
     or lower(http.user_agent) contains "pinterest"
     or lower(http.user_agent) contains "skypeuripreview"
     or lower(http.user_agent) contains "google-inspectiontool")
  EOT

  media_host_match = join(" or ", [
    for h in var.media_hostnames : "http.host eq \"${h}\""
  ])
}
