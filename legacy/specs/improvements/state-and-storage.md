# Improvement — state and storage

Status: **deferred improvement. Not part of the MVP contract.**

[`../mvp.md`](../mvp.md) is the implementation contract and is being built as
written. This document supersedes nothing. Where the two disagree, `mvp.md`
wins.

Nothing here is scheduled. Revisit after the M0–M12 flow is live-verified, or
earlier if a listed limitation actually bites.

Question: does Docket need a database, and does GitHub provide a built-in
substitute?

Short verdict:

1. GitHub has **no built-in database or key-value store**. It has six durable
   primitives that cover most of Docket's state, and two of them are stronger
   than what `mvp.md` currently plans to use.
2. Those primitives are enough for M0–M12. **Keep the no-database rule.**
3. They are *not* enough for the UI (M13), for audit beyond 90–400 days, or for
   any writer outside GitHub Actions. A database is required there.
4. When it arrives, the database must be a **read model / projection**, not the
   system of record. GitHub keeps the merge gate, the tokens and the truth.

---

## 1. State inventory

Every piece of state Docket handles, with its real lifetime and access pattern.

| # | State | Lifetime | Access pattern | Home |
| --- | --- | --- | --- | --- |
| S1 | Desired config: environments, branches, org refs, policy, tests, hooks | permanent, versioned | read one file at an exact commit | Git — `docket.yml` at the PR base commit |
| S2 | Merge-gate verdict for the current PR head | life of the PR | read/write by SHA | GitHub Check Run — nothing else can block the Merge button |
| S3 | Validated plan + manifests (validate → deploy handoff) | hours to days, integrity critical | write once, read once by exact identity | GHCR OCI blob (digest) + Actions artifact copy |
| S4 | Manual pre/post step status and who completed it | life of the run | write once, immutable | GitHub Environment required reviewers + Check Run |
| S5 | Per-org deployment serialization | seconds to hours | mutual exclusion | Actions `concurrency` group with `queue: max` |
| S6 | Deployment record: which SHA went to which org, when, result | permanent | append, read by repo/env | Deployments API + immutable run bundle in GHCR |
| S7 | Cross-run queries, history, dashboards | permanent | arbitrary filters, aggregates, joins | **Postgres (phase 2)** |
| S8 | Salesforce credentials | — | — | never in Docket: GitHub Environment secrets, or OIDC to Salesforce |

S1–S6 are GitHub-native. S7 is the only category that genuinely needs a
database. S8 must never touch either.

---

## 2. GitHub built-ins, evaluated

| Mechanism | Durable? | Queryable? | Verdict for Docket |
| --- | --- | --- | --- |
| **Check Runs** | life of the commit | no | **Required.** Only mechanism that gates the native Merge button. Already in spec. |
| **Deployments API** | latest status permanent; *previous* statuses purged after 90 days | by repo/env/ref only | **Adopt.** GitHub's built-in deployment ledger. `payload` is a free-form JSON field; carry the validated-plan identity there. `description` capped at 140 chars. |
| **Environments** | permanent config | n/a | **Adopt.** Required reviewers = manual pre-deployment steps, with GitHub's own approval UI, audit log and self-review prevention. Max 6 protection rules per environment. Custom rules can be driven by a GitHub App. |
| **Actions artifacts** | 90 days default; public repos 1–90, private 1–400 | no | Keep for the fast handoff path only. **Not** audit storage — this is the retention hole `mvp.md` §4 already flags. |
| **Actions `concurrency`** | run-scoped | no | **Adopt with `queue: max`** (shipped 2026-05-07): up to 100 runs wait FIFO instead of the pending one being cancelled. This fixes the silent-cancellation flaw in the default behaviour. Cannot be combined with `cancel-in-progress: true`. |
| **GHCR / OCI packages (ORAS)** | no documented expiry; deletion restorable within 30 days | by tag/digest only | **Adopt.** Permanent, content-addressed blob store. `GITHUB_TOKEN` with `packages: write` publishes it and auto-links the repo. The digest *is* an integrity check for free. |
| **Release assets** | permanent | no | Alternative to GHCR. Rejected: pollutes the customer's release list. |
| **Actions variables** | mutable, no history | no | 48 KB each, 500 per repo, 100 per environment, 256 KB combined per run. Mutable with no audit trail — unusable for run state. |
| **Actions cache** | evicted when unused | no | Never for correctness state. |
| **Artifact attestations** | Sigstore bundle stored by GitHub; retention undocumented | no | Interesting later for tamper-evident "this plan was validated by this workflow". Not load-bearing. |
| **Issues / Projects as a store** | permanent | weakly | Rejected: rate limits, schema-less, and it dumps Docket's internals into the customer's issue tracker. |
| **Orphan Git branch as a store** | permanent | git-log only | Rejected as primary: push contention needs a retry loop, repo grows forever, bot pushes trigger workflows. Keep as an *optional* self-hosted audit export. |

