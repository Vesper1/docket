---
name: review-typescript
description: Review, plan, or reorganize TypeScript applications and libraries using strict compiler contracts, runtime validation at untrusted boundaries, explicit success/error/dependency models, controlled module surfaces, and type-level tests. Use for TypeScript or Node.js audits, tsconfig reviews, unsafe type assertions, domain-model design, Result/discriminated-union APIs, public API inference, side-effect isolation, or requests to improve TypeScript structure without blindly adopting a framework.
---

# Review TypeScript

Apply the strongest transferable TypeScript practices demonstrated by Effect. Keep the target repository's runtime, scale, and existing architecture authoritative. Do not require Effect as a dependency.

Read [references/effect-derived-checklist.md](references/effect-derived-checklist.md) before auditing a repository.

## Establish the contract

1. Inspect repository instructions, working-tree state, package manifests, lockfiles, TypeScript configs, package exports, source layout, and CI workflows.
2. Identify the runtime and artifact: application, CLI, library, worker, or monorepo package. Identify actual public boundaries and generated files.
3. Resolve inherited TypeScript configuration with `tsc --showConfig` when feasible. Do not review one config file in isolation.
4. Find the repository's real quality commands. Run read-only checks appropriate to the request; distinguish typecheck, lint, runtime tests, type tests, build, and live integration.
5. Preserve unrelated changes. In review mode, do not edit product code.

## Audit in risk order

### 1. Runtime boundaries

Trace data entering from CLI arguments, environment variables, JSON/YAML, files, subprocesses, network APIs, persistence, plugins, and framework callbacks.

- Keep boundary input `unknown` until decoded or narrowed.
- Reject casts that merely silence uncertainty, especially `JSON.parse(...) as T`, parsed config casts, and unchecked subprocess payloads.
- Validate once at the edge; pass domain values inward.
- Preserve useful validation context without exposing secrets.
- Test malformed, missing, extra, nullish, and adversarial input.

### 2. Domain states and failures

- Model mutually exclusive states as discriminated unions.
- Keep tags and error codes literal and stable.
- Make expected failures explicit with a local `Result`/error union or the repository's established equivalent.
- Reserve thrown exceptions for defects or APIs that require them; translate exceptions at an adapter boundary.
- Require exhaustive handling for commands, states, and error codes. Prefer typed maps or exhaustive switches over fallback branches that hide new variants.
- Prevent impossible combinations instead of documenting them.

### 3. Side effects and dependencies

- Keep parsing, planning, classification, and rendering pure where practical.
- Put filesystem, process, clock, randomness, network, and credentials behind narrow adapters or explicit function dependencies.
- Make cleanup, cancellation, timeout, exit status, signal handling, and partial output part of the contract.
- Keep orchestration at the composition root; do not let domain modules read globals directly.
- Avoid introducing dependency-injection machinery for one implementation. Prefer the smallest explicit seam.

### 4. Compiler and escape hatches

- Require `strict`; evaluate `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, and scoped ambient `types` against the actual runtime.
- Treat `skipLibCheck` as third-party declaration policy, not proof that application types are sound.
- Search for `any`, assertions, non-null assertions, `@ts-ignore`, broad index signatures, unchecked property access, and double casts. Verify each at its trust boundary.
- Prefer `satisfies` when checking a value while preserving inference. Use `as const` only when literal preservation is intended.
- Do not enable flags mechanically when tooling or emitted-code contracts conflict; record the exception and its test.

### 5. Module and API design

- Organize by cohesive feature or domain, with adapters at the edge and a small composition root.
- Keep `shared` limited to stable primitives used by multiple features. Move feature-specific types beside their behavior.
- Expose deliberate entry points; block internal modules from public exports.
- Keep value imports and type-only imports explicit under ESM.
- Preserve readable inferred public types. Avoid leaking private helpers, giant conditional types, or accidental unions.
- Check for circular dependencies and cross-feature imports that bypass public contracts.

### 6. Tests as type contracts

- Keep runtime tests for behavior and separate compile-time tests for exported inference, narrowing, overloads, and forbidden calls when those types matter to users or safety.
- Add negative compile-time cases with checked `@ts-expect-error`; never use unverified suppression comments.
- Test success and every expected failure variant at runtime.
- Use deterministic clocks, inputs, paths, process environments, and fixtures where output identity matters.
- Match validation scope to the change: targeted runtime test, type test, typecheck, lint, build, then broader gates only when justified.

## Avoid cargo culting Effect

- Do not recommend Effect, a schema library, branded primitives, project references, or type-performance infrastructure without a demonstrated target-repository need.
- Prefer a small discriminated union and explicit dependency argument when they close the same risk.
- Separate correctness defects from maintainability proposals.
- Require evidence before claiming a performance or compiler-speed problem.
- Do not convert every exception into a typed failure; classify expected operational failures separately from programmer defects.

## Report findings first

Order findings by severity and confidence. For each finding include:

1. Severity and concise title.
2. Exact `path:line`.
3. Trigger or counterexample.
4. Runtime, security, API, or maintenance impact.
5. Smallest concrete remediation consistent with existing patterns.
6. Positive and negative checks that prove the remediation.

Then report:

- compiler/runtime/test commands actually run and their exact status;
- confirmed strengths worth preserving;
- an incremental organization plan, with dependencies between steps;
- proposals separately from confirmed defects;
- unverified live or integration behavior separately from fixture evidence.

Do not report style preferences as findings. Do not claim that a passing typecheck validates runtime input.
