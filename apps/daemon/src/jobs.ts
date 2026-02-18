import type { DbHandle } from "./db";

export type JobRow = {
  id: number;
  name: string;
  enabled: number;
  schedule_json: string | null;
  capabilities_json: string | null;
  definition_json: string | null;
};

export type JobCreateInput = {
  name: string;
  enabled?: boolean;
  schedule?: Record<string, unknown>;
  capabilities?: string[];
  definition?: Record<string, unknown>;
};

export function listJobs(db: DbHandle, limit = 100) {
  const stmt = db.prepare(
    `SELECT id, name, enabled, schedule_json, capabilities_json, definition_json
     FROM jobs
     ORDER BY id DESC
     LIMIT ?`
  );
  return stmt.all(limit).map((row) => ({
    ...row,
    schedule: row.schedule_json ? JSON.parse(String(row.schedule_json)) : null,
    schedule_summary: summarizeSchedule(
      row.schedule_json ? JSON.parse(String(row.schedule_json)) : null
    ),
    capabilities: row.capabilities_json
      ? JSON.parse(String(row.capabilities_json))
      : null,
    definition: row.definition_json
      ? JSON.parse(String(row.definition_json))
      : null
  }));
}

export function getJobById(db: DbHandle, id: number) {
  const stmt = db.prepare(
    `SELECT id, name, enabled, schedule_json, capabilities_json, definition_json
     FROM jobs
     WHERE id = ?`
  );
  const row = stmt.get(id) as JobRow | undefined;
  if (!row) return null;
  return {
    ...row,
    schedule: row.schedule_json ? JSON.parse(String(row.schedule_json)) : null,
    schedule_summary: summarizeSchedule(
      row.schedule_json ? JSON.parse(String(row.schedule_json)) : null
    ),
    capabilities: row.capabilities_json
      ? JSON.parse(String(row.capabilities_json))
      : null,
    definition: row.definition_json
      ? JSON.parse(String(row.definition_json))
      : null
  };
}

export function getJobByName(db: DbHandle, name: string) {
  const stmt = db.prepare(
    `SELECT id, name, enabled, schedule_json, capabilities_json, definition_json
     FROM jobs
     WHERE name = ?`
  );
  const row = stmt.get(name) as JobRow | undefined;
  if (!row) return null;
  return {
    ...row,
    schedule: row.schedule_json ? JSON.parse(String(row.schedule_json)) : null,
    schedule_summary: summarizeSchedule(
      row.schedule_json ? JSON.parse(String(row.schedule_json)) : null
    ),
    capabilities: row.capabilities_json
      ? JSON.parse(String(row.capabilities_json))
      : null,
    definition: row.definition_json
      ? JSON.parse(String(row.definition_json))
      : null
  };
}

