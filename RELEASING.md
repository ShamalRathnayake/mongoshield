# Releasing MongoShield

How a release gets from merged pull requests to npm, ghcr.io, GitHub and the docs site,
and the exact steps for the **first stable release, 2.0.0**.

## What a release ships

| Artifact | Where | Built by |
|---|---|---|
| `mongoshield` (library + CLI) | npm, dist-tag `latest` (`next` for pre-releases) | `.github/workflows/release.yml` |
| `@mongoshield/console` | npm, same version as `mongoshield` | `release.yml` |
| CLI image | `ghcr.io/shamalrathnayake/mongoshield:X.Y.Z`, `:X.Y`, `:X`, `:latest` | `docker.yml`, called by `release.yml` |
| Console image | `ghcr.io/shamalrathnayake/mongoshield-console:` same tags; also `:latest`, `:next` and `:sha-…` on every push to `main` (see below) | `docker.yml`, called by `release.yml` |
| `@mongoshield/operator` (Kubernetes operator) | npm, its own 0.x version line | `release.yml` |
| Operator image | `ghcr.io/shamalrathnayake/mongoshield-operator:` the operator's version | `docker.yml`, called by `release.yml` |
| Git tags + GitHub releases | `mongoshield@X.Y.Z`, `@mongoshield/console@X.Y.Z` | changesets/action in `release.yml` |
| Docs site | https://shamalrathnayake.github.io/mongoshield/ | `docs.yml`, on every push to `main` |
| GitHub Action | `ShamalRathnayake/mongoshield/action@v2` | a moving `v2` git tag, moved by hand (below) |

npm packages are published with **trusted publishing** (OIDC, no `NPM_TOKEN` anywhere) and
carry **provenance**. Images are multi-arch, signed with cosign (keyless) and ship an SBOM
and SLSA provenance.

### Versioning decisions

- **2.0.0 is the first stable release.** The npm name `mongoshield` already holds
  `1.0.1-alpha.0` and `1.0.1-alpha.1` from an earlier, unrelated prototype, so the first
  real release has to be above them; it is 2.0.0. Those old versions, and the
  prototype's `@mongoshield/core`, `@mongoshield/provider-local` and
  `@mongoshield/provider-s3` packages, are deprecated after the release (step 8).
- **`@mongoshield/console` is released in lockstep** with `mongoshield`
  (`"fixed": [["mongoshield", "@mongoshield/console", "@mongoshield/operator"]]` in
  `.changeset/config.json`), so its
  first version is also 2.0.0. The console depends on the exact library version it was
  built with (`workspace:*` becomes `"mongoshield": "2.0.0"` on publish), both Docker images
  are built from one commit with one version tag, and "console X runs on mongoshield X" is
  the only compatibility rule anyone has to know. A separate 0.x line would suggest the
  console is experimental and need a compatibility table; it has its own full test suite
  (unit, integration, Playwright) and is not experimental.
- **`@mongoshield/operator` is released in lockstep too** (it is in the same `fixed`
  group), so its first version is also 2.0.0 and "operator X runs MongoShield X" holds.
  Its custom resources are still `mongoshield.io/v1alpha1`: the API version, not the
  package version, says that they may change. `docker.yml` tags its image with
  `packages/operator/package.json`'s version.
- Any other non-private package under `packages/` is published too. A new package must
  either join the `fixed` group, set `"private": true`, or go through the first-publish
  bootstrap below, and it must pass `pnpm check:package` (the release job runs it).

## One-time setup (before the first release)

These need the repository owner; agents and CI cannot do them.

### GitHub settings

1. **Settings → Actions → General → Workflow permissions:** tick "Allow GitHub Actions to
   create and approve pull requests" (changesets/action opens the version PR).
2. **Settings → Pages → Source:** "GitHub Actions" (for `docs.yml`).
3. Optional but recommended: protect `main` (require CI), so a release only ever builds
   from reviewed code.

### GitHub Container Registry: make the images public

Images pushed to ghcr.io from a workflow with `GITHUB_TOKEN` start out **private**, even
for a public repository: `docker pull` and the console quickstart then fail with
"unauthorized" for everyone else. After the first push of each image (the first `docker.yml`
run on `main` creates them):

1. GitHub → your profile → **Packages** → `mongoshield-console` (then `mongoshield` and
   `mongoshield-operator`) → **Package settings**.
