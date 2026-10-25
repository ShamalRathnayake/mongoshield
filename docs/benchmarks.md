# Benchmarks

How MongoShield compares with `mongodump` and `mongorestore` on the same data, on the
same machine: backup and restore time, CPU time, peak memory and backup size. Every
number here comes from the harness in
[`packages/mongoshield/bench/compare.ts`](../packages/mongoshield/bench/compare.ts),
and the raw results (every run, not only the medians) are in
[`packages/mongoshield/bench/results/`](../packages/mongoshield/bench/results/).
Run it yourself: numbers from your own hardware and data beat ours.

## Summary

- **Fastest backup: `mongodump` without compression.** On the medium and large
  datasets it is 1.5–2× faster than MongoShield and uses a third of the memory, but
  writes 2.4× more bytes (it does not compress).
- **Fastest compressed backup: MongoShield with zstd.** On the medium and large
  datasets it is 3.5–5× faster than `mongodump --gzip` and uses about a quarter of
  the CPU, for a backup of the same size (zstd and gzip end up within 2% of each
  other on this data). On the small dataset `mongodump --gzip` is faster.
- **Encryption (age) adds about 1 second (20%)** to the medium backup and nothing
  measurable to restores; on the other datasets the difference is within the noise.
- **Restores are close.** MongoShield was 5–25% faster than `mongorestore` on the
  medium and large datasets, while using about 1.5× the CPU. On the small dataset
  `mongorestore` was slightly faster.
- **Memory is where `mongodump` clearly wins.** MongoShield's backup peaks at
  400 MiB–1 GiB RSS against 120–260 MiB for `mongodump`. (Restores are the other way
  round on the bigger datasets: `mongorestore` peaks higher.)
- **Small databases: `mongodump` wins outright.** Below a few hundred MiB, Node.js
  start-up and the fixed cost of `converge` consistency (about 0.8 s) dominate.

## Results

Medians of 3 runs (5 for the small dataset); the numbers in brackets are the fastest
and slowest run. "Size vs raw" is the backup's size relative to the uncompressed BSON
size of the data. CPU is user + system time of the tool's process; peak RSS is the
tool's process (the server's own memory and CPU are not included).

### Medium: 2 million documents, 1.45 GiB of BSON

| Variant | Backup time | Backup CPU | Backup peak RSS | Backup size | Size vs raw | Restore time | Restore CPU | Restore peak RSS |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| mongoshield (zstd) | 5.2 s (4.2–5.3) | 11.5 s | 704 MiB | 631 MiB | 42% | 14.3 s (13.7–14.4) | 17.2 s | 606 MiB |
| mongoshield (zstd, consistency none) | 4.7 s (4.6–4.9) | 11.0 s | 749 MiB | 631 MiB | 42% | 13.5 s (13.2–13.7) | 17.5 s | 590 MiB |
| mongoshield (zstd + age) | 6.3 s (6.2–6.3) | 11.9 s | 708 MiB | 631 MiB | 42% | 14.5 s (13.5–14.6) | 17.5 s | 630 MiB |
| mongoshield (gzip) | 9.3 s (9.3–10.3) | 29.6 s | 627 MiB | 640 MiB | 43% | 14.3 s (13.8–17.0) | 18.5 s | 539 MiB |
| mongodump (plain) | 3.2 s (3.2–3.6) | 3.9 s | 234 MiB | 1488 MiB | 100% | 16.2 s (14.7–16.6) | 11.0 s | 730 MiB |
| mongodump (--gzip) | 19.3 s (19.3–20.5) | 44.0 s | 216 MiB | 641 MiB | 43% | 15.3 s (15.2–16.0) | 11.6 s | 706 MiB |

### Large: 5 million documents, 3.6 GiB of BSON

The noisiest run: the machine was busy with other work while it ran (load average up
to 10), and the data plus its restored copy did not fit in the 6 GiB WiredTiger
cache. Read the ranges, not only the medians.

