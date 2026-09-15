# CI/CD on GitHub Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run all 144 tests on every pull request, and deploy the two Cloudflare Workers automatically when a pull request merges to `main`.

**Architecture:** One workflow file, `.github/workflows/ci.yml`. A `test` job gates two deploy jobs through `needs`, so nothing reaches production unless every test passes. A `changes` job reads the changed file list and decides which Worker to deploy. The decision logic lives in a plain shell script with its own test suite, so the only real logic in this change can be tested on a laptop instead of only by pushing to GitHub.

**Tech Stack:** GitHub Actions, Node 22, pnpm 10.26.0, wrangler 4, bash.

**Spec:** `docs/superpowers/specs/2026-09-15-cicd-github-actions-design.md`

## Global Constraints

- Node version in CI: **22**.
- pnpm version: **10.26.0**, read from the `packageManager` field in `package.json`. Never hardcode it in a second place.
- Install command is always `pnpm install --frozen-lockfile`.
- Only `actions/*` actions are allowed. No third-party actions. The repo is public and holds a deploy credential.
- Every action is pinned to a commit SHA with the version in a trailing comment. The three allowed SHAs, resolved 2026-09-15:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
  - `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0)
  - `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9` (v6.1.0)
- Workflow-level `permissions: contents: read`.
- Values from `${{ github.event.* }}` must reach shell scripts through `env:`, never by direct interpolation into a `run:` block. Direct interpolation allows shell injection.
- Worker names are `trydos-proxy` (folder `workers/proxy`) and `trydos-ingest` (folder `workers/ingest`).
- Terraform is out of scope. No job may run `terraform` anything.

## Starting state

- Branch `main`, clean tree, one unpushed commit `d2ec913` (the spec).
- No `.github` directory exists yet.
- Repo secrets: `CLOUDFLARE_ACCOUNT_ID` is set. `CLOUDFLARE_API_TOKEN` is **missing** and must be created by the user in the Cloudflare dashboard.

---

### Task 1: Stop tracking the TypeScript build artifact

`tsconfig.tsbuildinfo` is committed. `tsc --build` rewrites it on every run, so it makes noise in every diff and can carry stale incremental state into a fresh clone. Remove it from git and ignore it.

**Files:**
- Modify: `.gitignore`
- Delete from git index (keep on disk): `tsconfig.tsbuildinfo`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on. This task is independent and can be reviewed on its own.

- [ ] **Step 1: Prove the file is tracked right now**

```bash
git ls-files | grep tsbuildinfo
```

Expected: prints `tsconfig.tsbuildinfo`. If it prints nothing, this task is already done — skip to Task 2.

- [ ] **Step 2: Add the ignore rule**

Add these two lines to `.gitignore`, directly under the existing `dist/` line:

```
# tsc --build writes this; it is a cache, not source.
tsconfig.tsbuildinfo
```

- [ ] **Step 3: Remove it from the index but keep the file on disk**

```bash
git rm --cached tsconfig.tsbuildinfo
```

Expected output: `rm 'tsconfig.tsbuildinfo'`

- [ ] **Step 4: Verify it is untracked and ignored**

```bash
git ls-files | grep tsbuildinfo ; echo "exit=$?"
git check-ignore -v tsconfig.tsbuildinfo
```

Expected: the first command prints nothing and `exit=1`. The second prints `.gitignore:<n>:tsconfig.tsbuildinfo	tsconfig.tsbuildinfo`.

- [ ] **Step 5: Verify a typecheck no longer dirties the tree**

```bash
pnpm typecheck
git status --short
```

Expected: `pnpm typecheck` exits 0, and `git status --short` shows only `.gitignore` and the staged deletion. It must NOT show `tsconfig.tsbuildinfo` as modified.

- [ ] **Step 6: Commit**

Stage only `.gitignore`. The deletion is **already staged** by `git rm --cached` in Step 3. Do not run `git add tsconfig.tsbuildinfo` — the file is now ignored, so git refuses to add it and the command exits non-zero.

```bash
git add .gitignore
git status --short
git commit -m "Stop tracking tsconfig.tsbuildinfo

