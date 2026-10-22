import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type Charge = { applied: number; status: number };

const state = {
  charges: 0,
  idempotent: new Map<string, Charge>(),
  hits: 0,
};

function reset(): void {
  state.charges = 0;
  state.idempotent.clear();
  state.hits = 0;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__reset" && req.method === "POST") {
      reset();
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__state") {
      send(res, 200, { charges: state.charges, hits: state.hits, idempotent: state.idempotent.size });
      return;
    }
    if (url.pathname === "/reports/daily" && req.method === "GET") {
      state.hits += 1;
      send(res, 200, { rows: [{ sku: "INK-4", qty: 3, price: 12 }] });
      return;
    }
    if (url.pathname === "/orders/accept" && req.method === "POST") {
      state.hits += 1;
      const body = await readJson(req);
      send(res, 200, { accepted: true, id: "ord_1", email: body.email ?? null, amount: body.amount ?? null });
      return;
    }
    if (url.pathname === "/orders/reject" && req.method === "POST") {
      state.hits += 1;
      send(res, 200, { rejected: true });
      return;
    }
    if (url.pathname === "/charges" && req.method === "POST") {
      state.charges += 1;
      state.hits += 1;
      if (state.charges === 1) {
        send(res, 500, { applied: state.charges, error: "ambiguous failure after apply" });
        return;
      }
      send(res, 200, { applied: state.charges });
      return;
    }
    if (url.pathname === "/charges-idempotent" && req.method === "POST") {
      state.hits += 1;
      const key = String(req.headers["idempotency-key"] ?? "");
      const prior = key ? state.idempotent.get(key) : undefined;
      if (prior) {
        send(res, 200, { applied: prior.applied, replay: true }, { "idempotent-replay": "true" });
        return;
      }
      state.charges += 1;
      const applied = state.charges;
      if (key) state.idempotent.set(key, { applied, status: 500 });
      if (applied === 1) {
        send(res, 500, { applied, error: "ack lost after apply" });
        return;
      }
      send(res, 200, { applied });
      return;
    }
    if (url.pathname === "/redirect-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-report") {
      res.writeHead(302, { location: "/reports/daily" });
      res.end();
      return;
    }
    send(res, 404, { error: "missing fixture" });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : "fixture error" });
  }
});

const port = Number(process.env.FIXTURE_PORT ?? 4099);
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ message: "halyard fixture listening", port }));
});
