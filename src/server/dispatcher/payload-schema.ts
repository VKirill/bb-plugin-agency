/**
 * Supported EventDefinition.payloadSchema subset (not full JSON Schema).
 * Allowed keys: type, properties, required, additionalProperties (boolean only),
 * items, enum, const, minLength, maxLength, minimum, maximum, minItems, maxItems, description.
 * Types: object | string | number | integer | boolean | array | null. Depth ≤ 6.
 * Rejected: $ref, $defs, anyOf/oneOf/allOf, not, pattern, format, type unions,
 * additionalProperties as a schema object.
 */
import { fail, ok, type DomainResult } from "../../domain";

const ALLOWED_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "description",
]);

const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);
const MAX_DEPTH = 6;
const MAX_PROPERTIES = 32;
const MAX_ENUM = 32;

export type PayloadSchemaNode = {
  type?: string;
  properties?: Record<string, PayloadSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PayloadSchemaNode;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function compilePayloadSchema(raw: unknown, depth = 0): DomainResult<PayloadSchemaNode> {
  if (depth > MAX_DEPTH) return fail("payload_schema_unsupported", "payload schema nesting exceeds the supported subset");
  if (!isPlainObject(raw)) return fail("payload_schema_unsupported", "payload schema must be an object");
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      return fail("payload_schema_unsupported", `payload schema key ${key} is outside the supported subset`);
    }
  }
  const node: PayloadSchemaNode = {};
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !TYPES.has(raw.type)) {
      return fail("payload_schema_unsupported", "payload schema type must be a single supported keyword");
    }
    node.type = raw.type;
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return fail("payload_schema_unsupported", "payload schema description must be a string");
  }
  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties !== "boolean") {
      return fail("payload_schema_unsupported", "additionalProperties must be a boolean");
    }
    node.additionalProperties = raw.additionalProperties;
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.some((item) => typeof item !== "string") || raw.required.length > MAX_PROPERTIES) {
      return fail("payload_schema_unsupported", "required must be a short string array");
    }
    node.required = raw.required;
  }
  if (raw.properties !== undefined) {
    if (!isPlainObject(raw.properties) || Object.keys(raw.properties).length > MAX_PROPERTIES) {
      return fail("payload_schema_unsupported", "properties must be a short object");
    }
    node.properties = {};
    for (const [name, child] of Object.entries(raw.properties)) {
      const compiled = compilePayloadSchema(child, depth + 1);
      if (!compiled.ok) return compiled;
      node.properties[name] = compiled.value;
    }
  }
  if (raw.items !== undefined) {
    const compiled = compilePayloadSchema(raw.items, depth + 1);
    if (!compiled.ok) return compiled;
    node.items = compiled.value;
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > MAX_ENUM || !raw.enum.every(isPrimitive)) {
      return fail("payload_schema_unsupported", "enum must be a short primitive list");
    }
    node.enum = raw.enum;
  }
  if (raw.const !== undefined) {
    if (!isPrimitive(raw.const)) return fail("payload_schema_unsupported", "const must be a primitive");
    node.const = raw.const;
  }
  for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) {
        return fail("payload_schema_unsupported", `${key} must be a finite number`);
      }
      node[key] = raw[key];
    }
  }
  return ok(node);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

export function matchPayloadSchema(schema: PayloadSchemaNode, value: unknown): DomainResult<true> {
  if (schema.const !== undefined && value !== schema.const) {
    return fail("payload_schema_mismatch", "payload does not match const");
  }
  if (schema.enum && !schema.enum.some((item) => item === value)) {
    return fail("payload_schema_mismatch", "payload is not in enum");
  }
  if (schema.type) {
    const actual = typeName(value);
    if (schema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail("payload_schema_mismatch", "payload is not a number");
      }
    } else if (schema.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return fail("payload_schema_mismatch", "payload is not an integer");
      }
    } else if (actual !== schema.type && !(schema.type === "object" && isPlainObject(value))) {
      return fail("payload_schema_mismatch", `payload type ${actual} != ${schema.type}`);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return fail("payload_schema_mismatch", "string shorter than minLength");
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return fail("payload_schema_mismatch", "string longer than maxLength");
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return fail("payload_schema_mismatch", "number below minimum");
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return fail("payload_schema_mismatch", "number above maximum");
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return fail("payload_schema_mismatch", "array shorter than minItems");
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return fail("payload_schema_mismatch", "array longer than maxItems");
    }
    if (schema.items) {
      for (const item of value) {
        const child = matchPayloadSchema(schema.items, item);
        if (!child.ok) return child;
      }
    }
  }
  if (isPlainObject(value) && (schema.type === "object" || schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) return fail("payload_schema_mismatch", `missing required ${key}`);
    }
    const properties = schema.properties ?? {};
    const extra = schema.additionalProperties ?? true;
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const matched = matchPayloadSchema(properties[key]!, child);
        if (!matched.ok) return matched;
      } else if (!extra) {
        return fail("payload_schema_mismatch", `unexpected property ${key}`);
      }
    }
  }
  return ok(true);
}

export function validateEventPayload(schemaJson: unknown, body: unknown): DomainResult<true> {
  const compiled = compilePayloadSchema(schemaJson);
  if (!compiled.ok) return compiled;
  return matchPayloadSchema(compiled.value, body);
}
