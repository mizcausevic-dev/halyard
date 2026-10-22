const SECRET_KEY =
  /^(password|passwd|secret|token|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|set-cookie|signature)$/i;
const SECRET_HEADER = /authorization|api[-_]?key|secret|token|cookie|signature/i;
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function containsPem(value: string): boolean {
  return PEM.test(value);
}

export function containsTokenMaterial(value: string): boolean {
  return /(?:sk_live_|sk_test_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{8,}/.test(value) || containsPem(value);
}

export function redact(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 24) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets, depth + 1));
  if (typeof value === "string") return scrubString(value, secrets);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && "value" in record && SECRET_HEADER.test(record.name)) {
    return { ...mapRecord(record, secrets, depth), value: "[redacted]" };
  }
  return mapRecord(record, secrets, depth);
}

function mapRecord(record: Record<string, unknown>, secrets: readonly string[], depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redact(entry, secrets, depth + 1);
  }
  return out;
}

function scrubString(value: string, secrets: readonly string[]): string {
  let next = value;
  for (const secret of secrets) {
    if (secret.length < 8 || !next.includes(secret)) continue;
    next = next.split(secret).join("[redacted]");
  }
  if (containsPem(next) || containsTokenMaterial(next)) return "[redacted]";
  return next;
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").length;
}

export function limitStored(value: unknown, maxBytes: number): { value: unknown; truncated: boolean; bytes: number } {
  const encoded = JSON.stringify(value) ?? "null";
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes <= maxBytes) return { value, truncated: false, bytes };
  const preview = encoded.slice(0, Math.min(encoded.length, 2_000));
  return {
    truncated: true,
    bytes,
    value: { truncated: true, bytes, preview },
  };
}
