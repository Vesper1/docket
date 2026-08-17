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

## Repository variable: `DOCKET_PACKAGE`

Every workflow installs the engine with `npm install --global "$DOCKET_PACKAGE"`
and refuses to run when the variable is empty. There is an unrelated public
`docket` package on npm, so a bare name is never correct — the variable must
name the exact engine this repository trusts:

```text
@vesper1/docket@0.1.0            # a published version, the normal form
https://example.com/docket-0.1.0.tgz
/opt/docket                      # a vendored path on a self-hosted runner
```

A git URL is deliberately not among them. `dist/` is absent from Git, so npm
would have to build the engine inside the consumer's runner, and whether that
build gets its devDependencies depends on the npm version and cache state. A
published package carries `dist/` already built.

The engine is published to npm by `.github/workflows/publish-engine.yml` in the
engine repository, from a `v*` tag, with provenance: `npm view @vesper1/docket`
shows which workflow run and commit produced the version pinned here.

The package is public, so no workflow here holds a credential to install it.
That matters most in the `gates` job, where candidate-controlled commands run in
the same job right after the install step.

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
