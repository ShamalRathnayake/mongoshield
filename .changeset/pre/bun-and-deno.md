---
"mongoshield": minor
---

Bun and Deno support: the library, the CLI and config files now run on Bun 1.4+ and
Deno 2.9+ (`bunx --bun mongoshield`, `deno run -A npm:mongoshield`), tested in CI at the
oldest and newest version of each. See docs/guides/bun-and-deno.md.

- age encryption works on Bun, whose `node:crypto` has no ChaCha20-Poly1305: where the
  cipher is missing, MongoShield loads the audited `@noble/ciphers` (a new dependency,
  imported lazily) and produces the same bytes. Node.js and Deno keep using `node:crypto`
  and never load it.
- A damaged zstd file under Deno is now reported as `MS_INTEGRITY_FAILED` instead of
  crashing the process (Deno's `node:zlib` threw the codec error outside the stream).
- New `pnpm --filter mongoshield test:runtimes`: end-to-end smoke scenarios (backup,
  deep verify, restore, corruption, cancellation, backpressure, CLI and Ctrl-C) run
  against the built package under Node.js, Bun and Deno.
