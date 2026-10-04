/**
 * Runs a migration file the way psql does for `apply-migrations.sh`: its transaction (up to the first COMMIT) as
 * one command, every statement after it on its own — `CREATE INDEX CONCURRENTLY` and `VALIDATE CONSTRAINT` are
 * refused inside a multi-statement command.
 */
export async function runMigrationFile(query: (sql: string) => Promise<unknown>, sql: string): Promise<void> {
  const end = sql.indexOf('\nCOMMIT;');
  if (end < 0) { await query(sql); return; }
  await query(sql.slice(0, end + '\nCOMMIT;'.length));
  const rest = sql.slice(end + '\nCOMMIT;'.length).split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  for (const statement of rest.split(';').map((part) => part.trim()).filter(Boolean)) await query(statement);
}
