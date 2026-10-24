# Security policy

MongoShield handles database credentials, encryption keys and full copies of
production data. We take vulnerabilities seriously.

## Reporting a vulnerability

Please do **not** open a public issue. Report privately through
[GitHub security advisories](https://github.com/ShamalRathnayake/mongoshield/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. We aim to
acknowledge reports within 48 hours and to agree on a disclosure date with you.

## Supported versions

| Version | Supported |
|---|---|
| 2.x | Yes |
| 1.x (alpha) | No. Please upgrade. |

## Scope

In scope: anything that could expose backup contents, credentials or keys; let an
attacker modify a backup without detection; or make a restore write unintended data.

The threat model is documented in `docs/specs/ENCRYPTION.md`.
