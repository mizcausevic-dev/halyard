import { Cron } from "croner";

const PROBE_STEP_MS = 15 * 60 * 1000;
const PROBE_LIMIT = 48;

export function assertTimezone(timezone: string): void {
  if (!timezone || timezone.length > 80) throw new Error("Timezone is required.");
  Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
}

export function assertCron(cron: string, timezone: string): void {
  assertTimezone(timezone);
  try {
    const parsed = new Cron(cron, { timezone });
    if (!parsed.nextRun(new Date(0))) throw new Error("Cron expression has no upcoming match.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron expression.";
    throw new Error(message);
  }
}

export function nextFireAfter(cron: string, timezone: string, after: Date): Date {
  assertTimezone(timezone);
  let probe = new Date(after.getTime());
  for (let attempt = 0; attempt < PROBE_LIMIT; attempt += 1) {
    let candidate: Date | null;
    try {
      candidate = new Cron(cron, { timezone }).nextRun(probe);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid cron expression.";
      throw new Error(message);
    }
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
    probe = new Date(probe.getTime() + PROBE_STEP_MS);
  }
  throw new Error("No future schedule instant could be resolved.");
}

export type MissedDecision = {
  fire: boolean;
  scheduledFor: Date | null;
  following: Date;
  missed: boolean;
};

export function decideMissedRun(args: {
  cron: string;
  timezone: string;
  policy: "skip" | "catch_up_once";
  dueAt: Date;
  now: Date;
  graceMs: number;
}): MissedDecision {
  const following = nextFireAfter(args.cron, args.timezone, args.now);
  const lateness = args.now.getTime() - args.dueAt.getTime();
  if (lateness < 0) {
    return { fire: false, scheduledFor: null, following: args.dueAt, missed: false };
  }
  if (args.policy === "catch_up_once") {
    return { fire: true, scheduledFor: args.dueAt, following, missed: lateness > args.graceMs };
  }
  if (lateness <= args.graceMs) {
    return { fire: true, scheduledFor: args.dueAt, following: nextFireAfter(args.cron, args.timezone, args.dueAt), missed: false };
  }
  return { fire: false, scheduledFor: null, following, missed: true };
}