---

## 3. Where GitHub-native actually breaks

These are the only reasons to add a database. Each is concrete.

**G1 — No queries.** "All runs against QA in the last 30 days", "median
validation time", "which Apex classes deploy most often", "why is this PR
blocked" — each becomes N REST calls. A GitHub App installation gets a minimum
of 5,000 requests/hour (+50/hour per repo above 20, +50/hour per user above 20,
capped at 12,500; 15,000 for Enterprise Cloud). One dashboard page over a
moderately busy org burns that. **This is the real driver.**

**G2 — Retention.** Artifacts die at 90 days (public) or 400 (private), logs
with them, previous deployment statuses at 90 days. Salesforce enterprise buyers
expect multi-year deployment audit. GHCR closes most of this hole; queryable
history still needs a database.

**G3 — No transactions or compare-and-swap.** `concurrency` serializes *Actions
runs*, not arbitrary writers. The spec's own local CLI path (M6) can deploy to
the same org from a laptop while an Actions deploy is in flight. Nothing in
GitHub prevents that. A `SELECT … FOR UPDATE` or a PG advisory lock does.

**G4 — Nothing spans repositories.** Multi-repo release trains, per-customer
dashboards and multi-tenant control plane have no GitHub-native home. Currently
a non-goal, but it is where the product goes.

**G5 — Latency.** GitHub's API is too slow to render a UI from directly.

---

## 4. Decision

### Phase 1 — M0 through M12: no database, with three upgrades

The no-database rule stands. Three changes make the GitHub-native design
correct rather than merely sufficient:

- **U1 — Publish the validated plan bundle to GHCR.** Push `plan.json`,
  `package.xml`, `destructiveChanges.xml` and `validation.json` as an OCI
  artifact via ORAS to `ghcr.io/<owner>/<repo>-docket-plans`, tagged with the
  head SHA. The OCI digest becomes the validated-plan identity from §5 Phase C.6
  of `mvp.md`. This kills the retention hole and the integrity check in one
  move. Keep the Actions artifact as the fast local copy.
- **U2 — Record every deployment through the Deployments API.** `environment` =
  the Docket environment id, `payload` = the validated-plan identity tuple plus
  the OCI digest. The latest status is retained permanently, so this becomes the
  permanent spine of deployment history at zero infrastructure cost.
- **U3 — Fix the lock and the manual steps.** `concurrency: docket-deploy-<orgId>`
  with `queue: max` for FIFO per-org serialization. Use Environment **required
  reviewers** for manual pre-deployment steps instead of hand-rolled check runs
  — GitHub then supplies the approval UI, the identity of the approver, the
  audit log entry and self-review prevention for free.

M12.4 ("verify the code MVP runs without a database") stays as the honest test
of this phase.

### Phase 2 — M13 and the UI: Postgres as a read model

Add a database only when the UI starts, and only in this shape:

- Fed by GitHub webhooks: `pull_request`, `check_run`, `workflow_run`,
  `deployment_status`. Every write keyed by the webhook `delivery_id` for
  idempotency.
- **Rebuildable.** Dropping the database must lose nothing of record — replaying
  the GitHub API plus the GHCR bundles must reconstruct it. This is the
  invariant that keeps GitHub as the system of record.
