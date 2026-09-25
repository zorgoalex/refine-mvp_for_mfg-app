import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { MdfAcceptedSource } from '../domain/mdf-accepted-projection';
import type { MdfJob } from './mdf-job-runner';
import { applyMdfCncAuthorityEffects, loadMdfCncAuthority, type MdfCncAuthority } from './mdf-cnc-authority-job';

const claimId = '550e8400-e29b-41d4-a716-446655440000';
const packetId = '650e8400-e29b-41d4-a716-446655440000';
const revision = `cnc-observation:${claimId}`;
const digest = 'a'.repeat(64);

function job(overrides: Partial<MdfJob> = {}): MdfJob {
  return {
    job_id: '750e8400-e29b-41d4-a716-446655440000', event_key: 'cnc-observation:test',
    source_kind: 'packet', source_id: packetId, revision_key: revision, correction_epoch: '3',
    actor_user_id: '1', request_id: 'request-1', attempts: 1, effect_policy: 'forward', ...overrides,
  } as MdfJob;
}

function txFor(responses: unknown[]) {
  let index = 0;
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: responses[index++] ?? [] }));
  return { tx: { query } as unknown as TransactionClient, query };
}

function registeredRows() {
  const membership = [['membership:0', '10', '20', '10', false]];
  const membershipDigest = createHash('sha256').update(JSON.stringify(membership)).digest('hex');
  return { membershipDigest, rows: membership.map(([line_key, order_id, detail_id, quantity, rework]) => ({
    line_key, order_id, detail_id, quantity, rework,
  })) };
}

function authority(): MdfCncAuthority {
  return { packetId, claimId, reportDigest: digest, headVersion: '5', correctionEpoch: '3',
    rawSourceVersion: '7', observationVersion: '9', fenceState: 'none' };
}

function validAuthorityRow(overrides: Record<string, unknown> = {}) {
  const binding = { messageId: '101', role: 'svg', sha256: digest };
  return {
    packet_id: packetId, claim_id: claimId, authority: 'cnc_autocut', report_state: 'completed',
    failure_code: null, report_digest: digest,
    report: [{ messageId: 101, chatId: '-100123original', role: 'svg', sha256: digest,
      present: true, thumbsUp: true }],
    result: { status: 'recorded', jobId: '750e8400-e29b-41d4-a716-446655440000',
      observationVersion: '9', fenceState: 'none' },
    correction_epoch: '3', head_version: '5', raw_source_version: '7', observation_version: '9',
    target_accepted_revision_key: revision, target_membership_digest: digest,
    target_last_observation_version: '9', target_state: 'completed', current_raw_source_version: '7',
    revision_origin: 'cnc', revision_cause_key: `cnc-observation:${claimId}`,
    target_source_chat_id: '-100123original', target_message_bindings: [binding],
    revision_request_id: 'request-1', revision_actor_user_id: '1',
    // The explicit-import packet row may use this synthetic packet chat; the
    // target/report remain bound to the original, authorized Telegram chat.
    source_chat_id: 'erp-manual-svg-upload',
    ...overrides,
  };
}

function emptyEffectInput(authorityOverride: Partial<MdfCncAuthority> = {}) {
  return {
    job: job(), authority: { ...authority(), ...authorityOverride },
    heads: [{ kind: 'packet', id: packetId, accepted: revision, received: revision, epoch: '3' }],
    sources: [], details: [], orderIds: [], verifiedSourceKeys: new Set<string>(),
    suppressedOrderIds: new Set<number>(), enabled: true,
  } as Parameters<typeof applyMdfCncAuthorityEffects>[1];
}

