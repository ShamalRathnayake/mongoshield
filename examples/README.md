# Examples

Copyable setups for running MongoShield on different platforms. Each folder has its own
README; the matching guides are in [`docs/guides`](../docs/guides/).

| Example | What it shows |
|---|---|
| [`github-actions`](./github-actions/) | nightly backup + verify + prune with the MongoShield action and AWS OIDC; Atlas Free/Flex templates for S3/R2 or GitHub artifacts |
| [`docker-compose`](./docker-compose/) | app + MongoDB + MinIO + the MongoShield scheduler |
| [`console-compose`](./console-compose/) | the web console + MongoDB, zero setup: paste the URI, browse, back up, restore |
| [`aws-lambda`](./aws-lambda/) | SAM template: Lambda on an EventBridge schedule, S3 bucket, error alarm |
| [`vercel-cron`](./vercel-cron/) | Next.js route handler called by Vercel Cron |
| [`nestjs`](./nestjs/) | a NestJS module providing `MongoShield`, with a scheduled job |
| [`express-admin`](./express-admin/) | a protected "back up now" endpoint, with a security checklist |

Kubernetes lives in [`deploy/`](../deploy/): a Helm chart and a plain CronJob manifest.

Pin an exact version in production.
