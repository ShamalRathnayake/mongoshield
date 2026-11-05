#!/bin/sh
# Installs MongoShield and the chosen optional cloud SDKs into the current directory.
# Used by docker/Dockerfile (deps stage); kept as a script so the logic is readable
# and testable outside Docker:
#
#   install-sdks.sh <mongoshield.tgz> <sdk list>
#   install-sdks.sh /tmp/mongoshield.tgz s3,gcs
#
# The SDK list is comma-separated: s3, gcs, azure, sftp, all or none.
# Versions are exact: the ones pnpm-lock.yaml resolved, which CI tested (they must also
# satisfy the peerDependencies in packages/mongoshield/package.json, or npm refuses).
# Keep them in sync with the lockfile and action/run.sh when the SDKs are bumped.
#
# Their own dependencies are resolved by npm at build time. Set NPM_BEFORE (an ISO 8601
# time, see docker/Dockerfile) to ignore every version published after it.

# -e: stop at the first failing command. -u: an unset variable is an error, not "".
set -eu

tarball="$1"
requested="$2"

# Always installed: the package itself and the MongoDB driver (a required peer).
packages="$tarball mongodb@7.7.0"

# Adds the npm packages behind one SDK name to $packages.
add_sdk() {
  case "$1" in
    s3)    packages="$packages @aws-sdk/client-s3@3.1155.0 @aws-sdk/lib-storage@3.1155.0 @aws-sdk/client-kms@3.1155.0" ;;
    gcs)   packages="$packages @google-cloud/storage@8.4.0 @google-cloud/kms@6.3.0" ;;
    azure) packages="$packages @azure/storage-blob@12.34.0 @azure/identity@4.14.0 @azure/keyvault-keys@4.10.2" ;;
    sftp)  packages="$packages ssh2@1.17.0" ;;
    none)  ;;
    all)   add_sdk s3; add_sdk gcs; add_sdk azure; add_sdk sftp ;;
    *)
      echo "install-sdks: unknown SDK \"$1\" (expected s3, gcs, azure, sftp, all or none)" >&2
      exit 2
      ;;
  esac
}

# Split "s3,gcs" on commas. IFS only affects this loop's word splitting.
old_ifs="$IFS"
IFS=","
for sdk in $requested; do
  IFS="$old_ifs"
  add_sdk "$(echo "$sdk" | tr -d ' ')"
done
IFS="$old_ifs"

# --before=<time>: only versions published before then (empty NPM_BEFORE: no limit).
before=""
if [ -n "${NPM_BEFORE:-}" ]; then before="--before=$NPM_BEFORE"; fi

echo "install-sdks: installing $packages $before"

# --omit=dev        production dependencies only.
# --ignore-scripts  no install scripts: nothing we install needs one (ssh2 falls back to
#                   pure JavaScript crypto), and it closes the most common supply-chain hole.
# --no-audit/--no-fund  keep build logs short; the image is scanned by Trivy in CI instead.
# $packages and $before are unquoted on purpose: a space-separated list of package
# specs, and an optional flag that must disappear entirely when it is empty.
# shellcheck disable=SC2086
npm install --omit=dev --ignore-scripts --no-audit --no-fund $before $packages

# Fail the build early if the CLI cannot even start (missing dependency, bad tarball).
node node_modules/mongoshield/dist/cli.mjs --version
