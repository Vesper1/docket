# Effect-derived TypeScript checklist

Use this reference as evidence and review prompts, not as a mandate to adopt Effect.

## Source snapshot

Reviewed `Effect-TS/effect` at commit [`ee06c9c1eed73ebcf282541ceb1615ff1ba1730d`](https://github.com/Effect-TS/effect/commit/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d) on 2026-08-16.

Primary evidence:

- [`tsconfig.base.json`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/tsconfig.base.json): shared strict baseline, exact optional properties, unused checks, explicit module semantics, scoped ambient types, composite builds.
- [`tsconfig.json`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/tsconfig.json) and [`tsconfig.packages.json`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/tsconfig.packages.json): solution-style project references instead of one undifferentiated compilation unit.
- [`package.json`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/package.json): separate checks for compilation, runtime tests, type tests, circular dependencies, lint, docs, bundle size, runtime performance, and type performance.
- [`packages/effect/src/Effect.ts`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/packages/effect/src/Effect.ts): `Effect<A, E, R>` exposes success, expected failure, and required services in the type.
- [`packages/effect/src/Result.ts`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/packages/effect/src/Result.ts): success and failure are a tagged union that can be narrowed and exhaustively handled.
- [`packages/effect/typetest/Result.tst.ts`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/packages/effect/typetest/Result.tst.ts): compile-time assertions protect inference separately from runtime behavior tests.
- [`packages/effect/package.json`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/packages/effect/package.json): explicit entry points and `null` export rules prevent access to internals.
- [`ai-docs/src/01_effect/02_schema/10_schema-basics.ts`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/ai-docs/src/01_effect/02_schema/10_schema-basics.ts): decode `unknown` into a valid domain value at the application edge.
- [`ai-docs/src/01_effect/03_services/01_service.ts`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/ai-docs/src/01_effect/03_services/01_service.ts): express side-effect dependencies through typed service contracts.
- [`ai-docs/src/01_effect/05_resources/10_acquire-release.ts`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/ai-docs/src/01_effect/05_resources/10_acquire-release.ts): couple acquisition with cleanup and translate promise rejection into a domain error.
- [`.agents/AGENTS.md`](https://github.com/Effect-TS/effect/blob/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d/.agents/AGENTS.md): use narrow, change-specific verification and run type tests for public type changes.

## Transferable model

Translate Effect's central type into ordinary TypeScript when the target does not use Effect:

```ts
// Effect<Success, ExpectedFailure, Requirements>
type Operation<R, E> = (deps: Requirements) => Promise<Result<R, E>>;
```

The exact abstraction is optional. The information is not:

- What value can succeed?
- Which failures are expected and recoverable?
- Which capabilities or side effects are required?

Use explicit parameters, small adapter interfaces, and a tagged `Result` union before adding a framework.

## Review probes

### Boundary proof

For every external value, answer:

1. Where does it first have type `unknown` or an equivalent raw type?
2. Which runtime check turns it into a domain value?
3. Can any cast bypass that check?
4. Is invalid input tested without performing later side effects?

High-risk searches:

```text
JSON.parse
JSON.stringify
process.env
process.argv
readFile / readFileSync
stdout / stderr
fetch / Response.json
yaml / parse
as unknown as
as <DomainType>
!
@ts-ignore / @ts-expect-error
```

### State proof

For each union, status, command, or error code:

1. Is there one stable discriminant?
2. Can incompatible fields coexist?
3. Does adding a variant force every consumer to decide what it means?
4. Is serialization stable and tested?

Prefer:

```ts
type Run =
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly error: RunError }
  | { readonly state: 'succeeded'; readonly deploymentId: string };
```

Avoid a bag of optional fields such as `{ state; error?; deploymentId? }`.

### Failure proof

Classify each failure:

- expected domain/operational failure: typed and handled;
- invalid external input: decoded and rejected at the edge;
- dependency defect or invariant violation: allowed to throw or converted once at the adapter;
- cancellation/timeout/signal: represented distinctly when callers act on it.

Reject `catch (error) { return undefined }`, string matching on arbitrary exception messages, and one error variant that erases all causes callers need.

### Dependency proof

Trace filesystem, Git, child processes, clock, network, and credentials. Require a narrow seam where tests can substitute them. Keep process-global reads and construction in the entry point or adapter layer.

Do not require a class or container. This is often enough:

```ts
interface Git {
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult>;
}
```

### Type-contract proof

Add compile-time tests only when inference itself is an API or safety property:

- result/error union is neither widened nor erased;
- a tag narrows to the correct payload;
- invalid call shapes fail;
- readonly input stays readonly where promised;
- an exported generic returns the intended public type.

Keep runtime tests for runtime behavior. A type test cannot prove a parser rejects bad JSON.

## Configuration interpretation

Effect demonstrates a coherent strict baseline, but flag choice remains contextual:

- `strict`: baseline requirement for modern TypeScript.
- `exactOptionalPropertyTypes`: distinguishes absence from a present `undefined`; valuable for config and serialized contracts.
- `noUncheckedIndexedAccess`: useful for dictionaries and parser output even though the reviewed Effect base does not enable it; adopt based on target risk, not imitation.
- `noUnusedLocals` / `noUnusedParameters`: useful in libraries; can conflict with staged application work or framework conventions.
- `types: []` or an explicit list: prevents accidental ambient globals.
- `verbatimModuleSyntax`: makes ESM/type-only import intent explicit.
- `isolatedModules` / `erasableSyntaxOnly`: protect compatibility with type-stripping or single-file transforms.
- project references: add only when package boundaries or compiler scale justify them.

## Organization interpretation

Effect uses a large public surface plus explicit internal modules because it is a library monorepo. For a small application or CLI:

- prefer cohesive feature folders;
- colocate a feature's types, parser, implementation, and tests;
- keep a small `shared` layer for cross-feature primitives only;
- separate pure decisions from adapters and process entry points;
- introduce package boundaries only after a real independent build, ownership, or release boundary appears.

Do not copy library-scale barrel generation, higher-kinded types, language-service plugins, or type-performance harnesses into a small application without measured need.
