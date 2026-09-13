import { z } from "zod";

const secretReference = z.string().regex(/^(?:Bearer )?\$\{[A-Z_][A-Z0-9_]*\}$/, "Используйте ссылку ${SECRET_NAME}, а не значение секрета");
const references = z.record(z.string().min(1), secretReference);
const remoteUrl = z.string().url().superRefine((value, ctx) => {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    ctx.addIssue({ code: "custom", message: "Нужен HTTP(S) URL без пароля, query-параметров и фрагмента" });
});
const serverSchema = z.union([
  z.strictObject({ command: z.string().trim().min(1), args: z.array(z.string()).max(100).optional(), env: references.optional(), type: z.literal("stdio").optional() }),
  z.strictObject({ url: remoteUrl, headers: references.optional(), type: z.enum(["http", "sse"]).optional() }),
]);
export type McpConfig = z.infer<typeof serverSchema>;
export interface CustomMcp { name: string; config: McpConfig; enabled: boolean; }
const documentSchema = z.strictObject({ mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/), serverSchema) });
export function parseMcpImport(text: string, existingNames: string[] = []): CustomMcp[] {
  if (text.length > 65536) throw new Error("Конфигурация слишком большая: максимум 64 К символов.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Некорректный JSON. Проверьте кавычки, запятые и скобки."); }
  const result = documentSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${issue.path.join('.') || 'JSON'}: ожидается mcpServers с command/args/env либо url/headers; type — stdio, http или sse. В env и headers используйте ссылки \u0024{SECRET_NAME}. Неизвестные поля не поддерживаются.`);
  }
  const entries = Object.entries(result.data.mcpServers);
  if (!entries.length || entries.length > 20) throw new Error("Добавьте от 1 до 20 серверов за один импорт.");
  const collision = entries.find(([name]) => existingNames.some(n => n.toLowerCase() === name.toLowerCase()));
  const names = entries.map(([name]) => name.toLowerCase());
  if (collision || new Set(names).size !== names.length) throw new Error("Имя MCP уже используется. Укажите другое имя или отредактируйте существующее подключение.");
  return entries.map(([name, config]) => ({ name, config, enabled: true }));
}
export const mcpTransport = (config: McpConfig) => 'command' in config ? 'stdio' : config.type || 'http';
export const mcpExample = (local = false) => JSON.stringify({mcpServers: local
  ? { 'local-tools': { command: 'node', args: ['/path/to/mcp-server.js'], env: { API_KEY: '${MY_API_KEY}' } } }
  : { 'research-tools': { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } } }
}, null, 2);
