---
"mongoshield": patch
---

GitHub Action and container images:

- The Action installs the cloud SDK for storage set in the config file or in
  `MONGOSHIELD_STORAGE`, not only in the `storage` input, and points a missing optional
  package at its `packages:` input.
- An empty `version` now runs the release the Action ref belongs to (never `next`).
  mongoshield, the MongoDB driver and the SDKs are installed at exact versions with
  `npm install --ignore-scripts`.
- The Action masks the URL-decoded password and secret-looking `args`, and logs the
  command line with them replaced by `***`.
- Images: base images pinned by digest, exact SDK versions, `NPM_BEFORE` to freeze npm
  resolution at the commit time, a host-aware console HEALTHCHECK (IPv4 and IPv6), and
  `:latest` of the console image now follows releases only.
