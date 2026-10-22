import ipaddr from "ipaddr.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata.internal"]);

export type Destination =
  | { ok: true; url: URL }
  | { ok: false; code: string; message: string };

export function addressRange(ip: string): string | null {
  if (!ipaddr.isValid(ip)) return null;
  const parsed = ipaddr.parse(ip);
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range();
    return v6.range();
  }
  return parsed.range();
}

export function isPublicAddress(ip: string): boolean {
  return addressRange(ip) === "unicast";
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host)) return true;
  return host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

export function classifyDestination(raw: string, allowHosts: readonly string[] = []): Destination {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "url_invalid", message: "The URL could not be parsed." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "url_protocol", message: "Only http and https URLs are allowed." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "url_userinfo", message: "URLs must not include a username or password." };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, code: "url_host", message: "The URL is missing a host." };
  const allowed = allowHosts.some((entry) => entry.toLowerCase() === host);
  if (!allowed && isBlockedHostname(host)) {
    return { ok: false, code: "ssrf_blocked", message: `Host ${host} is blocked.` };
  }
  if (!allowed && ipaddr.isValid(host) && !isPublicAddress(host)) {
    return { ok: false, code: "ssrf_blocked", message: `Address ${host} is not a public destination.` };
  }
  if (/^\d+$/.test(host)) {
    return { ok: false, code: "ssrf_blocked", message: "Decimal IP hosts are blocked." };
  }
  return { ok: true, url };
}

export function privateUrlWarning(raw: string): string | null {
  const classified = classifyDestination(raw);
  if (!classified.ok && classified.code === "ssrf_blocked") {
    return "This URL points at a private, local, or metadata destination. The worker will refuse it unless the host is on the development allowlist.";
  }
  try {
    const url = new URL(raw);
    if (isBlockedHostname(url.hostname)) {
      return "This hostname is treated as a local destination and will be blocked in production.";
    }
  } catch {
    return null;
  }
  return null;
}
