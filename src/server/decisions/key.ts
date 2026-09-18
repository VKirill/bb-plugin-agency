import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Ключ оценщика. Агентство хранит только **имя**: сам ключ лежит либо в плагине Env Catalog
 * (зашифрован, общий для машин), либо в окружении машины BB. Так секрет не попадает ни в базу
 * Агентства, ни в резервные копии, ни в экспорт настроек.
 *
 * До Env Catalog ходим его же публичной командой `bb env-catalog`: это граница между плагинами,
 * а не чтение чужого файла с ключами.
 */

const run = promisify(execFile);

/** Путь к bb: BB_CLI задаёт сам BB, иначе рассчитываем на PATH. */
function cli(): string {
  return process.env.BB_CLI?.trim() || "bb";
}

export type EnvKeyRef = { source: "env-catalog" | "machine-env"; name: string };

export type KeyLookup = { ok: true; value: string } | { ok: false; reason: "no_catalog" | "not_found" | "empty_name" };

export async function resolveDecisionKey(ref: EnvKeyRef, timeoutMs = 5_000): Promise<KeyLookup> {
  const name = ref.name.trim();
  if (!name) return { ok: false, reason: "empty_name" };
  if (ref.source === "machine-env") {
    const value = process.env[name]?.trim();
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  }
  try {
    const { stdout } = await run(cli(), ["env-catalog", "get", name, "--raw"], { timeout: timeoutMs, windowsHide: true });
    const value = stdout.trim();
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  } catch (error) {
    // Плагина нет — команда неизвестна; переменной нет — ненулевой код. Владельцу это разные советы.
    const text = String((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? "");
    return { ok: false, reason: /unknown command|not found: env-catalog|command not found/i.test(text) ? "no_catalog" : "not_found" };
  }
}

export type EnvKeyOption = { name: string; service: string | null; masked: string | null };

/**
 * Имена переменных Env Catalog для выпадающего списка. Значения не запрашиваем: в интерфейс
 * уходят имя, сервис и маска, которую печатает сам каталог.
 */
export async function listEnvKeyOptions(timeoutMs = 5_000): Promise<{ available: boolean; options: EnvKeyOption[] }> {
  try {
    const { stdout } = await run(cli(), ["env-catalog", "list", "--json"], { timeout: timeoutMs, windowsHide: true });
    const parsed = JSON.parse(stdout) as { name?: unknown; service?: unknown; maskedValue?: unknown }[];
    if (!Array.isArray(parsed)) return { available: true, options: [] };
    return {
      available: true,
      options: parsed
        .filter((row): row is { name: string; service?: string; maskedValue?: string } => typeof row?.name === "string")
        .map((row) => ({ name: row.name, service: typeof row.service === "string" ? row.service : null, masked: typeof row.maskedValue === "string" ? row.maskedValue : null })),
    };
  } catch {
    return { available: false, options: [] };
  }
}

/**
 * Положить ключ в Env Catalog под своим именем. Нужен тому, кто вставляет ключ в поле: Агентство
 * передаёт его каталогу и запоминает только имя.
 */
export async function putEnvKey(name: string, value: string, description: string, timeoutMs = 5_000): Promise<KeyLookup> {
  const key = name.trim();
  if (!key || !value.trim()) return { ok: false, reason: "empty_name" };
  try {
    await run(cli(), ["env-catalog", "set", key, value, "--desc", description, "--service", "OpenRouter"], { timeout: timeoutMs, windowsHide: true });
    return { ok: true, value: key };
  } catch {
    return { ok: false, reason: "no_catalog" };
  }
}
