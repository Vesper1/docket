---
name: review-typescript-structure
description: Review or plan the file layout and module boundaries of TypeScript and Node.js repositories, especially CLIs, CI/CD tools, deployment engines, and single-package applications. Use for project-structure audits, folder reorganizations, oversized or mixed-responsibility modules, command organization, feature versus layer decisions, import-boundary checks, test placement, or comparisons with open-source repository layouts.
---

# Review TypeScript Structure

Keep the target repository's runtime, scale, contracts, and growth axis authoritative. Do not impose a generic architecture.

Read [references/benchmarks.md](references/benchmarks.md) before comparing a Node.js CLI or deployment tool with open-source layouts.

## Establish the repository contract

1. Inspect repository instructions, working-tree state, manifests, lockfiles, TypeScript configs, package exports, source tree, tests, templates, generated files, and CI workflows.
2. Identify the artifact: CLI, library, server, worker, action, or monorepo package. Identify its composition roots, public entry points, external adapters, and persistent artifacts.
3. Record the real stack and scale. Do not reuse an older architecture description without checking the current checkout.
4. Find and run the repository's existing non-mutating quality commands. Separate typecheck, unit, fixture/integration, build, and live-provider evidence.
5. In review mode, preserve unrelated changes and do not move or edit product files.

## Compare by fitness

1. Prefer primary repository sources pinned to a commit SHA. Record the review date.
2. Score candidates by runtime, artifact type, domain, scale, command growth, trust boundaries, and test strategy. Popularity is not architecture evidence.
3. Extract transferable decisions and explicit non-goals. Never copy monorepo packages, framework conventions, barrels, or `utils/` folders without a demonstrated need.
4. Select one closest baseline and use other repositories only for missing concerns.

## Audit the module graph

1. Inventory production and test files separately. Summarize files per bounded area and identify generated or fixture-only trees.
2. Trace imports from composition roots through commands/use cases, domain decisions, and adapters.
3. Check cycles, cross-area edges, high fan-out orchestrators, high fan-in contracts, deep imports across intended boundaries, and process-global reads below the composition root.
4. Classify each directory by one primary reason to change. Flag a boundary only when code with different change drivers is coupled or the layout hides ownership.
5. For a CLI, pass a recognized option to an unrelated command. Require command-owned parsing and help to reject it instead of silently ignoring an operator mistake.
6. Treat line count as a probe, never a finding. Prove mixed responsibilities with functions, imports, side effects, or tests.

## Prefer a small vertical structure

- Keep the executable entry point and command registration thin.
- Group a command or use case with its options, orchestration, rendering, and focused tests when they change together.
- Keep domain values and pure decisions beside the feature that owns them.
- Put Git, GitHub, Salesforce, filesystem, process, clock, and network effects behind narrow adapters or explicit dependencies.
- Keep `shared` limited to stable primitives used by several areas. Reject vague `utils`, `common`, and `helpers` dumping grounds.
- Add a package boundary only for an independent public API, build/release unit, ownership boundary, or measured compiler need.
- Prefer direct imports inside an area. Add public entry points or automated import rules only when cross-area access needs enforcement.
- Colocate focused unit tests. Put end-to-end or provider fixture tests in a separate tree only when they cross several areas.

## Propose changes incrementally

1. Preserve strengths and working contracts first.
2. Separate confirmed structural defects from optional target-layout proposals.
3. Start with dependency direction and cohesive extraction; perform broad path renames only after behavior is protected.
4. For every move, name the new owner, allowed dependencies, affected imports, and positive/negative checks.
5. Avoid a big-bang rewrite. Order slices so every step typechecks, tests, and builds independently.

## Report findings first

Order findings by severity and confidence. For each finding include:

1. Exact `path:line` evidence.
2. The conflicting responsibilities or dependency edge.
3. Trigger and maintenance, runtime, or security impact.
4. The smallest concrete boundary change.
5. Positive and negative verification.

Then report the chosen benchmark, confirmed strengths, current tree/check status, a proposed target tree, and a dependency-ordered migration plan. Label unverified live behavior separately from fixture evidence. Do not report naming taste, nesting depth, or file size alone as defects.
