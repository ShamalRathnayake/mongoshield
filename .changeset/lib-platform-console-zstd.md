---
"@mongoshield/console": patch
---

"Back up now" plans and imported configs without a `compression` setting use zstd only
where the console's Node.js has it, and gzip otherwise, instead of failing every backup
on Node 22.12-22.14.
