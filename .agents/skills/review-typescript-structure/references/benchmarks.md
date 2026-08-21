# TypeScript CLI structure benchmarks

Snapshot date: 2026-08-16.

Use this reference for Node.js CLI and deployment-tool reviews. Refresh the repositories when the user asks for a current comparison or the target stack changes.

## Selection matrix

| Repository | Runtime/artifact fit | Transferable strengths | Do not copy |
| --- | --- | --- | --- |
| [Changesets](https://github.com/changesets/changesets/tree/d0386b69c8a8bd14a702e7636ab01c1e83b1914e) | TypeScript/Node CLI; release and Git automation | Thin command registration, command-owned folders and tests, capability packages for stable domains, explicit package exports | Its 20-package monorepo split for a small single-package CLI |
| [Salesforce CLI deploy/retrieve plugin](https://github.com/salesforcecli/plugin-deploy-retrieve/tree/7ca3324a2f151d2333702ab2c47bc55a080d0c39) | TypeScript/Node CLI; exact Salesforce deployment domain | Command paths mirror CLI nouns/verbs; formatters are explicit; unit and live/NUT tests are separated | oclif inheritance, large command classes, and a broad horizontal `src/utils/` folder |
| [Effect](https://github.com/Effect-TS/effect/tree/ee06c9c1eed73ebcf282541ceb1615ff1ba1730d) | TypeScript library monorepo, not a CLI | Strict compiler baseline, explicit entry points, typed success/error/dependency contracts, separate type tests | Library-scale packages, generated barrels, framework adoption, or type-performance machinery without need |

## Closest baseline: Changesets

Use Changesets as the primary structural analogue for a TypeScript automation CLI:

- [`packages/cli/src/cli.ts`](https://github.com/changesets/changesets/blob/d0386b69c8a8bd14a702e7636ab01c1e83b1914e/packages/cli/src/cli.ts) registers flags and lazily dispatches to command modules.
- [`packages/cli/src/commands`](https://github.com/changesets/changesets/tree/d0386b69c8a8bd14a702e7636ab01c1e83b1914e/packages/cli/src/commands) gives each growing command a folder with implementation and focused tests.
- [`packages/cli/src/commands/publish-plan`](https://github.com/changesets/changesets/tree/d0386b69c8a8bd14a702e7636ab01c1e83b1914e/packages/cli/src/commands/publish-plan) separates the command adapter from pure plan calculation.
- [`packages/cli/package.json`](https://github.com/changesets/changesets/blob/d0386b69c8a8bd14a702e7636ab01c1e83b1914e/packages/cli/package.json) exposes deliberate entry points instead of every internal file.
- Stable capabilities such as `config`, `git`, `errors`, `types`, `read`, and release-plan assembly have package boundaries because Changesets is a reusable monorepo ecosystem.

Transfer the vertical command ownership and deliberate boundaries. Keep a small target in one package until it has an independent build, release, public API, or owner.

## Salesforce-specific supplement

Use the Salesforce plugin to check domain terminology and test separation:

- [`src/commands/project`](https://github.com/salesforcecli/plugin-deploy-retrieve/tree/7ca3324a2f151d2333702ab2c47bc55a080d0c39/src/commands/project) mirrors `project deploy validate`, `project deploy start`, and related CLI paths.
- [`src/commands/project/deploy/validate.ts`](https://github.com/salesforcecli/plugin-deploy-retrieve/blob/7ca3324a2f151d2333702ab2c47bc55a080d0c39/src/commands/project/deploy/validate.ts) shows why flag declarations, orchestration, polling, formatting, and failure translation should not all migrate into a Docket command module.
- [`test/commands`](https://github.com/salesforcecli/plugin-deploy-retrieve/tree/7ca3324a2f151d2333702ab2c47bc55a080d0c39/test/commands) and [`test/nuts`](https://github.com/salesforcecli/plugin-deploy-retrieve/tree/7ca3324a2f151d2333702ab2c47bc55a080d0c39/test/nuts) distinguish command tests from real Salesforce acceptance.

Do not recreate `src/utils`. Give shared deployment behavior a domain owner or an adapter owner.

## Single-package target pattern

Adapt the benchmarks as a dependency direction, not a mandatory directory spelling:

```text
src/
  bin/                 executable composition root
  cli/
    commands/<verb>/   command parsing, invocation, rendering, focused tests
  workflows/           multi-capability validate/deploy/rollback use cases
  domain/              pure plans, policies, identities, records
  adapters/            git, github, salesforce, filesystem, process
  shared/              small stable primitives only
tests/
  fixtures/            deterministic cross-area fixtures
  live/                explicit provider acceptance, never part of fixture claims
```

Feature-first alternatives are valid when each feature owns its domain logic and adapter seams. Reject only real dependency ambiguity, cycles, or mixed change drivers.