- Serves queries, dashboards, history and cross-repo views. Never serves the
  merge gate.

### Engine: Postgres, not SQLite

`mvp.md` §4 already states the rule and the rule already decides it: multiple
processes and remote writers (webhook handler, UI server, workers) rule SQLite
out. Two further reasons:

- Salesforce DevOps buyers are conservative enterprises. Many will refuse a SaaS
  that sits in their production deployment path, so **Docket must be
  self-hostable**. Postgres in Docker is the least controversial dependency in
  that market.
- Relational shape: runs ↔ environments ↔ steps ↔ components ↔ Salesforce
  deployments, with time-range aggregates. This is exactly what a relational
  engine is for. A document store would be a downgrade.

Use plain SQL through Drizzle or Kysely, with migrations, and **no
provider-specific features**. Then hosting is an unlocked choice: Neon for dev
and SaaS (serverless, scale-to-zero, cheap branching — its 2026 free tier is
roughly 100 CU-hours/month and 0.5 GB per project; re-verify before relying on
it), the customer's own Postgres for self-hosted. Supabase only if its bundled
auth and realtime are wanted for the UI; Cloudflare D1 and Turso are rejected
because they add a second SQL dialect and self-host friction for no gain here.

SQLite keeps exactly one legitimate role, later and optional: a non-authoritative
local CLI cache at `~/.docket/cache.db`, single process, single machine.

---

## 5. Projection schema sketch

Illustrative, for phase 2. Every table carries provenance so any row can be
re-derived from GitHub.

```text
installations      (id, account, installed_at)
repositories       (id, installation_id, owner, name)
environments       (id, repo_id, docket_env_id, target_branch, sf_org_id)
runs               (id, repo_id, pr_number, base_sha, head_sha, env_id,
                    kind: validate|deploy|rollback, status, plan_digest,
                    gh_run_id, gh_deployment_id, started_at, finished_at)
plan_components    (run_id, metadata_type, member, change: added|modified|deleted)
steps              (run_id, ord, kind: gate|pre|post|manual, name, status,
                    exit_code, approver_login, completed_at)
sf_deployments     (run_id, sf_deployment_id, sf_org_id, tests_mode,
                    tests_run, coverage_pct, status)
org_locks          (sf_org_id PK, run_id, acquired_at, expires_at)   -- only once a non-Actions writer exists
gh_events          (delivery_id PK, event_type, received_at, payload) -- idempotency + replay
```

### Invariants

1. No secrets, credentials or session tokens — ever.
2. No desired configuration — that lives in `docket.yml`.
3. The database never gates a merge. The Check Run does.
4. Every row is re-derivable from `gh_run_id` / `gh_deployment_id` /
   `plan_digest`.
5. Deleting the database is an availability incident, never a data-loss
   incident.

---

## 6. Edits this improvement would need in `mvp.md`

Deferred — none of these are applied. Listed so the cost is known if the
improvement is ever adopted.

- §4, runtime-state list: add the GHCR plan bundle (U1) and the Deployments API
  record (U2) as the durable pair; keep artifacts as the fast path.
- §4, storage paragraph: replace "Do not add SQLite during M0–M13" with "no
  database is the system of record; a Postgres read model arrives with the UI at
  M13".
- §5 Phase C.6: the validated-plan identity is the OCI digest of the plan bundle.
- §5 Phase D.4: retrieve the plan from GHCR by digest; the Actions artifact
  becomes a fallback, not the only source.
- M8.6: retrieve by digest, verify the digest before use.
- M10.4: implement the manual pre-deployment step as an Environment required
  reviewer, not a hand-rolled check.
- M12.1: `concurrency` with `queue: max`; add a negative check that a third
  queued deploy is not silently dropped.
- New **M12.5** — publish the run bundle to GHCR and prove it survives artifact
  expiry. Check: after the Actions artifact is deleted, the plan and manifests
  are still retrievable by digest.
- §9 non-goals: keep "multi-tenant control plane"; reword the database entry to
  "no runtime database as the system of record before M13".
