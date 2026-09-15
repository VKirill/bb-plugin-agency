import { describe, expect, it } from "vitest";
import { compilePayloadSchema, validateEventPayload } from "../src/server/dispatcher/payload-schema";

describe("payload schema subset", () => {
  it("accepts the documented object subset and rejects $ref / pattern / type unions", () => {
    expect(compilePayloadSchema({ type: "object" }).ok).toBe(true);
    expect(compilePayloadSchema({ type: "object", properties: { status: { type: "string", enum: ["ready"] } }, required: ["status"] }).ok).toBe(true);
    expect(compilePayloadSchema({ $ref: "#/defs/x" }).ok).toBe(false);
    expect(compilePayloadSchema({ type: ["string", "null"] }).ok).toBe(false);
    expect(compilePayloadSchema({ type: "string", pattern: ".*" }).ok).toBe(false);
    expect(compilePayloadSchema({ anyOf: [{ type: "string" }] }).ok).toBe(false);
    expect(compilePayloadSchema({ additionalProperties: { type: "string" } }).ok).toBe(false);
  });

  it("matches required data.status and rejects a missing own property", () => {
    const schema = {
      type: "object",
      required: ["data"],
      properties: {
        data: { type: "object", required: ["status"], additionalProperties: true },
      },
    };
    expect(validateEventPayload(schema, { data: { status: "ready" } }).ok).toBe(true);
    const missing = validateEventPayload(schema, { data: {} });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("payload_schema_mismatch");
  });
});
