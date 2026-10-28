/**
 * Operator CLI of the Bitrix24 assignment channel (migration 270). It ships in the backend image:
 *
 *   node dist/modules/crm-sync/assignment/bitrix24-assignment-cli.js <command> [args]
 *
 *   status                         mode, counts, preserved conflicts
 *   plan                           what the cohort (BACKEND_BITRIX24_ASSIGNMENT_ERP_USER_IDS) would take over
 *   enable                         off → on (release user = BITRIX24_ASSIGNED_BY_ID)
 *   enqueue                        queue the cohort and everything ERP already owns
 *   restore --dry-run              read-only preview of restore
 *   restore                        on → restore: bring every owned object back
 *   set-release                    adopt a changed BITRIX24_ASSIGNED_BY_ID as the release user
 *   resolve <object:id> keep|apply a hand-made change found by restore
 *   complete                       restore → off when every target is finished
 *
 * The cohort and the release user are read from the same variables as the relay (assignmentPolicy). Commands that
 * change the channel take the relay's writer lock; the CLI waits for it up to ~2.5 minutes.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { assignmentPolicy } from './assignment-policy';
import { AssignmentCommandError, Bitrix24AssignmentCommands, newCorrelationId } from './bitrix24-assignment-commands';

const USAGE =
  'usage: bitrix24-assignment-cli status|plan|enable|enqueue|set-release|complete|restore [--dry-run]|resolve <object:id> keep|apply';

export async function runAssignmentCli(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...rest] = argv;
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is not set\n');
    return 2;
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const commands = new Bitrix24AssignmentCommands(poolDatabase(pool), new AuditService());
  const policy = assignmentPolicy(
    env.BACKEND_BITRIX24_ASSIGNMENT === 'true',
    env.BACKEND_BITRIX24_ASSIGNMENT_ERP_USER_IDS ?? '',
    env.BITRIX24_ASSIGNED_BY_ID ?? null,
  );
  const actor = { userId: null, correlationId: newCorrelationId() };
  // Unknown or extra arguments are refused before anything is changed (a mistyped flag must not run a mutation).
  const allowed: Record<string, number> = { status: 0, plan: 0, enable: 0, enqueue: 0, 'set-release': 0, complete: 0, resolve: 2, restore: 1 };
  if (!(command in allowed) || rest.length > allowed[command] || (command === 'restore' && rest.length === 1 && rest[0] !== '--dry-run')) {
    process.stderr.write(`${USAGE}\n`);
    await pool.end().catch(() => undefined);
    return 2;
  }
  try {
    const result = await withRetry(async () => {
      switch (command) {
        case 'status':
          return commands.status();
        case 'plan':
          return { cohort: policy.cohort === null ? '*' : [...policy.cohort], ...(await commands.plan(policy.cohort)) };
        case 'enable':
          return commands.enable(actor, policy.releaseAssignedById ?? '');
        case 'set-release':
          return commands.setRelease(actor, policy.releaseAssignedById);
        case 'enqueue':
          return commands.enqueue(actor, policy.cohort);
        case 'restore':
          return rest[0] === '--dry-run'
            ? commands.previewRestore(policy.releaseAssignedById)
            : commands.startRestore(actor, policy.releaseAssignedById);
        case 'complete':
          return commands.completeRestore(actor, policy.releaseAssignedById);
        case 'resolve': {
          const [target, decision] = rest;
          const match = /^(deal|contact|company):([1-9][0-9]*)$/.exec(target ?? '');
          if (!match || (decision !== 'keep' && decision !== 'apply')) throw new AssignmentCommandError(USAGE);
          await commands.resolve(actor, match[1], match[2], decision);
          return { resolved: target, decision };
        }
        default:
          throw new AssignmentCommandError(USAGE);
      }
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** The relay may hold the writer lock for a tick: try again a few times. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof AssignmentCommandError && /writer is busy/.test(error.message);
      if (!busy || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
}

function poolDatabase(pool: Pool): DatabaseService {
  return {
    isConfigured: true,
    query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      return pool.query<T>(text, [...params]);
    },
    async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: TransactionClient = {
          raw: client as never,
          query<T2 extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) {
            return client.query<T2>(text, [...params]);
          },
        } as TransactionClient;
        const result = await handler(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async withAdvisoryLock<T>(key: string, handler: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T | null> {
      const client = await pool.connect();
      try {
        const acquired = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [key],
        );
        if (!acquired.rows[0]?.acquired) return null;
        try {
          return await handler(async () => {
            await client.query('SELECT 1');
          });
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => undefined);
        }
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
}

if (require.main === module) {
  void runAssignmentCli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
