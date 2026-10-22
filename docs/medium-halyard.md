# Durable Workflow Automation for People Who Have Been Burned by Retries

**Subtitle:** Halyard is a visual editor and a PostgreSQL worker. It will run the graph. It will not promise that a side effect happened once.

If you have ever operated a workflow tool, you already know the bad minute. The HTTP call reached the other system. The process died before the run was marked complete. The queue delivered the job again. The second call also succeeded. Your dashboard says the workflow ran once. The other system's ledger says it ran twice.

That minute is the whole product brief for Halyard.

Halyard is a durable workflow runner. You draw a directed graph, publish an immutable version, and a worker executes that version from PostgreSQL. A run stays pinned to the version it started on. The editor can keep changing. The in-flight run does not follow it.

The public source is [github.com/mizcausevic-dev/halyard](https://github.com/mizcausevic-dev/halyard). The live preview is [mizcausevic-dev.github.io/halyard](https://mizcausevic-dev.github.io/halyard/), published from the `gh-pages` branch. The preview can show the editor and replay the semantic runner in the browser. It does not start the worker, and it does not open outbound sockets. If a page tells you otherwise, it is the wrong page.

## What "durable" means here

Durable, in this system, means the state that matters is a row.

A worker crash does not erase a draft, a published version, a credential, a run, a step, a queued job, a future delay, a schedule's next fire time, or a webhook deduplication key. Those are committed. They are still there when a new process starts.

A worker crash does erase the things that were only in memory: the job lease, the open socket, and any HTTP call that had left the machine and had not been recorded. The new worker claims the job with `FOR UPDATE SKIP LOCKED`. If the step is already marked succeeded, it does not do the work again. If a non-retryable step was marked running and the attempt was already spent, the step fails with `uncertain_outcome`. The destination is not called again. The external action may already have happened. Halyard will not invent a compensating transaction to undo it.

That is the contract. The tests pin it, including one that sends `SIGKILL` to a worker during a delay and lets a second process finish the same run once.

## The graph is allowed to be boring

Published workflows are directed acyclic graphs. One trigger. Every node reachable from that trigger. Cycles are rejected at publish time. A draft can still be saved while it is illegal, because people save half-drawn graphs, and the publish button is the gate.

A condition evaluates one expression. The value has to be a boolean. Exactly one port runs, `true` or `false`. The other branch is skipped, and skip status walks downstream. Nodes on the inactive side do not execute.

Iteration is not a back-edge. An `iterate` node names an array and a hard cap (50 items, and the node can set a lower one). Child nodes belong to that iteration. Items run in order, one at a time. Nested iteration is rejected. A delay inside the body is rejected, because a delay has to become a row with a future `run_at`, and the body is one job on purpose.

Independent ready nodes are enqueued together, up to `settings.parallelism`. The default is 4. A node that is waiting on a delay does not hold a slot. Sibling branches must not assume each other's finish order.

A merge waits until every incoming branch has succeeded or been skipped.

- `all` lists every branch, including the skipped ones, in edge order. The merge succeeds.
- `first_success` takes the first succeeded branch in that same order. If every branch was skipped, the merge fails with `merge_none_succeeded`. It does not invent a value.

Edge order is the order of the `edges` array in the published document, not the order in which the branches happened to finish.

## Expressions, and the thing we will not run

Halyard does not execute user JavaScript. There is no `eval`, no `Function`, no plugin runtime inside the API process.

Node configuration uses a closed JSON expression language: literals, field reads, comparisons, boolean logic, arithmetic, a few string operations, `length`, `coalesce`, `if`, and object construction. Paths cannot walk `__proto__`, `prototype`, or `constructor`. Depth is capped at 16. The evaluator stops at 2,000 steps. Strings stop at 10,000 characters.

That language is enough to validate an email, compare an amount, and build a request body. It is not a place to hide a program. If a workflow needs a program, that program should be a service with its own review, its own logs, and its own deployment. The workflow should call it over HTTP.

## HTTP, retries, and the charge that applied twice

Outbound requests are `http` and `https` only. The worker resolves DNS, classifies every answer, and connects to the address it already checked. Redirects are followed by hand, at most three, and each hop is classified again. Private, loopback, link-local, and metadata addresses are blocked. A development allowlist can permit `127.0.0.1` for a local fixture. Production refuses to boot if that allowlist is set.

HTTP nodes are not retried unless you set `retryable: true`. The default is off. When retries are on, Halyard retries timeouts, network errors, HTTP 408, HTTP 429, and HTTP 5xx. Other 4xx responses stop. The cap is 5 product attempts. Backoff is exponential and bounded.

The acceptance test uses a fixture that increments a counter and then returns 500. The retry is allowed. The run succeeds. The counter is 2. That is the product working as specified. The first request was a real side effect. The 500 was a lost acknowledgement. The second request did the work again.

A second fixture stores an `Idempotency-Key`. The same shape of failure then leaves the counter at 1, and the second response is marked as a replay. Halyard only sends that header when the node configures `idempotencyKeyExpr`. The header is a request. Deduplication is the destination's job. A workflow tool that claims otherwise is selling a property it does not control.

## Delays, schedules, and the clock change

A delay writes a resume job with `run_at` in the future. The API returns. The worker does not sleep inside the request. If every worker is down, the job sits there. When a worker is up and the time has passed, the step completes and passes its input through.

Schedules are a cron expression plus an IANA timezone. One worker holds a transaction advisory lock while it scans due rows. The run insert is unique on `(schedule_id, scheduled_for)`. Two workers cannot dispatch the same instant.

Missed runs have two policies.

- `skip` fires a due instant that is still inside a 30-second grace window. Older instants are not backfilled. The next fire jumps forward.
- `catch_up_once` creates one run for a missed stretch, marks it missed, and then jumps forward.

Daylight saving follows croner 9.1.0, and the wrapper refuses any candidate that is not strictly in the future. We measured this rather than describing the textbook version.

On 8 March 2026, in `America/New_York`, local 02:30 does not exist. The expression `30 2 * * *` resolves to `2026-03-08T07:30:00.000Z`, which is 03:30 EDT. The missing local time is shifted. It is not dropped, and it is not fired again the next day for the same occurrence.

On 1 November 2026, local 01:30 happens twice. `30 1 * * *` fires once, at `2026-11-01T05:30:00.000Z` (01:30 EDT). The next match is the next day. During the repeated hour, croner can hand back the instant that already passed. The wrapper rejects it.

If you need a schedule that does something else on a clock change, this is the wrong assumption to leave implicit. The behavior is in `docs/EXECUTION_CONTRACT.md` because a schedule bug is a production bug.

## Secrets stay out of the graph

Workflow JSON stores `credentialId`. The secret lives in a `credentials` row, encrypted with AES-256-GCM. The stored form is versioned: `v1.{keyVersion}.{iv}.{tag}.{data}`. The current key is `CREDENTIAL_ENCRYPTION_KEY`, 32 bytes, base64. Older keys can be listed in `CREDENTIAL_DECRYPT_KEYS` so existing rows still open.

Rotation is a procedure, not a hope. Keep the old key available, point encryption at the new key, run `npm run rotate-credentials`, then remove the old key. A row whose key version is no longer configured cannot be decrypted. There is no recovery after that key is gone.

Import rejects secret-shaped fields, PEM private keys, and a few obvious token prefixes. Export returns the document. The acceptance test creates a credential with a known value and asserts that neither the plaintext nor the ciphertext appears in the exported JSON.

Viewers can see run and step status. They cannot read step inputs or outputs. Operators, editors, and owners can. Webhook authentication is checked before a run is created. A repeated event id returns the existing run. Rate limits and the `application/json` content type are enforced on the request, not as a suggestion in the UI.

## Three workflows, and what they are for

The seed publishes three graphs against a local fixture server.

1. **Order intake.** A webhook, a field mapping with validation, one condition, then either `POST /orders/accept` or a rejection log. Invalid orders do not call the accept endpoint.
2. **Morning digest.** A schedule at 06:00 `America/New_York`, `GET /reports/daily`, a mapping of the row count and first SKU, and a log.
3. **Amount split.** A manual trigger, a bounded iteration, a condition on `item.amount > 100`, and an approved or held output for each item.

`Run now` on a scheduled or webhook workflow pins the current published version. It does not move the next scheduled fire.

## What the GitHub Pages preview is

GitHub Pages can host the editor. It cannot host PostgreSQL, and it cannot host the worker. The live build is [mizcausevic-dev.github.io/halyard](https://mizcausevic-dev.github.io/halyard/). The `gh-pages` branch is that static build. Sign-in on that build is the preview user. Run now uses the same in-browser semantic runner the unit tests use, with HTTP stubbed. The editor says so on the canvas.

The durable claims in this article are about the API and the worker. Those claims are backed by the acceptance tests: publish and run, inspect every step, kill the worker during a wait, reject a cycle, cancel a waiting run, show a duplicated charge, show an idempotency key that holds, and prove the export has no secret.

If you are evaluating the product, run those tests. Do not evaluate it from the static preview alone.

## Run it

You need Node 22 and PostgreSQL 16.

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

The seeded sign-in and the webhook secret are development values, written in the README. The sample encryption key in `.env.example` is public. Production refuses to start if you use that key, and it refuses to start if the SSRF allowlist is set.

Deployment is three processes: the API, at least one worker, and Postgres. Schedules, delays, and queued steps do not move while every worker is down. The API can still accept a webhook and insert the run. That split is deliberate. A web request is a bad place to wait for a day-long delay.

## What this will not become

Halyard will not grow a node that runs arbitrary code inside the API process. It will not grow a checkbox that says exactly-once. It will not treat cancel as undo.

The limits are on purpose. Eighty nodes. A 256 KiB cap on stored payloads. A seven-day maximum delay. One level of iteration. Those numbers are the product, in the same way the queue semantics are the product. If a workflow needs more, it needs a different boundary, not a quieter failure.

The source, the contract, and the tests are the thing to read next: [github.com/mizcausevic-dev/halyard](https://github.com/mizcausevic-dev/halyard).

---

**Suggested Medium tags:** workflow automation, PostgreSQL, software architecture, backend, developer tools

**Meta description:** Halyard is a visual workflow editor with a PostgreSQL worker. Published graphs are acyclic, runs are pinned to a version, and HTTP retries do not pretend to be exactly-once.
