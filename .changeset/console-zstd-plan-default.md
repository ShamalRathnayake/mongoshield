---
"@mongoshield/console": patch
---

On a Node.js without zstd (before 22.15), new plans start on gzip, the plan editor
shows zstd as unavailable, and the server refuses to save a zstd plan whose backups
could never run. The GitHub Action no longer fails in repositories whose
`package.json` names pnpm or yarn as their package manager.
