export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isObject(value) && Object.values(value).every(isJson);
}

export function object(value: unknown): JsonObject {
  if (!isObject(value) || !isJson(value)) throw new Error("Expected a JSON object.");
  return value;
}

export function objects(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array.");
  return value.map(object);
}
