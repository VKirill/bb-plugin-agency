/**
 * Interface translation check: every Russian text passed to tr()/<Tr> or to a
 * self-translating prop of the shared components has an English entry, and no
 * tr() call runs at module top level (it would stay Russian forever).
 *
 *   npx tsx scripts/i18n-check.ts [--list]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setUiLanguage, hasTranslation } from "../src/app/i18n";

const ROOT = join(import.meta.dirname, "..", "src", "app");
const CYRILLIC = /[А-Яа-яЁё]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "demo" || name === "i18n" ? [] : files(path);
    return /\.(tsx?|ts)$/.test(name) ? [path] : [];
  });
}

const literal = String.raw`"((?:[^"\\]|\\.)*)"`;
const patterns = [
  new RegExp(String.raw`\btr\(\s*${literal}`, "g"),
  new RegExp(String.raw`<Tr\s+text=\{?${literal}`, "g"),
  new RegExp(String.raw`\b(?:label|title|description|placeholder|hint)=${literal}`, "g"),
  new RegExp(String.raw`<(?:PageHead|Panel|Field|TextField|Choice|Empty|HintHeading|InfoHint|HintedChoice)\b[^>]*?\b(?:label|title|description)=\{?${literal}`, "g"),
];

const missing = new Map<string, string[]>();
const topLevel: string[] = [];
setUiLanguage("en");
for (const file of files(ROOT)) {
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = JSON.parse(`"${match[1]}"`) as string;
      if (!CYRILLIC.test(value) || hasTranslation(value)) continue;
      missing.set(value, [...(missing.get(value) ?? []), file.slice(ROOT.length + 1)]);
    }
  }
  // tr( on a line that starts a top-level declaration, outside any function.
  let depth = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (depth === 0 && /^(export\s+)?const\s+\w+[^=]*=\s*(?!\(|async|function)/.test(line) && /\btr\(/.test(line)) topLevel.push(`${file.slice(ROOT.length + 1)}:${index + 1}`);
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
}
console.log(`missing translations: ${missing.size}`);
if (process.argv.includes("--list")) for (const [value, where] of missing) console.log(`- ${JSON.stringify(value)}  ← ${[...new Set(where)].join(", ")}`);
console.log(`possible top-level tr(): ${topLevel.length}`);
for (const where of topLevel) console.log(`- ${where}`);
