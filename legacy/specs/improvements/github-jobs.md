# Improvement — GitHub Actions jobs worth having

Status: **candidate for the next slice. Not part of the POC.**

[`../poc.md`](../poc.md) is what the engine is today: three dispatched
workflows, each taking a `base`/`head` SHA pair. Where the two disagree,
`poc.md` wins.

## 1. Where the value is

The POC's workflows are transport — they install a CLI, hold one secret and
call `node .docket/docket.mjs`. Everything a person sees is a log line or a
zipped artifact they must download.

GitHub Actions offers a surface Docket currently ignores entirely: check runs,
annotations, job summaries, environments, deployment statuses, merge queues,
concurrency queues and OIDC. Every job below is worth building **because of
what it puts in front of a person**, not because it runs more code.

## 2. The jobs

Ranked. Each is one workflow file in the Salesforce repository.

### 2.1 `docket-plan` on `pull_request` — the plan as a PR comment

No credential, no org, runs in seconds. A sticky comment (updated in place, one
per PR, never a thread of twenty) showing:

```text
Docket plan — 4 components, 1 deletion
  + InvoiceService        added
  ~ BillingHandler        modified
  ~ BillingHandlerTest    modified
  - LegacyRatesEngine     DELETED  ← allowDestructiveChanges: true
tests: RunSpecifiedTests (BillingHandlerTest)
```

The single most common Salesforce deployment surprise is *"I didn't know that
was in the deployment."* This answers it before review starts, and costs one
credential-free job.

The same body goes to `$GITHUB_STEP_SUMMARY`, so `report.md` is readable
without downloading an artifact.

### 2.2 `docket-check` — validation as a required check

`pull_request_target`, so the workflow file comes from the base branch and a
candidate cannot rewrite the step holding the credential. Refuse forks in an
un-credentialed job first, then `needs:` into the credentialed one.

Runs `plan` and `pre` gates, then `--check-only` against the org, then the
`post` gates ([`quality-gates.md`](./quality-gates.md) §2). Publishes one check
run per gate, not one for the whole run — a red `docket / coverage` beside a
green `docket / unit` tells a reviewer what to fix without opening a log.

A run that dies before recording a verdict publishes its own failure, so the PR
never shows a blocked merge with no stated reason.

### 2.3 Gate annotations — findings in the Files tab

`::error file=force-app/main/default/classes/BillingHandler.cls,line=42::SOQL inside a loop`

Every finding from `findings[]` becomes an inline annotation on the exact line
of the diff. This is the cheapest possible change with the largest visible
effect: gate output stops being a log nobody opens and becomes a review comment
on the offending line.

### 2.4 `docket-drift` on `schedule` — the nightly org watchdog

Cron, once a night. Retrieve the configured metadata from the org, diff against
`main`, and when they differ:

- open (or update) one issue naming each component, who last modified it and
  when;
- fail a `docket / org-clean` check so the state is visible, not just emailed.

This catches the hand-edit *before* a deployment silently reverts it, rather
than during. It is also the only job that finds anything while nobody is
working — a genuinely new capability, not a nicer view of an existing one.

### 2.5 Deploy through a GitHub Environment — free approvals and history

Name the deployment job's `environment: production` with required reviewers,
and GitHub supplies the approval UI, the audit trail of who approved, the
wait timer and the branch restriction. No Docket code at all.

Then post real deployment statuses through the Deployments API, so the
repository's **Environments** tab becomes the deployment history the POC
deliberately does not keep. `in_progress` → `success`/`failure`, each linked to
the run and the SHA.

### 2.6 `merge_group` — validate what will actually merge

Under a merge queue, a PR is validated alone but merges combined with whatever
queued ahead of it. Two independently green PRs that both edit
`BillingHandler.cls` can merge into a class that does not compile.

Running validation on the `merge_group` event validates the *combination*.
Salesforce metadata is unusually prone to this: no local build catches a
last-modified-wins overwrite.

### 2.7 Deploy freeze — a window, enforced

A job that reads a `freeze` window from `docket.yml` (or a repository variable)
and refuses to deploy inside it unless the run carries an explicit
`emergency` label from a person with write access. Fridays at 17:00, release
weekends, an audit period.

Cheap to build, and it is policy nobody remembers at 17:00 on a Friday.

### 2.8 Post-merge deploy from the merged PR event

The merge commit gives both SHAs with nothing to keep in sync: `base` is the
merge commit's first parent, `head` is the merge commit. That removes the last
hand-typed input from the POC's dispatch flow, and it means the plan deployed
is arithmetically the plan that was validated.

### 2.9 Parallel gates via `matrix`

One job per gate, from a matrix built by `docket gates --list`. Three effects:
a slow gate stops blocking a fast one, each gate gets its own log and its own
check run, and a rerun can rerun one failed gate instead of everything.

### 2.10 OIDC instead of `DOCKET_SF_AUTH_URL`

The POC's one secret is a long-lived refresh token in repository settings.
GitHub's OIDC provider can mint a short-lived token that a Salesforce External
Client App exchanges via the JWT flow — no stored credential at all, scoped to
one repository and one branch by the subject claim.

This is the strongest security improvement available to the project, and it
removes the only secret Docket has.

### 2.11 `workflow_run` recovery — a failed deploy proposes its own rollback

A deployment failing after merge cannot un-merge. A `workflow_run` job on
`conclusion == failure` can compute the inverse plan and post it as a
one-click dispatch link (or open the revert PR), so recovery is the obvious
next click rather than a thing someone reconstructs under pressure.

## 3. Cross-cutting mechanics

| Mechanism | Why it matters here |
| --- | --- |
| `concurrency: docket-deploy-${{ org }}` | one org, one deployment; the POC already has the group but keys it globally |
| `cancel-in-progress: false` on deploy | Salesforce must never be left mid-change |
| `cancel-in-progress: true` on validation | a superseded PR head is wasted compute |
| `permissions:` per job | `checks: write` and `deployments: write` only where needed; `contents: read` everywhere else |
| `persist-credentials: false` | already correct in the POC; keep it as gates grow |
| npm cache for the `sf` CLI | a global install is ~40s of every single run |
| `GITHUB_RETENTION_DAYS` in `result.json` | states how long the evidence actually survives |

## 4. Suggested build order

1. **2.1 plan comment + job summary** — no credential, no trust question, and it
   changes what every reviewer sees on every PR.
2. **2.3 annotations** — needs `findings[]` from the gates work; nothing else.
3. **2.2 required check** — the first job that gates a merge, and the first that
   needs `pull_request_target`'s trust rules to be exactly right.
4. **2.8 post-merge deploy** — removes hand-typed SHAs.
5. **2.5 environments + deployment statuses** — approvals and history for free.
6. **2.4 nightly drift** — needs the `org` gate phase.
7. **2.10 OIDC** — do it before more repositories hold the secret, not after.

## 5. What must be confirmed against a live run

None of this has run on GitHub Actions. In particular:

- that `pull_request_target` + a fork-refusing un-credentialed job actually
  keeps a fork from reaching the credentialed one;
- that annotation counts do not silently truncate (GitHub caps them per run);
- that a `merge_group` validation can obtain both SHAs the engine needs;
- that a Salesforce External Client App accepts a GitHub OIDC token in the JWT
  flow without a stored certificate.