2. **Manage Actions access**: make sure the `mongoshield` repository is listed with the
   **Write** role (pushing from `docker.yml`), or turn on **Inherit access from source
   repository**. The `org.opencontainers.image.source` label links the package to the
   repository automatically.
3. **Danger Zone → Change visibility → Public**. This cannot be undone for a package that
   has been public, which is what we want.

Check from a machine that is not logged in to ghcr.io:
`docker logout ghcr.io && docker pull ghcr.io/shamalrathnayake/mongoshield-console:latest`.

**Console `:latest` follows `main`.** The console's quickstart is the tag-less
`docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console`,
so `docker.yml` also pushes `:latest` of the console image on every push to `main`
(`latest-on-main: true` in its matrix). Pre-GA that is the only way the one-liner works:
prereleases never move `:latest`. The trade-off is that between releases `:latest` is the
newest `main` build rather than the newest release; production users should pin `:X.Y.Z`.
After 2.0.0, decide whether to keep that or set `latest-on-main: false` so `:latest`
tracks releases only (as for the CLI and operator images). A release always moves
`:latest` to itself.

### npm: trusted publisher for `mongoshield` (exists already)

On https://www.npmjs.com/package/mongoshield/access (Settings):

1. **Trusted Publisher → GitHub Actions**:
   - Organization or user: `ShamalRathnayake`
   - Repository: `mongoshield`
   - Workflow filename: `release.yml` (the file name only, not the path)
   - Environment: leave empty (the release job does not use a GitHub environment)
2. **Publishing access:** "Require two-factor authentication and disallow tokens". With a
   trusted publisher, CI needs no token, and nobody can publish with a leaked one.

Newer npm CLIs can do step 1 from a terminal too (`npm trust --help`). Set it up shortly
before the release: npm may expire trusted-publisher configurations that are never used.

### npm: bootstrap `@mongoshield/console` (does not exist yet)

npm only lets you attach a trusted publisher to a package that already exists, so the
very first version of a new package cannot come from CI. Publish a throwaway placeholder
by hand, configure the trusted publisher, and let CI publish the real 2.0.0. The
`@mongoshield` scope is already yours (the prototype packages live there).

```sh
mkdir -p /tmp/console-bootstrap && cd /tmp/console-bootstrap
cat > package.json <<'EOF'
{
  "name": "@mongoshield/console",
  "version": "0.0.0-bootstrap.0",
  "description": "Placeholder so the release workflow can publish this package. Install 2.0.0 or later.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/ShamalRathnayake/mongoshield.git", "directory": "packages/console" }
}
EOF
npm login                                        # interactive, with 2FA
npm publish --access public --tag bootstrap      # publishes only package.json
```

Then add the trusted publisher on https://www.npmjs.com/package/@mongoshield/console/access
exactly as for `mongoshield` above, and disallow tokens. The placeholder is removed in
step 8.

## Releasing 2.0.0

The repository is in Changesets **pre mode** (`.changeset/pre.json`, tag `next`). Leaving
pre mode makes the next version PR produce stable versions on `latest`.

### 1. Check that `main` is green

CI, Docs, Docker and Examples must pass on `main`. Run the topology suite
(`pnpm test:topology`, Docker) and, if the cloud accounts are set up, the real-cloud
workflow (`gh workflow run cloud.yml`) and wait for both.

### 2. Exit pre mode

```sh
git switch main && git pull
git switch -c release/2.0.0
pnpm changeset pre exit        # sets "mode": "exit" in .changeset/pre.json
pnpm changeset status          # expect: mongoshield major, @mongoshield/console major
```

Read every `.changeset/*.md`: they become the 2.0.0 changelog and GitHub release notes.
Reword anything that reads as an internal fix log.

To preview the result without touching the branch:

```sh
git worktree add ../mongoshield-release-preview HEAD
cd ../mongoshield-release-preview && pnpm install --frozen-lockfile
GITHUB_TOKEN="$(gh auth token)" pnpm changeset version   # the changelog plugin calls the GitHub API
grep '"version"' packages/*/package.json                  # expect 2.0.0 and 2.0.0
cat packages/mongoshield/CHANGELOG.md
cd - && git worktree remove --force ../mongoshield-release-preview
```

Commit, open a pull request, merge it:

