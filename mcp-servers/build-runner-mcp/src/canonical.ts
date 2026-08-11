import { createHash } from "node:crypto";

export const SHA256_RE = /^[a-f0-9]{64}$/;

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("canonical JSON only accepts finite numbers other than -0");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A normal object would treat the JSON key `__proto__` as a prototype
    // setter and silently omit it from the canonical payload.  Use a
    // null-prototype dictionary so every own JSON key is hashed verbatim.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        throw new TypeError(`canonical JSON rejects undefined at key ${key}`);
      }
      out[key] = normalize(item);
    }
    return out;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function domainHash(domain: string, value: string | Buffer): string {
  if (!/^[a-z0-9][a-z0-9./_-]{0,127}$/.test(domain)) {
    throw new TypeError("invalid hash domain");
  }
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex");
}

export function domainHashJson(domain: string, value: unknown): string {
  return domainHash(domain, canonicalJson(value));
}

export function assertSha256(value: string, label: string): string {
  if (!SHA256_RE.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

export function shortHash(value: string): string {
  return assertSha256(value, "hash").slice(0, 12);
}