| Variant | Backup time | Backup CPU | Backup peak RSS | Backup size | Size vs raw | Restore time | Restore CPU | Restore peak RSS |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| mongoshield (zstd) | 18.3 s (13.3–20.4) | 33.5 s | 962 MiB | 1574 MiB | 42% | 37.8 s (35.2–46.4) | 43.7 s | 537 MiB |
| mongoshield (zstd, consistency none) | 12.6 s (12.2–13.3) | 27.4 s | 1006 MiB | 1574 MiB | 42% | 33.6 s (33.4–37.3) | 42.6 s | 561 MiB |
| mongoshield (zstd + age) | 15.3 s (15.3–19.3) | 30.9 s | 895 MiB | 1575 MiB | 42% | 36.5 s (36.0–40.8) | 43.3 s | 564 MiB |
| mongoshield (gzip) | 28.3 s (28.3–34.4) | 78.6 s | 887 MiB | 1596 MiB | 43% | 50.7 s (37.3–61.2) | 48.7 s | 570 MiB |
| mongodump (plain) | 8.7 s (8.0–21.7) | 9.4 s | 257 MiB | 3717 MiB | 100% | 49.9 s (46.0–65.5) | 26.9 s | 789 MiB |
| mongodump (--gzip) | 66.0 s (57.3–131.3) | 117.1 s | 236 MiB | 1602 MiB | 43% | 42.9 s (41.8–55.7) | 29.7 s | 729 MiB |

### Small: 100,000 documents, 75 MiB of BSON

| Variant | Backup time | Backup CPU | Backup peak RSS | Backup size | Size vs raw | Restore time | Restore CPU | Restore peak RSS |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| mongoshield (zstd) | 1.2 s (1.2–1.3) | 0.8 s | 417 MiB | 31.7 MiB | 42% | 1.2 s (1.0–1.6) | 1.2 s | 455 MiB |
| mongoshield (zstd, consistency none) | 0.4 s (0.4–0.4) | 0.8 s | 409 MiB | 31.7 MiB | 42% | 1.1 s (1.1–1.4) | 1.2 s | 453 MiB |
| mongoshield (zstd + age) | 1.2 s (1.2–1.2) | 0.8 s | 440 MiB | 31.7 MiB | 42% | 1.2 s (1.1–1.5) | 1.3 s | 461 MiB |
| mongoshield (gzip) | 1.2 s (1.2–1.2) | 1.8 s | 412 MiB | 32.2 MiB | 43% | 1.1 s (1.1–1.2) | 1.2 s | 437 MiB |
| mongodump (plain) | 0.1 s (0.1–0.1) | 0.2 s | 124 MiB | 74.6 MiB | 100% | 0.9 s (0.9–1.0) | 0.5 s | 285 MiB |
| mongodump (--gzip) | 0.9 s (0.9–0.9) | 2.1 s | 133 MiB | 32.2 MiB | 43% | 1.0 s (0.9–1.3) | 0.5 s | 295 MiB |

## What the numbers mean

