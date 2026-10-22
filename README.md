# Halyard

Halyard is a directed workflow runner. You edit a graph, publish an immutable version, and a PostgreSQL worker executes that version. A run stays pinned to the version it started with.

The prompt asked for an appended execution contract. None was attached, so [docs/EXECUTION_CONTRACT.md](docs/EXECUTION_CONTRACT.md) is the contract the code and tests implement.

Halyard does not run user JavaScript. Node configuration uses a closed JSON expression language. HTTP is at-least-once. Canceling a run does not reverse a call that already completed.

## Local development

Requirements: Node 22, PostgreSQL 16.

```bash
cp .env.example .env
# create the role and database if you are not using docker compose
#   CREATE USER halyard WITH PASSWORD 'halyard' SUPERUSER;
#   CREATE DATABASE halyard OWNER halyard;
npm install
npm run migrate
npm run seed
npm run dev
```

`npm run dev` starts the fixture server on port 4099, the API on port 8787, one worker, and the editor at http://127.0.0.1:5173.

Seeded sign-in: `ada@halyard.dev` / `halyard-dev-password`. The webhook shared secret is `hook-secret`. Both are development values.

Docker Compose only starts Postgres:

```bash
docker compose up -d
```

## Web and worker deployment

Run three processes against one database.

1. Apply SQL in `migrations/` with `npm run migrate`.
2. Start the API: `node apps/server/dist/main.js` after `npm run build`, or `npm run api` under tsx. Set `HALYARD_STATIC_DIR` to `apps/web/dist` if the API should serve the built editor.
3. Start at least one worker: `npm run worker`. Schedules, delays, and queued steps do not move while every worker is down. The API can still accept a webhook and insert the run.
4. Put TLS in front of the API. Set `HALYARD_ENV=production`, a unique `CREDENTIAL_ENCRYPTION_KEY`, and `HALYARD_ORIGIN` to the browser origin. Do not set `HALYARD_SSRF_ALLOW_HOSTS`. Production refuses to boot if that allowlist is present or if the sample key from `.env.example` is used.

Build artifacts:

```bash
npm run build          # server bundle and the editor
npm run build:preview  # static editor for GitHub Pages
```

The `gh-pages` branch is the static preview at <https://mizcausevic-dev.github.io/halyard/>. It is the output of `npm run build:preview` at the branch root, plus `.nojekyll`. Pages publishes that branch from the `/` folder. That host cannot run Postgres or the worker. The preview signs in as Ada and runs the same semantic functions in the browser, with outbound HTTP stubbed. The banner in the editor says so.

## Scheduler requirements

The worker holds transaction-scoped advisory lock `84218421` while scanning `schedules`. A row due at `next_fire_at` is locked with `FOR UPDATE`. The run insert uses a unique key of `(schedule_id, scheduled_for)` and an idempotency key `schedule:{id}:{instant}`.

- `skip`: a due instant inside 30 seconds fires. An older instant does not. `next_fire_at` jumps to the next future match. Missed ticks are not backfilled.
- `catch_up_once`: if any tick was missed, exactly one run is created and marked `missed`, then the schedule jumps forward.

Cron uses an IANA timezone through croner 9.1.0. The wrapper rejects a candidate that is not strictly after the cursor, because croner can return an already elapsed instant during a fall-back hour. Observed behavior is in the execution contract, including the 2026-03-08 spring-forward shift and the single 2026-11-01 fall-back fire.

A second worker that loses the advisory lock does not scan. The unique key stops a double insert if two transactions ever both believe they should fire.

## Credential encryption

Ciphertext is AES-256-GCM. The stored form is `v1.{keyVersion}.{iv}.{tag}.{data}`, each binary part base64url. The key is `CREDENTIAL_ENCRYPTION_KEY`, 32 bytes, base64. `CREDENTIAL_ENCRYPTION_KEY_VERSION` is an integer.

Previous keys live in `CREDENTIAL_DECRYPT_KEYS` as `version:base64` pairs. Decryption selects the key that matches the version on the row. Encryption always uses the current version.

