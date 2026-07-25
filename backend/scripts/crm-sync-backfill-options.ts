import type { BackfillScope } from '../src/modules/crm-sync/application/crm-sync-backfill';

export interface BackfillCliOptions {
  dryRun: boolean;
  restart: boolean;
  scope: BackfillScope;
  progressEvery: number;
}

export class BackfillInterruptedError extends Error {
  constructor() {
    super('Bitrix24 backfill interrupted');
    this.name = 'BackfillInterruptedError';
  }
}

export function parseBackfillCliOptions(args: string[]): BackfillCliOptions {
  let dryRun = false;
  let restart = false;
  let scope: BackfillScope | null = null;
  let progressEvery = 25;
  const seen = new Set<string>();

  const mark = (option: string) => {
    if (seen.has(option)) throw new Error(`duplicate option: ${option}`);
    seen.add(option);
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') {
      mark('--dry-run');
      dryRun = true;
      continue;
    }
    if (arg === '--restart') {
      mark('--restart');
      restart = true;
      continue;
    }
    if (arg === '--scope' || arg.startsWith('--scope=')) {
      mark('--scope');
      const value = optionValue(arg, '--scope', args, index);
      if (arg === '--scope') index++;
      if (value !== 'clients' && value !== 'all') {
        throw new Error('--scope must be clients or all');
      }
      scope = value;
      continue;
    }
    if (arg === '--progress-every' || arg.startsWith('--progress-every=')) {
      mark('--progress-every');
      const value = optionValue(arg, '--progress-every', args, index);
      if (arg === '--progress-every') index++;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100000) {
        throw new Error('--progress-every must be an integer from 1 to 100000');
      }
      progressEvery = parsed;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (!scope) {
    throw new Error('--scope clients|all is required');
  }
  if (dryRun && restart) {
    throw new Error('--dry-run and --restart cannot be used together');
  }
  return { dryRun, restart, scope, progressEvery };
}

export function interruptibleSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new BackfillInterruptedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', interrupted, { once: true });

    function done() {
      signal.removeEventListener('abort', interrupted);
      resolve();
    }

    function interrupted() {
      clearTimeout(timer);
      reject(new BackfillInterruptedError());
    }
  });
}

function optionValue(
  arg: string,
  option: string,
  args: string[],
  index: number,
): string {
  const value = arg === option ? args[index + 1] : arg.slice(option.length + 1);
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
