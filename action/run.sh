#!/usr/bin/env bash
# The body of the MongoShield GitHub Action (action.yml). Reads INPUT_* environment
# variables, installs a pinned mongoshield (plus the cloud SDKs the storage needs) into a
# temporary folder, runs `mongoshield <command> --json`, and writes the `backup-id` and
# `json` step outputs.
#
# Can be run locally for testing:
#   INPUT_COMMAND=backup INPUT_URI=mongodb://localhost INPUT_STORAGE=./b \
#   GITHUB_OUTPUT=/dev/stdout bash action/run.sh

# -e: stop on errors. -u: unset variables are errors. -o pipefail: a pipe fails if any
# part fails. -f: no filename globbing, so patterns such as `*.sessions` in INPUT_ARGS
# reach mongoshield literally instead of being expanded against files in the workspace.
set -euo pipefail -f

# The folder this script lives in (the Action's own checkout). GitHub downloads the whole
# repository at the Action's ref, so ../packages/mongoshield/package.json is there too.
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

# --- Pinned versions -----------------------------------------------------------
# What the Action installs next to mongoshield, pinned to exact versions: the ones in
# pnpm-lock.yaml, which CI tested. Exact pins mean a new (possibly malicious) release of
# one of these packages cannot reach every user's backup job the moment it is published.
# Keep them in sync with pnpm-lock.yaml and docker/install-sdks.sh when the SDKs are bumped.
MONGODB_DRIVER="mongodb@7.7.0"
SDK_S3=("@aws-sdk/client-s3@3.1155.0" "@aws-sdk/lib-storage@3.1155.0")
SDK_GCS=("@google-cloud/storage@8.4.0")
SDK_AZURE=("@azure/storage-blob@12.34.0" "@azure/identity@4.14.0")
SDK_SFTP=("ssh2@1.17.0")

# --- Secrets ----------------------------------------------------------------
# Mask before anything else can print them. GitHub already masks values that come
# straight from `secrets.*`, but not values built from them or passed via `vars.*`.
#
# `::add-mask::` is a line the runner reads from the step's stdout. File descriptor 3 is
# a copy of that stdout, so masking also works from inside `$(...)`, whose own stdout is
# captured into a variable instead of reaching the runner.
exec 3>&1
mask() {
  if [[ -n "$1" ]]; then echo "::add-mask::$1" >&3; fi
}

# Percent-decoding (`p%40ss` -> `p@ss`). Connection strings must percent-encode special
# characters in the password, and a driver or tool may print the decoded form, so both
# spellings are masked. `+` is literal in the user-info part of a URI, so it stays.
url_decode() {
  local encoded="${1//\\/\\\\}"
  printf '%b' "${encoded//%/\\x}"
}

# Masks a connection string, and the password inside it (mongodb://user:PASSWORD@host)
# on its own, raw and decoded, in case either is ever printed without the rest.
mask_uri() {
  local uri="$1"
  mask "$uri"
  if [[ "$uri" =~ ://[^:/@]+:([^@]+)@ ]]; then
    mask "${BASH_REMATCH[1]}"
    mask "$(url_decode "${BASH_REMATCH[1]}")"
  fi
}

mask_uri "${INPUT_URI:-}"
mask "${INPUT_IDENTITY:-}"
# The same values may also come from the step's environment instead of the inputs.
mask_uri "${MONGODB_URI:-}"
mask_uri "${MONGOSHIELD_URI:-}"
mask_uri "${MONGOSHIELD_DRILL_URI:-}"
mask "${MONGOSHIELD_IDENTITY:-}"
mask "${MONGOSHIELD_PASSPHRASE:-}"
# The OneDrive sign-in (onedrive:// storage). Usually straight from `secrets.*`, which
# GitHub masks already, but not when it was built from other values.
mask "${MONGOSHIELD_ONEDRIVE_TOKEN:-}"

# --- Command ----------------------------------------------------------------
command="${INPUT_COMMAND:-backup}"
case "$command" in
  backup | run | verify | restore) ;;
  *)
    echo "::error::Unsupported command \"$command\". Use backup, run, verify or restore."
    exit 2
    ;;
esac

