# Docket MVP — code-first deployment prototype

Status: M0–M12 code paths are implemented; completed checklist gates are
fixture-verified. Live GitHub Actions and Salesforce acceptance remains pending
where marked.

The [original handwritten notes](./source-notes.md) are preserved separately.
Deferred ideas live in [`improvements/`](./improvements/) and do not change this
contract.

## 1. MVP outcome

The first complete slice is:

```text
one same-repository GitHub PR
  → one configured Salesforce QA/sandbox org
  → visible partial/destructive deployment plan
  → validation with configured tests
  → required GitHub validation check becomes green
  → user merges the PR with the native GitHub Merge button
  → merge automatically triggers a regular deployment of the validated plan
  → recorded deployment result
```

The code and configuration are completed before UI implementation starts.

## 2. Working method

Each implementation step must be small enough to:

1. implement independently;
2. verify with one focused positive check;
3. verify with one focused negative check;
4. inspect its output immediately;
5. stop before the next behavior is added.

Verification labels:

- **code** — implemented but not executed against a fixture/provider;
- **fixture** — deterministic local checks pass;
- **live** — accepted by real GitHub Actions or a real non-production
  Salesforce org.

Fixture success is never reported as live acceptance.

## 3. Fixed decisions

| Area | MVP decision |
| --- | --- |
| VCS | GitHub only. |
| Source change | One open, non-draft, same-repository pull request. |
| Target | One QA/sandbox environment from `docket.yml`. |
| Delta | Implemented by Docket, starting with `ApexClass`. |
| Engine | TypeScript running on Node.js. |
| Configuration | Declarative `docket.yml`. |
| Shell | Bash only for small, explicitly referenced hook scripts. |
| Remote execution | GitHub Actions. |
| Local execution | The same engine and deployment contract through CLI. |
| Workspace | Every run uses a clean isolated workspace checked out at the exact commit SHA. |
| Identity | Exact repository, PR, base SHA, head SHA, org and policy tuple. |
| Tests | All tests or an explicit manual list. |
| Deployment | A green validation check allows native GitHub Merge; the merge automatically triggers a new regular Salesforce deployment using the validated plan and test configuration. |
| Runtime state | No database in the code MVP: GitHub checks, workflow artifacts, concurrency groups and non-secret JSON run records. |
| Rollback | A compensating GitHub PR through the normal deployment flow. |
| UI | Final stage after code/configuration live acceptance. |

Secrets and Salesforce credentials are never stored in Git, YAML or run
artifacts.

## 4. Configuration boundary

`docket.yml` describes:

- pipeline environments and target branches;
- Salesforce org references, never credentials;
- destructive-change policy;
- Apex test selection;
- quality gates;
- ordered automatic pre/post hooks and manual pre-deployment steps.

The TypeScript engine performs Git operations, metadata mapping, manifest
generation, validation, deployment, rollback calculation and status handling.

Trusted execution configuration is read from the PR base commit. An unmerged PR
must not change commands that execute with deployment credentials.

Candidate quality checks run without deployment credentials. Any hook that
receives Salesforce credentials is resolved from the trusted base commit, not
from the PR head. A gate also runs without the runner's own tokens: the
`ACTIONS_*` variables mint OIDC identities and write artifacts, so they are
stripped alongside the Salesforce ones.

This guarantee stops at the workflow file. GitHub runs a `pull_request` workflow
from the pull request's own merge ref, so an unmerged change can rewrite the
steps that invoke Docket — including the step holding the Salesforce
credential — and no engine-side rule can prevent that. The credential is
therefore protected by the GitHub Environment it belongs to: the `qa`
environment must carry required reviewers, so a candidate commit cannot reach it
without a person approving that run. Naming an environment on a job is not by
itself a gate.

The engine is installed from a pinned reference, never resolved by name at run
time: an unrelated `docket` package exists on the public npm registry, and a
bare `npx docket` would execute it inside the job that holds the credential.

Every operation runs in a clean isolated workspace at the exact commit SHA. A
GitHub-hosted runner uses its fresh job workspace; the local executor creates a
temporary isolated copy. Local uncommitted/untracked files never enter a run,
and temporary local workspaces are cleaned up after success, failure or
cancellation.

