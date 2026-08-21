---
name: github-actions
description: Write, review, or debug GitHub Actions CI/CD - workflow triggers, job graph, permissions, SHA-pinned actions, caching, matrices, reusable workflows, environments and deployments. Use when creating or changing anything in .github/workflows, hardening a pipeline, cutting CI time, or reviewing a workflow diff.
---

# github-actions

Rules distilled from GitHub's official Actions documentation (secure-use reference,
workflow syntax, events reference, dependency caching, reusing workflow
configurations, deployments and environments). Every rule below is documented
behaviour of the platform, not taste.

Read [references/security.md](references/security.md) before touching a workflow that
handles secrets, deploys, or runs on `pull_request_target` / `workflow_run`.
Read [references/templates.md](references/templates.md) for ready workflow skeletons.

## 1. Shape of a pipeline

- **One workflow per purpose**, named by what it does: `ci.yml`, `release.yml`,
  `deploy-staging.yml`. Not one mega-workflow with `if:` everywhere.
- **Fast feedback first.** Cheap jobs (lint, typecheck, unit) run in parallel; slow
  or costly jobs (e2e, build image, deploy) sit behind `needs:`.
- **A job is a unit of isolation**, not a unit of logic. Each job gets a fresh runner:
  nothing carries over except artifacts, cache, and declared `outputs`.
- **Pass data between jobs explicitly**:
  ```yaml
  jobs:
    build:
      outputs:
        version: ${{ steps.meta.outputs.version }}
      steps:
        - id: meta
          run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
    deploy:
      needs: build
      run: echo "${{ needs.build.outputs.version }}"
  ```
- **Never `cd` between steps** - each `run` is its own shell. Use
  `defaults.run.working-directory` or per-step `working-directory`.
- **Set `timeout-minutes` on every job.** Default is 360 minutes; a hung job burns
  six hours of billable time.

## 2. Triggers

- `push` on the default branch and release branches; `pull_request` for validation.
  Running the same workflow on both `push` and `pull_request` doubles every PR run -
  filter branches instead.
- **Filter what you can**: `branches`, `paths`, `paths-ignore`, `types`. `paths`
  filters do not apply to tag pushes.
- `workflow_dispatch` on anything a human may need to rerun manually - it also
  unlocks cache writes on the default branch.
- `schedule` uses POSIX cron, minimum interval 5 minutes, only runs from the default
  branch, and is auto-disabled after 60 days of repository inactivity.
- `merge_group` is required if the repo uses a merge queue - otherwise required
  checks never report.
- `pull_request` from a fork gets a **read-only** `GITHUB_TOKEN` and **no secrets**.
  Design fork-facing CI so it needs neither.
- `pull_request_target` and `workflow_run` run with full write privileges and secrets
  against the base branch. Only use them when there is no alternative, and never
  check out the PR head in them. See [references/security.md](references/security.md).
- A path/branch-filtered job that is a required check will never report on skipped
  runs - use a "gate" job with `if: always()` that aggregates `needs` results, or
  configure the check as not required.

## 3. Permissions and secrets

- **Declare `permissions` at workflow level, minimum needed**, then widen per job:
  ```yaml
  permissions:
    contents: read
  ```
  Specifying any permission sets every unspecified one to `none`.
- **Prefer OIDC over stored cloud credentials.** `permissions: id-token: write` plus
  the cloud provider's login action gives short-lived, scoped tokens; no long-lived
  secret to rotate or leak.
- **Secrets are per-scope**: repository, organization, environment. Deployment
  credentials belong on the environment, behind protection rules.
- Reusable workflows can only **downgrade** the caller's token permissions, never
  raise them. Pass secrets explicitly, or `secrets: inherit` inside the same org.
- Never interpolate untrusted context (`github.event.*` titles, bodies, branch names)
  into a `run:` block. Bind it to `env:` first - see security reference.

## 4. Actions and versions

