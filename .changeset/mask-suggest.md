---
"mongoshield": minor
---

Masking suggestions: `mongoshield mask suggest` samples collections (read-only, bounded `$sample`,
one collection at a time, `secondaryPreferred`) and detects personal data by value patterns and
field names: emails, phones, person names, addresses, postal codes, card numbers (Luhn), IBANs
(mod-97), IP addresses, national ids (US SSN, UK NI number, Spanish DNI/NIE, Brazilian CPF, Sri
Lankan NIC, Indian Aadhaar, Canadian SIN, Dutch BSN), dates of birth, secrets (JWTs, API keys,
password hashes, tokens), geolocation and free text containing emails or phones. It prints one
suggested mask rule per field, ordered by confidence, with masked examples only; `--mask` marks
fields the mask file already covers, `--write` merges new rules into a JSON mask file or creates
a new one (existing TypeScript/JavaScript mask files are never rewritten; the snippet is printed),
`--json` prints the report. From code: `suggestMasks(client, options)` and `detectPii(documents)`.
