export const SHANGHAI_TIME_ZONE = "Asia/Shanghai" as const;

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
  day: "2-digit",
  month: "2-digit",
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
});

export function shanghaiDateKey(date: Date = new Date()): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid date");
  }
  const parts = Object.fromEntries(
    shanghaiDateFormatter
      .formatToParts(date)
      .filter(({ type }) => type === "year" || type === "month" || type === "day")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
