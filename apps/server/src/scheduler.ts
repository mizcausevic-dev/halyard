import { decideMissedRun, LIMITS, type WorkflowDocument } from "@halyard/core";
import { getPool, withTx } from "./db.js";
import { insertRun } from "./engine.js";
import { workspaceSecrets } from "./secrets.js";

type ScheduleRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  cron: string;
  timezone: string;
  missed_policy: "skip" | "catch_up_once";
  next_fire_at: Date;
};

export async function fireDueSchedules(now = new Date()): Promise<number> {
  return withTx(async (client) => {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(84218421) AS locked");
    if (!lock.rows[0]?.locked) return 0;
    const due = await client.query<ScheduleRow>(
      `SELECT id, workspace_id, workflow_id, cron, timezone, missed_policy, next_fire_at
       FROM schedules
       WHERE enabled = true AND next_fire_at IS NOT NULL AND next_fire_at <= $1
       ORDER BY next_fire_at
       FOR UPDATE`,
      [now],
    );
    let fired = 0;
    for (const schedule of due.rows) {
      const decision = decideMissedRun({
        cron: schedule.cron,
        timezone: schedule.timezone,
        policy: schedule.missed_policy,
        dueAt: new Date(schedule.next_fire_at),
        now,
        graceMs: LIMITS.schedulerGraceMs,
      });
      if (decision.fire && decision.scheduledFor) {
        const published = await client.query<{ id: string; document: WorkflowDocument; workflow_id: string }>(
          `SELECT v.id, v.document, w.id AS workflow_id
           FROM workflows w
           JOIN workflow_versions v ON v.id = w.published_version_id
           WHERE w.id = $1 AND v.status = 'published'`,
          [schedule.workflow_id],
        );
        const version = published.rows[0];
        if (version) {
          const secrets = await workspaceSecrets(schedule.workspace_id);
          const result = await insertRun(client, {
            workspaceId: schedule.workspace_id,
            workflowId: schedule.workflow_id,
            versionId: version.id,
            document: version.document,
            triggerType: "schedule",
            triggerOutput: {
              kind: "schedule",
              at: now.toISOString(),
              scheduledFor: decision.scheduledFor.toISOString(),
              timezone: schedule.timezone,
              cron: schedule.cron,
              missed: decision.missed,
              body: {},
            },
            scheduleId: schedule.id,
            scheduledFor: decision.scheduledFor,
            idempotencyKey: `schedule:${schedule.id}:${decision.scheduledFor.toISOString()}`,
            secrets,
          });
          if (!result.duplicate) fired += 1;
        }
      }
      await client.query("UPDATE schedules SET next_fire_at = $2, last_fired_for = CASE WHEN $3::timestamptz IS NULL THEN last_fired_for ELSE $3 END, updated_at = now() WHERE id = $1", [
        schedule.id,
        decision.following,
        decision.fire ? decision.scheduledFor : null,
      ]);
    }
    return fired;
  });
}

export async function schedulesDue(limit = 20): Promise<unknown[]> {
  const result = await getPool().query(
    `SELECT s.id, s.workflow_id, w.name AS workflow_name, s.cron, s.timezone, s.missed_policy, s.next_fire_at, s.enabled
     FROM schedules s JOIN workflows w ON w.id = s.workflow_id
     WHERE s.enabled = true
     ORDER BY s.next_fire_at NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}