describe('MDF CNC authority executor', () => {
  it('fails closed for observation provenance without a durable authority marker', async () => {
    const { tx, query } = txFor([[], [{ origin: 'cnc', cause_key: `cnc-observation:${claimId}` }]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_MARKER_MISSING',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not misclassify ordinary CNC-origin imports as CNC-authority jobs', async () => {
    const { tx } = txFor([[], [{ origin: 'cnc', cause_key: 'explicit-import:packet-1' }]]);
    await expect(loadMdfCncAuthority(tx, job({ revision_key: 'explicit-import-1' }))).resolves.toBeNull();
  });

  it('rejects an authority marker attached to a non-CNC authority kind or policy', async () => {
    const { tx: wrongKind } = txFor([[{ authority: 'cnc_autocut' }]]);
    await expect(loadMdfCncAuthority(wrongKind, job({ source_kind: 'bazisCutSet' }))).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_MARKER_INVALID',
    });
    const { tx: publishOnly } = txFor([[{ authority: 'cnc_autocut' }]]);
    await expect(loadMdfCncAuthority(publishOnly, job({ effect_policy: 'publish_only' }))).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_MARKER_INVALID',
    });
  });

  it('rejects a malformed immutable result before granting authority', async () => {
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [validAuthorityRow({
      result: { status: 'recorded', jobId: 'other-job', observationVersion: '9', fenceState: 'none' },
    })]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({ code: 'MDF_CNC_AUTHORITY_RECEIPT_INVALID' });
  });

  it('rejects a completed observation whose reported return-fence state is not canonical', async () => {
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [validAuthorityRow({
      result: { status: 'recorded', jobId: '750e8400-e29b-41d4-a716-446655440000',
        observationVersion: '9', fenceState: 'waiting_pending' },
    })]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({ code: 'MDF_CNC_AUTHORITY_RECEIPT_INVALID' });
  });

  it('accepts an exact completed report bound to the original chat despite the synthetic packet chat id', async () => {
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [validAuthorityRow()]]);
    await expect(loadMdfCncAuthority(tx, job())).resolves.toMatchObject({
      packetId, claimId, reportDigest: digest, fenceState: 'none',
    });
  });

  it('rejects a revision attached to a different request', async () => {
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [validAuthorityRow({ revision_request_id: 'other-request' })]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({ code: 'MDF_CNC_AUTHORITY_RECEIPT_INVALID' });
  });

  it('rejects a revision attached to a different actor', async () => {
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [validAuthorityRow({ revision_actor_user_id: '2' })]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({ code: 'MDF_CNC_AUTHORITY_RECEIPT_INVALID' });
  });

  it('rejects a report whose exact bound message digest differs from the registered group', async () => {
    const row = validAuthorityRow({ target_message_bindings: [{ messageId: '101', role: 'svg', sha256: 'b'.repeat(64) }] });
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [row]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({ code: 'MDF_CNC_AUTHORITY_RECEIPT_INVALID' });
  });

  it('rejects a completed report fetched from a chat other than the original import chat', async () => {
    const row = validAuthorityRow({ report: [{ messageId: 101, chatId: 'erp-manual-svg-upload',
      role: 'svg', sha256: digest, present: true, thumbsUp: true }] });
    const { tx } = txFor([[{ authority: 'cnc_autocut' }], [row]]);
    await expect(loadMdfCncAuthority(tx, job())).rejects.toMatchObject({ code: 'MDF_CNC_AUTHORITY_RECEIPT_INVALID' });
  });

  it('rejects a live return fence when the authority receipt claims no fence', async () => {
    const { tx } = txFor([
      [{ target_state: 'completed', accepted_revision_key: revision, last_observation_version: '9', raw_source_version: '7' }],
      [{ correction_epoch: '3', baseline_source_version: '7', pending_source_version: null,
        completion_source_version: null, state: 'waiting_pending' }],
    ]);
    await expect(applyMdfCncAuthorityEffects(tx, emptyEffectInput())).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_UNEXPECTED_RETURN_FENCE',
    });
  });

  it('rejects an unsatisfied or mismatched completion fence before effects', async () => {
    const { tx } = txFor([
      [{ target_state: 'completed', accepted_revision_key: revision, last_observation_version: '9', raw_source_version: '7' }],
      [{ correction_epoch: '3', baseline_source_version: '7', pending_source_version: '8',
        completion_source_version: '9', state: 'waiting_completion' }],
    ]);
    await expect(applyMdfCncAuthorityEffects(tx, emptyEffectInput({ fenceState: 'satisfied' }))).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_RETURN_FENCE_INVALID',
    });
  });

  it('requires the packet revision itself to cover its sealed membership before BASIS can contribute', async () => {
    const registered = registeredRows();
    const packet: MdfAcceptedSource = {
      kind: 'packet', id: packetId, accepted: revision, received: revision, verified: true,
      priorColumn: 'parsed', manualPlacementColumn: null, issues: [],
      lines: [
        { evidenceLineId: 'membership:0', orderId: 10, detailId: 20, quantity: 10,
          stage: 'membership', evidence: 'derived', rework: false },
        { evidenceLineId: 'cut:short', orderId: 10, detailId: 20, quantity: 4,
          stage: 'cut', evidence: 'physical', rework: false },
      ],
    };
    const { tx, query } = txFor([
      [{ target_state: 'completed', accepted_revision_key: revision, last_observation_version: '9', raw_source_version: '7' }],
      [],
      [{ version: '6', correction_epoch: '3' }],
      [{ registered_membership_digest: registered.membershipDigest }],
      registered.rows,
    ]);
    const inputs = {
      job: job(), authority: authority(),
      heads: [{ kind: 'packet', id: packetId, accepted: revision, received: revision, epoch: '3' }],
      sources: [packet, { kind: 'bazisCutSet', id: 'basis-1', accepted: 'basis-r1', received: 'basis-r1',
        verified: true, priorColumn: null, issues: [], lines: [{ evidenceLineId: 'basis-cut', orderId: 10,
          detailId: 20, quantity: 6, stage: 'cut', evidence: 'physical', rework: false }] } as MdfAcceptedSource],
      details: [{ orderId: 10, detailId: 20, quantity: 10, rank: 0 }],
      orderIds: [10], verifiedSourceKeys: new Set([`["packet","${packetId}"]`, '["bazisCutSet","basis-1"]']),
      suppressedOrderIds: new Set<number>(), enabled: true,
    };
    await expect(applyMdfCncAuthorityEffects(tx, inputs)).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_PACKET_CUT_INCOMPLETE',
    });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.some(([sql]) => /UPDATE\s+(order_details|orders|mdf_)/i.test(String(sql)))).toBe(false);
  });

  it('keeps valid rework-only CNC receipts accounted without normal detail credit or scalar effects', async () => {
    const membership = [['membership:rework', '10', '20', '5', true]];
    const membershipDigest = createHash('sha256').update(JSON.stringify(membership)).digest('hex');
    const packet: MdfAcceptedSource = {
      kind: 'packet', id: packetId, accepted: revision, received: revision, verified: true,
      priorColumn: 'parsed', manualPlacementColumn: null, issues: [],
      lines: [
        { evidenceLineId: 'membership:rework', orderId: 10, detailId: 20, quantity: 5,
          stage: 'membership', evidence: 'derived', rework: true },
        { evidenceLineId: 'cut:rework', orderId: 10, detailId: 20, quantity: 5,
          stage: 'cut', evidence: 'physical', rework: true },
      ],
    };
    const { tx, query } = txFor([
      [{ target_state: 'completed', accepted_revision_key: revision, last_observation_version: '9', raw_source_version: '7' }],
      [],
      [{ version: '6', correction_epoch: '3' }],
      [{ registered_membership_digest: membershipDigest }],
      membership.map(([line_key, order_id, detail_id, quantity, rework]) => ({ line_key, order_id, detail_id, quantity, rework })),
      [{ order_id: '10', order_status_name: 'В производстве' }],
    ]);
    const input = {
      ...emptyEffectInput(), sources: [packet],
      details: [{ orderId: 10, detailId: 20, quantity: 5, rank: 0 }], orderIds: [10],
      verifiedSourceKeys: new Set([JSON.stringify(['packet', packetId])]),
    };
    await expect(applyMdfCncAuthorityEffects(tx, input)).resolves.toEqual({ changedOrderIds: [], completedOrderIds: [] });
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls.some(([sql]) => /UPDATE\s+(order_details|orders|mdf_)/i.test(String(sql)))).toBe(false);
  });

  it('fails closed with MEMBERSHIP_BINDING_INVALID and performs no writes when the registered CNC digest no longer matches the sealed revision', async () => {
    // Membership is invariant through every real writer; this reproduces the only way the
    // stored registered_membership_digest and the live sealed revision can disagree: the
    // durable target row is tampered directly (as covered by a database-level guard test),
    // never through this job's own inputs.
    const registered = registeredRows();
    const tamperedDigest = 'f'.repeat(64);
    expect(tamperedDigest).not.toBe(registered.membershipDigest);
    const packet: MdfAcceptedSource = {
      kind: 'packet', id: packetId, accepted: revision, received: revision, verified: true,
      priorColumn: 'parsed', manualPlacementColumn: null, issues: [],
      lines: [
        { evidenceLineId: 'membership:0', orderId: 10, detailId: 20, quantity: 10,
          stage: 'membership', evidence: 'derived', rework: false },
        { evidenceLineId: 'cut:full', orderId: 10, detailId: 20, quantity: 10,
          stage: 'cut', evidence: 'physical', rework: false },
      ],
    };
    const { tx, query } = txFor([
      [{ target_state: 'completed', accepted_revision_key: revision, last_observation_version: '9', raw_source_version: '7' }],
      [],
      [{ version: '6', correction_epoch: '3' }],
      [{ registered_membership_digest: tamperedDigest }],
      registered.rows,
    ]);
    const inputs = {
      job: job(), authority: authority(),
      heads: [{ kind: 'packet', id: packetId, accepted: revision, received: revision, epoch: '3' }],
      sources: [packet],
      details: [{ orderId: 10, detailId: 20, quantity: 10, rank: 0 }],
      orderIds: [10], verifiedSourceKeys: new Set([`["packet","${packetId}"]`]),
      suppressedOrderIds: new Set<number>(), enabled: true,
    };
    await expect(applyMdfCncAuthorityEffects(tx, inputs)).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_MEMBERSHIP_BINDING_INVALID',
    });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.some(([sql]) => /UPDATE\s+(order_details|orders|mdf_)/i.test(String(sql)))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /INSERT\s+INTO\s+audit_log/i.test(String(sql)))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /INSERT\s+INTO\s+outbox_events/i.test(String(sql)))).toBe(false);
  });

  it('requires complete packet physical proof separately for rework membership', async () => {
    const membership = [['membership:rework', '10', '20', '5', true]];
    const membershipDigest = createHash('sha256').update(JSON.stringify(membership)).digest('hex');
    const packet: MdfAcceptedSource = {
      kind: 'packet', id: packetId, accepted: revision, received: revision, verified: true,
      priorColumn: 'parsed', manualPlacementColumn: null, issues: [],
      lines: [
        { evidenceLineId: 'membership:rework', orderId: 10, detailId: 20, quantity: 5,
          stage: 'membership', evidence: 'derived', rework: true },
        { evidenceLineId: 'cut:short-rework', orderId: 10, detailId: 20, quantity: 4,
          stage: 'cut', evidence: 'physical', rework: true },
      ],
    };
    const { tx, query } = txFor([
      [{ target_state: 'completed', accepted_revision_key: revision, last_observation_version: '9', raw_source_version: '7' }],
      [],
      [{ version: '6', correction_epoch: '3' }],
      [{ registered_membership_digest: membershipDigest }],
      membership.map(([line_key, order_id, detail_id, quantity, rework]) => ({ line_key, order_id, detail_id, quantity, rework })),
    ]);
    const input = {
      ...emptyEffectInput(), sources: [packet],
      details: [{ orderId: 10, detailId: 20, quantity: 5, rank: 0 }], orderIds: [10],
      verifiedSourceKeys: new Set([JSON.stringify(['packet', packetId])]),
    };
    await expect(applyMdfCncAuthorityEffects(tx, input)).rejects.toMatchObject({
      code: 'MDF_CNC_AUTHORITY_PACKET_CUT_INCOMPLETE',
    });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.some(([sql]) => /UPDATE\s+(order_details|orders|mdf_)/i.test(String(sql)))).toBe(false);
  });
});
