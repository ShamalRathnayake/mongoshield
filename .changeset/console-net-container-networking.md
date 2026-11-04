---
"@mongoshield/console": patch
---

Console networking fixes for the environments people really run it in:

- `host.docker.internal` is only offered when it resolves inside the console. On Linux Docker Engine without `--add-host` the console now explains `--add-host=host.docker.internal:host-gateway` instead, a refused `host.docker.internal` points at mongod's `bindIp`, and the quick fill and the automatic localhost rewrite add `directConnection=true` for a single host, so a single-node replica set on the host connects instead of timing out.
- The console detects whether it runs in Docker Desktop, Docker Engine, Podman (`host.containers.internal`), Kubernetes or a container on the host's network, and tailors suggestions and hints: `localhost` is kept in Kubernetes and with host networking.
- `mongodb+srv://` lookups that time out or fail at the DNS server are reported as a DNS resolver problem with the standard connection string as the fix, not as "the cluster may be deleted".
- Hosts are treated as production unless they are clearly this machine: `.local`, `.internal` (Kubernetes Services, AWS and GCP internal names) and single-label names are no longer guessed to be test databases.
- A data directory the console may not write (a bind-mounted host folder) gives a clear message with the `chown -R 65532:65532` fix instead of a stack trace.
- `secret.key` with group access (a Kubernetes `fsGroup` mount makes it 0660) is accepted; access for other users is still refused.
- The printed setup link uses `MONGOSHIELD_PUBLIC_URL` when set, and otherwise says that a `-p` port mapping changes it.
- The console listens on `::` (IPv6 and IPv4) by default, falling back to `0.0.0.0` where IPv6 is unavailable. `HOST` still overrides it.
