#!/usr/bin/env node
/* global console, process */

const schedules = {
  ingest: { hour: 22, weekday: null },
  refine: { hour: 23, weekday: 0 },
};

const [job, explicitNow] = process.argv.slice(2);
const schedule = schedules[job];
if (!schedule) {
  console.error("unknown scheduled job");
  process.exit(64);
}

const now = explicitNow === undefined ? new Date() : new Date(explicitNow);
if (Number.isNaN(now.getTime())) {
  console.error("invalid schedule time");
  process.exit(64);
}

const due = new Date(now);
due.setHours(schedule.hour, 0, 0, 0);
if (schedule.weekday === null) {
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1);
} else {
  const daysSinceScheduledWeekday = (due.getDay() - schedule.weekday + 7) % 7;
  due.setDate(due.getDate() - daysSinceScheduledWeekday);
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 7);
}

const year = String(due.getFullYear()).padStart(4, "0");
const month = String(due.getMonth() + 1).padStart(2, "0");
const day = String(due.getDate()).padStart(2, "0");
process.stdout.write(`${job}:${year}-${month}-${day}\n`);
