# Docket workflow templates

Copy these files into `.github/workflows/` of the **Salesforce repository** —
the one holding `force-app/` and `docket.yml`. They are not workflows of the
engine repository: nothing here builds a plan from the engine's own history.

| File | What starts it | What it does |
| --- | --- | --- |
| `docket-validate.yml` | a pull request against the configured branch | runs gates, validates against the org, publishes the required `docket/validate` check |
| `docket-deploy.yml` | that pull request being merged | deploys exactly the validated plan the green check points at |
| `docket-complete-step.yml` | manual dispatch | records an immutable completion for one manual pre-deployment step |
| `docket-rollback.yml` | manual dispatch | opens a compensating pull request, which then goes through validate/deploy like any other |
| `docket-history.yml` | manual dispatch | rebuilds deployment history from run artifacts only |

## The vendored engine: `.docket/docket.mjs`

The engine is not installed from a registry. It is one bundled file committed
to the Salesforce repository:

```text
.docket/docket.mjs        # ~430 KB, no node_modules, Node 24
```

Get it from the engine repository:

```sh
git clone https://github.com/Vesper1/docket
cd docket && pnpm install && pnpm bundle
cp bundle/docket.mjs <salesforce-repo>/.docket/docket.mjs
```

The last line of the file states the version it was built from, so
`tail -1 .docket/docket.mjs` answers "what is installed here" and
`sha256sum` ties a workflow log to one exact build.

Updating the engine is a normal pull request that changes one file. Nothing
else in the Salesforce repository moves.

### Why it is read from a trusted commit, not from the workspace

Every workflow materializes the engine like this:

```sh
git show "$DOCKET_ENGINE_REF:$DOCKET_ENGINE" > "$RUNNER_TEMP/docket.mjs"
```

`DOCKET_ENGINE_REF` is the pull request's **base** commit — never
`head.sha`. The candidate's tree is checked out into the same workspace as the
job that holds `DOCKET_SF_AUTH_URL`, so reading `.docket/docket.mjs` off the
disk would let an unmerged commit replace the program that runs next to the
credential. This is the rule `docket.yml` and every privileged hook already
follow: trusted execution configuration comes from the base commit. The engine
is executable configuration too.

The manually dispatched workflows read it from `github.sha`, the commit the
dispatch names. Dispatch already requires repository write access.

No registry, no `.npmrc`, no token: the `gates` job runs candidate-controlled
commands right after this step and must hold no credential at all.

### What this trades away

- **No fleet view.** Each repository carries its own copy, so nothing can
  answer "which repositories still run the old engine" — you check them one by
  one.
- **No provenance.** A published package could point back at the workflow run
  and commit that built it; a committed file cannot.
- **Unreviewable diffs.** An engine update is 430 KB of bundled output. A
  reviewer approves it on trust in its source, not by reading it. The
  base-commit rule above is what keeps that from being a credential problem.
- **Repository growth.** Every update leaves another copy in Git history
  forever.

These are acceptable while the engine changes often and lives in one or two
repositories. Publishing to npm becomes the better trade once it stabilizes;
only the materialize step and this file change.

## The rest of the setup

1. **`qa` GitHub Environment** with required reviewers, holding
   `DOCKET_SF_AUTH_URL` (the output of `sf org display --verbose --json` as an
   SFDX auth URL). `pull_request` runs the workflow file *from the pull
   request*, so the environment approval — not the file — is what stands
   between a candidate commit and the org credential.
2. **Branch protection** on the environment's branch requiring the
   `docket/validate` check. This is the only thing that gates the native Merge
   button.
3. **`docket.yml`** at the repository root, read from the base commit:

   ```yaml
   version: 1
   sourceRoot: force-app
   apiVersion: '62.0'
   environments:
     qa:
       branch: main
       org: docket-qa          # the alias the workflow logs in as
       allowDestructiveChanges: false
       tests:
         mode: all
   ```

4. **`DOCKET_PR_TOKEN`** (optional) for `docket-rollback.yml`. It avoids
   GitHub's approval-required fallback for pull requests created with the
   repository `GITHUB_TOKEN`, so the rollback pull request is validated like
   any other.

## Running the same engine locally

```sh
node .docket/docket.mjs plan --environment qa --base <sha> --head <sha>
```

Same file, same contract as the workflows.
