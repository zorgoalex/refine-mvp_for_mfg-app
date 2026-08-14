import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./pg-cut-repository.ts', import.meta.url),
  'utf8',
);

describe('PgCutRepository delete cut job contract', () => {
  it('requires explicit confirmation before hiding linked MDF board packets', () => {
    expect(source).toContain('CUT_JOB_ALREADY_DELETED');
    expect(source).toContain('CUT_JOB_LINKED_MDF_PACKETS');
    expect(source).toContain('command.deleteLinkedMdfPackets !== true');
    expect(source).toContain('hideLinkedMdfPacketsForCutJob');
    expect(source).toContain('mdf_board_hidden_at = COALESCE(mdf_board_hidden_at, now())');
  });

  it('records cut-job deletion as a deletion audit event with affected entities', () => {
    expect(source).toContain('event: CUT_AUDIT_EVENTS.deleted');
    expect(source).toContain('releasedOrderDetailIds');
    expect(source).toContain('hiddenMdfPacketIds');
  });
});
