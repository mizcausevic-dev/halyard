import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

type Key = { version: number; bytes: Buffer };

function decodeKey(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw new Error(`${label} must decode to 32 bytes.`);
  return bytes;
}

export function currentKey(): Key {
  const version = Number(process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error("CREDENTIAL_ENCRYPTION_KEY_VERSION must be a positive integer.");
  return { version, bytes: decodeKey(process.env.CREDENTIAL_ENCRYPTION_KEY ?? "", "CREDENTIAL_ENCRYPTION_KEY") };
}

export function keyForVersion(version: number): Buffer {
  const current = currentKey();
  if (version === current.version) return current.bytes;
  const packed = process.env.CREDENTIAL_DECRYPT_KEYS ?? "";
  for (const entry of packed.split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator < 1) continue;
    const found = Number(entry.slice(0, separator));
    if (found === version) return decodeKey(entry.slice(separator + 1), `decrypt key ${version}`);
  }
  throw new Error(`No encryption key is configured for version ${version}.`);
}

export function encryptJson(value: unknown): { ciphertext: string; keyVersion: number } {
  const key = currentKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = ["v1", String(key.version), iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
  return { ciphertext, keyVersion: key.version };
}

export function decryptJson(ciphertext: string): unknown {
  const [prefix, versionText, iv, tag, data] = ciphertext.split(".");
  if (prefix !== "v1" || !versionText || !iv || !tag || !data) throw new Error("Credential ciphertext is not in the expected format.");
  const decipher = createDecipheriv("aes-256-gcm", keyForVersion(Number(versionText)), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

export function secretStrings(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record.value, record.password, record.username]
    .filter((entry): entry is string => typeof entry === "string" && entry.length >= 8);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, nText, rText, pText, saltText, hashText] = stored.split("$");
  if (scheme !== "scrypt" || !nText || !rText || !pText || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, { N: Number(nText), r: Number(rText), p: Number(pText) }, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
