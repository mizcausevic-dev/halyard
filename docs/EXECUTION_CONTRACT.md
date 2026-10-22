# Halyard execution contract

This document is the contract the editor, publisher, and worker implement. The prompt asked to apply an appended execution contract. No separate contract text was attached to the run, so this file is the binding contract. Tests in `packages/core` and `apps/server` pin the behavior below.

Halyard does not run user-supplied JavaScript. Expressions are a closed set of JSON operations with step, depth, and size limits.

## Graph

A published workflow is a directed acyclic graph. Edges run from an output port to an input port. Cycles are rejected at publish time. A draft may be saved while it is still invalid, but it cannot be published and it cannot be run.

There is exactly one trigger: `manual_trigger`, `schedule_trigger`, or `webhook_trigger`. Every top-level node must be reachable from that trigger by following edges, including both outputs of a condition. A node inside an iteration body must be reachable from a body entry (a body node with no incoming body edge).

Iteration is not a back-edge. An `iterate` node names a bounded array and owns child nodes through `iterationParent`. Child edges stay inside that body. Delay nodes are not allowed in a body. Items run one at a time, in index order. The next item does not start until the current item's body result has been committed.

## What a run pins

Every run stores `workflow_version_id`. That row is immutable. Later edits change the draft. A later publish creates a new version. An in-flight run keeps the version it started with.

`Run now` on a scheduled or webhook workflow still pins the current published version. It does not move the schedule's next fire time.

## Branches

A condition evaluates one expression. The value must be a boolean. The node selects exactly one port, `true` or `false`. The other port is inactive. Nodes that are reachable only through inactive edges are `skipped` and do not run. Skip status propagates downstream.

A merge node runs only after every incoming branch is terminal (`succeeded` or `skipped`).

- `mode: "all"` (default). The output lists every incoming branch in edge-array order. A skipped branch is `{ status: "skipped", value: null }`. The merge step succeeds.
- `mode: "first_success"`. The output is the first succeeded branch in edge-array order. Skipped branches are ignored. If every branch was skipped, the merge step fails with `merge_none_succeeded`. It does not invent a value.

Edge-array order is the order of `edges` in the published document, not the order in which branches finished.

## Concurrency

`settings.parallelism` (default 4, maximum 8) is how many top-level nodes may be `queued` or `running` at once. The planner enqueues every ready node up to that cap, in node-id order when it has to choose. Independent branches therefore may execute concurrently when the worker pool has capacity. Sibling branches must not assume each other's completion order.

Iteration bodies ignore workflow parallelism and run sequentially.

Waiting on a durable delay does not consume a parallelism slot.

## Step and run states

Run states: `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`.