```sh
git commit -am "chore: leave pre mode for the 2.0.0 release"
git push -u origin release/2.0.0 && gh pr create --fill
```

### 3. Review the version pull request

On that merge, `release.yml` opens **"chore: version packages"** (branch
`changeset-release/main`). Check:

- `packages/mongoshield/package.json` and `packages/console/package.json` say `2.0.0`
  (no `-next.N`), and `.changeset/pre.json` and the consumed changesets are deleted;
- `CHANGELOG.md` in both packages reads like release notes.

### 4. Switch the docs from `@next` to the stable release

Until 2.0.0 is on `latest`, `npx mongoshield` would install the old prototype, so the docs
say `mongoshield@next`. Switch them in the version PR itself, so the docs site (deployed
on the same merge) and npm change together. Merge the PR soon after: the next push to
`main` regenerates that branch.

```sh
git fetch origin && git switch changeset-release/main

# npm: mongoshield@next -> mongoshield
grep -rlE 'mongoshield@next' README.md docs website/src/content examples deploy action \
  | xargs sed -i '' 's/mongoshield@next/mongoshield/g'           # Linux: sed -i

# Images: :next -> :2 in examples (the tag list in docs/guides/docker.md keeps :next)
grep -rlE 'mongoshield(-console)?:next' docs deploy examples \
  | xargs sed -i '' -E '/latest build from main/!s/mongoshield(-console)?:next/mongoshield\1:2/g'

# The GitHub Action: @main -> @v2
grep -rl 'mongoshield/action@main' action docs examples \
  | xargs sed -i '' 's#mongoshield/action@main#mongoshield/action@v2#g'
```

Then edit by hand (search for `next` in each):

- `README.md`: delete the "Status: release candidate" note; update the roadmap's "Next:" line.
- `website/src/content/docs/getting-started/introduction.md`: delete the Status note.
- `website/src/content/docs/limitations.md`: delete the "Release candidate" bullet.
- `examples/README.md`: "All examples use the `mongoshield@next` dist-tag…" → "Pin an
  exact version in production."
- `action/action.yml`: `version` input `default: next` → `default: latest`, and
  `docs/guides/github-actions.md`: "(default `next`)" → "(default `latest`)".
- `deploy/helm/mongoshield/Chart.yaml`: `appVersion: "next"` → `"2.0.0"` (and bump the
  chart `version`); `docs/guides/kubernetes.md`: `tag: "next"` → `tag: "2.0.0"`.

```sh
git diff                                  # review every change
pnpm docs:build                           # the site builds and every internal link resolves
git commit -am "docs: point install instructions at the stable release"
git push
```

### 5. Merge the version pull request

`release.yml` then, on `main`:

1. builds and runs `pnpm check:package` (publint + attw);
2. runs `changeset publish`: `pnpm publish` of `mongoshield@2.0.0` and
   `@mongoshield/console@2.0.0` to the `latest` dist-tag, authenticated by OIDC, with
   provenance;
3. pushes the tags `mongoshield@2.0.0` and `@mongoshield/console@2.0.0` and creates a GitHub
   release for each from its changelog;
4. calls `docker.yml` with `version: 2.0.0`, which builds, smoke-tests, scans, pushes and
   signs `:2.0.0`, `:2.0`, `:2` and `:latest` of both images.

`docs.yml` deploys the site from the same push.

If the publish step fails half-way, fix the cause and re-run it:
`gh workflow run release.yml` (`changeset publish` skips versions already on npm).

### 6. Verify

```sh
npm view mongoshield dist-tags                     # latest: 2.0.0
npm view @mongoshield/console dist-tags            # latest: 2.0.0
npx --yes mongoshield@2.0.0 --version
mkdir -p /tmp/verify && cd /tmp/verify && npm init -y >/dev/null \
  && npm install mongoshield@2.0.0 @mongoshield/console@2.0.0 && npm audit signatures
docker run --rm ghcr.io/shamalrathnayake/mongoshield:2.0.0 --version
cosign verify ghcr.io/shamalrathnayake/mongoshield:2.0.0 \
  --certificate-identity-regexp '^https://github.com/ShamalRathnayake/mongoshield/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The npm package page shows a "Provenance" badge linking to the workflow run. Open the
docs site and check the install commands.

### 7. GitHub: releases and the Action tag

GitHub marks the most recently created release as "Latest", which may be the console's.
Make the library's release the latest one and add a short introduction at the top of its
notes:

```sh
gh release edit "mongoshield@2.0.0" --latest
gh release edit "mongoshield@2.0.0" --notes-file <(printf '%s\n\n' "First stable release." && gh release view "mongoshield@2.0.0" --json body -q .body)
```

Point the Action's major tag at the release (move it the same way on every release):

```sh
git fetch --tags
git tag -f v2 "mongoshield@2.0.0^{commit}"
git push -f origin v2
```

`docker.yml` ignores `v2` (it only builds full versions such as `v2.0.0`).

### 8. npm housekeeping

```sh
# Keep `mongoshield@next` (old blog posts, pinned workflows) resolving to the newest
# release until the next pre-release cycle moves it again.
npm dist-tag add mongoshield@2.0.0 next