export function createJob(db: DbHandle, input: JobCreateInput) {
  const stmt = db.prepare(
    `INSERT INTO jobs (name, enabled, schedule_json, capabilities_json, definition_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    input.name,
    input.enabled === false ? 0 : 1,
    input.schedule ? JSON.stringify(input.schedule) : null,
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.definition ? JSON.stringify(input.definition) : null
  );
  return Number(info.lastInsertRowid);
}

export function listRunnableJobs(db: DbHandle, now: Date) {
  const stmt = db.prepare(
    `SELECT j.id, j.name, j.enabled, j.schedule_json, MAX(r.ts) AS last_run
     FROM jobs j
     LEFT JOIN job_runs r ON r.job_id = j.id
     WHERE j.enabled = 1
     GROUP BY j.id`
  );

  const rows = stmt.all() as Array<{
    id: number;
    name: string;
    enabled: number;
    schedule_json: string | null;
    last_run: string | null;
  }>;

  const runnable: Array<{
    id: number;
    name: string;
    schedule: Record<string, unknown> | null;
  }> = [];

  for (const row of rows) {
    const schedule = row.schedule_json
      ? (JSON.parse(String(row.schedule_json)) as Record<string, unknown>)
      : null;
    if (!schedule) continue;

    const lastRun = row.last_run ? Date.parse(row.last_run) : null;
    if (shouldRun(schedule, now, lastRun)) {
      runnable.push({ id: row.id, name: row.name, schedule });
    }
  }

  return runnable;
}

function shouldRun(
  schedule: Record<string, unknown>,
  now: Date,
  lastRun: number | null
) {
  const intervalSeconds = Number(schedule.interval_seconds ?? 0);
  if (Number.isFinite(intervalSeconds) && intervalSeconds > 0) {
    const nowMs = now.getTime();
    return lastRun === null || nowMs - lastRun >= intervalSeconds * 1000;
  }

  const cron = typeof schedule.cron === "string" ? schedule.cron : null;
  if (!cron) return false;

  const timezone = typeof schedule.timezone === "string" ? schedule.timezone : "local";
  const parts = getDateParts(now, timezone);
  if (!cronMatches(cron, parts)) return false;

  if (lastRun === null) return true;
  const last = getDateParts(new Date(lastRun), timezone);
  return (
    parts.year !== last.year ||
    parts.month !== last.month ||
    parts.day !== last.day ||
    parts.hour !== last.hour ||
    parts.minute !== last.minute
  );
}

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
};

function getDateParts(now: Date, timezone: string): DateParts {
  if (timezone.toLowerCase() === "utc") {
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      dow: now.getUTCDay()
    };
  }

  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    dow: now.getDay()
  };
}

function cronMatches(cron: string, parts: DateParts) {
  const tokens = cron.trim().split(/\s+/);
  if (tokens.length !== 5) return false;
  const [minField, hourField, dayField, monthField, dowField] = tokens;

  return (
    fieldMatches(minField, parts.minute, 0, 59) &&
    fieldMatches(hourField, parts.hour, 0, 23) &&
    fieldMatches(dayField, parts.day, 1, 31) &&
    fieldMatches(monthField, parts.month, 1, 12) &&
    fieldMatchesDow(dowField, parts.dow)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number) {
  const tokens = field.split(",");
  for (const token of tokens) {
    if (token === "*") return true;
    if (token.startsWith("*/")) {
      const step = Number(token.slice(2));
      if (Number.isFinite(step) && step > 0 && (value - min) % step === 0) {
        return true;
      }
      continue;
    }
    const [rangePart, stepPart] = token.split("/");
    const [startStr, endStr] = rangePart.split("-");
    const start = Number(startStr);
    const end = endStr ? Number(endStr) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (value < start || value > end) continue;
    if (!stepPart) return true;
    const step = Number(stepPart);
    if (Number.isFinite(step) && step > 0 && (value - start) % step === 0) {
      return true;
    }
  }
  return false;
}

function fieldMatchesDow(field: string, value: number) {
  if (value === 0) value = 7;
  const matches = fieldMatches(field, value, 1, 7);
  if (matches) return true;
  return fieldMatches(field, 0, 0, 6);
}

export function summarizeSchedule(schedule: Record<string, unknown> | null) {
  if (!schedule) return "unscheduled";
  const intervalSeconds = Number(schedule.interval_seconds ?? 0);
  if (Number.isFinite(intervalSeconds) && intervalSeconds > 0) {
    return `every ${intervalSeconds}s`;
  }
  const cron = typeof schedule.cron === "string" ? schedule.cron : null;
  const timezone = typeof schedule.timezone === "string" ? schedule.timezone : "local";
  if (cron) return summarizeCron(cron, timezone);
  return "unscheduled";
}

function summarizeCron(cron: string, timezone: string) {
  const tokens = cron.trim().split(/\s+/);
  if (tokens.length !== 5) return `cron ${cron} (${timezone})`;
  const [minField, hourField, dayField, monthField, dowField] = tokens;
  const tzLabel = timezoneLabel(timezone);

  if (minField === "*" && hourField === "*" && dayField === "*" && monthField === "*" && dowField === "*") {
    return `every minute (${tzLabel})`;
  }

  const minuteStep = parseStep(minField);
  if (minuteStep !== null && hourField === "*" && dayField === "*" && monthField === "*" && dowField === "*") {
    return `every ${minuteStep} minute${minuteStep === 1 ? "" : "s"} (${tzLabel})`;
  }

  const minute = parseFixed(minField, 0, 59);
  const hour = parseFixed(hourField, 0, 23);
  const hourStep = parseStep(hourField);

  if (minute !== null && hourField === "*" && dayField === "*" && monthField === "*" && dowField === "*") {
    return `every hour ${formatHourlyAnchor(minute)} (${tzLabel})`;
  }

  if (minute !== null && hourStep !== null && dayField === "*" && monthField === "*" && dowField === "*") {
    return `every ${hourStep} hour${hourStep === 1 ? "" : "s"} ${formatHourlyAnchor(minute)} (${tzLabel})`;
  }

  if (minute !== null && hour !== null && dayField === "*" && monthField === "*" && dowField === "*") {
    return `every day at ${formatTime(hour, minute)} (${tzLabel})`;
  }

  const dowList = parseDowList(dowField);
  if (
    minute !== null &&
    hour !== null &&
    dayField === "*" &&
    monthField === "*" &&
    dowList !== null &&
    dowList.length > 0
  ) {
    return `every ${dowList.map(formatDow).join(", ")} at ${formatTime(hour, minute)} (${tzLabel})`;
  }

  return `cron ${cron} (${timezone})`;
}

function timezoneLabel(timezone: string) {
  return timezone.toLowerCase() === "local" ? "local time" : timezone;
}

function parseFixed(field: string, min: number, max: number) {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function parseStep(field: string) {
  if (!field.startsWith("*/")) return null;
  const value = Number(field.slice(2));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseDowList(field: string) {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const tokens = field.split(",");
  const days: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return null;
    const raw = Number(token);
    if (!Number.isFinite(raw) || raw < 0 || raw > 7) return null;
    days.push(raw === 7 ? 0 : raw);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function formatDow(value: number) {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[value] ?? `day ${value}`;
}

function formatMinute(minute: number) {
  return `:${String(minute).padStart(2, "0")}`;
}

function formatHourlyAnchor(minute: number) {
  if (minute === 0) return "on the hour";
  return `at ${formatMinute(minute)}`;
}

function formatTime(hour24: number, minute: number) {
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

export function setJobEnabled(db: DbHandle, id: number, enabled: boolean) {
  const stmt = db.prepare(
    `UPDATE jobs SET enabled = ? WHERE id = ?`
  );
  const info = stmt.run(enabled ? 1 : 0, id);
  return info.changes > 0;
}

export function recordJobRun(
  db: DbHandle,
  jobId: number,
  status: "queued" | "running" | "completed" | "failed",
  output?: Record<string, unknown>
) {
  const stmt = db.prepare(
    `INSERT INTO job_runs (job_id, ts, status, output_json, error)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    jobId,
    new Date().toISOString(),
    status,
    output ? JSON.stringify(output) : null,
    null
  );
  return Number(info.lastInsertRowid);
}