# --- Configuration through environment variables ----------------------------
# MongoShield reads these itself (see packages/mongoshield/src/config/env.ts), which
# keeps secrets out of the process arguments visible in `ps`.
if [[ -n "${INPUT_URI:-}" ]]; then export MONGODB_URI="$INPUT_URI"; fi
if [[ -n "${INPUT_STORAGE:-}" ]]; then export MONGOSHIELD_STORAGE="$INPUT_STORAGE"; fi
if [[ -n "${INPUT_RECIPIENTS:-}" ]]; then export MONGOSHIELD_RECIPIENTS="$INPUT_RECIPIENTS"; fi
if [[ -n "${INPUT_IDENTITY:-}" ]]; then export MONGOSHIELD_IDENTITY="$INPUT_IDENTITY"; fi

# --- Version ----------------------------------------------------------------
# Empty (the default): the mongoshield release this Action ref belongs to, read from the
# repository's packages/mongoshield/package.json at that ref. `@v2` then runs the latest
# stable 2.x release (the v2 tag moves with each release, see RELEASING.md), and pinning
# the Action to a release tag or commit SHA pins the CLI too. `latest` (the npm dist-tag)
# is the fallback when the file cannot be read, e.g. when run.sh is copied elsewhere.
version="${INPUT_VERSION:-}"
if [[ -z "$version" ]]; then
  version="$(
    node -e 'process.stdout.write(String(require(process.argv[1]).version ?? ""))' \
      "${action_dir}/../packages/mongoshield/package.json" 2> /dev/null || true
  )"
  # Between merging a "version packages" pull request and the npm publish finishing,
  # the ref names a version npm does not have yet: use the newest stable one meanwhile.
  if [[ -n "$version" ]] && [[ -z "$(npm view "mongoshield@${version}" version 2> /dev/null)" ]]; then
    echo "::notice::mongoshield ${version} is not on npm (yet); running the latest release instead."
    version=""
  fi
fi
version="${version:-latest}"
# A version, a range or a dist-tag. Anything with ":" or "/" could make npm fetch the
# package from somewhere else entirely (npm:alias@, git URLs, tarball URLs), so refuse it.
VERSION_PATTERN='^[A-Za-z0-9.^~<>=|_+ -]+$'
if [[ ! "$version" =~ $VERSION_PATTERN ]]; then
  echo "::error::Invalid version \"$version\". Use an npm version (2.0.1), a range (^2) or a dist-tag (latest)."
  exit 2
fi

# --- Which cloud SDKs ---------------------------------------------------------
# The SDKs are optional peer dependencies of mongoshield, so the storage decides which
# ones are installed. Storage can be set in three places, and all of them are looked at:
#   1. the `storage` input (exported as MONGOSHIELD_STORAGE above),
#   2. MONGOSHIELD_STORAGE in the step's or job's environment,
#   3. the config file (the `config` input, or mongoshield.config.* in the working
#      directory). Config files can be TypeScript, so they are not evaluated here; their
#      text is searched for storage URLs (s3://...) and adapter factories (s3Storage(...)).
#      Installing an SDK that turns out to be unused costs only a few seconds.
need_s3=false
need_gcs=false
need_azure=false
need_sftp=false

