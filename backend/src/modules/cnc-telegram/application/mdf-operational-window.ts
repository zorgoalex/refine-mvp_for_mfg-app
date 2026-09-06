/** Date-only arithmetic: business-date timezone conversion stays in PostgreSQL. */
export function mdfOperationalMonthStart(workdayTo: string): string {
  const date = new Date(`${workdayTo}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString().slice(0, 10);
}