# The prototype versions and packages.
npm deprecate mongoshield@"<2.0.0" "Early prototype, not maintained. Install mongoshield@2 or later: https://shamalrathnayake.github.io/mongoshield/"
npm deprecate @mongoshield/core "Early prototype, not maintained. Use the mongoshield package instead."
npm deprecate @mongoshield/provider-local "Early prototype, not maintained. Use the mongoshield package instead."
npm deprecate @mongoshield/provider-s3 "Early prototype, not maintained. Use the mongoshield package instead."
npm dist-tag rm @mongoshield/core alpha
npm dist-tag rm @mongoshield/provider-local alpha
npm dist-tag rm @mongoshield/provider-s3 alpha

# The console bootstrap placeholder. Unpublishing is allowed within 72 hours of its
# publication; after that, deprecate it instead.
npm dist-tag rm @mongoshield/console bootstrap
npm unpublish @mongoshield/console@0.0.0-bootstrap.0 \
  || npm deprecate @mongoshield/console@0.0.0-bootstrap.0 "Placeholder. Install @mongoshield/console@2 or later."

npm dist-tag ls mongoshield        # latest: 2.0.0, next: 2.0.0
```

`npm deprecate` and `npm dist-tag` need an interactive login with 2FA (`npm login`).

## Later releases

1. Every user-facing pull request adds a changeset: `pnpm changeset`.
2. Merging to `main` keeps the "chore: version packages" PR up to date.
3. Merging that PR publishes, tags, releases and builds the images as above (steps 5–7;
   move the `v2` tag each time).

Pre-releases: `pnpm changeset pre enter next`, merge, and version PRs then produce
`X.Y.Z-next.N` on the `next` dist-tag (images get only their exact `:X.Y.Z-next.N` tag).
`pnpm changeset pre exit` returns to stable releases.

## Rollback

npm never lets a version number be reused, so a bad release is fixed forward.

- **Broken npm release:** publish a fix as a patch (changeset + version PR). Meanwhile warn
  users with `npm deprecate mongoshield@2.0.1 "Broken: <why>. Use 2.0.2."` and, if an
  earlier version is good, `npm dist-tag add mongoshield@<good> latest` so new installs get
  it (move `latest` back after the fix). `npm unpublish` works only within 72 hours and only
  without dependents; prefer deprecation.
- **Broken image:** point the moving tags back at the last good image (no rebuild):
  `docker buildx imagetools create -t ghcr.io/shamalrathnayake/mongoshield:latest -t ghcr.io/shamalrathnayake/mongoshield:2 ghcr.io/shamalrathnayake/mongoshield:<good>`
  (needs `docker login ghcr.io`; repeat for `mongoshield-console`). Exact version tags stay.
- **Broken docs:** revert the commit on `main`; `docs.yml` redeploys.
- **Wrong GitHub release notes:** `gh release edit <tag>`; releases and tags can be
  deleted, but npm versions stay, so keep tags that match published versions.

## Troubleshooting

- **Publish fails with 404 / ENEEDAUTH / "OIDC token exchange failed":** the trusted
  publisher does not match this run. Check owner, repository and workflow file name
  (`release.yml`) on npmjs.com, and that the job has `id-token: write`.
- **Provenance error:** provenance needs a public repository and a GitHub-hosted runner.
- **No version PR appears:** the "Allow GitHub Actions to create and approve pull
  requests" setting is off, or there are no changesets on `main`.
- **Console publish fails on first release:** the bootstrap placeholder and its trusted
  publisher are missing (see "One-time setup").
