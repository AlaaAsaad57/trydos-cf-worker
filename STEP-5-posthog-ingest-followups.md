# Step 5 — PostHog `/ingest` follow-ups (trydos side)

**Owner:** trydos
**Blocking anything?** No. The cutover is done and verified — see CLAUDE.md §3.19.
**Why this file exists:** §0 forbids editing `../trydos` from this repo, so the
three changes below are written down rather than made.

`trydos.ramaaz.dev/ingest/*` is now served by the `trydos-ingest` Worker.
Nothing in trydos had to change for that, and nothing in trydos is broken by
it. These are the things worth doing *because* it happened.

---

## 5a. Re-enable session replay — the reason it was off is gone

`../trydos/utils/posthog.ts:72` sets `disable_session_recording: true`, and the
comment above it says exactly why:

> PAUSED to cut Vercel cost: session replay funnels a continuous stream of
> chunks through the /ingest edge proxy (one edge invocation + data transfer
> per chunk), which dominated the bill.

That cost no longer exists. Replay chunks now terminate at a Cloudflare Worker
— no Vercel invocation, no Fast Origin Transfer. The Worker streams the body
rather than buffering it (`workers/ingest/src/index.ts`), which is the part
that matters for a continuous chunk stream.

**Change:** delete the `disable_session_recording: true` line, or set it to
`false`. The `defaults: "2025-05-24"` preset already configures replay.

**What it costs instead:** PostHog's own replay quota, and Workers requests at
$0.30/M. Check the PostHog plan's replay allowance before flipping it — the
Vercel constraint is gone, the PostHog one is not, and this repo has no
visibility into it.

**Do this one deliberately, not casually.** It is the single change here that
increases traffic volume rather than leaving it flat.

---

## 5b. Confirm geo-IP survived the move

The Worker sets `X-Forwarded-For` from `cf-connecting-ip`
(`packages/shared/src/ingest.ts`). Without it PostHog would geolocate every
event to whichever Cloudflare PoP served the request — silently, with no error
anywhere.

It is covered by unit and handler tests, but **it is not verified in
production**, because confirming it needs the PostHog UI.

**How to check:** open any event captured after 2026-08-25 in PostHog and look
at `$geoip_country_code` / `$geoip_city_name`. Real, varied countries → fine.
Everything suddenly resolving to one country, or to wherever the nearest
Cloudflare PoP is → the header is not landing and this needs revisiting.

This is the same trap as CLAUDE.md §3.12, where an observation was consistent
with the fix working *and* with it not working. Do not mark it verified on
anything less than looking at the geo field.

---

## 5c. Eventually delete the Next route — but not yet

`../trydos/app/ingest/[...path]/route.ts` still exists and is still deployed.
It is now shadowed: the Cloudflare route pattern intercepts `/ingest/*` before
Vercel sees it.

**Leave it there for now — it is the rollback.** Deleting the `/ingest/*` route
in the Cloudflare dashboard falls straight back to it in seconds, with no
trydos deploy. That property is worth more than the dead code costs.

**When to delete it:** after the Worker has carried real traffic long enough to
trust, and after 5b is confirmed. When you do, also drop `ingest` from the
middleware matcher exclusion at `../trydos/proxy.ts:705` in the same change —
otherwise the exclusion outlives the thing it was excluding, and the next
person has to work out why it is there.

**If you delete it, update CLAUDE.md §3.19** — the ROLLBACK paragraph there
will no longer be true, and a rollback instruction that quietly stopped working
is worse than none.

---

## Not doing, and why

**Rate limiting `/ingest/*`.** It is an unauthenticated relay into the PostHog
project — anyone can POST arbitrary events at it. This was equally true of the
Next route, so the cutover did not make it worse, but it is now cheap to abuse
at volume. Free has exactly one rate-limiting rule and `media upload rate
limit` spent it (CLAUDE.md §3.17). Closing this means Pro, or giving up the
media limit. Flagged, not fixed.
