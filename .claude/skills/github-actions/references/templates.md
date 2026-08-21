# Workflow templates

Skeletons to adapt. SHAs shown as `@vN` for readability - pin third-party actions to a
full SHA in real files.

## CI - pull requests and default branch

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        task: [lint, typecheck, test]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run ${{ matrix.task }}
```

## Required-check gate over a filtered matrix

Make this job the required check, not the individual matrix legs.

```yaml
  ci-passed:
    if: always()
    needs: [check]
    runs-on: ubuntu-latest
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

## Build once, deploy with an environment

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v5
      - id: meta
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"
      - run: npm ci && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment:
      name: production
      url: ${{ steps.deploy.outputs.url }}
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    permissions:
      contents: read
      id-token: write   # OIDC, no stored cloud credentials
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/
      - id: deploy
        env:
          VERSION: ${{ needs.build.outputs.version }}
        run: ./scripts/deploy.sh "$VERSION"
```

## Reusable workflow

Called:
```yaml
# .github/workflows/node-check.yml
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        required: true
    secrets:
      NPM_TOKEN:
        required: false
    outputs:
      coverage:
        value: ${{ jobs.check.outputs.coverage }}
```

Caller:
```yaml
jobs:
  check:
    uses: my-org/ci/.github/workflows/node-check.yml@<sha>
    with:
      node-version: '22'
    secrets: inherit
```

## Untrusted PR + privileged follow-up

```yaml
# 1) unprivileged: runs fork code, no secrets, writes an artifact
on: pull_request
permissions: { contents: read }

# 2) privileged: never checks out PR head, only reads the artifact
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
permissions: { pull-requests: write }
```
