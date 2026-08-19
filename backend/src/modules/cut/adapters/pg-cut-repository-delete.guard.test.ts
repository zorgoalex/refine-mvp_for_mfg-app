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

  it('loads MDF board status from the same visibility rule as the MDF board', () => {
    expect(source).toContain('loadMdfBoardStatuses');
    expect(source).toContain('p.svg_cut_job_id = ANY($1::bigint[])');
    expect(source).toContain("p.source_chat_id IS DISTINCT FROM $2");
    expect(source).toContain("':mdf-card-created'");
    expect(source).toContain('mdfBoardStatusById.get(id)');
    expect(source).toContain('mdfBoardStatusById.get(query.cutJobId)');
    expect(source).toContain("state: 'created'");
    expect(source).toContain("state: 'not_created'");
  });

  it('creates a missing manual-SVG MDF board card with duplicate validation', () => {
    expect(source).toContain('createMdfBoardCard(command: CreateCutJobMdfBoardCardCommand)');
    expect(source).toContain('CUT_JOB_MDF_BOARD_CARD_ALREADY_EXISTS');
    expect(source).toContain('CUT_JOB_MDF_BOARD_MULTIPLE_PACKETS');
    expect(source).toContain('mdfBoardCardEventKey(packet)');
    expect(source).toContain('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(source).toContain('MDF_BOARD_CARD_CREATED_EVENT');
    expect(source).toContain('evaluateMdfOrderMachineFilesPresentAutomation');
    expect(source).toContain("canCreateCard: row.status === 'ready'");
    expect(source).toContain('ON CONFLICT (external_packet_key) DO NOTHING');
    expect(source).toContain("return cardKind === 'bath' ? 'bath_seed' : 'machine_file'");
  });

  it('records cut-job deletion as a deletion audit event with affected entities', () => {
    expect(source).toContain('event: CUT_AUDIT_EVENTS.deleted');
    expect(source).toContain('releasedOrderDetailIds');
    expect(source).toContain('hiddenMdfPacketIds');
  });
});
