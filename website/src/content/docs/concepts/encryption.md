---
title: Encryption
description: How backups are encrypted with age, which key options exist, and what encryption does not protect.
---

MongoShield encrypts backup files with [age](https://age-encryption.org), using the
standard age v1 file format. Every encrypted file is an ordinary `.age` file that the
official `age` CLI can decrypt without MongoShield and without network access. The
details are in the [encryption spec](/specs/encryption/).

## Choosing keys

| Option | Config | Good for |
|---|---|---|
| **Recipients** (recommended) | `encryption: { recipients: ["age1…"] }` | unattended backups: the backup machine holds only a public key |
| **Cloud KMS** | `encryption: { kms: [{ provider: "aws", key: "arn:…" }] }` | teams that manage keys and access through AWS KMS, Google Cloud KMS or Azure Key Vault |
| **Passphrase** | `encryption: { passphrase: process.env.BACKUP_PASSPHRASE }` | simple setups; cannot be combined with the others (an age format rule) |

Recipients and KMS keys can be combined. Two practices matter more than which you choose:

- **Keep the secret key off the backup machine.** With recipients, a stolen backup
  server cannot read past or future backups.
- **Add a recovery recipient.** Encrypt to at least two keys — the one your restore jobs
  use and one kept offline by someone else. Any one of them decrypts everything, so
  losing a key does not lose your backups. With KMS, an offline `age1…` recipient also
  means a backup can be recovered if the KMS key becomes unavailable.

Generate a key pair with [`mongoshield keygen`](/reference/cli/keygen/) or `age-keygen`.

## What is encrypted

Each file is encrypted independently with its own random key, after compression.

| File | Encrypted |
|---|---|
| Documents (`.bson.zst.age`) | yes |
| Collection metadata: indexes, options, validators (`.metadata.json.age`) | yes |
| `manifest.json` | **no** — needed to list, select and verify backups without keys |

The manifest never contains keys, passphrases or connection strings, but it does reveal
database and collection names, document counts, sizes, times, labels and the public
recipients. If names are sensitive, protect the storage location itself too.

## What encryption does not protect against

- **Metadata exposure:** names, counts and file sizes are visible.
- **Substitution by someone with write access:** anyone with a public key can create a
  valid encrypted file, and the manifest is not signed. Protect write access with
  separate credentials and [immutable backups](/guides/immutable-backups/).
- **Key loss:** there is no backdoor.
- **Quantum adversaries:** X25519 is not post-quantum, and age's post-quantum recipients
  are not supported yet.

## Decrypting without MongoShield

```sh
age -d -i key.txt app/users.bson.zst.age | zstd -d > users.bson
age -d -i key.txt app/users.metadata.json.age > users.metadata.json
```

Passphrase and KMS backups wrap a per-backup key in `backup-key.age`; the spec explains
how to recover it with standard tools (KMS backups need a recovery recipient for that).
