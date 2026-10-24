#!/usr/bin/env bash
# The body of the MongoShield GitHub Action (action.yml). Reads INPUT_* environment
# variables, runs `npx mongoshield@<version> <command> --json`, and writes the
# `backup-id` and `json` step outputs.
#
# Can be run locally for testing:
#   INPUT_COMMAND=backup INPUT_URI=mongodb://localhost INPUT_STORAGE=./b \
#   GITHUB_OUTPUT=/dev/stdout bash action/run.sh

# -e: stop on errors. -u: unset variables are errors. -o pipefail: a pipe fails if any
# part fails. -f: no filename globbing, so patterns such as `*.sessions` in INPUT_ARGS
# reach mongoshield literally instead of being expanded against files in the workspace.
set -euo pipefail -f

# --- Secrets ----------------------------------------------------------------
# Mask before anything else can print them. GitHub already masks values that come
# straight from `secrets.*`, but not values built from them or passed via `vars.*`.
mask() {
  if [[ -n "$1" ]]; then echo "::add-mask::$1"; fi
}
mask "${INPUT_URI:-}"
mask "${INPUT_IDENTITY:-}"
# The password inside the URI on its own (mongodb://user:PASSWORD@host), in case it is
# ever printed without the rest of the URI.
if [[ "${INPUT_URI:-}" =~ ://[^:/@]+:([^@]+)@ ]]; then
  mask "${BASH_REMATCH[1]}"
fi

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

# --- Packages ---------------------------------------------------------------
# npx installs everything given with --package into one temporary project, so
# mongoshield can import the cloud SDK it needs (they are optional peer dependencies).
# The mongodb driver is a required peer dependency, which npm installs automatically.
packages=("mongoshield@${INPUT_VERSION:-next}")
storage="${INPUT_STORAGE:-}"
case "$storage" in
  s3://*) packages+=("@aws-sdk/client-s3@^3" "@aws-sdk/lib-storage@^3") ;;
  gs://* | gcs://*) packages+=("@google-cloud/storage@^8") ;;
  az://*) packages+=("@azure/storage-blob@^12" "@azure/identity@^4") ;;
  sftp://*) packages+=("ssh2@^1") ;;
esac
# The user's extra packages, split on whitespace (no globbing: set -f above).
# shellcheck disable=SC2086 # word splitting is the point here
for package in ${INPUT_PACKAGES:-}; do
  packages+=("$package")
done

package_flags=()
for package in "${packages[@]}"; do
  package_flags+=("--package=$package")
done

# --- Arguments --------------------------------------------------------------
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

echo "Running: mongoshield ${args[*]}"

# --- Run --------------------------------------------------------------------
# Capture stdout (the JSON) while stderr streams to the log. Keep the exit code so the
# outputs are still written for a failed run (the JSON then describes the error).
output_file="$(mktemp)"
status=0
npx --yes "${package_flags[@]}" -- mongoshield "${args[@]}" > "$output_file" || status=$?

json="$(cat "$output_file")"
rm -f "$output_file"
echo "$json"

# --- Outputs ----------------------------------------------------------------
# Find the backup id in the JSON. Where each command puts it:
#   backup   { id, manifest, durationMs }            (BackupResult)
#   verify   { backupId, ok, problems, ... }         (VerifyReport)
#   restore  { plan: { backupId, ... }, ... }        (RestoreResult)
#   run      { backup: { id, ... }, ... }            (assumed; falls through if absent)
# Node is used instead of jq because it is guaranteed to be there (npx needs it).
backup_id="$(
  JSON="$json" node -e '
    let data;
    try { data = JSON.parse(process.env.JSON || "null"); } catch { process.exit(0); }
    const candidates = [data?.id, data?.backupId, data?.plan?.backupId, data?.backup?.id];
    const id = candidates.find((value) => typeof value === "string");
    if (id) process.stdout.write(id);
  '
)"

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
