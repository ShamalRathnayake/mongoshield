---
"mongoshield": minor
"@mongoshield/console": minor
---

Restore preview. The console's restore wizard has a "Preview changes" step between the
dry-run plan and the confirmation: per namespace, the documents only in the backup, only
in the target, changed and identical, what the chosen mode would do with them, index and
option differences, and a drill-down to one document's fields side by side (secret-looking
values hidden). It runs as a read-only, cancellable, time-limited `preview` job
(`POST /api/restore/preview`), samples namespaces above 100,000 documents and says so, keeps
document lists and contents to the document browser's role, and is audited. The library's
`diff` gains `rename` (compare each namespace with the one a restore would write) and
`sample: { above, size }` (compare large namespaces against a live deployment by `_id`
lookups of a sample, with estimated counts and `sampled` on the namespace).
