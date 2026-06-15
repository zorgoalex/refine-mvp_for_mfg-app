import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifestLib from './projects-live-backfill-manifest-lib.js';

const {
  buildProjectsLiveBackfillProofSql,
  buildProjectsLiveBackfillPlan,
  parseProjectsLiveBackfillManifest,
  validateProjectsLiveBackfillDryRunResponse,
} = manifestLib;

describe('projects live backfill manifest tooling', () => {
  it('builds dry-run and write payload chunks from explicit selected ids', () => {
    const manifest = parseProjectsLiveBackfillManifest({
      fixtureKey: 'projects-live-backfill-2026-06-15',
      projectId: '11111111-1111-4111-8111-111111111111',
      entityType: 'order',
      relationType: 'manual_backfill',
      source: {
        type: 'manual_selected_ids',
        reference: 'operator-approved-backfill-2026-06-15',
      },
      items: [
        {
          entityId: '11195',
          reason: 'operator selected order for project backfill',
          confidence: 'manual',
          sourceRow: 'manifest-row-1',
        },
      ],
    });

    const plan = buildProjectsLiveBackfillPlan(manifest);

    expect(plan.summary).toEqual({
      projectId: '11111111-1111-4111-8111-111111111111',
      entityType: 'order',
      itemCount: 1,
      chunkCount: 1,
    });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].dryRunPayload).toMatchObject({
      mode: 'dry-run',
      fixtureKey: 'projects-live-backfill-2026-06-15',
      idempotencyKey:
        'projects-live-backfill-dry-run-2026-06-15-project-11111111-1111-4111-8111-111111111111-chunk-001',
      entityType: 'order',
      relationType: 'manual_backfill',
      items: [{ entityId: '11195' }],
    });
    expect(plan.chunks[0].writePayload).toMatchObject({
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      fixtureKey: 'projects-live-backfill-2026-06-15',
      idempotencyKey:
        'projects-live-backfill-write-2026-06-15-project-11111111-1111-4111-8111-111111111111-chunk-001',
      items: [{ entityId: '11195' }],
    });
  });

  it('chunks manifests above 500 selected ids with stable chunk ids', () => {
    const manifest = parseProjectsLiveBackfillManifest({
      fixtureKey: 'projects-live-backfill-2026-06-15',
      projectId: '11111111-1111-4111-8111-111111111111',
      entityType: 'order',
      relationType: 'manual_backfill',
      source: {
        type: 'manual_selected_ids',
        reference: 'operator-approved-backfill-2026-06-15',
      },
      items: Array.from({ length: 501 }, (_, index) => ({
        entityId: String(index + 1),
        reason: 'operator selected order for project backfill',
        confidence: 'manual',
        sourceRow: `manifest-row-${index + 1}`,
      })),
    });

    const plan = buildProjectsLiveBackfillPlan(manifest);

    expect(plan.summary.chunkCount).toBe(2);
    expect(plan.chunks[0].dryRunPayload.items).toHaveLength(500);
    expect(plan.chunks[1].dryRunPayload.items).toHaveLength(1);
    expect(plan.chunks[1].dryRunPayload.idempotencyKey).toContain('chunk-002');
    expect(plan.chunks[1].writePayload.idempotencyKey).toContain('chunk-002');
  });

  it('rejects inference-shaped or unsafe manifests', () => {
    expect(() => parseProjectsLiveBackfillManifest({
      fixtureKey: 'projects-live-backfill-2026-06-15',
      projectId: '11111111-1111-4111-8111-111111111111',
      entityType: 'order',
      relationType: 'manual_backfill',
      source: {
        type: 'auto_inference',
        reference: 'guessed-from-order-name',
      },
      items: [{ entityId: '11195', reason: 'guessed', confidence: 'inferred' }],
    })).toThrow(/manual_selected_ids/);

    expect(() => parseProjectsLiveBackfillManifest({
      fixtureKey: 'projects-live-backfill-2026-06-15',
      projectId: '11111111-1111-4111-8111-111111111111',
      entityType: 'order',
      relationType: 'manual_backfill',
      source: {
        type: 'manual_selected_ids',
        reference: 'operator-approved-backfill-2026-06-15',
      },
      items: [],
    })).toThrow(/at least one selected item/);

    expect(() => parseProjectsLiveBackfillManifest({
      ...validManifest(),
      fixtureKey: 'manual-backfill-2026-06-15',
    })).toThrow(/projects-live-backfill/);
  });

  it('validates dry-run evidence responses and rejects accidental writes', () => {
    const chunk = buildProjectsLiveBackfillPlan(parseProjectsLiveBackfillManifest(validManifest())).chunks[0];

    expect(validateProjectsLiveBackfillDryRunResponse(chunk, {
      projectId: '11111111-1111-4111-8111-111111111111',
      mode: 'dry-run',
      summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
      proposals: [{ entityId: '11195' }],
      skipped: [],
      sampleEvidence: [{ entityId: '11195' }],
      writeEnabled: false,
    })).toEqual({
      projectId: '11111111-1111-4111-8111-111111111111',
      mode: 'dry-run',
      proposed: 1,
      skipped: 0,
      sampleEvidenceRows: 1,
    });

    expect(() => validateProjectsLiveBackfillDryRunResponse(chunk, {
      projectId: '11111111-1111-4111-8111-111111111111',
      mode: 'write',
      summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
      proposals: [],
      skipped: [],
      sampleEvidence: [],
      writeEnabled: true,
    })).toThrow(/dry-run/);
  });

  it('prints a plan from a manifest file without network side effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projects-live-backfill-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(validManifest())}\n`, 'utf8');

    const output = execFileSync(process.execPath, ['scripts/projects-live-backfill-manifest.js', manifestPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output);

    expect(parsed.summary).toMatchObject({ itemCount: 1, chunkCount: 1 });
    expect(parsed.chunks[0].dryRunPayload.mode).toBe('dry-run');
    expect(parsed.chunks[0].writePayload.writeIntent).toBe('explicit-selected-ids');
  });

  it('builds SQL proof queries from an approved manifest', () => {
    const proofSql = buildProjectsLiveBackfillProofSql({
      ...validManifest(),
      items: [
        {
          entityId: '101',
          reason: 'operator selected order 101',
          confidence: 'manual',
        },
        {
          entityId: '102',
          reason: 'operator selected order 102',
          confidence: 'manual',
        },
      ],
    });

    expect(proofSql.summary).toMatchObject({
      projectId: '11111111-1111-4111-8111-111111111111',
      entityType: 'order',
      itemCount: 2,
      chunkCount: 1,
      firstWriteIdempotencyKey:
        'projects-live-backfill-write-2026-06-15-project-11111111-1111-4111-8111-111111111111-chunk-001',
    });
    expect(proofSql.queries.links).toContain("entity_id_text in ('101', '102')");
    expect(proofSql.queries.audit).toContain("source='projects-batch-link'");
    expect(proofSql.queries.outbox).toContain(':project_entity_links_changed');
    expect(proofSql.queries.privacyScan).toContain('authorization|bearer|password');
  });

  it('prints SQL proof queries from a manifest file without database side effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projects-live-backfill-proof-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(validManifest())}\n`, 'utf8');

    const output = execFileSync(process.execPath, ['scripts/projects-live-backfill-proof-sql.js', manifestPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output);

    expect(parsed.queries.project).toContain('project_projects');
    expect(parsed.queries.idempotency).toContain('command_idempotency_keys');
  });
});

function validManifest() {
  return {
    fixtureKey: 'projects-live-backfill-2026-06-15',
    projectId: '11111111-1111-4111-8111-111111111111',
    entityType: 'order',
    relationType: 'manual_backfill',
    source: {
      type: 'manual_selected_ids',
      reference: 'operator-approved-backfill-2026-06-15',
    },
    items: [
      {
        entityId: '11195',
        reason: 'operator selected order for project backfill',
        confidence: 'manual',
        sourceRow: 'manifest-row-1',
      },
    ],
  };
}