# Notes every SDK whose URL scheme or adapter factory appears in the given text.
detect_storage() {
  # Lower-cased: MongoShield accepts S3:// as well as s3:// (schemes are case-insensitive).
  # Every pattern below is therefore lower-case too, the factory names included:
  # s3Storage( in the config text reads s3storage( here.
  local text
  text="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  if [[ "$text" == *s3://* || "$text" == *s3storage* ]]; then need_s3=true; fi
  # Backblaze B2 and Cloudflare R2 (b2://, r2://, b2Storage, r2Storage) are presets
  # on the S3 adapter, so they need the S3 SDK too.
  if [[ "$text" == *b2://* || "$text" == *b2storage* ]]; then need_s3=true; fi
  if [[ "$text" == *r2://* || "$text" == *r2storage* ]]; then need_s3=true; fi
  if [[ "$text" == *gs://*|| "$text" == *gcsstorage* ]]; then need_gcs=true; fi
  if [[ "$text" == *az://* || "$text" == *azurestorage* ]]; then need_azure=true; fi
  if [[ "$text" == *sftp://* || "$text" == *sftpstorage* ]]; then need_sftp=true; fi
}

# The config file the CLI will load: the same search order as
# packages/mongoshield/src/config/load.ts (CONFIG_FILE_NAMES).
config_file=""
if [[ -n "${INPUT_CONFIG:-}" ]]; then
  config_file="$INPUT_CONFIG"
else
  for name in mongoshield.config.ts mongoshield.config.mts mongoshield.config.js \
    mongoshield.config.mjs mongoshield.config.json; do
    if [[ -f "$name" ]]; then
      config_file="$name"
      break
    fi
  done
fi

detect_storage "${MONGOSHIELD_STORAGE:-}"
if [[ -n "$config_file" && -f "$config_file" ]]; then
  detect_storage "$(cat "$config_file")"
fi

# --- Packages ---------------------------------------------------------------
# The user's extra packages, split on whitespace (no globbing: set -f above).
user_packages=()
# shellcheck disable=SC2086 # word splitting is the point here
for package in ${INPUT_PACKAGES:-}; do
  user_packages+=("$package")
done

# True when the user's `packages` already names this package (any version), so the
# Action's pinned version does not conflict with the one they asked for.
user_requested() {
  local name="$1" package
  for package in "${user_packages[@]+"${user_packages[@]}"}"; do
    if [[ "$package" == "$name" || "$package" == "$name@"* ]]; then return 0; fi
  done
  return 1
}

# Adds pinned packages unless the user asked for their own version.
add_pinned() {
  local spec name
  for spec in "$@"; do
    name="${spec%@*}"
    if ! user_requested "$name"; then packages+=("$spec"); fi
  done
}

packages=("mongoshield@${version}")
# The driver is a required peer dependency; npm would install the newest 7.x on its own.
add_pinned "$MONGODB_DRIVER"
if [[ "$need_s3" == true ]]; then add_pinned "${SDK_S3[@]}"; fi
if [[ "$need_gcs" == true ]]; then add_pinned "${SDK_GCS[@]}"; fi
if [[ "$need_azure" == true ]]; then add_pinned "${SDK_AZURE[@]}"; fi
if [[ "$need_sftp" == true ]]; then add_pinned "${SDK_SFTP[@]}"; fi
packages+=("${user_packages[@]+"${user_packages[@]}"}")

# --- Arguments --------------------------------------------------------------
# Flag names whose values are secrets, and their values: masked, and shown as *** when
# the command line is echoed below. The CLI refuses most of these as flags anyway (they
# belong in environment variables), but a refused flag must not leak either.
SECRET_FLAG='^--?[A-Za-z-]*(uri|url|password|passphrase|secret|token|key|identity|credential)[A-Za-z-]*$'

# Prints the redacted form of one argument, and masks what is secret in it.
redact_argument() {
  local argument="$1" name value
  if [[ "$argument" == AGE-SECRET-KEY-1* ]]; then
    mask "$argument"
    printf '%s' '***'
  elif [[ "$argument" == --*=* ]]; then
    name="${argument%%=*}"
    value="${argument#*=}"
    if [[ "$name" =~ $SECRET_FLAG ]]; then
      mask_uri "$value"
      printf '%s=***' "$name"
    else
      printf '%s=%s' "$name" "$(redact_argument "$value")"
    fi
  elif [[ "$argument" =~ ://[^:/@]+:([^@]+)@ ]]; then
    # A connection string with a password, wherever it appears.
    mask_uri "$argument"
    printf '%s' "${argument/:${BASH_REMATCH[1]}@/:***@}"
  else
    printf '%s' "$argument"
  fi
}

args=("$command")
if [[ -n "${INPUT_CONFIG:-}" ]]; then args+=("--config" "$INPUT_CONFIG"); fi
# Extra arguments, split on whitespace; `*.sessions` stays literal thanks to set -f.
# shellcheck disable=SC2086 # word splitting is the point here
for argument in ${INPUT_ARGS:-}; do
  args+=("$argument")
done
# --json: one machine-readable document on stdout (progress goes to stderr).
# --yes: there is nobody to answer a confirmation prompt in CI. Restore still refuses to
# overwrite data unless you also pass --mode (or --drop) in `args`.
args+=("--json" "--yes")

# The command line as it is shown in the log: secrets replaced with ***. Each argument
# is redacted in a `$(...)` subshell; its masks still reach the runner through fd 3.
display=()
previous_was_secret_flag=false
for argument in "${args[@]}"; do
  if [[ "$previous_was_secret_flag" == true && "$argument" != -* ]]; then
    # `--to-uri VALUE`: the value of a secret flag given as a separate argument.
    mask_uri "$argument"
    display+=("***")
    previous_was_secret_flag=false
    continue
  fi
  previous_was_secret_flag=false
  if [[ "$argument" != *=* && "$argument" =~ $SECRET_FLAG ]]; then
    previous_was_secret_flag=true
  fi
  display+=("$(redact_argument "$argument")")
done

# --- Install ----------------------------------------------------------------
# Installed into a fresh folder with npm, instead of `npx`, for two reasons:
#   --ignore-scripts  no install scripts run (the most common way a compromised package
#                     attacks), while the runner holds the database URI and cloud
#                     credentials. Nothing MongoShield needs has an install script.
#   exact versions    see "Pinned versions" above.
install_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mongoshield-action.XXXXXX")"
echo "Installing: ${packages[*]}"
npm install --prefix "$install_dir" --ignore-scripts --no-audit --no-fund --no-save \
  --loglevel=error "${packages[@]}" >&2
cli="$install_dir/node_modules/.bin/mongoshield"

echo "Running: mongoshield ${display[*]}"

# --- Run --------------------------------------------------------------------
# Capture stdout (the JSON) while stderr streams to the log. Keep the exit code so the
# outputs are still written for a failed run (the JSON then describes the error).
output_file="$(mktemp)"
status=0
"$cli" "${args[@]}" > "$output_file" || status=$?

json="$(cat "$output_file")"
rm -f "$output_file"
echo "$json"

# --- Outputs ----------------------------------------------------------------
# Find the backup id in the JSON. Where each command puts it:
#   backup   { id, manifest, durationMs }            (BackupResult)
#   verify   { backupId, ok, problems, ... }         (VerifyReport)
#   restore  { plan: { backupId, ... }, ... }        (RestoreResult)
#   run      { backup: { id, ... }, ... }            (assumed; falls through if absent)
# Node is used instead of jq because it is guaranteed to be there (npm needs it).
backup_id="$(
  JSON="$json" node -e '
    let data;
    try { data = JSON.parse(process.env.JSON || "null"); } catch { process.exit(0); }
    const candidates = [data?.id, data?.backupId, data?.plan?.backupId, data?.backup?.id];
    const id = candidates.find((value) => typeof value === "string");
    if (id) process.stdout.write(id);
  '
)"

# A missing optional package: the library's hint says `npm install …`, which does not
# apply inside the Action. Point at the `packages:` input instead.
missing_packages="$(
  JSON="$json" node -e '
    let data;
    try { data = JSON.parse(process.env.JSON || "null"); } catch { process.exit(0); }
    const error = data?.error;
    if (!error || !/needs an optional package/.test(String(error.message))) process.exit(0);
    const hint = String(error.hint ?? "").replace(/^.*npm install\s+/, "").trim();
    process.stdout.write(hint || "the SDK named above");
  '
)"
if [[ -n "$missing_packages" ]]; then
  echo "::error title=MongoShield needs an optional package::Add it to the Action's packages input, e.g. \`packages: ${missing_packages}\`. Storage URLs in the storage input, MONGOSHIELD_STORAGE and the config file get their SDK automatically."
fi

# Multi-line values need the heredoc-style syntax with a unique delimiter.
delimiter="MONGOSHIELD_JSON_$RANDOM$RANDOM"
{
  echo "backup-id=$backup_id"
  echo "json<<$delimiter"
  echo "$json"
  echo "$delimiter"
} >> "${GITHUB_OUTPUT:-/dev/null}"

if [[ -n "$backup_id" ]]; then
  echo "Backup id: $backup_id"
fi
exit "$status"