### Configuration versus runtime state

`docket.yml` stores desired configuration only. It is never rewritten with
validation results, run status, manual-step completion, locks or deployment
history.

For the code MVP, runtime state uses GitHub-native storage:

- a required GitHub check stores the validation verdict and identifies the
  originating workflow run for the PR head;
- validation artifacts store `plan.json` and `validation.json` under an exact
  PR/head-SHA artifact name;
- the post-merge workflow uses that exact run ID and a scoped GitHub token to
  retrieve the validation artifacts;
- pending/completed manual-step status is represented by required GitHub checks
  and immutable step-result artifacts;
- a GitHub Actions concurrency group keyed by the verified target org serializes
  deployment and queues up to 100 pending runs;
- GitHub workflow/deployment status exposes success or failure.

Run artifacts are retained according to GitHub repository settings, so they are
not permanent audit storage. A workflow run records its own expiry in `run.json`
from the runner's `GITHUB_RETENTION_DAYS`, and the history projection reports how
much of it is bounded. The MVP promises no history beyond that window.

Do not add SQLite during M0–M13. Revisit storage only after a working flow proves
that GitHub-native state is insufficient. If a later single-process Docket
service with durable local disk needs queryable state, use SQLite. If multiple
processes or remote GitHub-hosted writers need shared state, use PostgreSQL or
another shared store instead of SQLite.

The M12 fixture audit records three code-MVP limits rather than hiding them:

- the Actions concurrency group does not serialize a direct local CLI deploy;
- history and rollback depend on retained or separately exported run artifacts;
- `queue: max` is bounded to 100 pending deployments per concurrency group.

## 5. Deployment process

### Phase A — Prepare

1. Receive `repository`, `pullRequest` and `environmentId`.
2. Freshly read the GitHub PR.
3. Require an open, non-draft, same-repository PR.
4. Read trusted `docket.yml` from the exact base commit.
5. Require the PR target branch to match the configured environment.
6. Resolve exact `baseSha`, `headSha` and expected Salesforce org.
7. Fetch and checkout the exact candidate SHA in a clean isolated workspace.

### Phase B — Build the plan

1. Compare the exact base and head commits.
2. Classify metadata as added, modified, deleted or renamed.
3. Generate `package.xml` for deployable changes.
4. Generate destructive manifests for deletions.
5. Add tests, gates and configured pre/post steps.
6. Reject destructive changes when the environment policy forbids them.
7. Write deterministic `plan.json` and a human-readable report.

### Phase C — Validate

1. Run required non-mutating candidate quality gates without deployment
   credentials.
2. Run configured trusted pre-validation hooks.
3. Execute Salesforce validation against the expected org.
4. Run all or explicitly selected Apex tests.
5. Treat CLI errors, failed tests or failed gates as validation failure.
6. Persist the validation result and exact validated-plan identity:
   `repository + PR + baseSha + headSha + orgId + tests + deletion policy +
   manifest digests`.
7. Require all manual pre-deployment steps to be completed.
8. Publish a required GitHub validation check for the current PR head.
9. Require the PR to stay up to date with its target branch; a changed base or
   head invalidates the check and requires validation again.

### Phase D — Merge and deploy

1. GitHub enables Merge only while the required validation check is green for
   the current PR head.
2. The user presses the native GitHub Merge button.
3. The merged-PR event automatically starts the deployment workflow.
4. The workflow retrieves the originating validated plan and manifests.
5. Freshly verify the merged PR, base/head SHAs, org mapping and unchanged
   validated-plan identity.
6. Record the GitHub merge commit in the deployment run.
7. Serialize deployment for the target org.
8. Start a new regular Salesforce deployment using the exact manifests,
   destructive policy and test selection from the validated plan.
9. Record the new Salesforce deployment ID and result.
10. Always release the org lock, including after failure.

### Phase E — Finish

1. Run configured post-deployment steps.
2. Record automatic/manual step results.
3. Write non-secret deployment artifacts and final `run.json`.
4. Report the final result to GitHub.

Validation failure blocks Merge. A deployment failure happens after Merge, so it
cannot undo the merge: GitHub must show the failed deployment and recovery uses
a fix or revert PR through the same process.

