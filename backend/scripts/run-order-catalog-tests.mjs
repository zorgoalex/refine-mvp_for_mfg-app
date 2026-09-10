// Stage-only integration harness. Credentials stay in child environment, never logs/argv.
import { execFileSync, spawnSync } from 'node:child_process';
const url = new URL(execFileSync('docker', ['exec','erp_test-backend-1','printenv','DATABASE_URL'], { encoding: 'utf8' }).trim());
url.hostname = '100.99.106.72';
const result = spawnSync('./node_modules/.bin/vitest', ['run','backend/src/modules/orders/adapters/order-catalog-lines.integration.test.ts','backend/src/modules/crm-sync/reverse/bitrix24-conversion-deadlines.integration.test.ts','--maxWorkers=1','--no-file-parallelism'], {
  stdio: 'inherit', env: { ...process.env, ERP_ORDER_CATALOG_TARGET_ENV: 'backend-test', ERP_ORDER_CATALOG_TEST_DATABASE_URL: url.href, ERP_CONVERSION_TEST_TARGET_ENV: 'backend-test', ERP_CONVERSION_TEST_DATABASE_URL: url.href },
});
process.exitCode = result.status ?? 1;
