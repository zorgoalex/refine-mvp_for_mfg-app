// Type declarations for the CommonJS SP2 copy runner so the (type-checked) integration test can import it.
import type { Pool } from 'pg';

export function parseSheetCopyArgs(argv: string[]): Record<string, unknown>;
export function resolveSheetCopyConfig(parsed: Record<string, unknown>, env?: NodeJS.ProcessEnv): Record<string, unknown>;
export function assertSheetCopyAllowed(config: Record<string, unknown>): void;

export function runSheetCopy(
  pool: Pool,
  config: Record<string, unknown> & { mode: 'dry-run' | 'write'; runId?: string },
): Promise<{
  mode: 'dry-run' | 'write';
  considered: number;
  inserted: number;
  linked: number;
  skipped: number;
  placeholderDimensions: Array<{ name: string; dimsParsed: Record<string, boolean> }>;
  reversalRecord: { runId: string; createdSheetMaterialTypeIds: number[]; links: unknown[] } | null;
}>;

export function reverseSheetCopy(
  pool: Pool,
  runId: string,
  options?: { actor?: string; expectedDbName?: string },
): Promise<{ runId: string; unlinked: number; deleted: number; refusedDeletes: number[] }>;

export class SheetCopyConflictError extends Error { conflicts: unknown[]; }
export class SheetCopySourceDriftError extends Error { materialIds: unknown[]; }
export class SheetReverseBlockedError extends Error { referencedIds: number[]; }
export class SheetReverseDriftError extends Error { materialId: unknown; expectedSheetMaterialTypeId: unknown; }

export function buildSheetCopyPlan(args: Record<string, unknown>): Record<string, unknown[]>;
export function parseSheetDimensions(name: string): { thicknessMm: number; widthMm: number; heightMm: number; parsed: Record<string, boolean> };
