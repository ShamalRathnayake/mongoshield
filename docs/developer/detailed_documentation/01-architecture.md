# Chapter 1: Project Design & Workspace Architecture

Before diving into the granular code, we must understand the macro-level engineering decisions that hold the MongoShield ecosystem together. A robust architecture starts at the root directory—with how the code is organized, linted, tested, and shipped.

This chapter breaks down the repository infrastructure, explaining the "why" behind the tools and configs that power the monorepo.

## 1.1 The Monorepo Strategy (PNPM Workspaces)

MongoShield is structured as a **Monorepo**. Instead of having 5 different Git repositories for the core engine, the local provider, the S3 provider, the scheduler, and the main wrapper, everything lives in one repository under the `packages/` directory.

### Why a Monorepo?
1. **Atomic Commits:** If a change in `@mongoshield/core` breaks an interface expected by `@mongoshield/provider-s3`, both changes (the core update and the provider fix) are committed together in a single PR. Tests run across the entire workspace, preventing localized breakages from silently entering production.
2. **Developer Experience (DX):** You can run `pnpm test` or `pnpm build` at the root, and the package manager inherently understands the dependency graph, building packages in the correct topological order.

### The `pnpm-workspace.yaml` Config
```yaml
packages:
  - "packages/*"
allowBuilds:
  cpu-features: true
  esbuild: true
  protobufjs: true
  ssh2: true
```
**Logic Decision:** 
- The `packages: - "packages/*"` line tells `pnpm` that every folder inside `packages/` is its own standalone NPM module with its own `package.json`.
- The `allowBuilds` section is a security feature in newer `pnpm` versions. It explicitly whitelists which dependencies are allowed to run post-install build scripts (e.g., compiling native C++ bindings for `ssh2` or `esbuild`). This prevents malicious sub-dependencies from silently executing arbitrary code during `pnpm install`.

## 1.2 Root Level Configuration (`package.json`)

The root `package.json` is not published to NPM. Its sole purpose is to orchestrate the workspace. Let's look at a few critical decisions:

