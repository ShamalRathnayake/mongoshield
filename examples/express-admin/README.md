# Express: a protected endpoint to trigger backups

[`server.mjs`](./server.mjs) adds `POST /admin/backups` (start a backup) and
`GET /admin/backups/current` (its status) to an Express app.

```bash
npm install
export ADMIN_TOKEN=$(openssl rand -hex 32)
MONGODB_URI=… BACKUP_BUCKET=… BACKUP_PUBLIC_KEY=age1… npm start

curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3001/admin/backups
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3001/admin/backups/current
```

**Do you need this?** For scheduled backups, a scheduler is simpler and safer: the
[Docker image](../../docs/guides/docker.md), a [Kubernetes CronJob](../../docs/guides/kubernetes.md)
or [GitHub Actions](../../docs/guides/github-actions.md). An HTTP trigger makes sense for
"back up now, before this migration" buttons in internal tools.

## Security checklist

- **Never public.** It listens on `127.0.0.1` by default. Reach it through a VPN, an internal
  load balancer, or `kubectl port-forward`. Every call costs database load and storage.
- **Strong token, compared in constant time.** At least 32 random bytes, kept in a secret
  manager, rotated when people leave. Better still: put it behind your SSO proxy
  (OAuth2 Proxy, Cloudflare Access, IAP) and keep the token as a second layer.
- **TLS** on any hop that leaves the machine; the token is a bearer credential.
- **One backup at a time.** A second request gets `409`, so a retry loop or a double click
  can't stack backups. Add rate limiting at the proxy for defense in depth.
- **Write-only keys.** The server encrypts for a public key and holds no secret key, so
  even a full compromise of this server cannot read existing backups.
- **Least-privilege credentials.** A MongoDB user with the `backup` role only, and storage
  credentials limited to the backup bucket and prefix.
- **No restore endpoint.** Restores overwrite data; run them deliberately with the CLI
  (`mongoshield restore --dry-run` first), not from a URL.
- **No error details to clients.** Responses carry only the stable error code
  (`MS_…`, see [docs/errors.md](../../docs/errors.md)); details go to the server log, and
  MongoShield already strips passwords from its messages.
- **Audit trail.** Each backup carries `trigger` and `runId` labels in its manifest; log
  who called the endpoint at your proxy.
