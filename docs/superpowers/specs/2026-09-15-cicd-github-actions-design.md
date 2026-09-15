# CI/CD for cf-worker — design

Date: 2026-09-15
Status: approved, not yet implemented
Repo: https://github.com/AlaaAsaad57/trydos-cf-worker (public)

## 1. Goal

Run the test suite on every pull request. Deploy the two Cloudflare Workers
automatically when a pull request merges to `main`.

Today both Workers are deployed by hand with `npx wrangler deploy`. Nothing
checks the tests first. This design makes the tests a hard blocker.

## 2. Scope

**In scope**

- Typecheck and all three test suites on pull requests and on pushes to `main`.
- Automatic deploy of `trydos-proxy` and `trydos-ingest` on merge to `main`.
- Only the Worker whose code changed is deployed.

**Out of scope, by decision**

- **Terraform.** The user decided on 2026-09-15 to keep Terraform out of CI
  completely. State stays local at `infra/terraform.tfstate` and `apply` stays
  a manual step. No `plan` job either.
- **Approval gate.** The user chose to deploy straight away with no human
  click. A merge reaches shoppers in about one minute.
- **Post-deploy smoke tests.** Offered and declined. The guard checks in
  DEPLOY.md section 5 stay manual.
- **Pushing Worker secrets.** `wrangler deploy` keeps the secrets already
  stored on Cloudflare, so CI never needs the seven backend URLs.

## 3. Risk this design accepts

`trydos-proxy` serves live `/api/proxy*` traffic on `trydos.ramaaz.dev`. It
attaches a shopper's `MARKET-TOKEN` to backend calls. With no approval gate,
the unit tests are the only thing between a merge and production.

This is a deliberate choice, recorded here so nobody has to guess later.
Rollback is still fast: delete the Worker route in the Cloudflare dashboard and
traffic falls back to the Next route (CLAUDE.md sections 3.14 and 3.19). Note
the weaker rollback warning in CLAUDE.md section 3.20 about the GET contract.

## 4. Shape: one workflow, three stages

One file, `.github/workflows/ci.yml`. Jobs:

```
          pull_request            push to main
               |                        |
            [test]                [test] + [changes]
               |                        |
            (done)          [deploy-proxy]  [deploy-ingest]
```

Two other shapes were rejected:

- **Two files linked by `workflow_run`.** That trigger always runs the copy of
  the file on `main`, and its result does not appear on the pull request. More
  confusion, no gain.
- **Two files both on `push`.** Tests and deploy would race. With no approval
  gate the tests must be a hard blocker, so deploy has to declare `needs`.

## 5. Jobs in detail

### 5.1 `test`

Triggers: `pull_request` (any branch) and `push` to `main`.

Steps:

1. Check out the repo.
2. Set up Node 22.
3. Turn on pnpm 10.26.0 with `corepack`. The version comes from the
   `packageManager` field in `package.json`, so there is one source of truth.
4. Restore the pnpm store from cache, keyed on `pnpm-lock.yaml`.
5. `pnpm install --frozen-lockfile`
6. `pnpm typecheck` — runs `tsc --build`
7. `pnpm test` — 101 unit tests
8. `pnpm test:worker` — 31 tests in workerd
9. `pnpm test:worker:ingest` — 12 tests in workerd

Total today is 144 tests. All pass locally as of 2026-09-15.

No secrets are used. This job therefore works on fork pull requests too.

### 5.2 `changes`

Triggers: only `push` to `main`. Skipped otherwise.

Decides which Workers to deploy. It reads the changed file list with plain
`git diff --name-only` between `github.event.before` and `github.sha`.

Rules:

