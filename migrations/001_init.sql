CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  published_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version_number int NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  schema_version int NOT NULL,
  document jsonb NOT NULL,
  revision int NOT NULL DEFAULT 1,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version_number)
);

CREATE UNIQUE INDEX workflow_versions_one_draft ON workflow_versions (workflow_id) WHERE status = 'draft';

ALTER TABLE workflows
  ADD CONSTRAINT workflows_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES workflow_versions (id);

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bearer', 'header', 'basic', 'hmac', 'shared_secret')),
  header_name text,
  ciphertext text NOT NULL,
  key_version int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  auth_mode text NOT NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  secret_header text,
  signature_header text,
  event_id_path text,
  rate_limit_per_minute int NOT NULL DEFAULT 60,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
  cron text NOT NULL,
  timezone text NOT NULL,
  missed_policy text NOT NULL CHECK (missed_policy IN ('skip', 'catch_up_once')),
  next_fire_at timestamptz,
  last_fired_for timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id),
  schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  scheduled_for timestamptz,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled')),
  trigger_type text NOT NULL,
  trigger_payload jsonb NOT NULL,
  error jsonb,
  idempotency_key text,
  cancel_requested_at timestamptz,
  deadline_at timestamptz NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX runs_schedule_fire_unique
  ON runs (schedule_id, scheduled_for)
  WHERE schedule_id IS NOT NULL AND scheduled_for IS NOT NULL;

CREATE UNIQUE INDEX runs_idempotency_unique
  ON runs (workflow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX runs_workspace_created_idx ON runs (workspace_id, created_at DESC);

CREATE TABLE steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'skipped')),
  attempt int NOT NULL DEFAULT 0,
  input jsonb,
  output jsonb,
  error jsonb,
  selected_port text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  wake_at timestamptz,
  UNIQUE (run_id, node_id)
);

CREATE INDEX steps_run_idx ON steps (run_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES steps(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('execute_step', 'resume_delay', 'iterate_item')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE UNIQUE INDEX jobs_one_active_step
  ON jobs (step_id, kind)
  WHERE status IN ('queued', 'running') AND step_id IS NOT NULL;

CREATE INDEX jobs_claim_idx ON jobs (run_at, created_at, id) WHERE status = 'queued';

CREATE TABLE run_logs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES steps(id) ON DELETE CASCADE,
  level text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_buckets (
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);