```json
  "engines": {
    "node": ">= 20.x"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "test": "vitest run",
    "release": "changeset publish"
  }
```
**Logic Decisions:**
- **Node `>= 20.x`:** By targeting Node 20+, MongoShield can rely on stable native features like the web standard `crypto` APIs, `fetch`, native `test` runners (though we use Vitest), and optimized V8 garbage collection without heavy polyfills.
- **`pnpm -r run build`:** The `-r` (recursive) flag tells pnpm to execute the `build` script in *every* workspace package.
- **`changeset`:** MongoShield uses [Changesets](https://github.com/changesets/changesets) for versioning. Instead of manually bumping versions across interconnected packages, developers write short markdown files describing their changes. The CI/CD pipeline then computes the semantic version bump (Major/Minor/Patch) for all affected packages simultaneously.

## 1.3 Strict Typing & Configuration Inheritance (`tsconfig.json` / `tsconfig.base.json`)

Typescript is the backbone of MongoShield's reliability. Instead of duplicating configurations in every workspace package, MongoShield uses a **Base Configuration Inheritance** pattern.

The `tsconfig.base.json` acts as the master truth for compiler strictness:
```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "isolatedModules": true
  }
}
```
**Logic Decisions in Base:**
- **`moduleResolution: "bundler"`:** Modern projects bundled by `esbuild` or `tsup` use this. It allows TypeScript to properly resolve package exports in `package.json` without forcing developers to append `.js` to their relative imports, unlike `NodeNext`.
- **`exactOptionalPropertyTypes`:** If an interface has `property?: string`, TypeScript will throw an error if you explicitly set it to `undefined`. This prevents database records from being accidentally polluted with literal `null` or `undefined` values instead of just omitting the key entirely.
- **`noImplicitOverride`:** Forces developers to use the `override` keyword when subclassing. If `AbstractStorageProvider` renames a base method, child classes will instantly throw compiler errors, preventing silent inheritance bugs.

The root `tsconfig.json` then extends this base and adds DX aliases:
```json
  "compilerOptions": {
    "paths": {
      "mongoshield": ["./packages/mongoshield/src"],
      "@mongoshield/core": ["./packages/core/src"],
      "@mongoshield/provider-local": ["./packages/provider-local/src"]
    }
  }
```
- **`"paths"` alias mapping:** This is a crucial Developer Experience (DX) improvement. When working inside `@mongoshield/provider-local`, importing from `@mongoshield/core` would normally require the core package to be built first. By mapping the paths directly to the `./packages/*/src` directories, VS Code and TypeScript instantly resolve the *live source code* of sibling packages. You get real-time autocomplete across package boundaries without constantly rebuilding.

## 1.4 Unified Toolchain: Biome (`biome.json`)

**What is it?**
Biome is a blazingly fast, Rust-based toolchain that replaces both `ESLint` (for linting code logic) and `Prettier` (for formatting code style). 

**How it works:**
Traditionally, JavaScript projects required complex configurations to make ESLint and Prettier play nicely together without fighting over rules (like trailing commas or line lengths). Biome integrates both the parser, linter, and formatter into a single native binary. Because it is written in Rust, it can traverse the Abstract Syntax Tree (AST) of the entire monorepo in milliseconds, rather than the seconds or minutes required by Node-based tooling.

**How to use it:**
In MongoShield, you don't need to memorize complex CLI flags. You simply run:
- `pnpm exec biome format --write .` to instantly format every file.
- `pnpm exec biome lint .` to catch logical errors like unused variables.
- Or, let the VS Code Biome extension format automatically on save!

```json
{
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  }
}
```
**Logic Decisions:**
- **Speed & Simplicity:** By consolidating both tasks into a single tool and a single configuration file (`biome.json`), it eliminates configuration hell and guarantees that CI/CD linting checks finish almost instantaneously, speeding up the PR review cycle.

## 1.5 CI/CD Pipelines (GitHub Actions)

Continuous Integration is defined in `.github/workflows/pr-validation.yml`. This "Gatekeeper" workflow runs on every Pull Request to `main`.

### The PR Gatekeeper (`pr-validation.yml`)
This workflow is the ultimate firewall. It runs on every Pull Request targeting the `main` branch. If any step fails, the PR cannot be merged.

**Step-by-step breakdown:**
1. **The Build Matrix (`matrix: node-version: [20.x, 22.x]`)**: 
   The pipeline doesn't just run once. It spawns multiple parallel jobs to test the codebase against multiple Node.js versions simultaneously. This ensures MongoShield doesn't accidentally use a feature exclusive to Node 22 that would break for users still on Node 20 LTS.
2. **Setup & Caching**: 
   The pipeline checks out the code, installs `pnpm` (v9), and sets up Node. Crucially, it uses `cache: "pnpm"`. This caches the `~/.local/share/pnpm/store` directory across workflow runs, cutting CI execution time in half since it doesn't have to download thousands of packages from the internet every time.
3. **Strict Installation (`--frozen-lockfile`)**: 
   It runs `pnpm install --frozen-lockfile`. This prevents the CI pipeline from accidentally updating `pnpm-lock.yaml`. If the dependencies in the lockfile don't match `package.json`, the CI will crash, forcing developers to commit lockfile changes locally first.
4. **Security Audit**: 
   Runs `pnpm audit --audit-level=high`. This queries the global vulnerability database. If a malicious or vulnerable dependency sneaks into the PR, the CI fails immediately.
5. **Separation of Concerns (Linting & Typing)**:
   Notice how Linting (`biome ci`), Type Checking (`tsc --noEmit`), and Testing (`vitest`) are separate steps. `tsc --noEmit` is run because Vitest/esbuild strips TypeScript types without checking them. We *must* verify type correctness explicitly.
6. **Integration Testing**: 
   Finally, `pnpm test` runs. Because we use `@testcontainers/mongodb`, this step automatically pulls a real MongoDB Docker image inside the GitHub Actions runner, spins up a live database, and runs the Vitest suite against it. This guarantees production-grade reliability.

### The Release Pipeline: Changesets Deep Dive (`release.yml`)
**What is it?**
Changesets is a workflow tool designed specifically for monorepos to manage versioning and changelogs. Instead of a maintainer manually figuring out which packages changed and bumping their versions in `package.json`, developers declare their changes via markdown files.

**How it works:**
When a developer works on a feature in a branch, they don't touch `package.json`. Instead, they run a CLI command which creates a temporary `.md` file in the `.changeset/` folder. This file contains YAML frontmatter detailing which packages should receive a `patch`, `minor`, or `major` bump, along with a human-readable description of the change. 
When the branch is merged to `main`, a GitHub Action reads all the accumulated `.md` files, deletes them, and aggregates their descriptions into a massive changelog, automatically bumping the versions across the monorepo according to Semantic Versioning (SemVer) rules.

**Step-by-step breakdown of the Release Pipeline:**
1. **Concurrency Control**:
   `concurrency: ${{ github.workflow }}-${{ github.ref }}` ensures that if two PRs are merged into `main` back-to-back rapidly, GitHub cancels the older release workflow and only runs the latest one. This prevents race conditions where an older build overrides a newer publish on NPM.
2. **Elevated Permissions**:
   ```yaml
   permissions:
     contents: write
     id-token: write
     pull-requests: write
   ```
   The action needs `pull-requests: write` to automatically open the "Version Packages" PR. It needs `id-token: write` for OIDC provenance authentication with NPM.
3. **Environment Setup & Build**:
   Just like the PR Gatekeeper, it installs dependencies with `--frozen-lockfile` and runs `pnpm build`. We must publish compiled `/dist` files, not raw TypeScript.
4. **The Changesets Action**:
   The `changesets/action@v1` takes over. If there are unreleased `.md` files, it creates or updates a PR titled "Version Packages". 
   If the admin *merges* that specific PR, the action detects it, runs `pnpm release` (which publishes to the NPM registry), and tags the GitHub commit.
5. **NPM Provenance (`NPM_CONFIG_PROVENANCE: true`)**:
   This is a modern supply-chain security feature. It uses GitHub OIDC tokens to cryptographically sign the NPM package, proving exactly which GitHub Actions runner and which specific Git commit generated the published package. It prevents attackers from intercepting and publishing compromised versions of MongoShield.

### Dependency Automation (`.github/dependabot.yml`)
Managing dependencies manually in a monorepo is a nightmare. MongoShield delegates this to GitHub Dependabot.
```yaml
updates:
  - package-ecosystem: "npm" 
    schedule:
      interval: "weekly"
    commit-message:
      prefix: "chore"
```
**Logic Decisions:**
- **Weekly Cadence:** Running it weekly prevents CI fatigue. Daily updates can overwhelm developers with minor PRs.
- **Semantic Compliance:** By configuring `prefix: "chore"`, Dependabot automatically formats its PRs to comply with the strict commit conventions (e.g., `chore(deps): bump typescript`). This ensures it passes the CI pipeline.

## 1.6 Build Matrix & Bundling: Tsup (`tsup.config.ts`)

**What is it?**
Tsup is a zero-config bundler powered by `esbuild`. Its job is to take raw, modern TypeScript files and compile them down into optimized JavaScript files that can be published to NPM and executed by Node.js.

**How it works:**
Node.js historically used the CommonJS module system (`require('module')`). Recently, it shifted to the modern ECMAScript Module system (`import { x } from 'module'`). A well-engineered library must support both formats simultaneously, otherwise users will encounter `ERR_REQUIRE_ESM` errors when trying to install the package.
Tsup reads the entry file (e.g., `src/index.ts`), walks the dependency tree, and rapidly compiles the code into a `/dist` folder containing both `.js` (ESM) and `.cjs` (CommonJS) files.

**How to use it:**
Running `pnpm build` at the root executes `tsup` across all packages in the monorepo, generating the production-ready `/dist` directories.

```typescript
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: true,
  sourcemap: true,
  treeshake: true,
});
```
**Logic Decisions:**
- **`format: ["cjs", "esm"]`:** This instructs esbuild to compile two separate bundles simultaneously. When a user installs MongoShield, Node.js automatically selects the correct bundle based on their project's module resolution type. 
- **`dts: true`:** Automatically generates `.d.ts` (TypeScript Declaration) files. Even though we strip out TS during compilation, this guarantees that consumers using TypeScript still receive full autocomplete and type-checking when integrating our library.
- **`treeshake: true`:** Dead-code elimination. If a consumer only imports a specific provider, esbuild strips out unused classes and functions from the final bundle, drastically reducing the package footprint.

## 1.7 Testing Standards: Vitest (`vitest.config.ts`)

**What is it?**
Vitest is a blazing fast unit-testing framework built on top of Vite. While Jest has historically been the standard, Vitest provides native TypeScript and ESM support without requiring complex Babel transpilation pipelines.

**How it works:**
Vitest uses worker threads to run tests in parallel. It completely shares the configuration of `vite` and `esbuild`, meaning the environment that builds your code is the exact same environment that tests your code. Furthermore, it natively supports tracking code coverage (which lines of code were executed during tests and which weren't).

**How to use it:**
Run `pnpm test` to execute all tests. Run `pnpm test --coverage` to generate an HTML report showing exactly which lines of code are missing test coverage.

```typescript
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
```
**Logic Decisions:**
- **`provider: "v8"`:** We use V8's native coverage engine rather than Istanbul (Babel). V8 coverage is significantly faster because it operates directly on the V8 engine bytecode without needing to transpile and instrument the source code with counting functions.
- **The 100% Threshold:** By enforcing 100% on *Lines, Functions, Branches, and Statements*, developers are forced to write tests for every `try/catch` block, every `if/else` path, and every edge case. For a data security tool like MongoShield, relying on "happy path" testing is unacceptable. Any PR that drops coverage by even 0.1% is automatically rejected by the CI gatekeeper.

## 1.8 Strict Commit Conventions (`commitizen` & `husky`)

**What are they?**
Husky is a tool that allows you to easily intercept Git lifecycle hooks (like `pre-commit` or `commit-msg`) and run bash scripts. Commitizen is an interactive CLI wizard that helps developers write perfectly formatted, semantic commit messages (e.g., `feat(core): add GZIP support`). 

**How they work together:**
To automate semantic versioning (Semantic Release), the git commit history must be strictly structured. If developers write commit messages like "fixed bug", the CI pipeline cannot determine whether it's a Major, Minor, or Patch release.
1. When a developer attempts to commit code, Husky's **pre-commit** hook fires first to ensure the code is clean.
2. The developer provides a commit message.
3. Husky's **commit-msg** hook fires next, piping the message into `commitlint` to ensure it is grammatically semantic. If it isn't, the commit is aborted.

**How to use them:**
Never run `git commit -m "my message"`. It is too easy to mess up the formatting and get rejected by Husky. Instead, run `pnpm commit`. This launches the **Commitizen CLI**. It asks you questions (Is this a feature or a bug? What is the scope? What is the short description?) and automatically constructs the perfect string for you!

### Husky Hooks (`.husky/`)

**1. `.husky/pre-commit`**
```bash
npx lint-staged
pnpm audit --audit-level high
```
- **Logic Decision:** When a developer types `git commit`, this script runs first. It executes `lint-staged` (which only runs Biome on the specific files being committed, keeping commits blazingly fast) and `pnpm audit`. If the audit detects a High severity CVE vulnerability in the `node_modules`, it crashes the script, actively blocking the developer from committing vulnerable code.

**2. `.husky/commit-msg`**
```bash
npx --no -- commitlint --edit "$1"
```
- **Logic Decision:** If the pre-commit checks pass, git tries to save the message. This script intercepts the message and pipes it through `@commitlint/config-conventional`. If the message doesn't follow the `type(scope): description` format, the commit is instantly rejected.

## 1.9 Automated API Documentation: TypeDoc (`typedoc.json`)

**What is it?**
TypeDoc is an automatic documentation generator for TypeScript projects. Instead of maintaining separate wiki pages that quickly go out of date, TypeDoc reads the actual TypeScript source code and compiler interfaces to generate documentation.

**How it works:**
TypeDoc scans the designated `entryPoints` (the public exports of your packages). It extracts all classes, interfaces, types, and methods. It reads the JSDoc comments (`/** ... */`) directly above them, pulling out tags like `@param` or `@returns`. It then compiles all of this information into a structured, easily navigable website or set of markdown files.

**How to use it:**
As a developer, your only job is to write high-quality JSDoc comments above your functions. When you run `npx typedoc`, the entire `/docs/api` folder is automatically generated and updated.

```json
{
  "entryPoints": [
    "packages/mongoshield/src/index.ts",
    "packages/core/src/index.ts"
  ],
  "out": "docs/api",
  "plugin": ["typedoc-plugin-markdown"]
}
```
**Logic Decisions:**
- **Docstrings as Truth:** By making the source code the single source of truth for documentation, we guarantee that the API docs exactly match the shipped code. 
- **Markdown Export:** Instead of generating ugly HTML files, `typedoc-plugin-markdown` generates clean `.md` files. This allows the documentation to be natively hosted on GitHub Wikis or injected directly into Docusaurus/Nextra documentation sites.

---

*This concludes Chapter 1. In the next chapter, we will dive deep into `@mongoshield/core` and dissect the streaming orchestration layer line by logic-driven line.*

<br/>