tsc --build rewrites it on every run, so it dirties every diff and can
carry stale incremental state into a fresh clone. It is a cache, not
source."
```

---

### Task 2: The worker-selection script, written test-first

This holds the only real logic in the change: turning a list of changed files into a decision about which Workers to deploy. Write the test first so the rules from spec section 5.2 are pinned down before any code exists.

**Files:**
- Create: `.github/scripts/select-workers.sh`
- Test: `.github/scripts/select-workers.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `.github/scripts/select-workers.sh`. Contract, relied on by Task 3:
  - Reads changed file paths from **stdin**, one per line.
  - Writes exactly two lines to stdout: `proxy=true` or `proxy=false`, then `ingest=true` or `ingest=false`.
  - Accepts one optional argument, `--all`. With it, stdin is ignored and both lines are `true`.
  - Exits 0 on success. Exits 2 on an unknown argument.
  - The output format is deliberately `key=value` lines so the workflow can append it straight to `$GITHUB_OUTPUT`.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/select-workers.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for select-workers.sh. Run with: bash .github/scripts/select-workers.test.sh
#
# Each case feeds a changed-file list on stdin and compares the two output
# lines, joined by a space, against what we expect.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/select-workers.sh"
fails=0
ran=0

# check <name> <expected> <stdin-content>
check() {
  local name="$1" expected="$2" input="$3" actual
  ran=$((ran + 1))
  actual="$(printf '%s' "$input" | bash "$SCRIPT" | tr '\n' ' ' | sed 's/ *$//')"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name"
  else
    echo "  FAIL  $name"
    echo "          expected: [$expected]"
    echo "          actual:   [$actual]"
    fails=$((fails + 1))
  fi
}

# check_args <name> <expected> <arg...>
check_args() {
  local name="$1" expected="$2"; shift 2
  local actual
  ran=$((ran + 1))
  actual="$(bash "$SCRIPT" "$@" </dev/null | tr '\n' ' ' | sed 's/ *$//')"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name"
  else
    echo "  FAIL  $name"
    echo "          expected: [$expected]"
    echo "          actual:   [$actual]"
    fails=$((fails + 1))
  fi
}

echo "select-workers.sh"

# --- one Worker only ---
check "proxy source changed"  "proxy=true ingest=false"  'workers/proxy/src/index.ts
'
check "ingest source changed" "proxy=false ingest=true" 'workers/ingest/src/index.ts
'
check "proxy wrangler config changed" "proxy=true ingest=false" 'workers/proxy/wrangler.jsonc
'

# --- shared code and root config deploy both ---
check "shared package changed"  "proxy=true ingest=true" 'packages/shared/src/guards.ts
'
check "root package.json"       "proxy=true ingest=true" 'package.json
'
check "lockfile"                "proxy=true ingest=true" 'pnpm-lock.yaml
'
check "workspace file"          "proxy=true ingest=true" 'pnpm-workspace.yaml
'
check "root tsconfig"           "proxy=true ingest=true" 'tsconfig.json
'

# --- things that must deploy nothing ---
check "docs only"     "proxy=false ingest=false" 'CLAUDE.md
'
check "terraform only" "proxy=false ingest=false" 'infra/waf.tf
'
check "workflow only" "proxy=false ingest=false" '.github/workflows/ci.yml
'
check "empty input"   "proxy=false ingest=false" ''

# --- prefixes must be real directory prefixes, not substrings ---
check "path merely containing workers/proxy" "proxy=false ingest=false" 'docs/workers/proxy/notes.md
'
check "packages/sharedextra is not packages/shared" "proxy=false ingest=false" 'packages/sharedextra/x.ts
'

