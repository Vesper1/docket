# `legacy/engine-m0-m12`

The M0–M12 engine, parked on 2026-08-19 when Docket was cut back to a POC.

Nothing here is built, typechecked or tested. `tsconfig.json` includes only
`src`, and `vitest.config.ts` excludes this directory. The files keep their
original paths under `src/`, so a module can be read in the layout it was
written for — but its relative imports point at modules that stayed behind in
`src/`, so it will not run as it stands.

It is kept to be read, and to be pulled from one piece at a time.

## Why it was parked

The engine supported exactly one metadata type (`ApexClass`) and had never run
against a live org or a live GitHub Actions job, yet already carried the shape
of a fleet product: versioned artifact schemas, a merge-gate protocol, an audit
projection, a release channel. The POC keeps the four things that do work —
changes, plan, deploy, rollback — and drops the machinery built for a flow that
has not run yet.

## What is in here, and when it becomes worth pulling back

| Parked | What it does | Pull it back when |
| --- | --- | --- |
| `features/github/` | reads pull requests, publishes required check runs, encodes the plan identity in `external_id`, opens a compensating PR | the flow becomes PR → green check → Merge → deploy. Check runs are the only thing that can block GitHub's Merge button; nothing else here substitutes for them |
| `features/run/` | `run.json`/`plan.json`/`validation.json` codecs, digest verification, secret scanning of artifacts | a plan is computed in one job and deployed by another. Verification is what makes an artifact from an untrusted store safe to deploy |
| `features/pipeline/gate-run.ts` | runs gates in a credential-free job and transfers the verdict as a verified artifact | gates must run in a job that never holds the Salesforce secret. The POC runs them in-process before authenticating |
| `features/steps/step-completion.ts` | immutable "a person did this" records bound to one plan identity | manual pre-deployment steps become real, i.e. once there is a UI to complete them |
| `features/audit/` | deployment history projection over run artifacts, and the no-database state contract | history needs to be answered from something other than a directory listing — most likely by the UI, reading the same artifacts |
| `features/rollback/` | inverse *file* operations, git-tree building, conflict detection against later commits | rollback goes back to being a compensating pull request instead of a direct deploy. `rollback-conflict.ts` is worth pulling sooner: it stops a rollback that would silently revert someone else's later work |
| `features/cli/commands/` | the 13-command registry, the central flag vocabulary, per-command help | the CLI outgrows four commands |
| `templates/github/docket-validate.yml` | `pull_request_target`, fork refusal, credential ordering, trusted-engine materialization | validation runs on pull requests again. The security reasoning in its header comments is the valuable part |
| `.github/workflows/release-engine.yml` | tagged release of the vendored bundle with a checksum | the bundle is consumed by more than one repository |

## What is not worth pulling back

`features/audit/state-contract.ts` is the specification restated as a TypeScript
constant. `specs/mvp.md` is the artefact; the constant only had to agree with it.

`src/tests/workflows.test.ts` transcribes the workflow YAML into JavaScript
assertions. Four of its checks carry real weight — `pull_request_target` rather
than `pull_request`, refusing forks, the credential step ordering, deployment
concurrency — and those are worth re-deriving. The rest restate the file.
