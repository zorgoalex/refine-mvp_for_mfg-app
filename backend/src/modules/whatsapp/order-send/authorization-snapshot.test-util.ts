/**
 * The authorization snapshot of migration 248 for an isolated test schema. The migration and the code name the
 * function and its tables in `public`; a test schema holds its own copies, so the migration is applied with
 * `public.` pointing at the schema and queries of the code are routed to the schema's function.
 * `migration248` — the text of `248_authorization_snapshot.sql` (read by the test).
 */
export async function installAuthorizationSnapshot(query: (sql: string) => Promise<unknown>, schema: string, migration248: string): Promise<void> {
  // Columns of the real tables the snapshot reads and the minimal test tables lack.
  await query(`ALTER TABLE "${schema}".roles ADD COLUMN IF NOT EXISTS role_code text;
    UPDATE "${schema}".roles SET role_code = CASE role_id WHEN 1 THEN 'admin' WHEN 10 THEN 'manager' ELSE 'role_' || role_id END WHERE role_code IS NULL;
    ALTER TABLE "${schema}".users ADD COLUMN IF NOT EXISTS is_service_account boolean NOT NULL DEFAULT false;
    ALTER TABLE "${schema}".permissions_catalog ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 0`);
  await query(migration248.replaceAll('public.', `"${schema}".`));
}

/** Routes `public.user_authorization_snapshot(...)` of the code to the function of the test schema. */
export function withLocalAuthorizationSnapshot(schema: string): (text: string) => string {
  return (text) => text.replaceAll('public.user_authorization_snapshot', `"${schema}".user_authorization_snapshot`);
}
