import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LIMITS, classifyDestination, isPublicAddress, type HttpCall, type HttpResult } from "@halyard/core";

export class OutboundError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboundError";
    this.code = code;
  }
}

type Pinned = { address: string; family: number };

const SENSITIVE = /authorization|cookie|api-key|secret|token/i;

export async function safeFetch(call: HttpCall, allowHosts: readonly string[] = []): Promise<HttpResult> {
  return requestWithRedirects(call, allowHosts, 0);
}

async function requestWithRedirects(call: HttpCall, allowHosts: readonly string[], redirects: number): Promise<HttpResult> {
  const classified = classifyDestination(call.url, allowHosts);
  if (!classified.ok) throw new OutboundError(classified.code, classified.message);
  const pinned = await pin(classified.url, allowHosts);
  const response = await requestOnce(classified.url, pinned, call);
  if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
    if (redirects >= LIMITS.maxRedirects) throw new OutboundError("redirect_limit", "The redirect limit was reached.");
    const nextUrl = new URL(response.location, classified.url).toString();
    const nextClass = classifyDestination(nextUrl, allowHosts);
    if (!nextClass.ok) throw new OutboundError(nextClass.code, `Redirect blocked: ${nextClass.message}`);
    const methodChanges = response.status === 303 || ((response.status === 301 || response.status === 302) && call.method !== "GET" && call.method !== "HEAD");
    const sameHost = nextClass.url.host === classified.url.host;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(call.headers)) {
      if (!sameHost && SENSITIVE.test(name)) continue;
      headers[name] = value;
    }
    return requestWithRedirects({
      ...call,
      url: nextUrl,
      method: methodChanges ? "GET" : call.method,
      headers,
      ...(methodChanges ? { body: undefined } : {}),
    }, allowHosts, redirects + 1);
  }
  let body: unknown = response.text;
  const type = response.contentType.toLowerCase();
  if (type.includes("json") && response.text) {
    try {
      body = JSON.parse(response.text);
    } catch {
      body = response.text;
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    bytes: response.bytes,
    truncated: response.truncated,
  };
}

async function pin(url: URL, allowHosts: readonly string[]): Promise<Pinned> {
  const host = url.hostname.toLowerCase();
  const allowed = allowHosts.some((entry) => entry.toLowerCase() === host);
  if (isIP(host)) {
    if (!allowed && !isPublicAddress(host)) throw new OutboundError("ssrf_blocked", `Address ${host} is not a public destination.`);
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  let records: { address: string; family: number }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new OutboundError("dns_failed", `Could not resolve ${host}.`);
  }
  if (records.length === 0) throw new OutboundError("dns_failed", `Could not resolve ${host}.`);
  if (!allowed && records.some((record) => !isPublicAddress(record.address))) {
    throw new OutboundError("ssrf_blocked", `${host} resolves to a non-public address.`);
  }
  const chosen = records[0];
  if (!chosen) throw new OutboundError("dns_failed", `Could not resolve ${host}.`);
  return { address: chosen.address, family: chosen.family };
}

function requestOnce(url: URL, pinned: Pinned, call: HttpCall): Promise<{
  status: number;
  headers: Record<string, string>;
  location?: string;
  contentType: string;
  text: string;
  bytes: number;
  truncated: boolean;
}> {
  const lib = url.protocol === "https:" ? https : http;
  const headers = { "user-agent": "Halyard/1.0", accept: "application/json, text/plain;q=0.8, */*;q=0.1", ...call.headers };
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: call.method,
      headers,
      servername: url.hostname,
      timeout: call.timeoutMs,
      lookup: (_hostname, options, callback) => {
        const done = typeof options === "function" ? options : callback;
        done(null, pinned.address, pinned.family);
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LIMITS.maxStoredOutputBytes) {
          truncated = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const rawHeaders = res.rawHeaders ?? [];
        const stored: Record<string, string> = {};
        for (let i = 0; i + 1 < rawHeaders.length && Object.keys(stored).length < 40; i += 2) {
          const name = rawHeaders[i];
          const value = rawHeaders[i + 1];
          if (!name || value === undefined) continue;
          stored[name.toLowerCase()] = value.slice(0, 512);
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: stored,
          ...(res.headers.location ? { location: String(res.headers.location) } : {}),
          contentType: String(res.headers["content-type"] ?? ""),
          text: Buffer.concat(chunks).toString("utf8"),
          bytes,
          truncated,
        });
      });
    });
    const fail = (error: Error) => reject(error.name === "AbortError" || error.message === "timeout" ? new OutboundError("http_timeout", "The outbound request timed out.") : error);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    call.signal?.addEventListener("abort", () => req.destroy(new OutboundError("http_timeout", "The outbound request was aborted.")), { once: true });
    if (call.body) req.write(call.body);
    req.end();
  });
}
