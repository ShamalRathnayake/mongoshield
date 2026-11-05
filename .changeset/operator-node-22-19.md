---
"@mongoshield/operator": patch
---

The operator now states its real minimum Node.js version: 22.19 (was 22.12). Its HTTP
client, undici 8 (also required by `@kubernetes/client-node` 2), crashes while loading
on older Node.js. The published container image runs Node.js 24 and is not affected.