Step states: `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, `skipped`.

A run is `waiting` when at least one step is waiting (a delay, or an iteration with a pending item) and no step is queued or running. A run is `succeeded` only when every top-level node has a `succeeded` or `skipped` step. A failed step fails the run after in-flight steps finish. Queued and waiting steps are canceled. The failure does not reverse side effects those in-flight steps already performed.

## Delivery, retries, and crashes

The queue is at-least-once. A job is claimed with `FOR UPDATE SKIP LOCKED` and a lease. If the worker process stops, the lease expires and another worker can claim the job.

Exactly-once external side effects are not promised.

- HTTP nodes are not retried unless `retryable` is set to `true`. The default is `false`.
- A retryable HTTP failure retries on timeout, network error, HTTP 408, HTTP 429, and HTTP 5xx, up to the attempt cap, with exponential backoff. Other 4xx responses are terminal.
- If a non-retryable step was already marked `running` and the worker is reclaimed from a dead lease, Halyard does not call the destination again. The step fails with `uncertain_outcome`. The external action may have happened. It is not retried and it is not reversed.
- Pure nodes (map, transform, condition, output, merge) can be re-run after a crash because they have no outbound side effect. Their default cap is 3 attempts.
- An idempotency key is sent only when the HTTP node configures `idempotencyKeyExpr`. The header name defaults to `Idempotency-Key`. Deduplication happens only if the destination stores that key. Halyard does not pretend the header is a transaction.

Canceling a run sets the run to `canceled`, cancels queued jobs, and cancels queued or waiting steps. A step already inside an outbound call is allowed to finish. If it finishes, its output is kept, successors are not started, and the run stays `canceled`. Completed external actions are not reversed.

## Delays and schedules

A delay stores a resume job with `run_at` in the future. The worker does not sleep inside a web request. The row survives a worker restart. When a worker is running again and `run_at` has passed, the step completes and its input is passed through as its output.

Schedules use a cron expression and an IANA timezone. The worker evaluates due schedules under a transaction advisory lock and a unique key of `(schedule_id, scheduled_for)`.

Missed-run policy:

- `skip` (default). If the scheduled instant is still inside the grace window (30 seconds), it fires. If it is older, it does not fire. `next_fire_at` jumps to the next future instant. Missed ticks are not backfilled.
- `catch_up_once`. If one or more ticks were missed, exactly one run is created, marked missed, and the schedule then jumps to the next future instant.

Daylight saving follows croner 9.1.0, which Halyard wraps. The wrapper accepts a candidate only when it is strictly after the cursor. If croner returns an earlier instant, Halyard probes forward in 15-minute steps.

Observed against `America/New_York`:

- Spring forward, 2026-03-08. Local 02:30 does not exist. `30 2 * * *` resolves to 2026-03-08T07:30:00.000Z, which is 03:30 EDT. The missing local time is shifted by the DST gap. It is not dropped, and it is not fired again the next day.
- Fall back, 2026-11-01. Local 01:30 happens twice. `30 1 * * *` fires once, at the first instant, 2026-11-01T05:30:00.000Z (01:30 EDT). The next match is 2026-11-02T06:30:00.000Z. The second 01:30 that morning is not dispatched.
- During that repeated hour, croner can return the already elapsed 05:30Z instant. The wrapper rejects it. Combined with the unique `(schedule_id, scheduled_for)` key, a schedule does not dispatch twice for one local match.

Iteration is one level deep. A body node cannot itself be an `iterate` node. Delay nodes are not allowed inside a body.

A worker must be running for schedules, delays, and queued steps to move. The API accepts webhook requests and enqueues runs without executing nodes inside that request.

## Limits

| Limit | Value |
| --- | --- |
| Schema version | 1 |
| Nodes | 80 |
| Edges | 160 |
| Parallelism | 1–8, default 4 |
| Run timeout | default 5 min, max 24 h |
| Step timeout | default 30 s, max 120 s |
| Stored payload / output | 256 KiB, then truncated |
| Iteration items | node max, hard cap 50 |
| Delay | 0 ms through 7 days |
| Expression depth / steps | 16 / 2,000 |
| Webhook body | 256 KiB, `application/json` only |
| HTTP redirects | 3, rechecked at each hop |
| Product attempts | max 5 |
| Queue claim cap | 8 claims of the same job row |

## Webhooks

Authentication is `shared_secret` or `hmac_sha256`. `none` is allowed and surfaced as a warning. The shared secret and the HMAC key are credential references. The raw secret is never part of the workflow document.

The endpoint checks content type, body size, and a per-minute rate bucket before creating a run. If `eventIdPath` extracts an identifier, `(endpoint, event id)` is unique. A duplicate returns the existing run and does not start another.

## Credentials and logs

Workflow JSON stores `credentialId` only. Ciphertext lives in `credentials`, encrypted with AES-256-GCM. See the README for key configuration and rotation limits.

Secrets are redacted from stored payloads, step errors, and logs. Viewers can see run and step status. They cannot read step inputs or outputs. Operators, editors, and owners can.

## What survives a worker restart

Survives, because it is committed in PostgreSQL: drafts, published versions, credentials, run and step rows, queued jobs, future delay jobs, schedule `next_fire_at`, webhook dedup keys, rate-bucket rows.

Does not survive as in-memory state: the job lease, an open socket, a half-finished HTTP call. Those follow the crash rules above. A graceful stop stops claiming new jobs. An in-flight job that does not commit is retried only when the step's attempt policy allows it.

## Outbound HTTP

Only `http:` and `https:` URLs are requested. The worker resolves DNS, classifies every answer, and connects to the address it already checked. Redirects are followed manually, with the same checks. Private, loopback, link-local, carrier-grade NAT, and metadata addresses are blocked. A host listed in `HALYARD_SSRF_ALLOW_HOSTS` may be private. That variable is ignored when `HALYARD_ENV=production`.
