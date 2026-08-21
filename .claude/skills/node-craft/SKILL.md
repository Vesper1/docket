---
name: node-craft
description: Review or write Node.js/TypeScript code against the conventions of reference-grade repos (execa, hono) - tiny single-purpose modules, named arrow exports, validate-at-the-boundary, why-comments, co-located behaviour tests. Use when reviewing a Node/TS diff, restructuring a module, or deciding how to split files.
---

# node-craft

Rules distilled from reading `sindresorhus/execa` (7.4k LOC, 110 modules) and
`honojs/hono` (25.7k LOC src). Every rule below is a measured property of those
repos, not taste.

## 1. Module shape

- **One concern per file, small.** execa: median lib file ~60 lines, largest 243,
  none over 250. Directory names are the concern (`terminate/`, `resolve/`,
  `return/`, `arguments/`), file names are the step (`kill.js`, `signal.js`,
  `timeout.js`). A file over ~250 lines is a signal to look, never a finding on its
  own - report it only once you can prove mixed responsibilities from the functions,
  imports, side effects or tests inside it.
- **Directory = feature, not layer.** No `utils/` dumping ground beyond genuinely
  generic primitives (execa's `utils/` holds 5 files: deferred, abort-signal,
  max-listeners, standard-stream, uint-array).
- **Barrel only at the package root, and only for external consumers.** `index.ts`
  re-exports the public API when something outside the package imports it; inside an
  area, import by explicit path.

## 2. Exports

- **Named exports only.** execa: 0 `export default` in 110 lib files.
- **`export const fn = (…) => …`**, not `export function`. execa: 234 vs 0.
  Both rules above govern new code, not review findings on their own - flag an
  existing export style only when it breaks a contract (a default export in a public
  entry point, a name that collides with the package API).
- **Non-exported helpers live below their caller**, defined with `const` in the same
  file, in call order (public entry first, private helpers under it).
- **Classes are rare** - 2 in all of execa, both real stateful objects. Default to
  functions over data.

## 3. Arguments and return values

- **Destructured object parameters** for anything past 2 args, destructured at the
  signature so the file documents its own inputs.
- **Stable result shape.** Build the return object with all keys always present in a
  fixed order; strip `undefined` at the end rather than conditionally adding keys.
  execa asserts key order in tests (`Reflect.ownKeys(result)`).
- **Normalize once, at the boundary.** `normalizeOptions()` runs every
  `validateX`/`normalizeX` in one place; everything downstream trusts its input.
  Never re-validate in inner functions.

## 4. Errors

- **Throw `TypeError` for programmer error** (bad argument type/shape), with a message
  naming the option, the expected shape, the received value *and* its type:
  ``Expected the `forceKillAfterDelay` option to be a non-negative integer, got `${value}` (${typeof value})``
- **Return error values for expected runtime failure** (a process exited non-zero is
  data, not an exception) - keep the two kinds separated.
- Preserve the original as `cause`; never swallow it.

## 5. Comments

- ~6 comment lines per file in execa, and they answer **why**, never what:
  `// Prevent prototype pollution by copying only own properties`,
  `// `signal` and `exitCode` emitted on `exit` can be `null`. We normalize to `undefined``.
  A comment restating the code is a defect. A non-obvious workaround with no comment
  is also a defect - link the issue (`// #116`).
- Exported API surface gets JSDoc (hono `context.ts`: 72 doc lines); internals do not.

## 6. Tests

- **Test tree mirrors source tree** (`test/return/result.js` ↔ `lib/return/result.js`),
  or co-located `*.test.ts` next to the source (hono). Pick one, keep it total.
- **Shared setup lives in `test/helpers/`**, one helper file per concern - not copied
  fixtures.
- **Parametrized cases**: write the case body once, run it against each variant
  (sync/async, each platform) rather than duplicating the assertion block.
- Assert the **whole shape**, not one field, when the shape is the contract.

## 7. Platform

- `node:` prefix on every builtin import, always.
- `"type": "module"`, `engines.node` pinned to a current LTS or newer.
- Precompile regexes to module-level consts (`const cmdExeRegExp = /…/i`).
- Platform branches (`process.platform === 'win32'`) get a comment saying why.

## Review procedure

Walk the diff once per section 1-7. For each finding report exactly:
`path:line - what breaks the rule - the concrete fix`.
Rank by: correctness bug > wrong module boundary > leaked validation/duplication >
naming/comment. Skip anything you cannot state a concrete fix for.