## 6. Run artifacts

Each run produces a directory containing:

```text
plan.json
package.xml
destructiveChanges.xml        # only when required
validation.json
deployment.json               # only after deployment
run.json
report.md
logs/
```

`run.json` is introduced before a database. It provides the immutable input
needed for the post-merge deployment, audit and later rollback prototypes. It is
uploaded as a GitHub Actions artifact and is never committed to the
configuration branch.

A rollback calculation additionally produces `rollback-plan.json` plus its
inverse manifests and report. A history projection produces `history.json` and
`history.md`. Neither artifact contains restored Apex source bytes or secrets.

## 7. Super-small implementation steps

Complete these steps in order. Do not start the next step until the current
check passes.

### M0 — Executable skeleton

- [x] **M0.1** Initialize Node.js + TypeScript. *(fixture)*  
  Check: one test runs and passes.
- [x] **M0.2** Add `docket --help` and `docket --version`. *(fixture)*  
  Check: valid commands exit 0; unknown command exits non-zero.
- [x] **M0.3** Add structured success/error results. *(fixture)*  
  Check: one command returns deterministic JSON; invalid input has a stable
  error code.

### M1 — Exact Git changes

- [x] **M1.1** Create a temporary Git fixture with exact base/head commits. *(fixture)*  
  Check: the fixture exposes both full SHAs.
- [x] **M1.2** Read one added path from the exact diff. *(fixture)*  
  Check: changing either SHA changes the result.
- [x] **M1.3** Parse one modified path. *(fixture)*  
  Check: status is `modified`.
- [x] **M1.4** Parse one deleted path. *(fixture)*  
  Check: status is `deleted`.
- [x] **M1.5** Parse one rename without losing either path. *(fixture)*  
  Check: old and new paths are present.
- [x] **M1.6** Reject missing/invalid refs. *(fixture)*  
  Check: command exits non-zero and produces no manifest.

### M2 — ApexClass manifests

- [x] **M2.1** Map one Apex class path to its metadata member. *(fixture)*  
  Check: `force-app/main/default/classes/Foo.cls` becomes `Foo`.
- [x] **M2.2** Generate `package.xml` for one added class. *(fixture)*  
  Check: exact XML snapshot passes.
- [x] **M2.3** Generate the same manifest for one modified class. *(fixture)*  
  Check: no duplicate member is produced.
- [x] **M2.4** Generate `destructiveChanges.xml` for one deleted class. *(fixture)*  
  Check: `Foo` is absent from deployable members.
- [x] **M2.5** Sort mixed members deterministically. *(fixture)*  
  Check: repeated runs are byte-identical.
- [x] **M2.6** Reject unsupported or malformed metadata paths. *(fixture)*  
  Check: failure is explicit, not silently ignored.

### M3 — Minimal `docket.yml`

- [x] **M3.1** Parse one QA environment with branch and org reference. *(fixture)*  
  Check: normalized config snapshot passes.
- [x] **M3.2** Parse destructive-change policy. *(fixture)*  
  Check: only real YAML booleans are accepted.
- [x] **M3.3** Parse all-tests mode. *(fixture)*  
  Check: deployment plan contains the expected test mode.
- [x] **M3.4** Parse an explicit Apex test list. *(fixture)*  
  Check: empty or malformed lists fail.
- [x] **M3.5** Reject missing/unknown environment IDs. *(fixture)*  
  Check: no runner command is created.

### M4 — Deployment plan

- [x] **M4.1** Combine refs, environment and manifests into `plan.json`. *(fixture)*  
  Check: exact plan snapshot passes.
- [x] **M4.2** Add the validated-plan identity. *(fixture)*  
  Check: changing any tuple field changes the plan identity.
- [x] **M4.3** Enforce the deletion policy. *(fixture)*  
  Check: deletions fail closed when disabled.
- [x] **M4.4** Produce `report.md`. *(fixture)*  
  Check: added/modified/deleted components and tests are visible.
- [x] **M4.5** Verify deterministic output. *(fixture)*  
  Check: the same inputs produce byte-identical artifacts.

### M5 — Safe process runner

