import type { TaskFile } from "../prototype/data";

const OPAQUE_ID = /^[a-z][a-z0-9]*_[a-z0-9]{8,48}$/;

export function isOpaqueRecordId(value: string): boolean {
  return OPAQUE_ID.test(value);
}

export function asRelativePath(name: string): string {
  const cleaned = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || "upload.txt";
}

export function mimeOf(file: Pick<TaskFile, "name" | "kind">): string {
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "text/yaml";
  if (name.endsWith(".csv")) return "text/csv";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return file.kind === "image" ? "image/png" : "text/plain";
}

export function fileBytes(file: Pick<TaskFile, "content" | "kind">): Uint8Array {
  if (file.kind === "image" && file.content.startsWith("data:")) {
    const encoded = file.content.slice(file.content.indexOf(",") + 1);
    const binary = atob(encoded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return new TextEncoder().encode(file.content);
}

/** Owned ArrayBuffer copy for SubtleCrypto; do not pass a shared ArrayBufferLike view. */
export function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Utf8(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

export function bytesToBase64(bytes: Uint8Array): string {
  const owned = new Uint8Array(ownedArrayBuffer(bytes));
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < owned.length; offset += chunk) {
    binary += String.fromCharCode(...owned.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function decodeArtifactBytes(bytesBase64: string, kind: TaskFile["kind"], name: string): string {
  const bytes = Uint8Array.from(atob(bytesBase64), (char) => char.charCodeAt(0));
  if (kind === "image") {
    const mime = mimeOf({ name, kind });
    return `data:${mime};base64,${bytesBase64}`;
  }
  return new TextDecoder().decode(bytes);
}

export function artifactAuthorLabel(author: { kind: string } | undefined): string {
  if (!author || author.kind === "system") return "Система";
  if (author.kind === "user") return "Вы";
  if (author.kind === "run") return "Запуск";
  return "Система";
}
