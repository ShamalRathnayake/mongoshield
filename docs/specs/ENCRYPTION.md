# MongoShield encryption (age v1 profile)

MongoShield encrypts backup files with [age](https://age-encryption.org), using the
standard **age v1 file format** ([C2SP spec](https://c2sp.org/age)). Every encrypted
file is an ordinary `.age` file, so you can always decrypt a backup with the official
`age` CLI, without MongoShield and without network access.

The implementation (`packages/mongoshield/src/crypto/`) is a streaming
implementation of age v1 on `node:crypto`. On runtimes whose `node:crypto` lacks
ChaCha20-Poly1305 (Bun), that one primitive comes from the audited `@noble/ciphers`
instead, loaded only there; the bytes are identical (see
[the Bun and Deno guide](../guides/bun-and-deno.md)). It is tested against the official
[CCTV age test vectors](https://github.com/C2SP/CCTV/tree/main/age), with both ciphers.

## Why age

- **An open, stable format with independent implementations.** Recovering a backup
  must not depend on MongoShield still existing, or on the exact version that wrote it.
- **Public-key encryption.** The machine that takes backups only needs a *public*
  recipient (`age1…`). The secret key that can read backups can stay offline.
- **Small and well reviewed.** X25519, HKDF-SHA-256, HMAC-SHA-256 and
  ChaCha20-Poly1305, with no options to misconfigure.
- **Authenticated streaming.** Data is encrypted in 64 KiB chunks, each with its own
  authentication tag, so files of any size are processed in constant memory and any
  modification, truncation or appended data is detected.

## What MongoShield supports

| age feature | Supported |
|---|---|
| X25519 recipients (`age1…`) and identities (`AGE-SECRET-KEY-1…`) | yes |
| Passphrases (scrypt stanza) | yes |
| Multiple recipients per file | yes |
| Unknown stanzas from other tools | ignored when decrypting, as the spec requires |
| Cloud KMS keys (AWS KMS, Google Cloud KMS, Azure Key Vault) | yes, for the backup's key file only, via a custom `mongoshield-kms` stanza ([KMS backups](#kms-backups)) |
| ASCII armor (`-----BEGIN AGE ENCRYPTED FILE-----`) | no (MongoShield writes binary files) |
| Post-quantum (`age1pq1…`), tagged (`age1tag1…`), SSH and plugin recipients | no |

## Recipients, KMS keys or a passphrase

Use recipients, cloud KMS keys, or both together; or a passphrase on its own. The age
format requires a passphrase (scrypt) stanza to be the only stanza in a file: that is
what guarantees a passphrase-encrypted file was made by someone who knew the
passphrase. Mixing it with recipients or KMS keys would silently drop that guarantee,
so MongoShield rejects a passphrase combined with either with `MS_CONFIG_INVALID`.

### Recipients (recommended)

```sh
age-keygen -o backup-key.txt          # prints "Public key: age1…"
```

```ts
encryption: { recipients: ["age1…"] }
```

- Put only the **public** recipient on the machine that runs backups. A stolen backup
  server then cannot read past or future backups.
- Keep `backup-key.txt` offline (password manager, hardware-backed vault, printed copy
  in a safe). MongoShield refuses an `AGE-SECRET-KEY-…` string where a recipient is
  expected, and never prints identities in errors or logs.
- **Add a recovery recipient.** Encrypt to at least two recipients: the key your
  restore jobs use, and a recovery key stored separately (e.g. printed and kept by a
  different person). Any one of them decrypts every file, so losing one key does not
  lose your backups.

```ts
encryption: { recipients: ["age1…ops", "age1…recovery"] }
```

### Passphrase

```ts
encryption: { passphrase: process.env.BACKUP_PASSPHRASE }
```

The passphrase is stretched with scrypt (`N = 2^18`, `r = 8`, `p = 1` by default, the
same as the `age` CLI; roughly 256 MiB of memory and about a second). MongoShield pays
that cost **once per backup**, not once per file; see [Passphrase backups](#passphrase-backups).
Use a long random passphrase; scrypt slows guessing but cannot save a weak one.

When decrypting, MongoShield refuses scrypt work factors above 22 (4 GiB of memory),
matching the `age` CLI, so a crafted file cannot exhaust memory. Raise
`maxScryptWorkFactor` only for files you trust.

## What is and is not encrypted

Each file is encrypted independently with its own random file key, after compression:

```
BSON → zstd/gzip → age → storage
```

| File | Encrypted | Notes |
|---|---|---|
| `<db>/<collection>.bson[.zst\|.gz].age` | yes | the documents |
| `<db>/<collection>.metadata.json.age` | yes | indexes, options, validators |
| `backup-key.age` | yes, with the passphrase or the KMS keys | passphrase and KMS backups only: the backup's own key ([passphrase](#passphrase-backups), [KMS](#kms-backups)) |
| `manifest.json` | **no** | needed to list, select and verify backups without keys |

The manifest is plaintext by design. It reveals:

- database and collection names (namespaces), document counts and sizes;
- backup times, the source server version and topology, labels;
- file names, sizes and checksums of the *encrypted* files;
- the encryption scheme (`age-v1`) and the **public** recipients, `scrypt`, or the KMS
  key identifiers (`kms:aws:arn:aws:kms:…`; identifiers, not key material).

It never contains keys, passphrases or connection strings. If namespace names are
sensitive, protect the storage location itself as well.

## Passphrase backups

age's passphrase recipient runs scrypt for every file it encrypts or decrypts. A backup
holds two files per collection, so encrypting each file with the passphrase would run
hundreds of scrypts per backup (each ~256 MiB of memory, several at once) and the same
number again on every restore. The scrypt result cannot be reused across files either:
age wraps each file key with it under a fixed, all-zero nonce, so reusing it would
reuse a nonce with the same key.

So each passphrase backup gets a **per-backup key envelope**:

1. MongoShield generates a fresh X25519 identity for the backup.
2. It writes `backups/<id>/backup-key.age`: that identity, in the `age-keygen` key-file
   format, age-encrypted **with the passphrase** (the backup's only scrypt):

   ```
   # created: 2026-11-14T03:00:04Z
   # public key: age1…
   AGE-SECRET-KEY-1…
   ```

3. Every data and metadata file is encrypted to the identity's public recipient
   (X25519: fast, no scrypt).
4. The manifest records `encryption.recipients: ["scrypt"]` and points to the envelope
   with `encryption.keyFile` (key, size and SHA-256, like any stored file).

The plaintext identity is never written anywhere; it exists only in memory while the
envelope is written. Readers (restore, deep verify) decrypt the envelope once with the
passphrase, check it against the manifest's size and SHA-256 first, and use the identity
inside for every file of the run. Such a backup can only be opened with the passphrase:
passing identities fails with `MS_NO_IDENTITY` ("this backup is protected with a
passphrase"). A wrong passphrase fails with `MS_DECRYPTION_FAILED`, and a modified
envelope with `MS_INTEGRITY_FAILED`. Fast verification checks the envelope's checksum
like any other file.

The security of a passphrase backup is unchanged: everything still depends on the
passphrase (via one scrypt), and every file still has its own random file key.

## KMS backups

```ts
encryption: {
  kms: [{ provider: "aws", key: "arn:aws:kms:eu-west-1:111122223333:key/…" }],
  recipients: ["age1…recovery"], // strongly recommended, see below
}
```

| `provider` | `key` | Needs (optional peer dependency) |
|---|---|---|
| `aws` | key ARN, alias ARN or `alias/<name>` | `@aws-sdk/client-kms` |
| `gcp` | `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>` (no version) | `@google-cloud/kms` |
| `azure` | `https://<vault>.vault.azure.net/keys/<name>` (or Managed HSM) | `@azure/keyvault-keys`, `@azure/identity` |

Credentials come from each SDK's default chain (environment, instance or task role,
workload identity, `DefaultAzureCredential`). A missing SDK fails with
`MS_CONFIG_INVALID` and the `npm install` command as the hint.

KMS backups use the same per-backup key envelope as [passphrase
backups](#passphrase-backups), with the KMS in place of scrypt:

1. MongoShield generates a fresh X25519 identity for the backup.
2. It writes `backup-key.age`: that identity (age-keygen key-file format), age-encrypted
   with **one `mongoshield-kms` stanza per configured KMS key**. The KMS wraps only the
   16-byte age file key of this one file; it never sees backup data, and there is one
   KMS call per backup run and one per restore or deep verification.
3. Every data and metadata file is encrypted to the identity's recipient **and to every
   configured `recipients` key**, as ordinary X25519 stanzas.
4. The manifest records `encryption.recipients: ["kms:<provider>:<key>", …, "age1…"]`
   and `encryption.keyFile`.

Restoring needs only permission to use the key for decryption, no keys or secrets:

| Provider | Backup needs | Restore and deep verify need |
|---|---|---|
| AWS | `kms:Encrypt` | `kms:Decrypt` |
| Google Cloud | `cloudkms.cryptoKeyVersions.useToEncrypt` (`roles/cloudkms.cryptoKeyEncrypter`) | `cloudkms.cryptoKeyVersions.useToDecrypt` (`roles/cloudkms.cryptoKeyDecrypter`) |
| Azure | `keys/wrapKey`, plus `keys/get` to detect the key type | `keys/unwrapKey` (e.g. role *Key Vault Crypto Service Encryption User*) |

Azure picks the wrapping algorithm from the key type, read once per backup with
`getKey`: RSA keys (`RSA`, `RSA-HSM`) use `RSA-OAEP-256`, Managed HSM symmetric keys
(`oct-HSM`, AES-256) use `A256KW`. Without `keys/get` it uses `RSA-OAEP-256`; pass
`algorithm` to `createAzureKmsClient` for symmetric keys then (and for AES-128/192
keys: `A128KW`/`A192KW`). Restores always use the algorithm recorded in the stanza.

KMS calls honour the run's `signal`: AWS and Azure requests are cancelled, and since
the Google client cannot cancel a request, MongoShield stops waiting for it. Either
way the run fails with `MS_ABORTED` at once.

So the machine that takes backups can be given encrypt-only rights and cannot read
them. A refused call fails with `MS_ENCRYPTION_FAILED` (backup) or `MS_DECRYPTION_FAILED`
(restore) and a hint naming the missing permission. With several KMS keys (e.g. two
regions or two providers), any one of them unlocks the backup; if all refuse, the first
refusal is reported. Fast verification checks the key file's checksum and makes no
KMS call.

### Recovery keys: why `recipients` next to `kms`

The plain `age` CLI cannot open `mongoshield-kms` stanzas (there is no age plugin for
them), and a KMS key can be deleted, disabled or lost with its cloud account. A KMS
backup without an offline recipient is only as durable as the KMS key. With a recovery
recipient, every data file can still be opened directly, without MongoShield, without
network access and without the cloud:

```sh
age -d -i recovery-key.txt app/users.bson.zst.age | zstd -d > users.bson
```

MongoShield's restore uses a given identity directly when it is one of the backup's
recipients, and then does not contact the KMS at all. `mongoshield init` generates a
recovery key for this purpose.

### The `mongoshield-kms` stanza

```
-> mongoshield-kms <provider> <base64url(key id)> <algorithm>
<base64 of the KMS ciphertext of the 16-byte file key, 64 columns per line>
```

- `provider`: `aws`, `gcp` or `azure`.
- key id: unpadded base64url of the UTF-8 key identifier the KMS used. AWS records the
  key ARN the KMS reports (not an alias, which could later point elsewhere); Azure
  records the versioned key URL (unwrapping with an unversioned URL would use the latest
  version, which breaks after rotation); GCP records the CryptoKey name (the ciphertext
  names its version).
- `algorithm`: `SYMMETRIC_DEFAULT` or `RSAES_OAEP_SHA_256` (AWS),
  `GOOGLE_SYMMETRIC_ENCRYPTION` (GCP), `RSA-OAEP-256` or `A256KW`/`A192KW`/`A128KW`
  (Azure Managed HSM symmetric keys).
- The file key is bound to the context `mongoshield:purpose=backup-key`: as the AWS
  encryption context `{"mongoshield:purpose": "backup-key"}` (symmetric keys) and as
  GCP additional authenticated data. Azure key wrap takes no context. This keeps
  MongoShield's ciphertexts apart from any other use of the key and labels the calls
  in audit logs (CloudTrail).

It is a custom stanza as the age spec permits: the header MAC covers it like any other
stanza (so a modified stanza is detected even if a KMS returned a key), and other age
implementations ignore it. MongoShield writes it only into `backup-key.age`.

When reading, the stanza is validated strictly **before** any KMS call, including the
key identifier's shape and, for Azure, that the host is a Key Vault or Managed HSM
domain. The key file is protected by the manifest's checksum, but the manifest is not
signed: someone with write access to the bucket could swap both, and must not be able
to make MongoShield send cloud credentials to a host of their choosing.

## Rekeying

Keys change: an administrator leaves, a key is suspected stolen, a KMS key is
rotated, a passphrase was shared too widely. `mongoshield rekey` (library:
`rekeyBackups` in `src/extras/rekey.ts`) changes who can open existing backups
**without re-encrypting their data**:

```sh
mongoshield rekey all --identity-file old.key \
  --add-recipient age1…new-ops-key --remove-recipient age1…old-ops-key
mongoshield rekey latest --passphrase-env OLD_PASS --new-passphrase-env NEW_PASS
mongoshield rekey all --add-kms aws:arn:aws:kms:…:key/new --remove-kms aws:arn:aws:kms:…:key/old
mongoshield rekey all --add-recipient age1…recovery     # a KMS backup's recovery key
```

How it works: an age file is a header (stanzas that each wrap the 16-byte file key for
one recipient, plus a MAC) followed by a payload encrypted under that file key. Rekeying
opens the header with a current key, checks its MAC, wraps the **same** file key for the
new set of recipients, computes a new MAC and puts the new header in front of the
unchanged payload. What is rewritten depends on the backup:

| Backup | Rewritten | Opened with |
|---|---|---|
| Recipients | every data, metadata and changes file | an identity of a current recipient |
| Passphrase | only `backup-key.age` (one scrypt) | the current passphrase |
| KMS, KMS keys changed | only `backup-key.age` | the KMS (environment credentials) |
| KMS, recovery recipients changed | every data, metadata and changes file; the first stanza (the backup's own recipient) is copied unchanged | a recovery identity, or the backup's identity unlocked through the KMS |

A passphrase backup can only change its passphrase, and a KMS backup always keeps at
least one KMS key; other changes are reported as skipped.

**The manifest is not changed** (it is immutable and may be object-locked). Rewritten
headers change the files' sizes and SHA-256s, so the new digests and the new
`encryption.recipients` are stored in a rekey record,
`annotations/<id>/rekey/<time>.json`, and the catalog lays complete records over the
manifest. `list`, `inspect`, verify (fast and deep), restore and find all see the backup
as it is now stored. The record is written in two steps for crash safety: first
`pending`, with every prepared new header and no digests (pending records are ignored by
readers); then, once every file is rewritten, `complete`, with the digests and without
the headers. A run that stopped in between is finished by the next `rekey` run, which
needs no keys for that. Until then, verify reports the already rewritten files as
changed.

Each rewrite streams the stored file through a check of its previous size and SHA-256
and is written back with an ordinary (atomic) put, so a damaged or concurrently changed
file is never "repaired" with a new header.

**Object-locked backups are refused.** Their files are write-once until
`immutableUntil`, so the storage would reject the rewrite; and so that a record cannot
redirect the digests of a locked backup, rekey records are ignored while the lock is in
force. Rekey them after the lock expires, or restore and back up again.

**What rekeying does not do.** It does not change file keys. Someone who could open a
backup before and kept a copy of its files (or of a header, or a file key) can still
decrypt those copies, and versioned buckets keep the old objects as previous versions.
Rekeying controls who can open the backup from now on; it does not revoke access that
was already had. For that, restore the data and take a new backup with the new keys (and
delete the old one). Remove versions of rewritten objects if your bucket keeps them.

## Decrypting without MongoShield

Every encrypted file is a standard age file:

```sh
# documents (zstd-compressed backups)
age -d -i key.txt app/users.bson.zst.age | zstd -d > users.bson

# documents (gzip-compressed backups)
age -d -i key.txt app/users.bson.gz.age | gzip -d > users.bson

# collection metadata
age -d -i key.txt app/users.metadata.json.age > users.metadata.json
```

For recipient backups, `key.txt` is your identity file. For passphrase backups, first
recover the backup's own identity from its envelope (age prompts for the passphrase),
then use it exactly like an identity file:

```sh
age -d backup-key.age > key.txt
age -d -i key.txt app/users.bson.zst.age | zstd -d > users.bson
```

`key.txt` then holds a secret key: keep it as safe as the passphrase and delete it when
done.

For KMS backups, use the recovery identity directly (see [KMS backups](#kms-backups)).
The `age` CLI cannot unwrap `mongoshield-kms` stanzas; without a recovery identity,
recovering the key file requires MongoShield (or calling the KMS decrypt API on the
stanza body yourself, with the context above, and decrypting with the resulting file
key).

The resulting `users.bson` and `users.metadata.json` use the mongodump layout, so they
can be loaded with `mongorestore` if needed.

## Format details MongoShield follows

All of these come from the age v1 spec; they are listed here because they are part of
MongoShield's on-disk contract.

- **File key:** 16 random bytes per file. Never reused.
- **X25519 stanza:** `-> X25519 <ephemeral share>`; a fresh ephemeral key per stanza;
  wrap key = HKDF-SHA-256(shared secret, salt = ephemeral share ‖ recipient,
  info = `age-encryption.org/v1/X25519`); body = ChaCha20-Poly1305 of the file key with
  an all-zero nonce. All-zero shared secrets (low-order points) are rejected.
- **scrypt stanza:** `-> scrypt <16-byte salt> <log2 N>`; salt input is
  `age-encryption.org/v1/scrypt` ‖ salt. It must be the only stanza in the header.
- **Header MAC:** HMAC-SHA-256 over the header up to and including `---`, keyed with
  HKDF-SHA-256(file key, empty salt, info = `header`). Headers are parsed strictly
  (canonical unpadded base64, 64-column body lines, LF line endings).
- **Payload:** a 16-byte random nonce, then ChaCha20-Poly1305 chunks of 64 KiB under
  HKDF-SHA-256(file key, salt = nonce, info = `payload`). Each chunk nonce is an 11-byte
  big-endian counter plus a final-chunk flag byte (`0x01` only on the last chunk). The
  last chunk may be full, and is empty only when the whole file is empty.

When decrypting, plaintext is released only after its chunk has been authenticated.
The data released before an error is always a prefix of the original file made of
whole, authenticated chunks, and the stream always ends with an error rather than
a silent short read when the file is truncated or tampered with. Consumers that write
restored data must still treat a failed stream as a failed restore.

## Threat model and limits

age protects **confidentiality and integrity of each file at rest**: someone with
read or write access to your bucket, but without a key, cannot read documents or
modify a file without detection.

It does **not** protect against:

- **Metadata exposure.** The manifest, file names and file sizes are visible (see
  above). Ciphertext length reveals the compressed size of each collection.
- **Whole-file substitution or rollback.** Anyone holding only a *recipient* can create
  a valid encrypted file (that is how public-key encryption works). An attacker with
  write access can therefore replace a file with different data encrypted to the same
  recipient, or swap in an older backup's file. MongoShield's manifest checksums detect
  changes to individual files, but the manifest is not signed, so an attacker who can
  rewrite both is not detected. Protect write access (object lock / immutable buckets,
  separate credentials for backup and restore).
- **Passphrase-encrypted files** are authenticated by the passphrase itself, so only
  someone who knows it can create one; but a weak passphrase can be guessed offline.
- **Compromise of the machine that decrypts.** Identities and plaintext are in its
  memory during a restore.
- **Key loss.** There is no backdoor. Without an identity (or the passphrase, or a
  usable KMS key), the data is gone. Keep a recovery recipient.
- **KMS administrators.** Anyone who may call the KMS decrypt API on a backup's key can
  read that backup. KMS protection moves trust to the cloud's IAM and audit logs; that
  is its purpose, but plan IAM accordingly.
- **Quantum adversaries.** X25519 is not post-quantum. Backups harvested today could be
  decrypted by a future large quantum computer. age's post-quantum recipient type is not
  supported yet.
