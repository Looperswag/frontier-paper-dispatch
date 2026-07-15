export const SHANGHAI_TIME_ZONE = "Asia/Shanghai" as const;

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
  day: "2-digit",
  month: "2-digit",
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
});

function requireValidDate(date: Date): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid date returned by clock");
  }
}

export function shanghaiDateKey(date: Date = new Date()): string {
  requireValidDate(date);
  const parts = Object.fromEntries(
    shanghaiDateFormatter
      .formatToParts(date)
      .filter(({ type }) => type === "year" || type === "month" || type === "day")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface ShanghaiRunTime {
  readonly date: string;
  readonly startedAt: string;
  readonly timeZone: typeof SHANGHAI_TIME_ZONE;
}

export function lockShanghaiRunTime(clock: () => Date = () => new Date()): ShanghaiRunTime {
  const instant = clock();
  requireValidDate(instant);
  return Object.freeze({
    date: shanghaiDateKey(instant),
    startedAt: instant.toISOString(),
    timeZone: SHANGHAI_TIME_ZONE,
  });
}
