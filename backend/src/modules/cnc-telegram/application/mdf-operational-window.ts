/** Date-only arithmetic: business-date timezone conversion stays in PostgreSQL. */
export function mdfOperationalMonthStart(workdayTo: string): string {
  const date = new Date(`${workdayTo}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString().slice(0, 10);
}

export function mdfOperationalTwoMonthStart(workdayTo: string): string {
  const date = new Date(`${workdayTo}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 2);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}
