import { WEBHOOK_MAX_BYTES } from "../webhook-auth.js";

export type BoundedBody =
  | { ok: true; rawBody: Uint8Array }
  | { ok: false; status: 413; code: "webhook_too_large" };

export type WebhookBodySource = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

function concat(parts: Uint8Array[], received: number): Uint8Array {
  const rawBody = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    rawBody.set(part, offset);
    offset += part.byteLength;
  }
  return rawBody;
}

async function readReadableStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedBody> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, code: "webhook_too_large" };
      }
      parts.push(value);
    }
    return { ok: true, rawBody: concat(parts, received) };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancel already closes the lock on some runtimes */
    }
  }
}

async function readAsyncIterable(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<BoundedBody> {
  const iterator = source[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const value = next.value;
      received += value.byteLength;
      if (received > maxBytes) {
        await iterator.return?.();
        return { ok: false, status: 413, code: "webhook_too_large" };
      }
      parts.push(value);
    }
    return { ok: true, rawBody: concat(parts, received) };
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}

function isReadableStream(value: object): value is ReadableStream<Uint8Array> {
  return "getReader" in value && typeof (value as ReadableStream<Uint8Array>).getReader === "function";
}

/** Caps the stream before a full-body allocation or JSON.parse. Oversized streams are cancelled. */
export async function readBoundedWebhookBody(
  source: WebhookBodySource,
  maxBytes = WEBHOOK_MAX_BYTES,
): Promise<BoundedBody> {
  if (ArrayBuffer.isView(source)) {
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    if (bytes.byteLength > maxBytes) return { ok: false, status: 413, code: "webhook_too_large" };
    return { ok: true, rawBody: bytes };
  }
  if (isReadableStream(source)) return readReadableStream(source, maxBytes);
  if (source && typeof source === "object" && Symbol.asyncIterator in source) {
    return readAsyncIterable(source, maxBytes);
  }
  throw new TypeError("webhook_body_source_invalid");
}