| Changed path | Deploy proxy | Deploy ingest |
|---|---|---|
| `workers/proxy/**` | yes | no |
| `workers/ingest/**` | no | yes |
| `packages/shared/**` | yes | yes |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` | yes | yes |
| anything else (`*.md`, `infra/**`, `.github/**`) | no | no |

Fallback: if `github.event.before` is missing, is all zeros, or is not a commit
this clone can read (a force push, or the first push to a branch), deploy
**both**. Guessing wrong in that direction is safe; guessing wrong the other
way leaves stale code live.

No third-party action is used for this. The repo is public and holds a deploy
credential, so the job that can write to the Cloudflare account should not pull
in code from outside `actions/*`.

### 5.3 `deploy-proxy` and `deploy-ingest`

Both declare `needs: [test, changes]`, so neither can start until every test
passes. Each also carries a condition on its `changes` output.

Because `changes` is skipped on pull requests, both deploy jobs are skipped on
pull requests as well. Fork pull requests get no secrets from GitHub, so a fork
cannot deploy even if it rewrites this workflow file.

Each job installs dependencies, then runs `npx wrangler deploy` inside its own
Worker folder, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
environment.

The new version id is read from the wrangler output and written to the job
summary, so it can be copied into CLAUDE.md, which tracks version ids as the
record of what is live.

Both jobs use the GitHub Environment named `production`. No protection rule is
attached, so nothing waits. It costs nothing, gives a deployment history, and
makes adding an approval click later a dashboard change rather than a code
change.

## 6. Concurrency

Workflow level:

- group: the workflow name plus the git ref
- cancel in progress: true only when the event is `pull_request`

Superseded pull request runs are cancelled to save time. A run on `main` is
**never** cancelled, so a deploy is never killed halfway. Two quick merges
queue and deploy in order.

## 7. Pinned actions

Every action is pinned to a commit SHA, not a tag. A tag can be moved to point
at new code; a SHA cannot. Resolved on 2026-09-15:

| Action | Version | SHA |
|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/cache` | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |

These are the only three actions used.

## 8. Permissions

`permissions: contents: read` at the top of the file. The default `GITHUB_TOKEN`
is otherwise able to write to the repo, which nothing here needs.

## 9. Secrets

| Secret | State on 2026-09-15 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | set (`ea7be323…`) |
| `CLOUDFLARE_API_TOKEN` | **missing** |

The token must be created in the Cloudflare dashboard with exactly two
permissions: Account to Workers Scripts Edit, and Zone to Workers Routes Edit
scoped to `ramaaz.dev`.

The file `.cf-token`, which exists in both the home folder and `infra/`, holds
the **same** value in both places. It **is** a real Cloudflare API token — the
`cfat_` prefix is Cloudflare's own token format — but Cloudflare rejects it:

```
GET /client/v4/user/tokens/verify
→ success: false, error 1000 "Invalid API Token"
```

So the token was deleted or rolled in the dashboard, not mistyped and not from
another service. `infra/settings.tf` records the same error 1000 on 2026-08-24,
so it has been dead since at least then. A replacement must be created; the old
value cannot be revived. Both copies should be deleted.

An earlier revision of this file said the value was "some other service's key"
because it did not match the older 40-character unprefixed format. **That was
wrong and is retracted.**

The seven backend URL secrets in the repo are unused by this design.

## 10. Cleanup included in this work

`tsconfig.tsbuildinfo` is tracked in git. It is a build artifact that
`tsc --build` rewrites on every run, so it creates noise in diffs and can carry
stale incremental state into a fresh clone. It will be untracked and added to
`.gitignore`.

## 11. How this gets verified

GitHub Actions cannot be run locally in a way that proves the real thing. The
plan is therefore:

1. Open a pull request carrying the workflow file.
2. Confirm `test` runs and passes on the pull request, with 144 tests reported.
3. Confirm `changes`, `deploy-proxy` and `deploy-ingest` all show as **skipped**
   on that pull request. This is the guard that matters most.
4. Merge. Confirm `changes` selects the right Workers for what the merge
   touched.
5. With the token still missing, confirm the deploy job fails on authentication
   and not on anything else. That proves the wiring is right.
6. After the token is added, confirm a real deploy prints a version id, and that
   `https://trydos.ramaaz.dev/api/proxy` still answers with no `x-vercel-id`
   header, which is the marker that the Worker and not Vercel served it.

## 12. Known risks

- **No smoke test after deploy.** A deploy that passes unit tests but breaks in
  production is caught only by a human. Accepted by decision.
- **`pnpm install --frozen-lockfile` has not been proven on Linux.** It works on
  this Windows machine. Any platform-specific lockfile problem shows up on the
  first CI run.
- **workerd tests have not been proven on `ubuntu-latest`.** They pass on
  Windows. Same as above: the first run tells us.
- **Deploying on merge assumes `main` is always releasable.** There is no branch
  protection on the repo today, so a direct push to `main` skips pull request
  review and deploys. Worth adding a branch protection rule, but that is not
  part of this design.
