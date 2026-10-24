/**
 * Chat notifications: Slack incoming webhooks and Discord webhooks.
 *
 * Both get the same facts (status, summary, backup id, sizes, duration, host,
 * error and hint) laid out the way each service renders best: Slack "blocks"
 * and Discord "embeds". The report has already been scrubbed of secrets.
 *
 * Slack:   https://api.slack.com/messaging/webhooks
 * Discord: https://discord.com/developers/docs/resources/webhook#execute-webhook
 */

import { type RunReport, summarizeReport, verifyLabel } from "../schedule/report.ts";
import { type DeliveryOptions, sendHttp } from "./http.ts";

/** A label/value pair shown in both layouts. */
interface Fact {
  readonly label: string;
  readonly value: string;
}

/** Discord embed colors (24-bit RGB as a number): green for success, red for failure. */
const DISCORD_GREEN = 0x2e_b8_6b;
const DISCORD_RED = 0xd9_34_34;

/** Discord limits an embed description to 4096 characters; stay well below. */
const MAX_TEXT = 3000;

/** The facts worth showing for a report, in display order. */
function factsOf(report: RunReport): Fact[] {
  const facts: Fact[] = [];
  if (report.backup) {
    facts.push({ label: "Backup", value: report.backup.id });
    facts.push({
      label: "Size",
      value: `${formatBytes(report.backup.bytesRaw)} raw → ${formatBytes(report.backup.bytesStored)} stored`,
    });
  }
  if (report.verify)
    facts.push({
      label: "Verify",
      value: `${verifyLabel(report.verify)}: ${report.verify.ok ? "ok" : "FAILED"}`,
    });
  if (report.guard && !report.guard.ok) {
    facts.push({
      label: "Guard",
      value: `${report.guard.findings.length} finding(s), action ${report.guard.action}`,
    });
  }
  facts.push({ label: "Duration", value: `${Math.round(report.durationMs / 1000)} s` });
  facts.push({ label: "Host", value: report.host });
  facts.push({ label: "Storage", value: report.storage });
  return facts;
}

/** The error details (and guard findings) as plain text lines, or "" for a success. */
function problemText(report: RunReport): string {
  const lines: string[] = [];
  if (report.error) {
    lines.push(`${report.error.code}: ${report.error.message}`);
    if (report.error.hint) lines.push(`Hint: ${report.error.hint}`);
  }
  for (const finding of report.guard?.findings ?? []) lines.push(`• ${finding.message}`);
  return truncate(lines.join("\n"));
}

/** The headline: an emoji-free status word keeps it readable in notifications and logs. */
function titleOf(report: RunReport): string {
  if (report.status === "checkpointed") return "MongoShield backup checkpointed (will resume)";
  return report.status === "success" ? "MongoShield backup succeeded" : "MongoShield backup FAILED";
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/** The JSON body for a Slack incoming webhook. `text` is the fallback for notifications. */
export function slackPayload(report: RunReport): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: titleOf(report) } },
    { type: "section", text: { type: "mrkdwn", text: escapeSlack(summarizeReport(report)) } },
    {
      type: "section",
      fields: factsOf(report).map((fact) => ({
        type: "mrkdwn",
        text: `*${fact.label}*\n${escapeSlack(fact.value)}`,
      })),
    },
  ];
  const problems = problemText(report);
  if (problems !== "") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `\`\`\`${escapeSlack(problems)}\`\`\`` },
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `run ${report.runId}` }] });
  return { text: `${titleOf(report)}: ${summarizeReport(report)}`, blocks };
}

/** Posts the report to a Slack incoming webhook. Never throws. */
export async function sendSlack(url: string, report: RunReport, options: DeliveryOptions = {}) {
  const body = JSON.stringify(slackPayload(report));
  return sendHttp(
    {
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      label: "Slack notification",
    },
    options,
  );
}

/** Slack's mrkdwn treats `&`, `<` and `>` specially (links, mentions). */
function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/** The JSON body for a Discord webhook. Mentions are disabled so an error message can't ping anyone. */
export function discordPayload(report: RunReport): Record<string, unknown> {
  const problems = problemText(report);
  const description =
    problems === ""
      ? summarizeReport(report)
      : `${summarizeReport(report)}\n\`\`\`\n${problems}\n\`\`\``;
  return {
    username: "MongoShield",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: titleOf(report),
        description: truncate(description),
        color: report.status === "failure" ? DISCORD_RED : DISCORD_GREEN,
        fields: factsOf(report).map((fact) => ({
          name: fact.label,
          value: fact.value,
          inline: true,
        })),
        footer: { text: `run ${report.runId}` },
        timestamp: report.finishedAt,
      },
    ],
  };
}

/** Posts the report to a Discord webhook. Never throws. */
export async function sendDiscord(url: string, report: RunReport, options: DeliveryOptions = {}) {
  const body = JSON.stringify(discordPayload(report));
  return sendHttp(
    {
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      label: "Discord notification",
    },
    options,
  );
}

// ---------------------------------------------------------------------------

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/** `1.5 GiB`. A local copy: notifications must not depend on the CLI's formatting. */
function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}
