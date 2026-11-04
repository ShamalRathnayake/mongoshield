/**
 * Netlify scheduled function: starts the nightly MongoDB backup.
 *
 * CAVEAT: this relies on UNDOCUMENTED behaviour. Netlify documents scheduled
 * functions and background functions, but not a scheduled function starting a
 * background one. It works at the time of writing and may stop working. It is meant
 * for SMALL databases: a scheduled function stops after 30 seconds, so it only
 * starts the work, and the background function then has 15 minutes in total.
 * The recommended runner is GitHub Actions (`npx mongoshield init --github`); see
 * docs/guides/atlas-free-netlify.md.
 *
 * This function does no backup work itself. It calls the background function with a
 * shared secret (so nobody else can start backups) and returns at once; Netlify
 * answers a background function's caller with 202 straight away.
 */

import type { Config } from "@netlify/functions";

export default async (): Promise<Response> => {
  const siteUrl = process.env.URL; // set by Netlify: the site's main URL
  const secret = process.env.BACKUP_TRIGGER_SECRET;
  if (!siteUrl || !secret) {
    console.error("Set BACKUP_TRIGGER_SECRET (and deploy on Netlify, which sets URL).");
    return new Response("not configured", { status: 500 });
  }

  const response = await fetch(new URL("/.netlify/functions/backup-background", siteUrl), {
    method: "POST",
    headers: { "x-backup-secret": secret },
    // Never wait anywhere near the 30-second limit for an answer.
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) {
    console.error(`The background backup did not start (HTTP ${response.status}).`);
    return new Response("backup not started", { status: 502 });
  }
  console.log("Backup started in the background function.");
  return new Response("backup started", { status: 202 });
};

export const config: Config = {
  // Once a day at midnight UTC. A cron expression ("17 3 * * *") works too.
  schedule: "@daily",
};
