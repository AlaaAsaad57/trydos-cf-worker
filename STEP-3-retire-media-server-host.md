# Step 3 — Retire `media_server.ramaaz.dev`

**Owner:** trydos + MediaServing
**Status:** not started. Lowest priority item on the list.
**Risk if done wrong:** images 404 across the storefront.

---

## Why bother

The honest reason is **interop, not performance**: an underscore is not valid
in a hostname per RFC 1123. It works through Cloudflare today (verified — it
serves HTTPS with a valid cert, CLAUDE.md §5), but some clients, proxies and
HTTP libraries reject underscore hostnames outright.

`media.ramaaz.dev` already exists, points at the same origin, and is proxied.

**A weaker reason, stated honestly:** cache entries are per-hostname, so two
hostnames mean two cache namespaces for the same image. But traffic is almost
entirely on `media_server` today, so consolidating mostly *moves* the namespace
rather than merging two hot ones. Do not justify this work on cache grounds.

---

## ⚠️ Pre-flight check — do this first

`GetImageUrl` (`../trydos/utils/server/helpers.ts:47`) returns the path
untouched when it already contains `http`:

```ts
if (path.includes("http")) return path;
```

So **any absolute URL stored in the database keeps pointing at
`media_server.ramaaz.dev` no matter what the env vars say.** If those exist,
this is a data migration, not a config change, and the scope is completely
different.

Check before starting: inspect a few product / boutique / story records and
confirm the stored media field is a relative `sub_path`
(e.g. `product/1780911983751124.jpg`) and not a full URL.

If absolute URLs are present, stop and re-scope.

---

## The five environment variables

**trydos** (`../trydos/.env.production`) — note two of them include a path
suffix, keep it:

```
NEXT_PUBLIC_BASE_MEDIA_URL=https://media_server.ramaaz.dev/image/upload
NEXT_PUBLIC_BASE_VIDEO_MEDIA_URL=https://media_server.ramaaz.dev/video/upload
NEXT_PUBLIC_MEDIA_SERVER_BASE_URL=https://media_server.ramaaz.dev
```

**MediaServing** (`../../MediaServing/.env.production`):

```
PUBLIC_BASE_URL
MEDIA_PUBLIC_BASE_URL
```

These are `NEXT_PUBLIC_*` in trydos, so they are **baked in at build time** —
changing them requires a rebuild and redeploy, not just an env update.

Also update the same values in the Vercel project settings, not only the local
`.env.production`. CLAUDE.md §5 records that the local file's contents do not
necessarily match what is deployed.

---

## Steps

1. Run the pre-flight check above.
2. Change the three trydos vars in **Vercel project settings**, redeploy.
3. Change the two MediaServing vars, redeploy.
4. **Leave the `media_server.ramaaz.dev` DNS record in place.** Old HTML,
   cached pages, mobile clients and any third party that scraped an image URL
   will keep requesting it for a long time.
5. **Leave both hostnames in `infra/main.tf`** (`var.media_hostnames`). The
   cache, WAF and rate-limit rules must keep covering the old host for as long
   as it receives traffic. Removing it early silently un-protects it.
6. Watch traffic on the old hostname. Retire the DNS record and drop it from
   `media_hostnames` only when it reaches zero — expect months, not weeks.

---

## Verify

```bash
# New host serves the same image
curl -sSI "https://media.ramaaz.dev/image/upload/h_200,w_200,c_fit/f_auto/q_auto:good/fl_lossy/so_0/product/1780911983751124.jpg"

# Storefront no longer emits the underscore host
curl -sS -L https://trydos.ramaaz.dev/gb-en | grep -c "media_server.ramaaz.dev"   # expect 0

# Old host still works for anything already cached out there
curl -sSI https://media_server.ramaaz.dev/health    # 200
```

Expect a burst of cache MISSes after the switch — every image URL is new to the
edge under the new hostname. Minutes, not hours.

## Already done, do not redo

`buildOgImageUrl` (`../trydos/utils/server/helpers.ts:69-77`) already rewrites
`media_server.ramaaz.dev` to `media.ramaaz.dev` for og:image URLs, and is
covered by tests at `../trydos/tests/utils/server/helpers.test.ts:175-179`.
Once the env vars move, that `.replace()` becomes a no-op and can eventually be
deleted — but only after step 6.
