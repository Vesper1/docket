# Security hardening reference

Source: GitHub Docs "Secure use reference" for GitHub Actions.

## Script injection

Anything under `github.event.*` is attacker-controlled: PR title, body, branch name,
commit message, issue comment, fork name. Interpolating it into `run:` splices it into
the generated shell script.

Wrong:
```yaml
- run: echo "Title: ${{ github.event.pull_request.title }}"
```

Right - bind to an env var, quote on use:
```yaml
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: echo "Title: $TITLE"
```
Better still: pass it as an action `with:` input, which never reaches a shell.

The same applies to `actions/github-script` bodies and to any value derived from an
untrusted one (a file contents, an API response about the PR).

## Privileged triggers

`pull_request_target` and `workflow_run` execute the **base branch** workflow with
write permissions and full secret access, in the context of a fork PR.

- Avoid them unless the job genuinely needs secrets on fork PRs (e.g. labelling).
- Never `actions/checkout` the PR head ref, and never run its build, install scripts,
  linters, or tests - `npm install` alone executes attacker code.
- Split: an unprivileged `pull_request` job produces an artifact; a privileged
  `workflow_run` job consumes it, treating the artifact as untrusted data.
- These runs share the default-branch cache - poisoned cache is a real path in.

## GITHUB_TOKEN

- Default the whole workflow to `permissions: contents: read`, widen per job.
- Set the repository/org default token permission to read-only.
- The token is a real credential: it expires with the job, but during the job it can
  do exactly what you granted. `contents: write` on a job that runs untrusted code is
  a repository takeover.
- Runs triggered by `GITHUB_TOKEN` do not themselves trigger further workflows
  (loop protection) - use a PAT or GitHub App token deliberately if you need chaining,
  and scope it.

## Secrets

- Store only in secrets; never in workflow files, never in artifacts, never in cache.
- One secret per value. Never wrap secrets in JSON/YAML - masking only matches the
  whole registered value, so structured wrappers leak the parts.
- Any transformation (base64, URL-encoding) produces an unmasked value; register it:
  ```yaml
  - run: echo "::add-mask::$DERIVED"
  ```
- Audit what you print. `set -x`, verbose CLI flags, and error dumps leak.
- Prefer OIDC (`permissions: id-token: write`) to any long-lived cloud credential.

## Third-party actions and reusable workflows

- Pin to a full-length commit SHA; verify the SHA is in the upstream repo, not a fork.
- Read the action's source before first use: what it sends over the network, what it
  writes to disk, whether it reads `secrets` or the environment wholesale.
- Same rules for `uses:` on reusable workflows.
- Dependabot does not alert on SHA-pinned actions' vulnerabilities the way it does for
  version ranges - schedule a review, or let Dependabot update the pins for you.
- Restrict which actions may run at all: repository/org setting "Allow select actions".

## Self-hosted runners

- Almost never for public repositories: a fork PR can persist on the machine.
- Prefer ephemeral / just-in-time runners that take exactly one job.
- Runner groups to limit which repos and workflows may target them.
- Keep no secrets, cloud metadata credentials, or long-lived kubeconfigs on the host.

## Governance

- `CODEOWNERS` on `.github/workflows/` so workflow changes need security review.
- Enable Dependabot version updates for `github-actions`.
- Watch audit log events: `org.update_actions_secret`, environment approvals,
  self-hosted runner registration.
