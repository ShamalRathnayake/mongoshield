# Contributing to MongoShield

Thanks for helping. MongoShield protects people's production data, so the bar for
correctness is high, and the bar for readable code is just as high: anyone should be
able to open a file and understand it quickly.

## Setup

You need Node.js 22.12+ (24 recommended, see `.nvmrc`) and Corepack.

```bash
corepack enable
pnpm install
```

Integration tests run against a real `mongod`. If you have one installed, point the
test harness at it to skip the download:

```bash
export MONGOMS_SYSTEM_BINARY=$(which mongod)
```

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm test` | all tests |
| `pnpm test:unit` | fast unit tests only |
| `pnpm test:integration` | tests against a real MongoDB |
| `pnpm lint:fix` | format and lint with Biome |
| `pnpm typecheck` | strict TypeScript check |
| `pnpm build` | build the package into `dist/` |
| `pnpm check` | everything CI runs |

## How we write code

Read [AGENTS.md](./AGENTS.md). The short version:

- Comment generously: a header on every file, JSDoc on every export, and a *why* on
  anything non-obvious.
- Small functions with descriptive names. No cleverness.
- Strict types: no `any`, no `@ts-ignore`, no non-null assertions.
- Every failure is a `MongoShieldError` with a code and, where possible, a hint.
- Anything touching MongoDB is tested against a real database.

## Commits and releases

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:` …); a git hook checks this.
- Any change users will notice needs a changeset: run `pnpm changeset` and describe it.
  Releases are published from CI; nobody publishes from a laptop.
- Changes to the on-disk format (manifest, layout, encryption) need an update to
  `docs/specs/` and a discussion in an issue first.