- [x] **M5.1** Spawn a command with an argument array and no shell. *(fixture)*  
  Check: stdout, stderr and exit code are captured.
- [x] **M5.2** Add timeout/cancellation. *(fixture)*  
  Check: a hanging fixture is terminated and reported failed.
- [x] **M5.3** Add a fake `sf` validation success. *(fixture)*  
  Check: the validation result is parsed into `validation.json`.
- [x] **M5.4** Add fake CLI/test failure. *(fixture)*  
  Check: run verdict is non-zero.
- [x] **M5.5** Write initial `run.json` without secrets. *(fixture)*  
  Check: a secret-pattern scan of artifacts passes.

### M6 — Local live QA path

- [x] **M6.1** Resolve a configured local Salesforce alias to the expected org ID. *(fixture)*  
  Check: wrong or disconnected org is rejected.
- [ ] **M6.2** Live-validate one added Apex class in QA. *(code — awaiting a live org)*  
  Check: Salesforce returns a successful validation result.
- [ ] **M6.3** Persist the real validated-plan identity. *(code — awaiting a live org)*  
  Check: run artifacts contain exact non-secret identity.
- [ ] **M6.4** Start a regular local deployment from that exact plan. *(code — awaiting a live org)*  
  Check: Salesforce confirms deployment success.
- [x] **M6.5** Reject changed SHA, org, tests or deletion policy. *(fixture)*  
  Check: no deploy command is executed.
- [ ] **M6.6** Prove deployment is a new Salesforce operation. *(code — awaiting a live org)*  
  Check: it has its own deployment ID and uses the same configured tests.

### M7 — GitHub PR input

- [x] **M7.1** Read one GitHub PR and resolve exact base/head SHAs. *(fixture)*  
  Check: full SHAs match GitHub.
- [x] **M7.2** Reject fork, closed and draft PRs. *(fixture)*  
  Check: each case produces a focused failure.
- [x] **M7.3** Require the configured target branch. *(fixture)*  
  Check: wrong-base PR is rejected.
- [x] **M7.4** Read trusted `docket.yml` from the base commit. *(fixture)*  
  Check: a PR-edited command is not executed.
- [x] **M7.5** Checkout the exact head SHA in a clean isolated workspace. *(fixture)*  
  Check: local uncommitted/untracked files cannot affect the run and cleanup
  happens after success or failure.
- [x] **M7.6** Build the same local plan from a real PR. *(fixture)*  
  Check: artifacts identify the PR and exact SHAs.

### M8 — GitHub Actions executor

- [ ] **M8.1** Add a minimal fixture workflow. *(code — awaiting a live run)*  
  Check: GitHub Actions returns the fixture verdict and artifacts.
- [ ] **M8.2** Add explicit `validate` inputs for PR and environment. *(code — awaiting a live run)*  
  Check: a real workflow builds the same plan as local execution.
- [ ] **M8.3** Run live Salesforce validation from GitHub Actions. *(code — awaiting a live run)*  
  Check: validation artifacts contain the real result and validated plan.
- [x] **M8.4** Publish a required validation check for the current PR head. *(fixture)*  
  Check: failed/stale validation keeps the GitHub Merge button blocked.
- [x] **M8.5** Trigger deployment only from a merged-PR event. *(fixture)*  
  Check: closing without merge does not start deployment.
- [x] **M8.6** Retrieve the originating validation artifacts. *(fixture)*  
  Check: the workflow uses the exact originating run ID plus a scoped token and
  retrieves the exact plan and manifests.
- [x] **M8.7** Verify the validated-plan identity before deployment. *(fixture)*  
  Check: mismatched input is rejected before Salesforce mutation.
- [ ] **M8.8** Run a regular deployment of the exact validated plan. *(code — awaiting a live run)*  
  Check: GitHub Actions and Salesforce both report success.
- [ ] **M8.9** Record a post-merge deployment failure. *(code — awaiting a live run)*  
  Check: the merge remains, deployment is visibly failed and recovery requires
  a fix/revert PR.

### M9 — Destructive deployment

- [x] **M9.1** Reject a destructive PR when policy is false. *(fixture)*  
  Check: validation is not started.
- [x] **M9.2** Enable deletion explicitly for QA. *(fixture)*  
  Check: the plan visibly changes and requires new validation.
