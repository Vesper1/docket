# Docket POC — scripts and jobs

Status: this is what the engine **is** today. [`mvp.md`](./mvp.md) is what it is
meant to become; the machinery built for that flow ahead of time is parked in
[`legacy/`](../legacy/README.md) and listed there with the condition under which
each piece becomes worth pulling back.

## 1. What it does

Four commands over one pair of exact commits:

```text
docket changes  --base <sha> --head <sha>     what changed, file by file
docket plan     --base <sha> --head <sha>     the manifests a deployment would use
docket deploy   --base <sha> --head <sha>     gates, then deploy to the org
docket rollback --base <sha> --head <sha>     deploy the inverse, restoring base
```

Each is dispatched by a person — from a terminal, or from a
`workflow_dispatch` job that passes the same two SHAs. The SHA pair is the
identity of a run; there is nothing else to keep in sync.

## 2. Fixed decisions

| Area | POC decision |
| --- | --- |
| Metadata | `ApexClass` only. Any other path inside `sourceRoot` is a refusal, never a silent omission. |
| Delta | Computed by Docket from the exact two commits, never through a merge base. |
| Trigger | Manual dispatch. No pull request event, no merge gate, no required check. |
| Configuration | `docket.yml`, read from the **base** commit. |
| Target | One org, named directly in `docket.yml`. No environment list. |
| Gates | Commands from `docket.yml`, run with credentials stripped from the environment. |
| Workspace | Every run exports the exact source commit with `git archive` into a temporary directory, and removes it afterwards. |
| Rollback | Deploys the inverse component set from the base commit's tree. It puts the **org** back; the repository is untouched. |
| State | None. A run reads two commits and writes a directory. |
| Delivery | One vendored file, `.docket/docket.mjs`, committed to the Salesforce repository. |
| Secrets | One: `DOCKET_SF_AUTH_URL`. Never in Git, YAML or artifacts. |

## 3. Configuration

```yaml
version: 1
org: docket-qa                 # an alias or username, never a credential
sourceRoot: force-app          # optional; this is the default
tests: all                     # or a list: [GreeterTest, BillingTest]
allowDestructiveChanges: false # deletions fail closed until enabled
gates:
  - name: unit
    run: npm test
    timeoutMinutes: 10         # optional; this is the default
```

Every rule fails closed: an unknown key is an error rather than a default,
because `allowDestructiveChange: true` — one letter short — would otherwise
read as a silent `false`.

Configuration is read from the base commit, never the working tree. A candidate
change must not be able to repoint the org or rewrite the gate commands that run
beside the Salesforce credential. This is the one trust boundary the POC keeps,
and it is cheap: one `git show`.

## 4. What a run does

1. Read `docket.yml` from the base commit.
2. Diff the two exact commits and classify each path.
3. Build `package.xml` and, when something is deleted, `destructiveChanges.xml`.
   A deletion under `allowDestructiveChanges: false` stops here.
4. Export the source commit into a clean temporary workspace — the head commit
   for a deployment, the base commit for a rollback.
5. Run the gates there, with `SF_*`, `GITHUB_TOKEN` and `ACTIONS_*` removed from
   the environment. A failed gate ends the run; Salesforce is never asked
   anything.
6. Run `sf project deploy start` (or `validate`, under `--check-only`) against
   the manifests and the configured tests.
7. Write the artifacts and remove the workspace, whatever happened.

Stripping credentials from a gate's environment is a barrier, not a sandbox: a
command can still read a cached CLI login on the same machine. Gates run code
from the candidate commit, and a hostile change is still a hostile change.

## 5. Artifacts

```text
package.xml
destructiveChanges.xml   # only when something is deleted
report.md
result.json
logs/gate-<name>.log
```

`result.json` records the commits, the org, the component lists, each gate's
verdict, the Salesforce deployment id and every failure. It carries no manifest
bytes and no secrets.

Nothing reads these back. They are evidence for a person, not state for the next
run — which is what makes the POC stateless.

## 6. Non-goals, for now

- gating GitHub's Merge button, and everything that needs: check runs, plan
  identity, artifact handoff between jobs;
- validating a pull request automatically when it opens;
- manual pre-deployment steps;
- deployment history;
- rollback as a compensating pull request;
- more than one environment;
- any metadata type beyond `ApexClass`.

Each of these has a parked implementation. `legacy/README.md` says what it was
and when it becomes worth pulling back.

## 7. What is not yet proven

No part of this has run against a live Salesforce org or a live GitHub Actions
job. The fixtures spawn a real process and read a real JSON envelope, so the
code path is exercised — but only a live org can prove Salesforce accepts the
arguments, and only a live run can prove the workflow files are right.

That is the next step, and it is the only one that matters before anything is
added.
