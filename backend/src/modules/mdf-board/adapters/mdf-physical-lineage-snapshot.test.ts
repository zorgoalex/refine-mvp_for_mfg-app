import { createHash } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { mdfPhysicalLineageDigest, type MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import { issueMdfValidatedBazisAssignmentState, mdfBazisMembershipDigest,
  type MdfValidatedBazisAssignmentState } from '../application/mdf-bazis-assignment-state';
import { loadMdfPhysicalLineageSnapshot } from './mdf-physical-lineage-snapshot';

const sourceId = '00000000-0000-0000-0000-000000000501';
const otherSourceId = '00000000-0000-0000-0000-000000000502';
const unrelatedId = '10000000-0000-0000-0000-000000000503';
const revisionKey = (id: string, revision = 'r1') => JSON.stringify(['packet', id, revision]);
const evidenceId = (id: string, row: number) =>
  `10000000-0000-4000-8000-${id.replaceAll('-', '').slice(-6)}${String(row).padStart(6, '0')}`;
const rootEvidenceId = (id: string) => evidenceId(id, 2);
const carriedEvidenceId = (id: string) => evidenceId(id, 3);

type FixtureKind = 'packet' | 'bazisCutSet';

interface ContractRow extends QueryResultRow {
  kind: FixtureKind; id: string; revision: string; contractFound: boolean; sourceHasContract: boolean;
  sealed: boolean; contextFound: boolean; sourceKind: FixtureKind | null; operation: string | null;
  productionAuthority: string | null; predecessorRevision: string | null; manifestDigest: string | null;
  dropped: string[] | null; origin: string | null; acceptanceRequested: boolean | null;
  compositionComplete: boolean | null; effectPolicy: string | null;
  contextPredecessorAccepted: string | null; contextPredecessorReceived: string | null;
}
interface EvidenceRow extends QueryResultRow {
  kind: FixtureKind; id: string; revision: string; evidenceLineId: string; lineKey: string;
  orderId: number; detailId: number; quantity: number; stageCode: string;
  evidenceKind: string; rework: boolean;
}
interface TransitionRow extends QueryResultRow {
  kind: FixtureKind; id: string; revision: string; evidenceLineId: string; action: string;
  predecessorEvidenceLineId: string | null; canonicalOriginEvidenceLineId: string;
  childKind: FixtureKind | null; childId: string | null; childRevision: string | null;
  childEvidenceKind: string | null; childLineKey: string | null; childOrderId: number | null;
  childDetailId: number | null; childQuantity: number | null; childStage: string | null; childRework: boolean | null;
  parentEvidenceLineId: string | null; parentKind: string | null; parentId: string | null;
  parentRevision: string | null; parentEvidenceKind: string | null; parentLineKey: string | null;
  parentOrderId: number | null; parentDetailId: number | null; parentQuantity: number | null;
  parentStage: string | null; parentRework: boolean | null; parentCanonicalOrigin: string | null;
  parentLineageOperation: string | null;
}
interface ParentRow extends QueryResultRow {
  kind: FixtureKind; id: string; revision: string; evidenceLineId: string;
  canonicalOriginEvidenceLineId: string | null; lineageContractFound: boolean;
}

interface Fixture {
  contracts: ContractRow[];
  evidence: EvidenceRow[];
  transitions: TransitionRow[];
  parents: ParentRow[];
}

function fixture(id = sourceId, operation: 'production' | 'carry' = 'production'): Fixture {
  const parentRevision = operation === 'carry' ? 'r0' : null;
  const originId = rootEvidenceId(id);
  const physicalId = operation === 'carry' ? carriedEvidenceId(id) : originId;
  const predecessorId = operation === 'carry' ? originId : null;
  const manifest: MdfPhysicalLineageManifest = operation === 'production'
    ? { operation, authority: 'manual_production', actions: [{ lineKey: 'physical', action: 'root' }],
      droppedPredecessorEvidenceLineIds: [] }
    : { operation, actions: [{ lineKey: 'physical', action: 'carry', predecessorEvidenceLineId: originId }],
      droppedPredecessorEvidenceLineIds: [] };
  const digest = mdfPhysicalLineageDigest(manifest);
  return {
    contracts: [{ kind: 'packet', id, revision: 'r1', contractFound: true, sourceHasContract: true,
      sealed: true, contextFound: true, sourceKind: 'packet', operation, productionAuthority:
        operation === 'production' ? 'manual_production' : null, predecessorRevision: parentRevision,
      manifestDigest: digest, dropped: [], origin: 'manual', acceptanceRequested: true,
      compositionComplete: true, effectPolicy: 'forward', contextPredecessorAccepted: parentRevision,
      contextPredecessorReceived: parentRevision }],
    evidence: [
      { kind: 'packet', id, revision: 'r1', evidenceLineId: evidenceId(id, 1),
        lineKey: 'member', orderId: 1, detailId: 101, quantity: 3, stageCode: 'membership',
        evidenceKind: 'derived', rework: false },
      { kind: 'packet', id, revision: 'r1', evidenceLineId: physicalId,
        lineKey: 'physical', orderId: 1, detailId: 101, quantity: 2, stageCode: 'cut',
        evidenceKind: 'physical', rework: false },
    ],
    transitions: [{ kind: 'packet', id, revision: 'r1', evidenceLineId: physicalId,
      action: operation === 'production' ? 'root' : 'carry', predecessorEvidenceLineId: predecessorId,
      canonicalOriginEvidenceLineId: operation === 'production' ? physicalId : originId,
      childKind: 'packet', childId: id, childRevision: 'r1', childEvidenceKind: 'physical',
      childLineKey: 'physical', childOrderId: 1, childDetailId: 101, childQuantity: 2,
      childStage: 'cut', childRework: false,
      parentEvidenceLineId: predecessorId, parentKind: operation === 'carry' ? 'packet' : null,
      parentId: operation === 'carry' ? id : null, parentRevision: operation === 'carry' ? 'r0' : null,
      parentEvidenceKind: operation === 'carry' ? 'physical' : null,
      parentLineKey: operation === 'carry' ? 'physical-root' : null,
      parentOrderId: operation === 'carry' ? 1 : null, parentDetailId: operation === 'carry' ? 101 : null,
      parentQuantity: operation === 'carry' ? 2 : null, parentStage: operation === 'carry' ? 'cut' : null,
      parentRework: operation === 'carry' ? false : null,
      parentCanonicalOrigin: operation === 'carry' ? originId : null,
      parentLineageOperation: operation === 'carry' ? 'production' : null,
    }],
    parents: operation === 'carry' ? [{ kind: 'packet', id, revision: 'r0', evidenceLineId: originId,
      canonicalOriginEvidenceLineId: originId, lineageContractFound: true }] : [],
  };
}

function clientFor(data: Fixture, onQuery?: (sql: string, params: readonly unknown[] | undefined) => void): DatabaseClient {
  return {
    async query<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      onQuery?.(sql, params);
      let rows: QueryResultRow[] = [];
      if (sql.includes('FROM unnest') && sql.includes('mdf_physical_lineage_contracts c')) rows = data.contracts;
      else if (sql.includes('FROM unnest') && sql.includes('JOIN mdf_evidence_lines l')) rows = data.evidence;
      else if (sql.includes('mdf_physical_lineage_transitions t')) rows = data.transitions;
      else if (sql.includes('FROM unnest') && sql.includes('lineageContractFound')) rows = data.parents;
      return { rows: rows as T[], command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] };
    },
  };
}