- [ ] **M9.3** Live-validate deletion of one disposable Apex class. *(code — awaiting a live run)*  
  Check: Salesforce validation succeeds.
- [ ] **M9.4** Merge the validated deletion PR and run automatic deployment. *(code — awaiting a live run)*  
  Check: the class is absent and the run is recorded.

### M10 — Gates and deployment steps

- [x] **M10.1** Run one passing quality gate. *(fixture)*  
  Check: its command and result are recorded.
- [x] **M10.2** Make the gate fail. *(fixture)*  
  Check: Salesforce validation is not started.
- [x] **M10.3** Run one automatic pre-deployment hook. *(fixture)*  
  Check: timeout and exit status are enforced.
- [x] **M10.4** Track one manual pre-deployment step as a required GitHub check. *(fixture)*  
  Check: Merge remains blocked until an explicit CLI/workflow action records an
  immutable completion result and completes the check.
- [x] **M10.5** Run one post-deployment hook. *(fixture)*  
  Check: its result appears in final `run.json`.

### M11 — Rollback

- [x] **M11.1** Select a successful recorded run. *(fixture)*  
  Check: failed or unknown runs cannot start rollback.
- [x] **M11.2** Invert one added Apex class to a deletion. *(fixture)*  
  Check: exact inverse manifest passes.
- [x] **M11.3** Restore one modified Apex class. *(fixture)*  
  Check: content matches its pre-deployment version.
- [x] **M11.4** Restore one deleted Apex class. *(fixture)*  
  Check: deployable manifest contains the restored member.
- [x] **M11.5** Detect a later conflicting change. *(fixture)*  
  Check: rollback stops instead of overwriting it.
- [x] **M11.6** Create a compensating GitHub PR. *(fixture)*  
  Check: the PR contains only the intended inverse change.
- [x] **M11.7** Run that PR through the normal flow. *(fixture)*  
  Check: rollback validates, merges and then deploys without a special
  deployment bypass. A real workflow-created PR still needs live acceptance;
  `DOCKET_PR_TOKEN` avoids GitHub's approval-required fallback for PRs created
  with the repository `GITHUB_TOKEN`.

### M12 — Serialization and audit

- [x] **M12.1** Add a GitHub Actions concurrency group keyed by target org. *(fixture)*  
  Check: two deploys to one org never overlap.
- [x] **M12.2** Always release the lock after failure/cancellation. *(fixture)*  
  Check: the next deployment can start.
- [x] **M12.3** Build deployment history from run artifacts. *(fixture)*  
  Check: PR, SHAs, org, validation and result are traceable.
- [x] **M12.4** Verify the code MVP runs without a database. *(fixture)*  
  Check: validation handoff, locking, history and rollback use only the defined
  GitHub-native state; any observed limitation is recorded for post-MVP review.

### M13 — UI, last

UI work begins only after M0–M12 are complete and the GitHub Actions + QA path
is live-verified. Its slices will be refined at that time.

## 8. Code MVP acceptance

The code/configuration MVP is complete only when:

- a real same-repository GitHub PR is processed;
- exact base/head SHAs and trusted base configuration are used;
- partial and destructive manifests are visible;
- configured tests and gates run;
- validation succeeds in a real QA/sandbox org;
- validation is a required GitHub check for the current PR head;
- the user merges through the native GitHub Merge button;
- the merged-PR event runs a regular deployment of only the exact validated
  plan with the same test configuration;
- pre/post steps are recorded;
- a rollback PR passes through the normal flow;
- concurrent deployment to the same org is blocked;
- a post-merge deployment failure is visible and recoverable through a
  fix/revert PR;
- artifacts contain enough non-secret evidence to audit the run.

Passing fixtures alone does not satisfy this definition.

## 9. Non-goals for the first code MVP

- GitLab, Bitbucket or generic VCS plugins;
- multiple QA/Prod environments and release-candidate composition;
- automatic test inference from historical coverage;
- automatic GitHub merge;
- data rollback;
- multi-tenant control plane;
- SQLite/PostgreSQL or another runtime database;
- polished UI;
- support for every Salesforce metadata type at once.