**Compression is the big difference in backup time.** `mongodump --gzip` compresses
each collection as one stream with Go's gzip; MongoShield compresses with zstd
(level 3, through Node.js's built-in zlib) and splits large collections into parts
that are compressed in parallel. With gzip on both sides MongoShield is still about
2× faster and uses a third less CPU (Node.js's gzip is zlib, written in C). Without
compression, `mongodump` simply does less work than any compressed variant: if disk
space and transfer do not matter, it is the fastest way to get the data out.

**zstd is not smaller than gzip here.** About an eighth of the dataset is random
bytes (like images or already-compressed files), which nothing compresses, and the
rest is short documents where zstd at its default level and gzip end up close. zstd's
advantage on this data is speed and CPU (about 40% of gzip's), not size.

**`converge` costs about half a second to a second.** By default
(`--consistency auto`) MongoShield makes every collection consistent to one moment
using a change stream, and at the end waits for the stream to catch up (one
`getMore` of up to a second). `mongodump` without `--oplog` makes no such guarantee,
so the "consistency none" row is the like-for-like comparison. On the large dataset
the gap was bigger (13.3–20.4 s against 12.2–13.3 s); we have not separated that
from the noise of that run. On a database that is not being written to, `converge`
has nothing to replay; on a busy one it also replays the changes made during the
backup.

**Restores are bound by the server.** Both tools insert through the same server,
build the same indexes and write the same oplog; the server does most of the work,
and the tools are within about 25% of each other. MongoShield uses more CPU on the
client (decompression, and checking every file's SHA-256 as it streams it).

**MongoShield's peak RSS is high.** It does not hold the data: its JavaScript heap
and buffers stay around 110–140 MiB at the default parallelism of 4 whatever the
database size (measured with `bench/memory.ts`, see
[PARTS-AND-RESUME.md, section 5](specs/PARTS-AND-RESUME.md#5-memory)), and peak RSS
grows far less than the data (from about 400 MiB at 75 MiB of data to about 1 GiB
at 3.6 GiB). The rest is most likely memory that V8 and the allocator keep rather
than hand back, as the memory benchmark also found.
A heap limit does not make it go away: in a separate check on the medium dataset,
`NODE_OPTIONS=--max-old-space-size=256` brought the backup's peak RSS down from about
720 to about 500 MiB and made it much slower (about 19 s instead of 5 s, though the
machine was also busier during that check). A lower `--parallelism`
lowers memory too. Either way, if a backup has to fit in 256 MiB of RAM, `mongodump`
does that out of the box and MongoShield does not.

## Methodology

- **Dataset.** Four collections generated from a seeded pseudo-random generator, so
  every run and every machine gets the same bytes (see
  [`bench/compare/dataset.ts`](../packages/mongoshield/bench/compare/dataset.ts)):
  - `users` (15% of documents, ~1 KiB): names, unique e-mail, nested address with a
    GeoJSON point, tag arrays, free-text bio, Decimal128 balance. Indexes: unique
    `email`, 2dsphere, multikey `tags`.
  - `orders` (35%, ~1.5 KiB): ObjectId reference, 1–8 line items with Decimal128
    prices, notes. Indexes: `{userId, createdAt}`, `{status}`.
  - `events` (50%, ~250 B): the small, numerous log shape with UUIDs and numbers.
    Indexes: `{at}`, `{type, at}`.
  - `attachments` (0.04%, 256 KiB–768 KiB each, about a quarter of the bytes): half
    random bytes, half text. Index: `{filename}`.
  - Text comes from an English word list, so it compresses the way prose does.
- **Deployment.** A single-node replica set (mongod 7.0.32, WiredTiger, 6 GiB cache)
  started by mongodb-memory-server with its data directory on the local SSD. Same
  machine as the tools; no network in between.
- **Tools.** The MongoShield CLI (`node dist/cli.mjs`) built from the repository
  (commit `3162676` plus uncommitted work, shortly before the 2.0.0 release) on
  Node.js 24.15; MongoDB Database Tools 100.16.0. Defaults everywhere except the
  options in the variant names: both sides back up and restore 4 collections at a
  time (their default), restores build all indexes.
- **Each run** backs up to a fresh, empty directory, then drops the target database
  and restores into it under another name (`mongoshield restore --rename`,
  `mongorestore --nsFrom/--nsTo`). Each restore is checked: same collections,
  document counts and indexes, or the benchmark fails. The order of the variants
  rotates from run to run, so none of them always goes first.
- **Measurements.** Each command is its own process, measured with `/usr/bin/time`
  (getrusage): wall time, peak RSS and user + system CPU of that process. Backup size
  is the sum of the files written. (Where `/usr/bin/time` is missing, the harness
  samples RSS with `ps` every 50 ms and reports CPU as null.)
- **Machine.** Apple M5 Pro (15 cores), 24 GiB RAM, internal SSD, macOS 27 (Darwin
  27.0). The full runs (small, medium, large) took about 31 minutes.

## Caveats

- **One machine, local disk, no network.** Backups to S3, GCS or Azure are usually
  limited by upload bandwidth, which favors whatever writes fewer bytes (so
  uncompressed `mongodump` loses most of its lead), and MongoShield streams to object
  storage directly while `mongodump` needs a local copy or a pipe. None of that is
  measured here.
- **Not an idle machine.** Other test suites were running on it during the runs (load
  average 2–10); this shows most in the large dataset's ranges. Medians of 3–5 runs
  reduce that noise but do not remove it.
- **A quiet database.** Nothing writes to it during the backup, so `converge` has no
  changes to replay and `mongodump --oplog` was not measured.
- **Warm caches.** The data was just written, so most of it is in WiredTiger's cache
  or the OS page cache (except partly for the large dataset). A cold production
  server reads from disk and both tools get slower.
- **Apple silicon.** zstd and gzip speeds, and Go versus Node.js, differ on other CPUs.
- **Your data is not our data.** Highly compressible data (logs, JSON-heavy text)
  makes compression matter more; mostly binary data makes it matter less.

## Run it yourself

```sh
# Once: the official tools, and a build of MongoShield
node packages/mongoshield/scripts/fetch-mongo-tools.ts
export MONGOMS_SYSTEM_BINARY=$(which mongod)   # optional: use an installed mongod

pnpm bench                                # small dataset, 3 runs (~1 minute)
pnpm bench --scale medium                 # 2M documents (~7 minutes)
pnpm bench --scale large --cache-gb 6     # 5M documents (~25 minutes)
pnpm bench --uri mongodb://my-server/     # against your own server (only the
                                          # mongoshield_bench* databases are touched)
```

Results go to `packages/mongoshield/bench/results/<scale>.json` (format them with
`pnpm exec biome format --write packages/mongoshield/bench/results` before committing),
and `node packages/mongoshield/bench/compare.ts --table <file>` prints a results file
as the tables above. CI runs `--scale tiny --runs 1` on every pull request, only to
prove the harness still works; those numbers mean nothing.
