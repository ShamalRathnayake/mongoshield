---
title: Install
description: Install the MongoShield CLI or library, and the optional packages for cloud storage and KMS.
---

MongoShield needs **Node.js 22.12 or newer**. It also runs on **Bun 1.4** and
**Deno 2.9** or newer (`bunx --bun mongoshield`, `deno run -A npm:mongoshield`);
see the [Bun and Deno guide](/guides/bun-and-deno/) for what is tested there.

## The CLI

Run it without installing:

```sh
npx mongoshield --help
```

Or install it into a project (recommended, so the version is pinned):

```sh
npm install --save-dev mongoshield mongodb
npx mongoshield --help
```

A Docker image is also available (`ghcr.io/shamalrathnayake/mongoshield`); see the
[Docker guide](/guides/docker/).

## The library

```sh
npm install mongoshield mongodb
```

`mongodb` (driver 6.10+ or 7.x) is a peer dependency, so MongoShield uses the same driver
version as your application and can share its `MongoClient`.

## Optional packages

Cloud SDKs are optional peer dependencies. Install only what you use; MongoShield loads
them lazily and tells you which package is missing if one is needed.

| For | Install |
|---|---|
| S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi | `@aws-sdk/client-s3 @aws-sdk/lib-storage` |
| Google Cloud Storage | `@google-cloud/storage` |
| Azure Blob Storage | `@azure/storage-blob @azure/identity` |
| SFTP | `ssh2` |
| AWS KMS | `@aws-sdk/client-kms` |
| Google Cloud KMS | `@google-cloud/kms` |
| Azure Key Vault | `@azure/keyvault-keys @azure/identity` |
| OpenTelemetry traces and metrics | `@opentelemetry/api` |

Local directories (and the in-memory storage used in tests) need nothing extra.

## Storage URLs

The CLI and config file name storage with a URL. Credentials never go in the URL; each
service uses its usual credential chain (AWS environment and profiles, Google
Application Default Credentials, Azure `DefaultAzureCredential`, an SSH key or agent).

| URL | Storage |
|---|---|
| `./backups`, `/var/backups`, `file:///abs/path` | a local directory |
| `s3://bucket/prefix?region=…&endpoint=…` | S3 or an S3-compatible service |
| `gs://bucket/prefix` | Google Cloud Storage |
| `az://account/container/prefix` | Azure Blob Storage |
| `sftp://user@host:port/path?fingerprint=SHA256:…` | SFTP |

## Optional: the age CLI

You do not need it to use MongoShield. It is worth having on the machine where you keep
your recovery key, so you can confirm you could decrypt a backup without MongoShield
([age installation](https://github.com/FiloSottile/age#installation)).
