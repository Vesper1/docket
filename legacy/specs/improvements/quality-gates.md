# Improvement — Quality gates that catch real mistakes

Status: **candidate for the next slice. Not part of the POC.**

[`../poc.md`](../poc.md) is what the engine is today. Where the two disagree,
`poc.md` wins.

## 1. The problem with the gate the POC has

Today a gate is a shell command from `docket.yml`, run in the candidate
workspace with credentials stripped:

```yaml
gates:
  - name: unit
    run: npm test
```

That is a *hook*, not a gate. It catches exactly what the repository owner
already thought to write down, it knows nothing about the plan, and it runs at
one moment only — before Salesforce is asked anything. Every Salesforce mistake
that actually hurts lives outside that window:

| The mistake | Why the current gate cannot see it |
| --- | --- |
| A new class ships with 0% coverage, hidden by a 78% org average | The number only exists *after* the test run, in the deploy result |
| The deployment overwrites a hotfix someone typed into Setup last night | Requires reading the org, which a credential-free gate may not do |
| A `tests: [FooTest]` list no longer covers the classes being changed | Requires the plan, which the gate never receives |
| 40 classes deleted because a folder was renamed wrong | The deletion policy is a boolean; it has no sense of scale |
| A hardcoded `005xx000001Sv6D` promoted from sandbox to prod | Nothing reads the changed bytes |
| A class still on `apiVersion 45.0` | Nothing reads the `-meta.xml` |

## 2. The fix: gates have phases

A gate is not always "a command before the deploy". Introduce four phases, each
defined by what it is allowed to see:

| Phase | Sees | Credential | Failure means |
| --- | --- | --- | --- |
| `plan` | the plan and the changed bytes | none | refuse before a workspace exists |
| `pre` | the candidate workspace | stripped | refuse before Salesforce is asked |
| `org` | the plan + a **read-only** org session | read-only | refuse before mutation |
| `post` | the deployment result | — | fail the run after a `--check-only` validation |

Phase ordering is the whole safety argument: a `plan` gate costs milliseconds
and no credential, a `post` gate costs a full test run. Cheap refusals first.

`post` gates are only honest under `--check-only`. Against a real deployment
they report on an org that already changed — which is a finding, not a gate.
The engine must label them that way rather than pretend.

## 3. Built-in gates, ranked by mistakes-caught-per-line-of-code

Each is a named gate the config enables, not a command a user writes. The point
is that Docket already holds the data — the plan, the diff, the deploy result —
and no shell command in the repository does.

### 3.1 `coverage` — per-component, not org-wide *(phase: post)*

Salesforce enforces 75% **org-wide**. That average is exactly why untested code
reaches production: one well-tested legacy class carries a new untested one.

```yaml
gates:
  - use: coverage
    minPercent: 85          # per deployed class, not averaged
    allowUncovered: false   # a deployed class with no coverage row is a failure
```

The numbers come from the deploy result's `runTestResult.codeCoverage`, keyed
by class name — the same names the plan already lists. A class in
`components.deployable` with no coverage row means no test executed it at all,
which is a distinct and worse finding than a low number.

**This is the single highest-value gate and should be built first.**

### 3.2 `org-drift` — did someone change the org by hand? *(phase: org)*

The classic Salesforce production incident: a fix is typed into Setup during an
outage, never committed, and the next deployment silently reverts it.

For every component the plan will deploy or delete, read the org's
`LastModifiedDate` and `LastModifiedById`. Refuse when the org's copy is newer
than the base commit the repository claims to be deploying from.

```yaml
  - use: org-drift
    action: refuse          # or `warn`, while a team is still cleaning up
```

The check is cheap — one `listMetadata`/Tooling query per type, not a full
retrieve — and it is the one gate that requires a credential, which is why the
phase split exists.

### 3.3 `blast-radius` — scale, not permission *(phase: plan)*

`allowDestructiveChanges: true` is permanent permission for any number of
deletions. A bad rename or a bad merge is not distinguishable from an intended
deletion by policy alone; it is distinguishable by **count**.

```yaml
  - use: blast-radius
    maxDeleted: 5
    maxComponents: 200
    override: label         # an explicit human act unlocks a bigger run
```

### 3.4 `test-selection` — the list rots silently *(phase: plan)*

Under `tests: [GreeterTest, BillingTest]`, adding `InvoiceService.cls` deploys
code that no listed test names. Refuse when a deployed non-test class has no
plausible test in the selection (`<Name>Test`, `Test<Name>`, or a declared
mapping), and refuse a listed test class that no longer exists in the tree.

### 3.5 `diff-lint` — static analysis scoped to the change *(phase: pre)*

PMD's Apex ruleset over a real org reports thousands of violations, so nobody
reads it and it gates nothing. Run it twice — at base and at head — and fail
only on violations the change *introduced*.

```yaml
  - use: diff-lint
    engine: pmd
    ruleset: config/pmd-apex.xml
    failOn: [SOQLInsideLoop, DMLInsideLoop, ApexCRUDViolation, EmptyCatchBlock]
```

A baseline diff is what makes static analysis enforceable on a legacy codebase
instead of aspirational.

### 3.6 `forbidden-bytes` — literals that must not be promoted *(phase: plan)*

Reads only the changed lines of the deployed components:

- 15/18-character Salesforce IDs outside a `@IsTest` block;
- `seeAllData=true`;
- hardcoded sandbox/production hostnames and named-credential URLs;
- secret-shaped strings (the artifact scan already exists; point it at source).

### 3.7 `api-version` — drift no one ever notices *(phase: plan)*

Every `.cls-meta.xml` carries an `apiVersion`. Refuse a spread wider than N
versions, or anything below a configured floor. Cheap, and it prevents the
"works in sandbox, compiles differently in prod" class of bug.

### 3.8 `stale-base` — the plan's ground has moved *(phase: plan)*

Refuse when `base` is not an ancestor of the org's last deployed commit, or
when the target branch has moved past `base`. The same invariant quick-deploy
depends on — *do not deploy a plan whose ground has moved* — enforced by Docket
rather than discovered by Salesforce.

## 4. Configuration shape

Named built-ins and shell commands are the same list, distinguished by key:

```yaml
gates:
  - use: blast-radius        # built-in
    maxDeleted: 5
  - name: unit               # shell, exactly as today
    run: npm test
  - use: coverage
    minPercent: 85
```

Fail closed as everywhere else: an unknown `use:` is an error, an unknown key
inside a built-in is an error. Every gate result keeps the shape `result.json`
already writes, plus `findings[]` — `{ severity, path, line, message }` — which
is what makes GitHub annotations possible (see
[`github-jobs.md`](./github-jobs.md) §3).

## 5. Suggested build order

1. `coverage` — the deploy result is already parsed; the gap is per-class rows.
2. `blast-radius` and `test-selection` — pure plan arithmetic, no new I/O.
3. `findings[]` + GitHub annotations — makes every later gate visible in the
   Files tab instead of buried in a log.
4. `org-drift` — needs the `org` phase and a read-only session.
5. `diff-lint` — needs a base-and-head double run; the workspace machinery for
   it already exists.

## 6. What must be confirmed against a live org

- whether `runTestResult.codeCoverage` is returned for a `--check-only`
  validation with `--test-level RunSpecifiedTests`, and whether it is keyed by
  class name or by ID;
- the cheapest way to read `LastModifiedDate` per component — `listMetadata`,
  the Tooling API, or `SourceMember` (sandbox only);
- whether coverage rows appear for classes that no test touched at all, or are
  simply absent.