Rotation: keep the old key in `CREDENTIAL_DECRYPT_KEYS`, set the new current key and version, run `npm run rotate-credentials`, then remove the old key. A row whose key version is no longer configured cannot be decrypted. There is no recovery after the old key is discarded. Rotation rewrites ciphertext. It does not change workflow documents, because those store `credentialId` only.

Workflow import rejects secret-shaped fields, PEM private keys, and common token prefixes. Export of a published workflow returns the document. It does not return ciphertext.

## Execution limits

| Limit | Value |
| --- | --- |
| Schema | 1 |
| Nodes / edges | 80 / 160 |
| Parallelism | 1–8, default 4 |
| Run timeout | default 5 minutes, max 24 hours |
| Step timeout | default 30 seconds, max 120 seconds |
| Stored JSON | 256 KiB, then truncated |
| Iteration | hard cap 50 items, one level, sequential |
| Delay | up to 7 days, stored as a future job |
| Expressions | depth 16, 2,000 steps |
| Webhook body | 256 KiB, `application/json` |
| HTTP redirects | 3, rechecked each hop |
| Product attempts | max 5 |
| Same job row claims | max 8 |

Independent ready nodes are enqueued together up to `settings.parallelism`. Waiting on a delay does not consume a slot. Iteration bodies run one node at a time, and items run in order.

## What survives a worker restart

Survives, because it is a committed row: drafts, published versions, credentials, runs, steps, queued jobs, future delay jobs, `next_fire_at`, webhook dedup keys, rate buckets.

Does not survive as memory: the job lease, an open socket, a half-finished HTTP call. A lease that expires is claimed again. If the step is already `succeeded`, the new claim does not repeat the work. If a non-retryable step was `running` and the attempt cap is already spent, the step fails `uncertain_outcome` and the destination is not called again. The external action may have happened. It is not reversed.

HTTP is not retried unless the node sets `retryable: true`. That retries timeout, network errors, 408, 429, and 5xx. Other 4xx responses stop. A retry can repeat a side effect. `Idempotency-Key` is sent only when the node configures `idempotencyKeyExpr`. Deduplication is the destination's job.

Cancel sets the run to `canceled`, cancels queued jobs, and cancels queued or waiting steps. A step already inside an outbound call may finish. Successors do not start. Completed external actions stay completed.

## Examples

Seed publishes three workflows. The fixture server is deterministic.

1. Order intake. Webhook, field mapping and validation, one condition branch, then `POST /orders/accept` or a rejection output.
2. Morning digest. Schedule at 06:00 `America/New_York`, `GET /reports/daily`, map the row count and first SKU, log it.
3. Amount split. Manual trigger, iterate at most 10 items, condition `item.amount > 100`, approved or held output.

`Run now` on a scheduled or webhook workflow pins the current published version and does not move the next fire time.

## Tests

```bash
npm test          # semantic tests and Postgres acceptance tests
```

The acceptance file creates, publishes, and runs a workflow; reads step inputs and outputs; kills a worker during a delay and finishes the run with a new process; rejects a cycle at publish; cancels a waiting run; shows a retry that applies a charge twice and an idempotency key that does not; and checks that export JSON has no secret. It also covers webhook auth, dedup, content type, rate limit, missed schedules, viewer payload hiding, and a redirect to the metadata address.

## Known limitations

- Delivery is at-least-once. External side effects are not exactly-once.
- Cancel is not a compensation transaction.
- Delay nodes cannot sit inside an iteration body. Nested iteration is rejected.
- Credential headers are applied on top-level HTTP nodes. An HTTP node inside an iteration body does not receive a resolved credential header.
- The in-memory runner used by unit tests and the GitHub Pages preview advances a delay immediately. Durable waiting is the worker's resume job.
- SSRF allowlisting is a development switch for the fixture. Production refuses the variable.
- GitHub Pages does not execute the worker.
- One organization, one Postgres. This is not a multi-region queue.
- Login passwords use scrypt. There is no email delivery for member invites. The temporary password is returned once to the owner.
- The sample key in `.env.example` is public. It is for local development only.
