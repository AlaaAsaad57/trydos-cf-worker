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
  # Matches the four cacheable GET routes read from src/api/*.js:
  #   /:resourceType/upload/*  (transform.js:912)
  #   /file/upload/*           (files.js:257)
  #   /chat/file/*             (chat.js:221)
  media_read_paths = <<-EOT
    (http.request.uri.path matches "^/(image|video|media)/upload/"
     or http.request.uri.path matches "^/file/upload/"
     or http.request.uri.path matches "^/chat/file/")
  EOT

  media_host_match = join(" or ", [
    for h in var.media_hostnames : "http.host eq \"${h}\""
  ])
}
