import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { ShadowCommandProof } from '../domain/mdf-shadow-proof';
import { loadMdfShadowProofsBatched } from './mdf-reconciliation-inventory';
import { ShadowProofLimitError } from './mdf-shadow-proof-loader';

const db = {} as DatabaseClient;
const proof = (sequence: string) => ({ sequence } as ShadowCommandProof);
const src = (id: string) => ({ kind: 'bazisCutSet' as const, id });

describe('loadMdfShadowProofsBatched', () => {
  // Fake loader with the real loader's contract: throws for a request whose total commands exceed the cap.
  const commands: Record<string, number> = { a: 400, b: 400, c: 400, big: 1200, d: 1 };
  const calls: string[][] = [];
  const loader = (async (_db: DatabaseClient, batch: readonly { kind: string; id: string }[]) => {
    calls.push(batch.map(s => s.id));
    if (batch.reduce((n, s) => n + commands[s.id], 0) > 1000) throw new ShadowProofLimitError('COMMAND_LIMIT');
    return new Map(batch.map(s => [`${s.kind}:${s.id}`, [proof(String(commands[s.id]))]]));
  }) as never;

  it('splits an oversized batch and isolates a single overflowing source without losing the others', async () => {
    const result = await loadMdfShadowProofsBatched(db, ['a', 'b', 'c', 'big', 'd'].map(src), loader, 5);
    expect([...result.overflow]).toEqual(['bazisCutSet:big']);
    expect([...result.proofs.keys()].sort()).toEqual(['bazisCutSet:a', 'bazisCutSet:b', 'bazisCutSet:c', 'bazisCutSet:d']);
    expect(calls[0]).toEqual(['a', 'b', 'c', 'big', 'd']);
  });

  it('rethrows non-limit errors', async () => {
    const failing = (async () => { throw new Error('boom'); }) as never;
    await expect(loadMdfShadowProofsBatched(db, [src('a')], failing)).rejects.toThrow('boom');
  });
});
