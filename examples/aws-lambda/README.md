# AWS Lambda: scheduled backups to S3

[`handler.mjs`](./handler.mjs) backs up MongoDB to S3 with the MongoShield library,
verifies the result and prunes old backups. [`template.yaml`](./template.yaml) (AWS SAM)
creates the bucket, the function and an EventBridge schedule.

```bash
npx mongoshield keygen --output backup.key     # keep backup.key offline
aws secretsmanager create-secret --name mongoshield/mongodb-uri --secret-string 'mongodb+srv://…'
npm install
sam build && sam deploy --guided
sam remote invoke BackupFunction                    # run once now
```

## Limits to know

- **15 minutes per run.** Lambda's hard limit. The handler aborts the backup a minute
  before it, and an aborted backup never gets a manifest, so it is never mistaken for a
  complete one. If your database doesn't fit, split it across several functions with
  `include`/`exclude`, wait for resumable backups (MongoShield P4, which will continue a
  run across invocations), or use ECS/Kubernetes with the Docker image.
- **Memory = CPU.** 1769 MB buys one full vCPU. Memory use stays flat whatever the
  database size, so more memory only helps through the extra CPU.
- **Network.** For Atlas, either allow Lambda's egress IPs (a VPC with a NAT gateway and
  an Elastic IP) or use Atlas PrivateLink. See [docs/guides/atlas.md](../../docs/guides/atlas.md).
- **Alerting.** The template adds a CloudWatch alarm on errors, which also fires when
  the function did not run at all. Attach an SNS topic to it.
- **AWS SDK.** The Lambda runtime ships an AWS SDK, but its version is not under your
  control; this example bundles its own (`package.json`).

Full guide: [docs/guides/aws-lambda.md](../../docs/guides/aws-lambda.md).
