# Docket workflow templates

Copy these three workflow files into `.github/workflows/` of the **Salesforce
repository** — the one holding `force-app/` and `docket.yml`:

```text
.github/workflows/docket-plan.yml
.github/workflows/docket-deploy.yml
.github/workflows/docket-rollback.yml
```

They are not workflows of the engine repository: nothing here builds a plan
from the engine's own history.

| File | What starts it | What it does |
| --- | --- | --- |
| `docket-plan.yml` | manual dispatch | shows the manifests a deployment would use; no credential involved |
| `docket-deploy.yml` | manual dispatch | runs the gates, then deploys the change between two exact commits |
| `docket-rollback.yml` | manual dispatch | deploys the inverse of that change, restoring the base commit in the org |

Every one of them takes the same two inputs: the full `base` and `head` SHAs.
That pair is the identity of a run — there is nothing else to keep in sync.

## The vendored engine: `.docket/docket.mjs`

The engine is not installed from a registry. It is one bundled file committed
to the Salesforce repository:

```text
.docket/docket.mjs        # no node_modules, no install step, Node 24
```

Build it from the engine repository and commit the result:

```sh
git clone https://github.com/Vesper1/docket
cd docket && pnpm install && pnpm bundle
cp bundle/docket.mjs <salesforce-repo>/.docket/docket.mjs
```

The last line of the file states the version it was built from, so a run can be
tied to one exact engine build.

Vendoring is a deliberate trade while the engine changes often and few
repositories consume it. It costs the fleet-wide view of which repository runs
which engine, and reviewable update diffs. Publishing to a registry becomes the
better trade once the engine stabilizes, and would change only the two lines
that invoke it.

## Configuration: `docket.yml`

At the repository root, read from the **base commit** of every run — never from
the working tree, so a candidate change cannot repoint the org or rewrite the
gate commands that run beside the Salesforce credential:

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

Gates run with `SF_*`, `GITHUB_TOKEN` and `ACTIONS_*` stripped from the
environment. That is a barrier, not a sandbox: a command can still read a
cached CLI login on the same machine.

## The one secret

`DOCKET_SF_AUTH_URL` — an sfdx auth URL for the target org, stored on the `qa`
environment. Nothing else in Docket reads a credential.

## What this POC does not do

- It does not gate the Merge button. Every run is dispatched by a person.
- It does not open a rollback pull request. A rollback puts the **org** back;
  reverting the code is an ordinary pull request you raise yourself.
- It supports `ApexClass` only. Any other path inside `sourceRoot` is a refusal,
  not a silent omission.
