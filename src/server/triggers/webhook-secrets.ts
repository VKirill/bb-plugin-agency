import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * Webhook source secrets and allowed topics.
 *
 * The HMAC secret must be readable by the server to verify signatures, so it is
 * kept in a separate file in the plugin data folder with owner-only access, not
 * in the database that backups and exports copy. The interface never reads it
 * back: a new secret is shown once, when it is issued; afterwards only its date.
 */

export const WEBHOOK_SECRETS_FILENAME = "agency-webhook-secrets.json";

export const SOURCE_TOPICS_MIGRATION = `CREATE TABLE agency_source_topics (
    source_id TEXT PRIMARY KEY,
    topics_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

type SecretFile = Record<string, { secret: string; createdAt: string }>;

function readFile(path: string): SecretFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SecretFile;
  } catch {
    return {};
  }
}

function writeSecrets(path: string, value: SecretFile): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Issues a new secret for the source, replacing the old one. The returned text is shown once. */
export function rotateWebhookSecret(path: string, sourceId: string, now: string): { secret: string; createdAt: string } {
  const secret = randomBytes(32).toString("hex");
  const all = readFile(path);
  all[sourceId] = { secret, createdAt: now };
  writeSecrets(path, all);
  return { secret, createdAt: now };
}

export function revokeWebhookSecret(path: string, sourceId: string): void {
  const all = readFile(path);
  if (!all[sourceId]) return;
  delete all[sourceId];
  writeSecrets(path, all);
}

/** Signing key bytes: the UTF-8 bytes of the secret text the sender was given. */
export function webhookSecretBytes(path: string, sourceId: string): Uint8Array | null {
  const entry = readFile(path)[sourceId];
  return entry ? new TextEncoder().encode(entry.secret) : null;
}

export function webhookSecretIssuedAt(path: string, sourceId: string): string | null {
  return readFile(path)[sourceId]?.createdAt ?? null;
}

const TOPIC = /^[a-z][a-z0-9_.-]{0,95}$/;

export function saveSourceTopics(db: SqlDatabase, sourceId: string, topics: readonly string[], now: string): DomainResult<string[]> {
  const clean = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))];
  const bad = clean.find((topic) => !TOPIC.test(topic));
  if (bad) return fail("invalid_topic", `Тема «${bad}»: латиница в нижнем регистре, цифры, точка, дефис и подчёркивание.`);
  if (clean.length > 32) return fail("invalid_topic", "Не больше 32 тем на источник.");
  db.prepare(
    `INSERT INTO agency_source_topics (source_id, topics_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET topics_json = excluded.topics_json, updated_at = excluded.updated_at`,
  ).run(sourceId, JSON.stringify(clean), now);
  return ok(clean);
}

export function sourceTopics(db: SqlDatabase, sourceId: string): string[] {
  const row = db.prepare(`SELECT topics_json FROM agency_source_topics WHERE source_id = ?`).get(sourceId) as { topics_json: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.topics_json) as string[];
  } catch {
    return [];
  }
}