- **Pin third-party actions to a full-length commit SHA.** Tags are mutable; a SHA is
  the only immutable reference.
  ```yaml
  - uses: actions/checkout@a5ac7e51b41094c7d3f77357a4e3565d7674a291 # v5.0.0
  ```
  Keep the human-readable version in a trailing comment, and let Dependabot
  (`.github/dependabot.yml`, `package-ecosystem: github-actions`) bump them.
- First-party `actions/*` and `github/*` at a major tag is an accepted trade-off in
  many repos; anything else gets a SHA.
- **Prefer an existing official action over hand-rolled shell** (`actions/cache`,
  `actions/upload-artifact`, `setup-*`). Prefer a plain `run:` over a random
  marketplace action for a one-line task.

## 5. Speed

- **Cache dependencies via the `setup-*` action's built-in cache** when available
  (`setup-node` with `cache: npm`, `setup-python`, `setup-go`, `setup-java`); reach
  for `actions/cache` only for what they don't cover.
  ```yaml
  - uses: actions/cache@v4
    with:
      path: ~/.cache/build
      key: ${{ runner.os }}-build-${{ hashFiles('**/package-lock.json') }}
      restore-keys: ${{ runner.os }}-build-
  ```
- **Key on a lockfile hash, restore-key on the prefix.** A key without a hash never
  invalidates; a key without `restore-keys` never warms.
- Cache facts: 10 GB per repository, evicted by least-recently-used, deleted after 7
  days unused. Caches are readable from the current branch, the base branch and the
  default branch - not from sibling branches. Only `push`, `workflow_dispatch`,
  `repository_dispatch` and `schedule` may write default-branch caches.
- **Never cache secrets or credentials** - anyone who can open a PR can read base
  branch caches.
- **Cancel superseded runs** on PR branches:
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```
  For deployments do the opposite: same group per environment, `cancel-in-progress:
  false`, so releases queue instead of racing.
- **Matrix for real variation only** (OS, runtime version). `fail-fast: false` when
  you want the full failure picture; `max-parallel` when a shared resource is behind
  the job.
- Build once, deploy many: produce an artifact/image in one job and consume it
  downstream, rather than rebuilding per environment.

## 6. Reuse

- **Reusable workflow** (`on: workflow_call`) when sharing whole jobs across repos or
  workflows - typed `inputs`, `secrets`, `outputs`; called with
  `uses: owner/repo/.github/workflows/x.yml@sha`. Limits: 10 nesting levels, 50
  unique called workflows per caller. Caller-level `env` is **not** propagated.
- **Composite action** when sharing a sequence of *steps* inside a job.
- **Starter/template workflow** (in the org `.github` repo) when teams need a
  scaffold they will then own and edit.
- Don't reach for reuse before the third copy; two similar workflows are cheaper to
  read than one parameterised one.

## 7. Deployment

- **Every deploy job declares `environment:`** - that's what binds protection rules,
  environment secrets, and the deployment record in the UI:
  ```yaml
  deploy:
    environment:
      name: production
      url: ${{ steps.deploy.outputs.url }}
  ```
- Gate production with required reviewers, a wait timer, or branch/tag restrictions -
  configured on the environment, not in YAML `if:`.
- Promote the *same artifact* through staging → production. Rebuilding per stage
  means the thing you tested is not the thing you shipped.
- Make deploy steps idempotent and re-runnable; a rerun after a network blip must not
  double-apply.

## 8. Review checklist

Read a workflow diff against these, in order of consequence:

1. Untrusted input reaching `run:`, or `pull_request_target`/`workflow_run` checking
   out PR head.
2. Missing or over-broad `permissions`; secrets available to fork PRs.
3. Unpinned third-party actions.
4. No `timeout-minutes`; no `concurrency` on PR or deploy workflows.
5. Cache key that never invalidates, or caches holding credentials.
6. Required checks that can be skipped by a path filter.
7. Rebuild instead of artifact promotion; non-idempotent deploy step.
8. Steps that duplicate a `setup-*` built-in, or logic that belongs in a script the
   developer can run locally.