# --- combinations ---
check "proxy plus docs" "proxy=true ingest=false" 'workers/proxy/src/index.ts
CLAUDE.md
'
check "both Workers" "proxy=true ingest=true" 'workers/proxy/src/index.ts
workers/ingest/src/index.ts
'
check "docs plus shared still deploys both" "proxy=true ingest=true" 'REMAINING.md
packages/shared/src/ingest.ts
'

# --- the force-push fallback ---
check_args "--all ignores stdin" "proxy=true ingest=true" --all

echo
if [ "$fails" -eq 0 ]; then
  echo "All $ran checks passed."
else
  echo "$fails of $ran checks FAILED."
fi
exit "$fails"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash .github/scripts/select-workers.test.sh
```

Expected: every line reads `FAIL`, because `select-workers.sh` does not exist yet. The bash error will be `No such file or directory`. The final line reports `18 of 18 checks FAILED.` and the exit code is 18.

- [ ] **Step 3: Write the minimal implementation**

Create `.github/scripts/select-workers.sh`:

```bash
#!/usr/bin/env bash
# Decide which Workers to deploy from a list of changed files.
#
# Reads changed paths on stdin, one per line. Writes two key=value lines so
# the caller can append the result straight to $GITHUB_OUTPUT:
#
#     proxy=true|false
#     ingest=true|false
#
# Pass --all to skip stdin and select both. The workflow uses that when it
# cannot work out a base commit to diff against, for example after a force
# push. Over-deploying is harmless; under-deploying leaves stale code live.

set -euo pipefail

proxy=false
ingest=false