const head = (id = sourceId, accepted = 'r1', received = accepted) => ({ kind: 'packet' as const, id, accepted, received });

const bazisSourceId = '00000000-0000-0000-0000-000000000504';
const bazisRevisionKey = (id: string, revision = 'r1') => JSON.stringify(['bazisCutSet', id, revision]);
const bazisHead = (id = bazisSourceId, accepted = 'r1', received = accepted) =>
  ({ kind: 'bazisCutSet' as const, id, accepted, received });

/** Sealed bazis carry receipt whose only retained fact is the confirmed
 * physical line; membership evidence is intentionally absent. */
function emptyBazisFixture(id = bazisSourceId): Fixture {
  const originId = rootEvidenceId(id);
  const carriedId = carriedEvidenceId(id);
  const manifest: MdfPhysicalLineageManifest = { operation: 'carry',
    actions: [{ lineKey: 'physical', action: 'carry', predecessorEvidenceLineId: originId }],
    droppedPredecessorEvidenceLineIds: [] };
  return {
    contracts: [{ kind: 'bazisCutSet', id, revision: 'r1', contractFound: true,
      sourceHasContract: true, sealed: true, contextFound: true, sourceKind: 'bazisCutSet',
      operation: 'carry', productionAuthority: null, predecessorRevision: 'r0',
      manifestDigest: mdfPhysicalLineageDigest(manifest), dropped: [], origin: 'manual',
      acceptanceRequested: true, compositionComplete: true, effectPolicy: 'forward',
      contextPredecessorAccepted: 'r0', contextPredecessorReceived: 'r0' }],
    evidence: [{ kind: 'bazisCutSet', id, revision: 'r1', evidenceLineId: carriedId,
      lineKey: 'physical', orderId: 1, detailId: 101, quantity: 10, stageCode: 'cut',
      evidenceKind: 'physical', rework: false }],
    transitions: [{ kind: 'bazisCutSet', id, revision: 'r1', evidenceLineId: carriedId,
      action: 'carry', predecessorEvidenceLineId: originId, canonicalOriginEvidenceLineId: originId,
      childKind: 'bazisCutSet', childId: id, childRevision: 'r1', childEvidenceKind: 'physical',
      childLineKey: 'physical', childOrderId: 1, childDetailId: 101, childQuantity: 10,
      childStage: 'cut', childRework: false, parentEvidenceLineId: originId,
      parentKind: 'bazisCutSet', parentId: id, parentRevision: 'r0', parentEvidenceKind: 'physical',
      parentLineKey: 'physical-root', parentOrderId: 1, parentDetailId: 101, parentQuantity: 10,
      parentStage: 'cut', parentRework: false, parentCanonicalOrigin: originId,
      parentLineageOperation: 'production' }],
    parents: [{ kind: 'bazisCutSet', id, revision: 'r0', evidenceLineId: originId,
      canonicalOriginEvidenceLineId: originId, lineageContractFound: true }],
  };
}

