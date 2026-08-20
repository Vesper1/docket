# Improvement — Salesforce Quick Deploy

Status: **deferred improvement. Not part of the POC.**

[`../poc.md`](../poc.md) is what the engine is today. This document supersedes
nothing. Where the two disagree, `poc.md` wins.

Deferred on 2026-08-19. Revisit once a promotion path beyond one org exists and
production test runs are long enough to hurt.

## What it is

Salesforce can separate a deployment into two calls:

```text
sf project deploy validate ...          → a deployment id; tests have run
sf project deploy quick --job-id <id>   → applies it without running tests again
```

The engine already carries the identifier this needs:
`DeploymentOutcome.deploymentId` in `src/lib/features/salesforce/deploy.ts` —
"the org's own record of this operation".

## Why it is deferred

Without it, a validation followed by a deployment runs the test suite twice.
That is the whole cost, and it is only a cost of **time**.

It is not a cost of safety. A metadata deployment is atomic: `rollbackOnError`
is forced in production, so a failed test suite leaves the org untouched. A
regular deployment is therefore already safe on its own, and a separate
validation step buys early warning rather than protection.

Early warning is worth little while there is one org and no maintenance window
to plan around. It becomes worth a lot when a production run takes hours and
has to fit inside an approved window.

## What it unlocks, and what it then demands

With quick deploy, a promotion can split across two jobs: validate when the
change is proposed, apply when a person approves it. The deployment id is the
handoff.

That handoff is the condition under which
`legacy/engine-m0-m12/src/lib/features/run/` becomes worth pulling back — its
README already names it: *"pull it back when a plan is computed in one job and
deployed by another."* Possibly only three fields are needed rather than the
whole codec: the deployment id and the commit pair that produced it, so an
approval can be shown to apply to the plan it was given.

## The one behaviour to get right

Salesforce invalidates a validated deployment if the org changes underneath it.
That is the same invariant the rest of Docket keeps — do not deploy a plan whose
ground has moved — except here the platform enforces it.

So the correct response to a rejected quick deploy is to **validate again**,
never to work around it.

## What must be confirmed against a live org

Neither of these is settled from documentation alone:

- how long a validated deployment stays eligible (believed to be 96 hours);
- what makes it eligible at all — a validation appears to have to run tests, but
  which test selections qualify is unverified.