if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)
      echo "proxy=true"
      echo "ingest=true"
      exit 0
      ;;
    *)
      echo "select-workers.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    workers/proxy/*)
      proxy=true
      ;;
    workers/ingest/*)
      ingest=true
      ;;
    # Shared code and root config affect both Workers.
    packages/shared/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | tsconfig.json)
      proxy=true
      ingest=true
      ;;
  esac
done

echo "proxy=$proxy"
echo "ingest=$ingest"
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash .github/scripts/select-workers.test.sh
echo "exit=$?"
```

Expected: 18 `PASS` lines, then `All 18 checks passed.` and `exit=0`.

- [ ] **Step 5: Check the unknown-argument path by hand**

```bash
bash .github/scripts/select-workers.sh --nonsense </dev/null ; echo "exit=$?"
```

Expected: prints `select-workers.sh: unknown argument '--nonsense'` to stderr and `exit=2`.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/select-workers.sh .github/scripts/select-workers.test.sh
git commit -m "Add the worker-selection script with tests

Turns a changed-file list into a deploy decision for each Worker. The
logic lives in a script rather than inline YAML so it can be tested on a
laptop instead of only by pushing to GitHub.

18 checks cover each rule, the deploy-nothing paths, substring paths that
must not match, and the --all fallback used after a force push."
```

---

### Task 3: The composite setup action and the workflow

Three jobs need the same Node and pnpm setup, so it goes in a local composite action to avoid repeating it. Then the workflow itself.

**Files:**
- Create: `.github/actions/setup/action.yml`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `.github/scripts/select-workers.sh` and `.github/scripts/select-workers.test.sh` from Task 2.
- Produces:
  - A local composite action referenced as `./.github/actions/setup`. It takes no inputs. After it runs, `pnpm` is on the PATH at the version in `packageManager`, and `pnpm install --frozen-lockfile` has already been run.
  - Job outputs `changes.outputs.proxy` and `changes.outputs.ingest`, each the string `"true"` or `"false"`.

- [ ] **Step 1: Write the composite setup action**

Create `.github/actions/setup/action.yml`:

```yaml
name: Set up Node and pnpm
description: Installs Node 22 and the pinned pnpm, restores the pnpm store cache, and installs dependencies.

runs:
  using: composite
  steps:
    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: "22"

    # pnpm comes from the packageManager field so there is one source of
    # truth. We install it with npm rather than corepack: corepack has had
    # signature-verification failures with recent pnpm releases, and this
    # avoids that whole class of problem.
    - name: Install pnpm from the packageManager field
      shell: bash
      run: |
        PNPM_SPEC="$(node -p "require('./package.json').packageManager")"
        echo "packageManager field: $PNPM_SPEC"
        npm install --global "$PNPM_SPEC"
        pnpm --version

    - name: Find the pnpm store
      id: store
      shell: bash
      run: echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"

    - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
      with:
        path: ${{ steps.store.outputs.path }}
        key: pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
        restore-keys: |
          pnpm-${{ runner.os }}-

    - name: Install dependencies
      shell: bash
      run: pnpm install --frozen-lockfile
```

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

# Nothing here needs to write to the repo.
permissions:
  contents: read

concurrency:
  # Supersede an older pull request run, but never cancel a run on main:
  # cancelling one halfway through would kill a deploy.
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: ./.github/actions/setup

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test

      - name: Proxy worker tests (workerd)
        run: pnpm test:worker

      - name: Ingest worker tests (workerd)
        run: pnpm test:worker:ingest

      - name: Worker-selection script tests
        run: bash .github/scripts/select-workers.test.sh

  changes:
    name: which workers changed
    # Only ever runs on a push to main. On a pull request this job is
    # skipped, which skips both deploy jobs with it.
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    outputs:
      proxy: ${{ steps.select.outputs.proxy }}
      ingest: ${{ steps.select.outputs.ingest }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # Full history so the base commit of the push is present locally.
          fetch-depth: 0

      - name: Select workers
        id: select
        # These reach the script through env, never by interpolating
        # ${{ }} into the shell. Interpolation would allow injection.
        env:
          BEFORE: ${{ github.event.before }}
          AFTER: ${{ github.sha }}
        run: |
          set -euo pipefail
          ZEROS=0000000000000000000000000000000000000000

          if [ -z "$BEFORE" ] || [ "$BEFORE" = "$ZEROS" ] \
             || ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
            echo "Base commit '$BEFORE' is missing or unreadable — deploying both Workers."
            bash .github/scripts/select-workers.sh --all | tee -a "$GITHUB_OUTPUT"
            exit 0
          fi

          echo "Changed files between $BEFORE and $AFTER:"
          git diff --name-only "$BEFORE" "$AFTER" | tee changed-files.txt
          echo
          bash .github/scripts/select-workers.sh < changed-files.txt | tee -a "$GITHUB_OUTPUT"

      - name: Write the decision to the summary
        run: |
          {
            echo "### Deploy decision"
            echo ""
            echo "| Worker | Deploy |"
            echo "|---|---|"
            echo "| trydos-proxy | ${{ steps.select.outputs.proxy }} |"
            echo "| trydos-ingest | ${{ steps.select.outputs.ingest }} |"
          } >> "$GITHUB_STEP_SUMMARY"

  deploy-proxy:
    name: deploy trydos-proxy
    needs: [test, changes]
    if: needs.changes.outputs.proxy == 'true'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup

      - name: Deploy
        working-directory: workers/proxy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -o pipefail
          npx wrangler deploy 2>&1 | tee deploy.log

      - name: Record the version id
        if: always()
        working-directory: workers/proxy
        run: |
          VERSION=""
          if [ -f deploy.log ]; then
            VERSION="$(grep -oiE 'version id: *[0-9a-f-]{36}' deploy.log | tail -n 1 | grep -oE '[0-9a-f-]{36}' || true)"
          fi
          {
            echo "### trydos-proxy"
            if [ -n "$VERSION" ]; then
              echo "Deployed version: \`$VERSION\`"
              echo ""
              echo "Paste this into CLAUDE.md, which tracks version ids as the record of what is live."
            else
              echo "No version id found in the deploy output."
            fi
          } >> "$GITHUB_STEP_SUMMARY"

  deploy-ingest:
    name: deploy trydos-ingest
    needs: [test, changes]
    if: needs.changes.outputs.ingest == 'true'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./.github/actions/setup

      - name: Deploy
        working-directory: workers/ingest
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -o pipefail
          npx wrangler deploy 2>&1 | tee deploy.log

      - name: Record the version id
        if: always()
        working-directory: workers/ingest
        run: |
          VERSION=""
          if [ -f deploy.log ]; then
            VERSION="$(grep -oiE 'version id: *[0-9a-f-]{36}' deploy.log | tail -n 1 | grep -oE '[0-9a-f-]{36}' || true)"
          fi
          {
            echo "### trydos-ingest"
            if [ -n "$VERSION" ]; then
              echo "Deployed version: \`$VERSION\`"
              echo ""
              echo "Paste this into CLAUDE.md, which tracks version ids as the record of what is live."
            else
              echo "No version id found in the deploy output."
            fi
          } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 3: Check both YAML files parse**

```bash
python -c "
import yaml, sys
for p in ['.github/workflows/ci.yml', '.github/actions/setup/action.yml']:
    with open(p) as f:
        yaml.safe_load(f)
    print('parsed OK:', p)
"
```

Expected: `parsed OK:` for both files.

If Python has no `yaml` module, install it with `pip install pyyaml`, or fall back to:

```bash
node -e "
const fs=require('fs');
for (const p of ['.github/workflows/ci.yml','.github/actions/setup/action.yml']) {
  const t=fs.readFileSync(p,'utf8');
  if (t.includes('\t')) throw new Error('TAB character in '+p+' — YAML forbids tabs for indentation');
  console.log('read OK:', p, t.split('\n').length, 'lines');
}
"
```

- [ ] **Step 4: Check the job wiring by reading the parsed file, not by eye**

```bash
python -c "
import yaml
w = yaml.safe_load(open('.github/workflows/ci.yml'))
jobs = w['jobs']
print('jobs:', list(jobs))
assert set(jobs) == {'test','changes','deploy-proxy','deploy-ingest'}, jobs
for j in ['deploy-proxy','deploy-ingest']:
    assert jobs[j]['needs'] == ['test','changes'], (j, jobs[j].get('needs'))
    print(j, 'needs', jobs[j]['needs'], '| if:', jobs[j]['if'])
assert 'github.event_name == ' + chr(39) + 'push' + chr(39) in jobs['changes']['if']
print('changes if:', jobs['changes']['if'])
print('permissions:', w['permissions'])
"
```

Expected: the four job names, both deploy jobs showing `needs ['test', 'changes']`, the `changes` guard containing the push check, and `permissions: {'contents': 'read'}`.

- [ ] **Step 5: Confirm no third-party action slipped in and every action is SHA-pinned**

```bash
grep -rhoE "uses: [^ ]+" .github/ | sort -u
```

Expected exactly these four lines and nothing else:

```
uses: ./.github/actions/setup
uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
```

If any line shows `@v4` or any other tag instead of a 40-character SHA, fix it before committing.

- [ ] **Step 6: Commit**

```bash
git add .github/actions/setup/action.yml .github/workflows/ci.yml
git commit -m "Add the CI workflow and a shared setup action

One workflow. The test job gates both deploy jobs through needs, so no
Worker deploys unless typecheck and all 144 tests pass.

The changes job runs only on a push to main, so both deploy jobs are
skipped on pull requests. Fork pull requests get no secrets, so a fork
cannot deploy even by rewriting this file.

Every action is pinned to a commit SHA. Only actions/* are used."
```

---

### Task 4: Prove it on a real pull request

The workflow cannot be truly tested locally. This task runs it for real and checks the guard that matters most: deploy jobs must not run on a pull request.

**Files:** none changed. This task verifies the previous three.

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces: a merged `main` with working CI.

- [ ] **Step 1: Push the docs commits that are already on main**

The branch `ci/github-actions` was created from `main` **before** Task 1, so `main` carries only the spec, plan and corrections, and the branch carries only the CI work. Nothing needs moving.

**🔴 Never run `git reset --hard` on `main` here.** An earlier revision of this plan said to. It would destroy the plan and correction commits made after the design doc.

Push the docs commits so the pull request diff shows only the CI change:

```bash
git checkout main
git log --oneline origin/main..main
git push origin main
git checkout ci/github-actions
```

Expected: the log lists the docs commits, the push succeeds, and `main` on GitHub now carries the spec and plan.

- [ ] **Step 2: Push the branch and open the pull request**

```bash
git push -u origin ci/github-actions
gh pr create --title "Add CI/CD for the two Workers" \
  --body "Runs typecheck and all 144 tests on every pull request. Deploys trydos-proxy and trydos-ingest on merge to main, only for the Worker whose code changed.

Design: docs/superpowers/specs/2026-09-15-cicd-github-actions-design.md"
```

- [ ] **Step 3: Watch the run**

```bash
gh run watch "$(gh run list --branch ci/github-actions --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: the `test` job passes.

- [ ] **Step 4: Check the test job really ran all three suites**

```bash
RUN=$(gh run list --branch ci/github-actions --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN" --log --job "$(gh run view "$RUN" --json jobs --jq '.jobs[] | select(.name=="test") | .databaseId')" \
  | grep -E "Tests +[0-9]+ passed"
```

Expected: three lines showing `101 passed`, `31 passed` and `12 passed`.

- [ ] **Step 5: Confirm the deploy jobs were SKIPPED — this is the key check**

```bash
RUN=$(gh run list --branch ci/github-actions --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN" --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

Expected:

```
test: success
```

Only the `test` job should appear. `changes`, `deploy trydos-proxy` and `deploy trydos-ingest` must be absent or reported as `skipped`. **If any deploy job ran on the pull request, stop and fix the guard before merging** — that would mean a fork could reach production.

- [ ] **Step 6: Merge and watch the first real deploy attempt**

```bash
gh pr merge --squash --delete-branch
git checkout main && git pull
gh run list --branch main --limit 1
```

Then watch it:

```bash
gh run watch "$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
```

**⚠️ Corrected 2026-09-15. An earlier revision of this step said the merge would touch only `.github/**`, so `changes` would report `proxy=false ingest=false` and both deploy jobs would skip. That is wrong.**

The fix round on Task 3 added `--fail-if-no-match` to two scripts in the root `package.json`, and `package.json` is in the shared-file list that deploys **both** Workers. Measured against the real branch:

```
$ git diff --name-only main..ci/github-actions | bash .github/scripts/select-workers.sh
proxy=true
ingest=true
```

So the merge **is a real production deploy of both Workers**, not a no-op.

The risk is low but not zero. No Worker source file changed on this branch, so `wrangler deploy` uploads the same code that is already live, and the routes in both `wrangler.jsonc` files already match the four routes on the zone. The practical effect is two new version ids for identical code. It is, in fact, a free end-to-end proof of the deploy path.

Expected: `test` passes, `changes` reports `proxy=true ingest=true`, and both deploy jobs run and succeed. Confirm afterwards with Step 5 of Task 5 that production still answers and that neither `/api/proxy` nor `/ingest/static/array.js` has gained an `x-vercel-id` header.

If you want the merge to deploy nothing instead, move the `--fail-if-no-match` change to a separate pull request merged later.

- [ ] **Step 7: Record the outcome in CLAUDE.md**

Add this section to `CLAUDE.md`, directly after section 3.20. Fill in the run URL and the observed job results from Step 5 and Step 6 — do not copy the expectations, copy what actually happened.

```markdown
### 3.21 ✅ CI/CD on GitHub Actions (2026-09-15)

`.github/workflows/ci.yml`, four jobs: `test`, `changes`, `deploy-proxy`,
`deploy-ingest`. Repo is https://github.com/AlaaAsaad57/trydos-cf-worker.

`test` runs typecheck plus all three suites (101 + 31 + 12 = 144) on every
pull request and every push to `main`. Both deploy jobs declare
`needs: [test, changes]`, so no Worker deploys unless every test passes.

`changes` runs `only` on a push to `main` and decides which Worker to deploy
from the changed file list. The rules live in
`.github/scripts/select-workers.sh`, which has 18 tests of its own that CI
also runs. Shared code (`packages/shared/`, root config) deploys both. An
unreadable base commit deploys both, which is the safe direction.

**Deliberately NOT here, both user decisions on 2026-09-15:**

- **Terraform.** State is local at `infra/terraform.tfstate` and `apply` stays
  manual. Git cannot lock, so a shared state file in the repo would let a
  local apply and a CI apply overwrite each other.
- **No approval gate.** A merge to `main` reaches live shopper traffic in
  about a minute. The unit tests are the only thing in between.

⚠️ `main` has no branch protection, so a direct push skips review and deploys.

**Verified on the first run** (<paste run URL>): deploy jobs were skipped on
the pull request — that is the guard that stops a fork reaching production.
```

```bash
git add CLAUDE.md
git commit -m "Record what CI/CD does and what it deliberately does not do"
git push
```

---

### Task 5: Turn on deploys

Only start this once the user has created the Cloudflare API token. Until then Tasks 1 to 4 stand on their own and nothing deploys.

**Files:** none changed.

**Interfaces:**
- Consumes: a working `main` with CI from Task 4.
- Produces: a verified end-to-end deploy.

- [ ] **Step 1: Confirm the token has the Workers Scripts permission**

**Status on 2026-09-15:** the token is created, valid, active, with no expiry, and already stored as the repo secret `CLOUDFLARE_API_TOKEN`. Token id `52296368c9814c38193fa45aed57a7f2`. It is **account-owned**, not user-owned.

**🔴 Do not verify an account-owned token with `/user/tokens/verify`.** That endpoint answers error 1000 "Invalid API Token" for a perfectly good account token, which looks identical to a dead token. Use the account endpoint:

```bash
ACCT=ea7be3230557106b17d8e4a905ffe5bc
curl -s -H "Authorization: Bearer $(tr -d ' \r\n' < /path/to/token-file)" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/tokens/verify" \
  | python -c "import sys,json;d=json.load(sys.stdin);r=d.get('result') or {};print('success:',d.get('success'),'| status:',r.get('status'))"
```

Expected: `success: True | status: active`.

**Verifying is not enough.** A valid token can still lack the permission wrangler needs. Probe the two endpoints a deploy actually uses:

```bash
ACCT=ea7be3230557106b17d8e4a905ffe5bc
ZONE=df0581418328bcb0b4cde6d982f5c3ea
TOK="$(tr -d ' \r\n' < /path/to/token-file)"
for u in "accounts/$ACCT/workers/scripts" "zones/$ZONE/workers/routes"; do
  printf '%-40s ' "$u"
  curl -s -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/$u" \
    | python -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('success') else 'DENIED '+str([(e.get('code'),e.get('message')) for e in d.get('errors',[])]))"
done
```

Both must print `OK`.

**✅ Resolved 2026-09-15.** The token was initially one permission short — `workers/scripts` answered error 10000 while `workers/routes` answered OK. The user added **Account → Workers Scripts → Edit** and both now pass:

| Endpoint | Before | After |
|---|---|---|
| `workers/scripts` | DENIED, error 10000 | **OK**, 6 scripts |
| `workers/routes` | OK | OK, 4 routes |

The scripts list contains `trydos-proxy` and `trydos-ingest`, and all four expected routes are present including the trailing-`*` proxy patterns. So the token is pointed at the right account and zone. This step is complete; go straight to Step 3.

Worth remembering for next time: **editing a token's permissions does not change its value**, so the repo secret stayed correct and nothing needed re-pasting. Account-owned tokens live under **Manage Account → API Tokens**, not My Profile.

Do **not** reuse the value in the existing `.cf-token` files. That one is dead on both the user and the account verify endpoints — error 1000 either way, re-checked 2026-09-15, and already recorded in `infra/settings.tf` on 2026-08-24.

- [ ] **Step 1b: Delete the two dead token files**

Both hold the same rejected value. Leaving them invites someone to trust them later.

```bash
rm -f /c/Users/DELL/.cf-token
rm -f /c/Users/DELL/Desktop/workspace/TrydosApp/cf-worker/infra/.cf-token
ls -la /c/Users/DELL/.cf-token /c/Users/DELL/Desktop/workspace/TrydosApp/cf-worker/infra/.cf-token 2>&1
```

Expected: `No such file or directory` for both. Neither is tracked in git, so nothing needs committing.

- [ ] **Step 2: Confirm both secrets are present**

```bash
gh secret list --repo AlaaAsaad57/trydos-cf-worker | grep -E "CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)"
```

Expected: both lines present.

- [ ] **Step 3: Trigger a real deploy with a harmless change**

Deploy the lower-risk Worker first. `trydos-ingest` is an analytics relay; `trydos-proxy` carries shopper auth tokens. Add one comment line at the very top of `workers/ingest/src/index.ts`:

```ts
// Deployed by GitHub Actions since 2026-09-15. See .github/workflows/ci.yml.
```

Then:

```bash
git checkout -b ci/first-deploy
git add workers/ingest/src/index.ts
git commit -m "Trigger the first CI deploy of the ingest Worker"
git push -u origin ci/first-deploy
gh pr create --title "First CI deploy: ingest Worker" --body "Comment-only change. Proves the deploy path end to end on the lower-risk Worker."
```

Wait for the `test` job to pass, then merge:

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 4: Confirm only the ingest Worker deployed**

```bash
RUN=$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN" --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

Expected: `test: success`, `which workers changed: success`, `deploy trydos-ingest: success`. The job `deploy trydos-proxy` must be **skipped**, because nothing under `workers/proxy/` or `packages/shared/` changed.

- [ ] **Step 5: Confirm production still works**

```bash
curl -sS -o /dev/null -D - https://trydos.ramaaz.dev/ingest/static/array.js | grep -iE "^HTTP|x-vercel-id"
curl -sS -o /dev/null -D - https://trydos.ramaaz.dev/api/proxy | grep -iE "^HTTP|x-vercel-id"
```

Expected: both return a status line, and **neither shows an `x-vercel-id` header**. That header is the marker that Vercel served the request instead of the Worker. Its absence proves the Workers are still in front.

- [ ] **Step 6: Record the new version id**

Read the version id from the job summary of the deploy job and add it to `CLAUDE.md` section 3.19, which tracks what is live for the ingest Worker.

```bash
git add CLAUDE.md
git commit -m "Record the first Worker version deployed by CI"
git push
```

---

## Notes for whoever executes this

- **Do not run `terraform` anything.** It is excluded by decision. State is local and `apply` stays manual.
- **Deploy has no approval gate.** A merge to `main` reaches live shopper traffic in about a minute. If a deploy goes wrong, the fast rollback is to delete the Worker route in the Cloudflare dashboard, which sends traffic back to the Next route on Vercel. Read the rollback warning in `CLAUDE.md` section 3.20 first — it is weaker than it looks for the proxy Worker's GET contract.
- **`main` has no branch protection.** A direct push to `main` skips pull request review and deploys. Worth adding a rule, but it is out of scope here.
- **The `production` environment does not need to be created first.** GitHub creates an environment the first time a workflow references it. It has no protection rule, so nothing waits. Adding an approval click later is a dashboard change, not a code change.
- Three things could not be proven on the Windows development machine and will only show up on the first CI run: `pnpm install --frozen-lockfile` on Linux, the workerd tests on `ubuntu-latest`, and the exact wording wrangler uses for the version id, which the summary step greps for. Step 4 of Task 4 and Step 4 of Task 5 are where those surface.