function emptyAssignmentMarker(data: Fixture, revision = 'r1',
  intentionalEmpty = true): MdfValidatedBazisAssignmentState {
  return issueMdfValidatedBazisAssignmentState({ sourceKind: 'bazisCutSet',
    sourceId: data.contracts[0].id, revisionKey: revision,
    assignmentStateId: '20000000-0000-4000-8000-000000000001',
    rootIntentId: '20000000-0000-4000-8000-000000000002',
    membershipDigest: mdfBazisMembershipDigest(data.evidence), intentionalEmpty });
}

describe('loadMdfPhysicalLineageSnapshot defensive checks', () => {
  it('issues exact sealed production roots and carried descriptors', async () => {
    const root = fixture();
    const carry = fixture(otherSourceId, 'carry');
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor({
      contracts: [...root.contracts, ...carry.contracts], evidence: [...root.evidence, ...carry.evidence],
      transitions: [...root.transitions, ...carry.transitions], parents: carry.parents,
    }), [head(), head(otherSourceId)]);

    expect(snapshot.lineage.get(revisionKey(sourceId))).toMatchObject({ operation: 'production',
      lines: [{ action: 'root', canonicalOriginEvidenceLineId: rootEvidenceId(sourceId) }] });
    expect(snapshot.lineage.get(revisionKey(otherSourceId))).toMatchObject({ operation: 'carry',
      predecessorAcceptedRevisionKey: 'r0',
      lines: [{ action: 'carry', predecessorEvidenceLineId: rootEvidenceId(otherSourceId),
        canonicalOriginEvidenceLineId: rootEvidenceId(otherSourceId) }] });
    expect(snapshot.lineageIssues.size).toBe(0);
  });

  it.each([
    ['missing immutable seal', (data: Fixture) => { data.contracts[0].sealed = false; }],
    ['missing execution context', (data: Fixture) => { data.contracts[0].contextFound = false; }],
    ['missing acceptance request', (data: Fixture) => { data.contracts[0].acceptanceRequested = false; }],
    ['missing composition completion', (data: Fixture) => { data.contracts[0].compositionComplete = false; }],
    ['missing manifest digest', (data: Fixture) => { data.contracts[0].manifestDigest = null; }],
    ['wrong manifest digest', (data: Fixture) => { data.contracts[0].manifestDigest = 'a'.repeat(64); }],
    ['missing transition', (data: Fixture) => { data.transitions.length = 0; }],
    ['duplicate transition', (data: Fixture) => { data.transitions.push({ ...data.transitions[0] }); }],
    ['transition foreign to child', (data: Fixture) => { data.transitions[0].childId = otherSourceId; }],
    ['changed child quantity', (data: Fixture) => { data.transitions[0].childQuantity = 1; }],
    ['changed child position', (data: Fixture) => { data.transitions[0].childDetailId = 102; }],
    ['changed child rework', (data: Fixture) => { data.transitions[0].childRework = true; }],
    ['changed canonical root origin', (data: Fixture) => { data.transitions[0].canonicalOriginEvidenceLineId = unrelatedId; }],
  ])('quarantines a source with %s', async (_name, mutate) => {
    const data = fixture();
    mutate(data);
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor(data), [head()]);
    expect(snapshot.lineage.has(revisionKey(sourceId))).toBe(false);
    expect(snapshot.lineageIssues.get(revisionKey(sourceId))).toEqual(['MDF_LINEAGE_INVALID']);
  });

  it.each([
    ['foreign parent source kind', (data: Fixture) => { data.transitions[0].parentKind = 'bazisCutSet'; }],
    ['foreign parent source id', (data: Fixture) => { data.transitions[0].parentId = otherSourceId; }],
    ['foreign parent revision', (data: Fixture) => { data.transitions[0].parentRevision = 'r1'; }],
  ])('rejects carry lineage with %s', async (_name, mutate) => {
    const data = fixture(sourceId, 'carry');
    mutate(data);
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor(data), [head(sourceId)]);
    expect(snapshot.lineage.has(revisionKey(sourceId))).toBe(false);
    expect(snapshot.lineageIssues.get(revisionKey(sourceId))).toEqual(['MDF_LINEAGE_INVALID']);
  });

  it('marks a missing contract as required when another revision proves the source is v2', async () => {
    const data = fixture();
    data.contracts[0] = { ...data.contracts[0], revision: 'r0', contractFound: true };
    data.contracts.push({ ...data.contracts[0], revision: 'r1', contractFound: false, sourceHasContract: true });
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor(data), [head(sourceId, 'r1')]);
    expect(snapshot.lineageIssues.get(revisionKey(sourceId))).toEqual(['MDF_LINEAGE_REQUIRED']);
  });

  it('keeps invalid lineage scoped to its source revision', async () => {
    const valid = fixture(sourceId);
    const invalid = fixture(otherSourceId);
    invalid.transitions[0].childQuantity = 99;
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor({
      contracts: [...valid.contracts, ...invalid.contracts], evidence: [...valid.evidence, ...invalid.evidence],
      transitions: [...valid.transitions, ...invalid.transitions], parents: [],
    }), [head(sourceId), head(otherSourceId)]);
    expect(snapshot.lineage.has(revisionKey(sourceId))).toBe(true);
    expect(snapshot.lineageIssues.get(revisionKey(otherSourceId))).toEqual(['MDF_LINEAGE_INVALID']);
  });

  it('lets missing lineage-table SQL errors escape', async () => {
    const error = new Error('relation mdf_physical_lineage_contracts does not exist');
    const client = clientFor(fixture(), sql => {
      if (sql.includes('mdf_physical_lineage_contracts c')) throw error;
    });
    await expect(loadMdfPhysicalLineageSnapshot(client, [head()])).rejects.toBe(error);
  });

  it('enforces the 1000 requested revision bound before querying', async () => {
    let calls = 0;
    const client = clientFor(fixture(), () => { calls++; });
    const heads = Array.from({ length: 1001 }, (_, index) => head(sourceId, `r${index}`));
    await expect(loadMdfPhysicalLineageSnapshot(client, heads)).rejects.toThrow('MDF_LINEAGE_LIMIT');
    expect(calls).toBe(0);
  });

  it('enforces the 50000 evidence row bound', async () => {
    const data = fixture();
    data.evidence = Array.from({ length: 50001 }, (_, index) => ({ ...data.evidence[0],
      evidenceLineId: createHash('sha1').update(String(index)).digest('hex').padEnd(36, '0').slice(0, 36) }));
    await expect(loadMdfPhysicalLineageSnapshot(clientFor(data), [head()])).rejects.toThrow('MDF_LINEAGE_LIMIT');
  });

  it('issues an authenticated intentional-empty bazis carry that retains the confirmed physical line', async () => {
    const data = emptyBazisFixture();
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor(data), [bazisHead()],
      { assignmentStates: new Map([[bazisRevisionKey(bazisSourceId), emptyAssignmentMarker(data)]]) });
    expect(snapshot.lineage.get(bazisRevisionKey(bazisSourceId))).toMatchObject({ operation: 'carry',
      predecessorAcceptedRevisionKey: 'r0', lines: [{ action: 'carry', quantity: 10,
        predecessorEvidenceLineId: rootEvidenceId(bazisSourceId),
        canonicalOriginEvidenceLineId: rootEvidenceId(bazisSourceId) }] });
    expect(snapshot.lineageIssues.size).toBe(0);
  });

  const forgedMarkers: [string, (data: Fixture) => MdfValidatedBazisAssignmentState | undefined][] = [
    ['no authenticated marker', () => undefined],
    ['a JSON-cloned marker', data => JSON.parse(JSON.stringify(emptyAssignmentMarker(data))) as MdfValidatedBazisAssignmentState],
    ['a wrong-revision marker', data => emptyAssignmentMarker(data, 'r0')],
    ['a marker without intentional-empty', data => emptyAssignmentMarker(data, 'r1', false)],
  ];
  it.each(forgedMarkers)('quarantines an empty bazis carry with %s', async (_name, makeMarker) => {
    const data = emptyBazisFixture();
    const marker = makeMarker(data);
    const snapshot = marker
      ? await loadMdfPhysicalLineageSnapshot(clientFor(data), [bazisHead()],
          { assignmentStates: new Map([[bazisRevisionKey(bazisSourceId), marker]]) })
      : await loadMdfPhysicalLineageSnapshot(clientFor(data), [bazisHead()]);
    expect(snapshot.lineage.has(bazisRevisionKey(bazisSourceId))).toBe(false);
    expect(snapshot.lineageIssues.get(bazisRevisionKey(bazisSourceId))).toEqual(['MDF_LINEAGE_INVALID']);
  });

  it('still rejects a bazis production root without membership despite a valid empty marker', async () => {
    const data = emptyBazisFixture();
    const childId = data.evidence[0].evidenceLineId;
    data.contracts[0] = { ...data.contracts[0], operation: 'production',
      productionAuthority: 'manual_production', predecessorRevision: null,
      manifestDigest: mdfPhysicalLineageDigest({ operation: 'production', authority: 'manual_production',
        actions: [{ lineKey: 'physical', action: 'root' }], droppedPredecessorEvidenceLineIds: [] }),
      contextPredecessorAccepted: null, contextPredecessorReceived: null };
    data.transitions[0] = { ...data.transitions[0], action: 'root', predecessorEvidenceLineId: null,
      canonicalOriginEvidenceLineId: childId, parentEvidenceLineId: null, parentKind: null,
      parentId: null, parentRevision: null, parentEvidenceKind: null, parentLineKey: null,
      parentOrderId: null, parentDetailId: null, parentQuantity: null, parentStage: null,
      parentRework: null, parentCanonicalOrigin: null, parentLineageOperation: null };
    data.parents = [];
    const snapshot = await loadMdfPhysicalLineageSnapshot(clientFor(data), [bazisHead()],
      { assignmentStates: new Map([[bazisRevisionKey(bazisSourceId), emptyAssignmentMarker(data)]]) });
    expect(snapshot.lineage.has(bazisRevisionKey(bazisSourceId))).toBe(false);
    expect(snapshot.lineageIssues.get(bazisRevisionKey(bazisSourceId))).toEqual(['MDF_LINEAGE_INVALID']);
  });
});
