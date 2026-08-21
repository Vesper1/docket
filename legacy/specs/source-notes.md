# Original handwritten notes

This file preserves the source sketches. The current working contract lives in
[`mvp.md`](./mvp.md).

## Initial MVP sketch

```text
Feature 1 ─┐
Feature 2 ─├─→ Dev ─→ QA ─→ Prod
Feature 3 ─┘
```

1. Partial deployments (only changed files).
2. Destructive changes deployment.
3. Run all / selected unit tests for a PR.
4. Quick deployment after validation.
5. Build `.yml` files for storing deployment data and pipeline setup.
   Should I use a local DB? A tiny one?
6. Investigate Git worktree workflow?
7. Rollback mechanism.
8. SvelteKit, HTMX, React?
9. How to deploy only specific dev changes using Git worktree, across all orgs?
10. Quality Gates setup: ESLint, Prettier, PMD rules.

The file extension in item 5 appears to be `.yml`.

## Salesforce Deployment Platform sketch

1. Create GitHub config with jobs for deployments:
   - partial deployments;
   - destructive changes deployments;
   - Quick Deploy after validation;
   - unit-test selection for deployment;
   - `Add` — crossed out in the source.
2. Question: What is the best language for CI/CD jobs?
3. Handle pre/post-deployment steps:
   - run scripts;
   - provide instructions for manual steps;
   - track whether each manual step is done;
   - persist instructions and scripts when needed;
   - run scripts automatically;
   - decide how post-deployment steps are completed.
4. Build a super-minimalistic UI:
   - Svelte, HTMX or React?
   - add a safe local deployment mechanism.

The handwritten phrase `PD steps` is interpreted as post-deployment steps.

## Rollback sketch

1. When a rollback is needed, use a PR approach.
2. Select which PR or branch to roll back.
3. Create a destructive-changes PR. Would it work?
4. Follow the deployment process.

## UI sketch

1. `Deploy to` / `Where to deploy?`
   - Dev;
   - QA;
   - Prod;
   - show environments from the pipeline.
2. `What to deploy?`
   - Feature 1;
   - Feature 2 — select a branch;
   - Feature 3.
3. `Review changes`:
   - add pre/post-deployment steps;
   - run quality gates and validation.
