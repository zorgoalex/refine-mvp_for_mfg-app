import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  cncWholeOrderIds,
  cncWholeOrderKeys,
  PgCncTelegramRepository,
} from './pg-cnc-telegram-repository';

const repositorySource = readFileSync(new URL('./pg-cnc-telegram-repository.ts', import.meta.url), 'utf8');

describe('PgCncTelegramRepository', () => {
  it('returns bath display cut numbers without result version', () => {
    expect(repositorySource).toContain('j.source_display_number');
    expect(repositorySource).toContain('displayCutNumber: formatCutJobNumber(cutJobId, true, row.source_display_number)');
    expect(repositorySource).toContain('cutNumber: formatCutNumber(cutJobId, resultNo, true, row.source_display_number)');
    expect(repositorySource).not.toContain('displayCutNumber: formatCutJobNumber(cutJobId, true)');
  });

  it('emits the MDF machine-files automation event from pending board cards', () => {
    expect(repositorySource).toContain('evaluateMdfOrderMachineFilesPresentAutomation');
    expect(repositorySource).toContain("packetColumnKey(packet) === 'parsed'");
    expect(repositorySource).toContain('orderIds: packet.items.map((item) => item.orderId)');
    expect(repositorySource).toContain('cnc-telegram-packet:${packet.packetId}:source-${packet.sourceVersion}:machine-files');
  });

  it('shows manual SVG packets on MDF board only after MDF-card creation marker', () => {
    expect(repositorySource).toContain('manual_svg_mdf_card.idempotency_key');
    expect(repositorySource).toContain("':mdf-card-created'");
    expect(repositorySource).toContain('p.source_chat_id IS DISTINCT FROM $3');
  });

  it('aggregates repeated SVG layout matches before placement-count comparison', () => {
    expect(repositorySource).toContain('existing.quantity + item.quantity');
    expect(repositorySource).toContain('countByLayoutKey.set(key, (countByLayoutKey.get(key) ?? 0) + 1)');
    expect(repositorySource).toContain('match.quantity !== count');
  });

  it('separates manual SVG packet-created and MDF-card-created audit/outbox events', () => {
    expect(repositorySource).toContain('writeManualSvgCreatedAudit');
    expect(repositorySource).toContain('writeManualSvgMdfCardAudit');
    expect(repositorySource).toContain('enqueueManualSvgCreatedEvent');
    expect(repositorySource).toContain('enqueueManualSvgMdfCardEvent');
    expect(repositorySource).toContain('event: MANUAL_SVG_COMPLETED_EVENT');
    expect(repositorySource).toContain('mdfMachineFileCardCreated: true');
    expect(repositorySource).toContain(':mdf-card-created`');
    expect(repositorySource).not.toContain('enqueueManualSvgEvents');
    expect(repositorySource).not.toContain('manual-svg-upload-mdf-card-created');
  });

  it('records one audit event per manual SVG uploaded file and queues Telegram sending', () => {
    expect(repositorySource).toContain("const MANUAL_SVG_FILE_UPLOADED_EVENT = 'cnc.manual_svg_upload.file_uploaded'");
    expect(repositorySource).toContain('for (const file of decodedFiles)');
    expect(repositorySource).toContain('writeManualSvgFileUploadedAudit');
    expect(repositorySource).toContain("entityType: 'cnc_manual_svg_upload_file'");
    expect(repositorySource).toContain('telegramSendEnabled');
    expect(repositorySource).toContain('generatedScreenshotContrast');
    expect(repositorySource).toContain('enqueueManualSvgTelegramSendRequest');
    expect(repositorySource).toContain('assertManualSvgTelegramCutJobReady');
    expect(repositorySource).toContain('manualSvgCutJobDisplayNumber(packet) !== null');
    expect(repositorySource).not.toContain('packet.svgCutResultId != null;');
    expect(repositorySource).toContain('MANUAL_SVG_TELEGRAM_MDF_CARD_REQUIRED');
    expect(repositorySource).toContain('manualSvgMdfCardEventExists(tx, input.packet)');
    expect(repositorySource).toContain('sourceFiles: manualSvgUploadSourceFileIdentities(dto.sourceFiles ?? [])');
    expect(repositorySource).toContain('const { sourceFiles: _sourceFiles, ...payloadDto } = dto');
    expect(repositorySource).toContain('renderManualSvgScreenshot');
    expect(repositorySource).toContain('lockActiveManualSvgTelegramSend');
  });

  it('skips Telegram SVG reverse import when source file already belongs to a cut job', () => {
    const replayIndex = repositorySource.indexOf('const replayResponse = await reconcileIdempotency(');
    const preflightIndex = repositorySource.indexOf('const skippedDuplicateSourceFileResponse = await skippedExistingTelegramSvgSourceFileResponse(');
    const insertPacketIndex = repositorySource.indexOf('const packetId = existing?.packet_id ?? await insertPacket(tx, resolvedCommand, payloadHash);');
    const resolverIndex = repositorySource.indexOf('const matchedDto = await resolveItemMatches(tx, effectiveCommand.dto);');
    expect(repositorySource).toContain('if (replayResponse) return replayResponse;');
    expect(repositorySource).toContain('lockSvgSourceFileIfPresent');
    expect(repositorySource).toContain('skippedExistingTelegramSvgSourceFileResponse');
    expect(repositorySource).toContain('findExistingSvgCutJobForSourceFile');
    expect(repositorySource).toContain('skipExistingTelegramSvgCutJobForSourceFile');
    expect(repositorySource).toContain('cnc_manual_svg_upload_files file');
    expect(repositorySource).toContain("lower(file.content_sha256)=lower($1)");
    expect(repositorySource).toContain("packet.svg_cut_import_status='imported'");
    expect(repositorySource).toContain('packet.packet_id::text AS packet_id');
    expect(repositorySource).toContain("svg_job.status <> 'archived'");
    expect(repositorySource).toContain("job.selection_criteria->'sourceFiles'");
    expect(repositorySource).toContain("job.status <> 'archived'");
    expect(repositorySource).toContain('skippedDuplicateSourceFile');
    expect(repositorySource).toContain('await completeIdempotency(tx, command.dto.idempotencyKey, skippedDuplicateSourceFileResponse);');
    expect(repositorySource).toContain('Telegram scan не создавал новое задание');
    expect(replayIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeGreaterThan(replayIndex);
    expect(resolverIndex).toBeGreaterThan(preflightIndex);
    expect(insertPacketIndex).toBeGreaterThan(preflightIndex);
  });

  it('refreshes a pending manual SVG Telegram send before relinking files', () => {
    expect(repositorySource).toContain('refreshPendingManualSvgTelegramSendRequest');
    expect(repositorySource).toContain('SET message_text=$2');
    expect(repositorySource).toContain('requested_by=$3::bigint');
    expect(repositorySource).toContain('requested_at=now()');
    expect(repositorySource).toContain("requestAction: 'updated_pending'");
  });

  it('supports forced manual SVG cut-job display number without reusing the identity id', () => {
    expect(repositorySource).toContain('requestedCutJobId: command.dto.requestedCutJobId ?? null');
    expect(repositorySource).toContain('allocateCutJobSourceDisplayNumber(tx, \'regular\')');
    expect(repositorySource).toContain('CUT_JOB_NUMBER_CONFLICT');
    expect(repositorySource).toContain('suggestedCutJobIds');
    expect(repositorySource).toContain('ensureSvgCutJobDisplayNumberAvailable');
    expect(repositorySource).toContain('suggestCutJobDisplayNumbers');
    expect(repositorySource).toContain('source_display_number');
    expect(repositorySource).toContain('existing_job.cut_job_id <> $2::bigint');
    expect(repositorySource).not.toContain('ON CONFLICT (cut_job_id) DO NOTHING');
    expect(repositorySource).not.toContain('syncCutJobIdentitySequence');
  });

  it('explains manual SVG order/detail match failures with per-detail reasons', () => {
    expect(repositorySource).toContain('buildManualSvgOrderScopeProblems');
    expect(repositorySource).toContain('Не все детали SVG найдены в выбранных заказах');
    expect(repositorySource).toContain('Размер в SVG');
    expect(repositorySource).toContain('Есть детали');
    expect(repositorySource).toContain('Количество в SVG');
    expect(repositorySource).toContain('problems: unmatched.slice(0, 50)');
  });

  it('supports informative non-MDF SVG imports without order-detail links', () => {
    expect(repositorySource).toContain("manualDto.matchMode === 'informational'");
    expect(repositorySource).toContain('buildInformationalSvgCutImportPlan');
    expect(repositorySource).toContain('Информативный SVG: связь с деталями ERP не требуется');
    expect(repositorySource).toContain('orderDetailId: null');
    expect(repositorySource).toContain("itemKey: informationalSvgItemKey(item, index)");
    expect(repositorySource).toContain("sheetMaterialTypeId: null");
    expect(repositorySource).toContain('buildInformationalSvgPdfDetailRows');
    expect(repositorySource).toContain('snapshotPieces.length');
  });

  it('emits only one MDF-card event for repeated same-source manual SVG follow-up', async () => {
    const { queries, first, second } = await runManualSvgMdfFollowupSequence();
    const auditEvents = queries
      .filter((query) => /INSERT INTO audit_log/i.test(query.text))
      .map((query) => query.params[0]);
    const outboxEvents = queries
      .filter((query) => /INSERT INTO outbox_events/i.test(query.text))
      .map((query) => query.params[0]);
    const outboxKeys = queries
      .filter((query) => /INSERT INTO outbox_events/i.test(query.text))
      .map((query) => query.params[4]);

    expect(first.createdMdfMachineFileCard).toBe(true);
    expect(second.createdMdfMachineFileCard).toBe(false);
    expect(first.packet.completionStatus).toBe('pending');
    expect(first.packet.thumbsUp).toBe(false);
    expect(auditEvents.filter((event) => event === 'cnc.manual_svg_upload.created')).toHaveLength(0);
    expect(auditEvents.filter((event) => event === 'cnc.manual_svg_upload.mdf_card_created')).toHaveLength(1);
    expect(outboxEvents.filter((event) => event === 'cnc.manual_svg_upload.created')).toHaveLength(0);
    expect(outboxEvents.filter((event) => event === 'cnc.manual_svg_upload.mdf_card_created')).toHaveLength(1);
    expect(outboxKeys.filter((key) => key === 'cnc-manual-svg:00000000-0000-0000-0000-000000000091:source-1:mdf-card-created'))
      .toHaveLength(1);
    expect(outboxEvents.filter((event) => event === 'mdf.board.completed')).toHaveLength(0);
    expect(queries.some((query) =>
      /UPDATE cnc_telegram_packets/i.test(query.text) &&
      /completion_status = 'completed'/i.test(query.text),
    )).toBe(false);
  });

  it('uses database current date for today when caller omits date', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/SELECT CURRENT_DATE::text AS workday/i.test(text)) {
          return { rows: [{ workday: '2026-07-24' }] };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user() });

    expect(result.workday).toBe('2026-07-24');
    expect(queries[1]?.params).toEqual(['2026-07-24', '2026-07-24', 'erp-manual-svg-upload']);
  });

  it('queries packets and bath readiness for a date range', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({
      currentUser: user(),
      workdayFrom: '2026-07-18',
      workdayTo: '2026-07-24',
    });

    expect(result.workday).toBe('2026-07-24');
    expect(queries[0]?.text).toContain('p.workday BETWEEN $1::date AND $2::date');
    expect(queries[0]?.params).toEqual(['2026-07-18', '2026-07-24', 'erp-manual-svg-upload']);
    expect(queries[1]?.text).toContain('p.workday BETWEEN $1::date AND $2::date');
    expect(queries[1]?.params).toEqual(['2026-07-18', '2026-07-24']);
  });

  it('ingests structured packets with idempotency, audit and outbox writes', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: ingestDto(),
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(result).toMatchObject({
      applied: true,
      ignoredStaleSourceVersion: false,
      auditId: 'audit-1',
      packet: {
        cuttingSequenceNo: 12,
        itemCount: 1,
        itemQuantityTotal: 4,
        items: [{ matchDetailId: 3101, matchDetailQuantity: 4 }],
        svgCutSheets: [{ cutGroupId: 100, sheetIndex: 0, sheetNumber: 1, detailIds: [3101, 3101] }],
        sourceCreatedAt: '2026-07-24T07:59:00.000Z',
      },
    });
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys');
    expect(sql).toContain('FROM unnest($1::bigint[], $2::bigint[])');
    expect(sql).toContain('svg_cut_sheets_json');
    expect(sql).toContain('cut_result_placement placement');
    expect(sql).toContain('matched_detail.quantity AS match_detail_quantity');
    expect(sql).not.toMatch(/\b(raw_gcode|screenshot_path|file_path)\b/i);
    const idempotencyInsert = queries.find((query) =>
      /INSERT INTO command_idempotency_keys/i.test(query.text),
    );
    expect(idempotencyInsert?.params).not.toContain('request-cnc-1');
    const packetInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packets/i.test(query.text),
    );
    expect(packetInsert?.params[5]).toBe('2026-07-24T08:00:00.000Z');
    expect(packetInsert?.params[6]).toBe('2026-07-24T07:59:00.000Z');
    expect(packetInsert?.params[18]).toBe('2026-07-24T08:00:00.000Z');
  });

  it('uses source creation time when Telegram update time is absent', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = ingestDto();
    delete (dto.source as { updatedAt?: string }).updatedAt;

    await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-1',
    });

    const packetInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packets/i.test(query.text),
    );
    expect(packetInsert?.params[5]).toBe('2026-07-24T07:59:00.000Z');
    expect(packetInsert?.params[6]).toBe('2026-07-24T07:59:00.000Z');
    expect(packetInsert?.params[18]).toBe('2026-07-24T07:59:00.000Z');
  });

  it('skips duplicate Telegram SVG source before packet and board side effects', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const svgSha = 'b'.repeat(64);
    const existingPacketId = '00000000-0000-0000-0000-000000000104';
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/WITH manual_file AS/i.test(text) && /job\.selection_criteria->'sourceFiles'/i.test(text)) {
          return {
            rows: [{
              cut_job_id: 98,
              cut_job_display_number: '104',
              cut_result_id: 500,
              packet_id: existingPacketId,
              file_name: 'CNC#1_1234.svg',
              matched_by: 'cut_job_selection',
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              packet_id: existingPacketId,
              external_packet_key: 'erp-svg-upload:existing',
              source_chat_id: 'erp-manual-svg-upload',
              source_message_id: null,
              source_version: 1,
              cutting_sequence_no: 104,
              svg_cut_job_id: 98,
              svg_cut_job_display_number: '104',
              svg_cut_result_id: 500,
              svg_cut_import_status: 'imported',
            })],
          };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:duplicate-svg-source-preflight',
      externalPacketKey: 'telegram:-100123:321',
      programName: 'CNC#1_1234.svg',
      sourceFiles: [{
        kind: 'svg' as const,
        fileName: 'CNC#1_1234.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 1234,
        sha256: svgSha,
      }],
    };

    const result = await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-duplicate-svg-source-preflight',
    });

    const lockIndex = queries.findIndex((query) => /pg_advisory_xact_lock\(hashtextextended/i.test(query.text));
    const duplicateIndex = queries.findIndex((query) => /WITH manual_file AS/i.test(query.text));
    const loadPacketIndex = queries.findIndex((query) => /FROM cnc_telegram_packets p/i.test(query.text));
    const completeIdempotencyIndex = queries.findIndex((query) =>
      /UPDATE command_idempotency_keys/i.test(query.text)
      && query.params[0] === 'cnc:test:repo:duplicate-svg-source-preflight',
    );

    expect(result).toMatchObject({
      applied: false,
      ignoredStaleSourceVersion: false,
      packet: {
        packetId: existingPacketId,
        cuttingSequenceNo: 104,
        svgCutJobId: 98,
        svgCutJobDisplayNumber: '104',
        svgCutImportStatus: 'imported',
      },
      skippedDuplicateSourceFile: {
        status: 'skipped',
        sha256: svgSha,
        fileName: 'CNC#1_1234.svg',
        cutJobId: 98,
        cutJobDisplayNumber: '104',
        cutResultId: 500,
        packetId: existingPacketId,
      },
    });
    expect(lockIndex).toBeGreaterThan(-1);
    expect(duplicateIndex).toBeGreaterThan(lockIndex);
    expect(loadPacketIndex).toBeGreaterThan(duplicateIndex);
    expect(completeIdempotencyIndex).toBeGreaterThan(loadPacketIndex);
    expect(queries[duplicateIndex]?.params).toEqual([svgSha, null]);
    expect(queries[duplicateIndex]?.text).toContain("svg_job.status <> 'archived'");
    expect(queries[duplicateIndex]?.text).toContain("job.status <> 'archived'");
    expect(queries.some((query) => /INSERT INTO cnc_telegram_packets/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cnc_telegram_packet_items/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cut_job\s*\(/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO audit_log/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO outbox_events/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /projectTelegramLabelMap/i.test(query.text))).toBe(false);
  });

  it('replays completed duplicate SVG idempotency before archived-state rechecks', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const svgSha = 'c'.repeat(64);
    const existingPacketId = '00000000-0000-0000-0000-000000000204';
    const storedResponse = {
      packet: {
        packetId: existingPacketId,
        externalPacketKey: 'erp-svg-upload:existing',
        sourceVersion: 1,
        cuttingSequenceNo: 104,
        svgCutJobId: 98,
        svgCutJobDisplayNumber: '104',
        svgCutResultId: 500,
        svgCutImportStatus: 'imported',
      },
      requestId: 'request-cnc-duplicate-svg-source-preflight',
      applied: false,
      ignoredStaleSourceVersion: false,
      skippedDuplicateSourceFile: {
        status: 'skipped',
        sha256: svgSha,
        fileName: 'CNC#1_1234.svg',
        cutJobId: 98,
        cutJobDisplayNumber: '104',
        cutResultId: 500,
        packetId: existingPacketId,
        note: 'SVG-файл уже есть в задании на раскрой 104. Telegram scan не создавал новое задание.',
      },
    };
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM command_idempotency_keys/i.test(text)) {
          const inserted = queries.find((query) =>
            /INSERT INTO command_idempotency_keys/i.test(query.text),
          );
          return {
            rows: [{
              request_hash: inserted?.params[4],
              response_json: storedResponse,
              status: 'completed',
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:duplicate-svg-source-replay',
      externalPacketKey: 'telegram:-100123:321',
      programName: 'CNC#1_1234.svg',
      sourceFiles: [{
        kind: 'svg' as const,
        fileName: 'CNC#1_1234.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 1234,
        sha256: svgSha,
      }],
    };

    const result = await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-duplicate-svg-source-recovery',
    });

    expect(result).toEqual(storedResponse);
    expect(queries.some((query) => /WITH manual_file AS/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cnc_telegram_packets/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cnc_telegram_packet_items/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cut_job\s*\(/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO audit_log/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO outbox_events/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE command_idempotency_keys/i.test(query.text))).toBe(false);
  });

  it('returns only posted and completed columns for the daily CNC board', async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000011',
                completion_status: 'pending',
                thumbs_up: false,
                parse_status: 'needs_review',
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000012',
                completion_status: 'completed',
                thumbs_up: true,
                svg_cut_job_id: 35,
                svg_cut_job_display_number: '67',
                svg_cut_result_id: 54,
                svg_cut_result_no: 3,
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.map((column) => [column.key, column.title, column.total])).toEqual([
      ['parsed', 'Файлы на станке', 1],
      ['completed', 'Выполнено', 1],
      ['baths', 'Ванны', 0],
      ['baths_ready', 'Готовы к закатке', 0],
      ['completed_laminated', 'Распиленные файлы', 0],
      ['baths_laminated', 'Закатаны/выданы', 0],
      ['completed_baths', 'Завершенные ванны', 0],
    ]);
    expect(queries[0]).toContain('LEFT JOIN cut_result svg_result');
    expect(queries[0]).toContain('LEFT JOIN cut_job svg_job');
    expect(queries[0]).toContain('svg_job.source_display_number AS svg_cut_job_display_number');
    expect(queries[0]).toContain('svg_result.result_no AS svg_cut_result_no');
    expect(result.columns[1].packets[0]).toMatchObject({
      svgCutJobId: 35,
      svgCutJobDisplayNumber: '67',
      svgCutResultId: 54,
      svgCutResultNo: 3,
    });
  });

  it('archives a completed machine file only when every detail of every linked order is packed or later', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/latest_vacuum_results/i.test(text)) return { rows: [] };
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000031',
                packet_item_id: '00000000-0000-0000-0000-000000000041',
                all_linked_order_details_packed_or_later: true,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000031',
                packet_item_id: '00000000-0000-0000-0000-000000000046',
                order_name: '2690',
                item_order_id: 2690,
                match_order_id: 2690,
                match_detail_id: 3201,
                all_linked_order_details_packed_or_later: true,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000032',
                packet_item_id: '00000000-0000-0000-0000-000000000042',
                all_linked_order_details_packed_or_later: true,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000032',
                packet_item_id: '00000000-0000-0000-0000-000000000043',
                source_item_key: '2689:32:497x477',
                detail_number: 32,
                match_detail_id: 3102,
                all_linked_order_details_packed_or_later: false,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000033',
                packet_item_id: '00000000-0000-0000-0000-000000000044',
                match_status: 'conflict',
                item_order_id: null,
                match_order_id: null,
                all_linked_order_details_packed_or_later: false,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000034',
                packet_item_id: '00000000-0000-0000-0000-000000000045',
                match_status: 'needs_review',
                all_linked_order_details_packed_or_later: false,
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.find((column) => column.key === 'completed')?.packets)
      .toHaveLength(3);
    expect(result.columns.find((column) => column.key === 'completed_laminated')?.packets)
      .toMatchObject([{
        packetId: '00000000-0000-0000-0000-000000000031',
        allLinkedOrderDetailsPackedOrLater: true,
    }]);
    expect(database.query.mock.calls[0]?.[0]).toContain("= 'packed'");
    expect(database.query.mock.calls[0]?.[0]).toContain('FROM order_details linked_detail');
    expect(database.query.mock.calls[0]?.[0]).toContain('COUNT(linked_detail.detail_id) > 0');
    expect(database.query.mock.calls[0]?.[0]).toContain(
      'linked_detail_status.sort_order >= packed_status.sort_order',
    );
    expect(database.query.mock.calls[0]?.[0]).toContain('linked_detail.delete_flag = false');
  });

  it('lists stored machine-file cutting sequence numbers for an order card', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        return {
          rows: [{
            packet_id: '00000000-0000-0000-0000-000000000021',
            external_packet_key: 'telegram:-100:10',
            cutting_sequence_no: 7,
            source_message_id: 10,
            workday: '2026-07-24',
            program_name: 'CNC#1_2700.TXT',
            material_name: 'МДФ 16мм',
            completion_status: 'pending',
            source_created_at: '2026-07-24T08:00:00.000Z',
            item_quantity_total: 5,
          }],
        };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listOrderCuttingSequences({
      currentUser: user(),
      orderId: 2700,
    });

    expect(queries[0]?.text).toContain('p.cutting_sequence_no IS NOT NULL');
    expect(queries[0]?.text).toContain('COALESCE(i.match_order_id, order_key.order_id) = $1::bigint');
    expect(queries[0]?.params).toEqual([2700]);
    expect(result).toEqual({
      orderId: 2700,
      sequences: [{
        packetId: '00000000-0000-0000-0000-000000000021',
        externalPacketKey: 'telegram:-100:10',
        cuttingSequenceNo: 7,
        sourceMessageId: 10,
        workday: '2026-07-24',
        programName: 'CNC#1_2700.TXT',
        materialName: 'МДФ 16мм',
        completionStatus: 'pending',
        sourceCreatedAt: '2026-07-24T08:00:00.000Z',
        itemQuantityTotal: 5,
      }],
    });
  });

  it('exposes unique ERP order ids for unmatched CNC packet item order names', async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                order_name: '2706',
                item_order_id: 11450,
                match_order_id: null,
                match_detail_id: null,
                match_status: 'unmatched',
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-28' });
    const sql = queries.join('\n');
    const item = result.columns.flatMap((column) => column.packets)
      .flatMap((packet) => packet.items)[0];

    expect(sql).toContain('COALESCE(i.match_order_id, item_order.order_id) AS item_order_id');
    expect(sql).toContain('matched_order.delete_flag');
    expect(sql).toContain('LEFT JOIN orders matched_order');
    expect(sql).toContain('HAVING COUNT(*) = 1');
    expect(item).toMatchObject({
      orderName: '2706',
      orderId: 11450,
      matchOrderId: null,
      matchDetailId: null,
      matchStatus: 'unmatched',
    });
  });

  it('marks packet items linked to soft-deleted matched orders', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                order_name: '2706',
                item_order_id: 11450,
                order_delete_flag: true,
                match_order_id: 11450,
                match_detail_id: 7788,
                match_status: 'matched',
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-28' });
    const item = result.columns.flatMap((column) => column.packets)
      .flatMap((packet) => packet.items)[0];

    expect(item).toMatchObject({
      orderId: 11450,
      matchOrderId: 11450,
      orderDeleted: true,
    });
  });

  it('hides noisy RapidOCR warning in the daily CNC board response', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                analysis_warnings_json: [
                  'RapidOCR found text, but no detail rows with order and size',
                  'Real operator-facing warning',
                ],
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns[1]?.packets[0]?.analysisWarnings).toEqual([
      'Real operator-facing warning',
    ]);
  });

  it('splits vacuum bath cards by completed detail quantities', async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (/latest_vacuum_results/i.test(text)) {
          return {
            rows: [
              bathPlacementRow({
                cut_result_id: 500,
                cut_job_id: 30,
                result_no: 2,
                order_detail_id: 3101,
                detail_number: 31,
                completed_quantity: 2,
              }),
              bathPlacementRow({
                cut_result_id: 500,
                cut_job_id: 30,
                result_no: 2,
                order_detail_id: 3101,
                detail_number: 31,
                completed_quantity: 2,
                sheet_index: 1,
                sheet_ordinal: 2,
              }),
              bathPlacementRow({
                cut_result_id: 501,
                cut_job_id: 31,
                result_no: 1,
                order_detail_id: 3201,
                detail_number: 32,
                completed_quantity: 0,
              }),
            ],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });
    const sql = queries.join('\n');

    expect(sql).toContain("= 'vacuum_table'");
    expect(sql).toContain('cut_result_placement');
    expect(sql).toContain('cut_result_sheet_map');
    expect(sql).toContain('cut_result_label_map_projection');
    expect(sql).toContain('fallback_target_details');
    expect(sql).toContain('completed_whole_order_keys');
    expect(sql).toContain('whole_order_target_details');
    expect(sql).toContain("lower(packet_comment.comment_text) LIKE '%весь%'");
    expect(sql).toContain("regexp_matches(\n        packet_comment.comment_text,\n        '(^|[^0-9])([0-9]{4,})([^0-9]|$)'");
    expect(sql).toContain('1000000000::integer AS completed_quantity');
    expect(sql).toContain('LEAST(SUM(target.completed_quantity), 1000000000::bigint)::integer');
    expect(sql).toContain('candidate_vacuum_results AS (');
    expect(sql).toContain('latest_vacuum_results AS (');
    expect(sql).toContain('SELECT DISTINCT ON (candidate.cut_job_id)');
    expect(sql).toContain('FROM candidate_vacuum_results candidate');
    expect(sql).toContain('(current_result.result_no = r.result_no) AS is_current_result');
    expect(sql).toContain('LEFT JOIN cut_result current_result');
    expect(sql).toContain('LEFT JOIN cut_result_archive_state archive');
    expect(sql).toContain("j.status <> 'archived'");
    expect(sql).toContain('archive.archived_at IS NULL');
    expect(sql).toContain('candidate.is_current_result DESC');
    expect(sql).toContain('candidate.result_created_at DESC');
    expect(sql).toContain('lower(trim(i.order_name)) AS order_key');
    expect(sql).toContain('od.detail_number = item.detail_number');
    expect(sql).toContain('jsonb_array_elements_text(p.comments_json)');
    expect(sql).toContain('item.mdf_relevant');
    expect(sql).toContain('%hdf%');
    expect(sql).toContain('%хдф%');
    expect(sql).toContain('%лдсп%');
    expect(sql).toContain('%ldsp%');
    expect(sql).toContain('%fanera%');
    expect(sql).toContain('%фанера%');
    expect(sql).toContain("item.source <> 'ocr'");
    expect(sql).toContain('item.width_mm::numeric = od.width::numeric');
    expect(sql).toContain("item.source = 'ocr'");
    expect(sql).toContain('ABS(item.width_mm::numeric - od.width::numeric) <= 3');
    expect(result.columns.map((column) => [column.key, column.total])).toEqual([
      ['parsed', 0],
      ['completed', 0],
      ['baths', 1],
      ['baths_ready', 1],
      ['completed_laminated', 0],
      ['baths_laminated', 0],
      ['completed_baths', 0],
    ]);
    expect(result.columns[2]?.baths[0]).toMatchObject({
      cutJobId: 31,
      ready: false,
      itemQuantityTotal: 1,
      positionCount: 1,
    });
    expect(result.columns[3]?.baths[0]).toMatchObject({
      cutJobId: 30,
      ready: true,
      itemQuantityTotal: 2,
      positionCount: 1,
      sheets: [
        { cutGroupId: 100, sheetIndex: 0, sheetNumber: 1 },
        { cutGroupId: 100, sheetIndex: 1, sheetNumber: 2 },
      ],
    });
  });

  it('returns Basis-cut set cards created in the requested date range', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/latest_vacuum_results/i.test(text)) {
          return { rows: [] };
        }
        if (/target_bazis_cut_sets/i.test(text)) {
          return {
            rows: [
              {
                bazis_cut_set_id: 8,
                name: 'Набор МДФ',
                created_at: '2026-07-21T08:30:00.000Z',
                sort_order: 0,
                source_order_detail_id: 3101,
                source_order_id: 2689,
                source_order_name: '2689',
                source_order_deleted: false,
                detail_number: 31,
                width_mm: 497,
                height_mm: 477,
                material_name: 'МДФ 16 мм',
                quantity: 2,
                packed_or_later: false,
              },
              {
                bazis_cut_set_id: 8,
                name: 'Набор МДФ',
                created_at: '2026-07-21T08:30:00.000Z',
                sort_order: 1,
                source_order_detail_id: 3201,
                source_order_id: 2701,
                source_order_name: '2701',
                source_order_deleted: false,
                detail_number: 41,
                width_mm: 600,
                height_mm: 400,
                material_name: 'ЛДСП 16 мм',
                quantity: 3,
                packed_or_later: false,
              },
              {
                bazis_cut_set_id: 8,
                name: 'Набор МДФ',
                created_at: '2026-07-21T08:30:00.000Z',
                sort_order: 2,
                source_order_detail_id: 3301,
                source_order_id: 2702,
                source_order_name: '2702',
                source_order_deleted: false,
                detail_number: 42,
                width_mm: 700,
                height_mm: 300,
                material_name: null,
                quantity: 4,
                packed_or_later: false,
              },
              {
                bazis_cut_set_id: 9,
                name: 'Завершенный набор МДФ',
                created_at: '2026-07-22T08:30:00.000Z',
                sort_order: 0,
                source_order_detail_id: 3401,
                source_order_id: 2703,
                source_order_name: '2703',
                source_order_deleted: false,
                detail_number: 43,
                width_mm: 800,
                height_mm: 300,
                material_name: 'МДФ 16 мм',
                quantity: 1,
                packed_or_later: true,
              },
            ],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({
      currentUser: user(),
      workdayFrom: '2026-07-18',
      workdayTo: '2026-07-24',
    });
    const parsed = result.columns.find((column) => column.key === 'parsed');
    const terminalFiles = result.columns.find((column) => column.key === 'completed_laminated');
    const basisQuery = queries.find((query) => /target_bazis_cut_sets/i.test(query.text));

    expect(basisQuery?.params).toEqual(['2026-07-18', '2026-07-24']);
    expect(basisQuery?.text).toContain('cut_set.created_at,');
    expect(basisQuery?.text).toContain('packed_status_threshold');
    expect(basisQuery?.text).toContain('issued_status_threshold');
    expect(basisQuery?.text).not.toContain('order_status_code');
    expect(basisQuery?.text).toContain('LEFT JOIN order_statuses source_order_status');
    expect(basisQuery?.text).toContain('LEFT JOIN mdf_board_manual_moves issued_order_move');
    expect(basisQuery?.text).toContain("issued_order_move.target_column = 'orders_issued'");
    expect(basisQuery?.text).toContain('source_order_status.sort_order >= issued_status.sort_order');
    expect(basisQuery?.text).toContain('WHEN issued_order_move.move_id IS NOT NULL THEN true');
    expect(basisQuery?.text).toContain('AS packed_or_later');
    expect(basisQuery?.text).toContain('cut_set.created_at >= $1::date');
    expect(basisQuery?.text).toContain("cut_set.created_at < ($2::date + INTERVAL '1 day')");
    expect(basisQuery?.text).not.toContain('detail.source_order_detail_id = ANY($1::bigint[])');
    expect(parsed?.total).toBe(1);
    expect(terminalFiles?.total).toBe(1);
    expect(terminalFiles?.bazisCutSets?.map((set) => set.bazisCutSetId)).toEqual([9]);
    expect(parsed?.bazisCutSets).toEqual([
      {
        bazisCutSetId: 8,
        name: 'Набор МДФ',
        createdAt: '2026-07-21T08:30:00.000Z',
        orderCount: 3,
        positionCount: 3,
        itemQuantityTotal: 9,
        items: [
          {
            orderId: 2689,
            orderName: '2689',
            orderDeleted: false,
            detailId: 3101,
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            materialName: 'МДФ 16 мм',
            quantity: 2,
            packedOrLater: false,
          },
          {
            orderId: 2701,
            orderName: '2701',
            orderDeleted: false,
            detailId: 3201,
            detailNumber: 41,
            widthMm: 600,
            heightMm: 400,
            materialName: 'ЛДСП 16 мм',
            quantity: 3,
            packedOrLater: false,
          },
          {
            orderId: 2702,
            orderName: '2702',
            orderDeleted: false,
            detailId: 3301,
            detailNumber: 42,
            widthMm: 700,
            heightMm: 300,
            materialName: 'Не определён',
            quantity: 4,
            packedOrLater: false,
          },
        ],
      },
    ]);
  });

  it('keeps a laminated ready bath visible until every detail is packed or later', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/latest_vacuum_results/i.test(text)) {
          return {
            rows: [
              bathPlacementRow({ laminated_or_later: true }),
              bathPlacementRow({
                order_detail_id: 3102,
                detail_number: 32,
                laminated_or_later: true,
              }),
            ],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.find((column) => column.key === 'baths_ready')?.baths).toEqual([]);
    expect(result.columns.find((column) => column.key === 'baths_laminated')?.baths)
      .toMatchObject([{ cutJobId: 30, ready: true }]);
    expect(result.columns.find((column) => column.key === 'completed_baths')?.baths).toEqual([]);
  });

  it('moves a bath to the completed bath terminal column when every detail is packed or later', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/latest_vacuum_results/i.test(text)) {
          return {
            rows: [
              bathPlacementRow({
                completed_quantity: 0,
                laminated_or_later: true,
                packed_or_later: true,
              }),
              bathPlacementRow({
                order_detail_id: 3102,
                detail_number: 32,
                completed_quantity: 0,
                laminated_or_later: true,
                packed_or_later: true,
              }),
            ],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.find((column) => column.key === 'baths_laminated')?.baths).toEqual([]);
    expect(result.columns.find((column) => column.key === 'completed_baths')?.baths)
      .toMatchObject([{ cutJobId: 30, ready: false }]);
  });

  it('keeps sheet image metadata when updating a completed packet', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: 'sha256:old',
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:completed-image-update',
        source: { ...ingestDto().source, version: 2 },
        thumbsUp: true,
        sheetImage: {
          storageKey: 'tg_100_10.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 12345,
        },
      },
      requestId: 'request-cnc-1',
    });

    const update = queries.find((query) => /UPDATE cnc_telegram_packets/i.test(query.text));
    expect(update?.text).toContain('sheet_image_storage_key = $13');
    expect(update?.text).not.toContain('THEN NULL');
    expect(update?.params[12]).toBe('tg_100_10.jpg');
    expect(update?.params[13]).toBe('image/jpeg');
    expect(update?.params[14]).toBe(12345);
  });

  it('merges a later Telegram SVG sheet image into the existing SVG cut packet', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/cnc_telegram_svg_packet_alias/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000061',
              source_version: 1,
              payload_hash: 'sha256:svg-only',
              cutting_sequence_no: 61,
              completion_status: 'completed',
              thumbs_up: true,
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              packet_id: '00000000-0000-0000-0000-000000000061',
              external_packet_key: 'telegram:-1001996415689:10947',
              cutting_sequence_no: 61,
              source_message_id: 10948,
              source_version: 2,
              program_name: 'CNC#2_2723-18MM.TXT',
              material_name: 'МДФ 18мм',
              sheet_image_storage_key: 'telegram/-1001996415689/10948.jpg',
            })],
          };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:svg-image-alias',
      externalPacketKey: 'telegram:-1001996415689:10948',
      source: {
        ...ingestDto().source,
        chatId: '-1001996415689',
        messageId: 10948,
        createdAt: '2026-08-11T10:35:14.000Z',
        updatedAt: '2026-08-11T10:37:26.000Z',
      },
      workday: '2026-08-11',
      programName: 'CNC#2_2723-18MM.TXT',
      materialName: 'МДФ 18мм',
      sheetImage: {
        storageKey: 'telegram/-1001996415689/10948.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 98765,
      },
      cutLayout: validCutLayout(),
    };

    const result = await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-svg-image-alias',
    });

    const sql = queries.map((query) => query.text).join('\n');
    const packetInsert = queries.find((query) => /INSERT INTO cnc_telegram_packets/i.test(query.text));
    const packetUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets/i.test(query.text) && /source_chat_id = \$2/i.test(query.text),
    );
    const sequenceUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets[\s\S]*cutting_sequence_no = \$2::integer/i.test(query.text),
    );

    expect(sql).toContain('cnc_telegram_svg_packet_alias');
    expect(packetInsert).toBeUndefined();
    expect(packetUpdate?.params[0]).toBe('00000000-0000-0000-0000-000000000061');
    expect(packetUpdate?.params[2]).toBe(10948);
    expect(packetUpdate?.params[4]).toBe(2);
    expect(packetUpdate?.params[12]).toBe('telegram/-1001996415689/10948.jpg');
    expect(sequenceUpdate?.params).toEqual([
      '00000000-0000-0000-0000-000000000061',
      61,
      42,
    ]);
    expect(result.applied).toBe(true);
    expect(result.packet.cuttingSequenceNo).toBe(61);
  });

  it('assigns a cutting sequence number for pending machine packets after item replacement', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: 13, completion_status: 'pending', thumbs_up: false })] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:pending-sequence',
        thumbsUp: false,
        completionStatus: 'pending',
      },
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(sql).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(sql).toContain('MAX(cutting_sequence_no)');
    expect(sql).toContain('packet.cutting_sequence_no IS NULL');
    expect(result.packet.cuttingSequenceNo).toBe(13);
  });

  it('stores explicit Telegram cutting sequence numbers under the same sequence lock', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: 7 })] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:explicit-sequence',
        cuttingSequenceNo: 7,
      },
      requestId: 'request-cnc-1',
    });

    const sequenceUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets[\s\S]*cutting_sequence_no = \$2::integer/i.test(query.text),
    );
    expect(queries.map((query) => query.text).join('\n')).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(sequenceUpdate?.params).toEqual([
      '00000000-0000-0000-0000-000000000001',
      7,
      42,
    ]);
    expect(result.packet.cuttingSequenceNo).toBe(7);
  });

  it('keeps ingesting when an explicit Telegram cutting sequence number is already taken', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/WHERE cutting_sequence_no = \$2::integer/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000099' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: null })] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:explicit-sequence-conflict',
        cuttingSequenceNo: 7,
      },
      requestId: 'request-cnc-1',
    });

    const sequenceUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets[\s\S]*cutting_sequence_no = \$2::integer/i.test(query.text),
    );
    expect(sequenceUpdate).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.packet.cuttingSequenceNo).toBeNull();
  });

  it('replays completed idempotency without applying a later explicit cutting sequence number', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:completed-explicit-sequence',
      cuttingSequenceNo: 17,
    };
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM command_idempotency_keys/i.test(text)) {
          const inserted = queries.find((query) =>
            /INSERT INTO command_idempotency_keys/i.test(query.text),
          );
          return {
            rows: [{
              request_hash: inserted?.params[4],
              response_json: {
                packet: { packetId: '00000000-0000-0000-0000-000000000001', cuttingSequenceNo: null },
                requestId: 'request-cnc-1',
                applied: false,
                ignoredStaleSourceVersion: false,
              },
              status: 'completed',
            }],
          };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: payloadHashForTest(dto),
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: 17 })] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-1',
    });

    const sequenceUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets[\s\S]*cutting_sequence_no = \$2::integer/i.test(query.text),
    );
    expect(sequenceUpdate).toBeUndefined();
    expect(queries.some((query) => /FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(query.text))).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.packet.cuttingSequenceNo).toBeNull();
  });

  it('replays completed idempotency without assigning a missing cutting sequence for a pending packet', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:completed-auto-sequence',
      thumbsUp: false,
      completionStatus: 'pending' as const,
    };
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM command_idempotency_keys/i.test(text)) {
          const inserted = queries.find((query) =>
            /INSERT INTO command_idempotency_keys/i.test(query.text),
          );
          return {
            rows: [{
              request_hash: inserted?.params[4],
              response_json: {
                packet: { packetId: '00000000-0000-0000-0000-000000000001', cuttingSequenceNo: null },
                requestId: 'request-cnc-1',
                applied: true,
                ignoredStaleSourceVersion: false,
              },
              status: 'completed',
            }],
          };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: payloadHashForTest(dto),
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              cutting_sequence_no: 21,
              completion_status: 'pending',
              thumbs_up: false,
            })],
          };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(sql).not.toContain('MAX(cutting_sequence_no)');
    expect(queries.some((query) => /FROM cnc_telegram_packets p/i.test(query.text))).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.packet.cuttingSequenceNo).toBeNull();
  });

  it('can assign a missing cutting sequence on stale source-version replays', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 5,
              payload_hash: 'sha256:old',
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: 14, source_version: 5 })] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:stale-sequence',
        source: { ...ingestDto().source, version: 4 },
        thumbsUp: false,
        completionStatus: 'pending',
      },
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(result.ignoredStaleSourceVersion).toBe(true);
    expect(sql).toContain('MAX(cutting_sequence_no)');
    expect(result.packet.cuttingSequenceNo).toBe(14);
  });

  it('fills missing item matches from unique ERP detail size', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2690',
                order_id: 2690,
                detail_id: 9006,
                detail_number: 6,
                width: 500,
                height: 350,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:size-match',
        items: [
          {
            sourceItemKey: '2690:none:500x350',
            orderName: '2690',
            detailNumber: null,
            widthMm: 500,
            heightMm: 350,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.71,
            matchStatus: 'unmatched' as const,
            reviewNote: 'OCR did not read detail number',
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[3]).toBe(6);
    expect(itemInsert?.params[9]).toBe(2690);
    expect(itemInsert?.params[10]).toBe(9006);
    expect(itemInsert?.params[11]).toBe('matched');
    expect(itemInsert?.params[12]).toBeNull();
  });

  it('uses OCR tolerance when resolving ERP detail size', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2690',
                order_id: 2690,
                detail_id: 9006,
                detail_number: 6,
                width: 500,
                height: 350,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:ocr-size-tolerance',
        items: [
          {
            sourceItemKey: '2690:none:502x350',
            orderName: '2690',
            detailNumber: null,
            widthMm: 502,
            heightMm: 350,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.71,
            matchStatus: 'unmatched' as const,
            reviewNote: 'OCR did not read detail number',
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[3]).toBe(6);
    expect(itemInsert?.params[9]).toBe(2690);
    expect(itemInsert?.params[10]).toBe(9006);
    expect(itemInsert?.params[11]).toBe('matched');
  });

  it('does not use size tolerance for non-OCR ERP detail resolution', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2690',
                order_id: 2690,
                detail_id: 9006,
                detail_number: 6,
                width: 500,
                height: 350,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:vector-size-exact',
        items: [
          {
            sourceItemKey: '2690:none:502x350',
            orderName: '2690',
            detailNumber: null,
            widthMm: 502,
            heightMm: 350,
            quantity: 1,
            source: 'vector' as const,
            confidence: 1,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[3]).toBeNull();
    expect(itemInsert?.params[9]).toBeNull();
    expect(itemInsert?.params[10]).toBeNull();
    expect(itemInsert?.params[11]).toBe('unmatched');
  });

  it('aggregates repeated rows only after they resolve to the same ERP detail', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2689',
                order_id: 2689,
                detail_id: 9031,
                detail_number: 31,
                width: 497,
                height: 477,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:aggregate-after-match',
        items: [
          {
            sourceItemKey: '2689:31:497x477',
            orderName: '2689',
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            quantity: 3,
            source: 'ocr' as const,
            confidence: 0.93,
            matchStatus: 'unmatched' as const,
          },
          {
            sourceItemKey: '2689:none:497x477',
            orderName: '2689',
            detailNumber: null,
            widthMm: 497,
            heightMm: 477,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.64,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInserts = queries.filter((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0]?.params[3]).toBe(31);
    expect(itemInserts[0]?.params[6]).toBe(4);
    expect(itemInserts[0]?.params[9]).toBe(2689);
    expect(itemInserts[0]?.params[10]).toBe(9031);
    expect(itemInserts[0]?.params[11]).toBe('matched');
  });

  it('does not guess detail numbers for ambiguous ERP sizes', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2677',
                order_id: 2677,
                detail_id: 9010,
                detail_number: 10,
                width: 2297,
                height: 390,
              },
              {
                order_key: '2677',
                order_id: 2677,
                detail_id: 9011,
                detail_number: 11,
                width: 2297,
                height: 390,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:ambiguous-size',
        items: [
          {
            sourceItemKey: '2677:none:2297x390',
            orderName: '2677',
            detailNumber: null,
            widthMm: 2297,
            heightMm: 390,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.68,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[3]).toBeNull();
    expect(itemInsert?.params[9]).toBeNull();
    expect(itemInsert?.params[10]).toBeNull();
    expect(itemInsert?.params[11]).toBe('unmatched');
  });

  it('matches identical duplicate ERP detail rows as one logical detail', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2665',
                order_id: 11409,
                detail_id: 61445,
                detail_number: 17,
                width: 531,
                height: 1965,
              },
              {
                order_key: '2665',
                order_id: 11409,
                detail_id: 62381,
                detail_number: 17,
                width: 531,
                height: 1965,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:logical-duplicate-detail',
        items: [
          {
            sourceItemKey: '2665:17:1965x531',
            orderName: '2665',
            detailNumber: 17,
            widthMm: 1965,
            heightMm: 531,
            quantity: 2,
            source: 'svg' as const,
            confidence: 0.99,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[9]).toBe(11409);
    expect(itemInsert?.params[10]).toBe(62381);
    expect(itemInsert?.params[11]).toBe('matched');
  });

  it('creates a completed cut result command when importing a valid SVG layout', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2689',
                order_id: 2689,
                detail_id: 3101,
                detail_number: 31,
                width: 497,
                height: 477,
              },
            ],
          };
        }
        if (/SELECT od\.detail_id, od\.order_id/i.test(text)) {
          return {
            rows: [
              {
                detail_id: 3101,
                order_id: 2689,
                order_name: '2689',
                order_delete_flag: false,
                detail_number: 31,
                detail_name: 'Detail 31',
                height: 477,
                width: 497,
                order_quantity: 4,
                area: 0.237,
                material_id: 10,
                sheet_material_type_id: 77,
                sheet_material_width_mm: 2070,
                sheet_material_height_mm: 2800,
                material_name: 'MDF 18',
                milling_type_id: null,
                milling_type_name: null,
                edge_type_id: null,
                edge_type_name: null,
                film_id: 88,
                film_name: 'White',
                priority: null,
                production_status_id: null,
                production_status_name: null,
                joint_order_id: null,
                note: null,
                link_cutting_file: null,
                link_cutting_image_file: null,
                link_cad_file: null,
                link_pdf_file: null,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status, cutting_sequence_no/i.test(text)) {
          return { rows: [{ svg_cut_job_id: null, svg_cut_result_id: null, svg_cut_import_status: 'none', cutting_sequence_no: 12 }] };
        }
        if (/INSERT INTO cut_job\s*\(/i.test(text)) {
          return { rows: [{ cut_job_id: 700, created_at: '2026-07-24T08:00:00.000Z' }] };
        }
        if (/INSERT INTO cut_group\s*\(/i.test(text)) {
          return { rows: [{ cut_group_id: 701 }] };
        }
        if (/INSERT INTO cut_job_item\s*\(/i.test(text)) {
          return { rows: [{ cut_job_item_id: 702 }] };
        }
        if (/INSERT INTO cut_group_sheet\s*\(/i.test(text)) {
          return { rows: [{ cut_group_sheet_id: 703 }] };
        }
        if (/INSERT INTO cut_result\s*\(/i.test(text)) {
          return { rows: [{ cut_result_id: 704 }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:svg-cut-ledger',
        cuttingSequenceNo: 12,
        items: [
          {
            sourceItemKey: '2689:31:497x477',
            orderName: '2689',
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            quantity: 1,
            source: 'vector' as const,
            confidence: 1,
            matchOrderId: 2689,
            matchDetailId: 3101,
            matchStatus: 'matched' as const,
          },
        ],
        cutLayout: {
          status: 'valid' as const,
          reasons: [],
          sheet: { widthMm: 2070, heightMm: 2800 },
          partContourCount: 1,
          acceptedItemCount: 1,
          items: [
            {
              orderName: '2689',
              detailNumber: 31,
              widthMm: 497,
              heightMm: 477,
              quantity: 1,
              confidence: 1,
              sourceElementId: 'PartContour-1',
              xMm: 10,
              yMm: 20,
              placedWidthMm: 497,
              placedHeightMm: 477,
              rotated: false,
            },
          ],
        },
      },
      requestId: 'request-cnc-1',
    });

    const commandInsertIndex = queries.findIndex((query) =>
      /INSERT INTO cut_result_command/i.test(query.text) && /'manual_save'/.test(query.text),
    );
    const resultInsertIndex = queries.findIndex((query) => /INSERT INTO cut_result\s*\(/i.test(query.text));
    const commandComplete = queries.find((query) => /UPDATE cut_result_command/i.test(query.text));
    const commandInsert = queries[commandInsertIndex];
    const resultInsert = queries[resultInsertIndex];
    const jobInsert = queries.find((query) => /INSERT INTO cut_job\s*\(/i.test(query.text));

    expect(commandInsertIndex).toBeGreaterThan(-1);
    expect(resultInsertIndex).toBeGreaterThan(commandInsertIndex);
    expect(resultInsert?.text).toContain('command_id, command_payload_hash, request_hash');
    expect(jobInsert?.text).toContain('source_display_number');
    expect(jobInsert?.params[7]).toBe('1');
    expect(queries.some((query) => query.params[0] === 'cut_job_display_number:regular')).toBe(true);
    expect(commandInsert?.params[1]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(resultInsert?.params[1]).toBe(commandInsert?.params[1]);
    expect(resultInsert?.params[2]).toBe(commandInsert?.params[2]);
    expect(JSON.parse(String(resultInsert?.params[4]))).toMatchObject({ displayNumber: '1', unplaced: [] });
    expect(commandComplete?.params).toEqual([700, commandInsert?.params[1], 704]);
  });

  it('does not block Telegram SVG import when chat sequence number is already a cut display number', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2689',
                order_id: 2689,
                detail_id: 3101,
                detail_number: 31,
                width: 497,
                height: 477,
              },
            ],
          };
        }
        if (/SELECT od\.detail_id, od\.order_id/i.test(text)) {
          return {
            rows: [
              {
                detail_id: 3101,
                order_id: 2689,
                order_name: '2689',
                order_delete_flag: false,
                detail_number: 31,
                detail_name: 'Detail 31',
                height: 477,
                width: 497,
                order_quantity: 4,
                area: 0.237,
                material_id: 10,
                sheet_material_type_id: 77,
                sheet_material_width_mm: 2070,
                sheet_material_height_mm: 2800,
                material_name: 'MDF 18',
                milling_type_id: null,
                milling_type_name: null,
                edge_type_id: null,
                edge_type_name: null,
                film_id: 88,
                film_name: 'White',
                priority: null,
                production_status_id: null,
                production_status_name: null,
                joint_order_id: null,
                note: null,
                link_cutting_file: null,
                link_cutting_image_file: null,
                link_cad_file: null,
                link_pdf_file: null,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status, cutting_sequence_no/i.test(text)) {
          return { rows: [{ svg_cut_job_id: null, svg_cut_result_id: null, svg_cut_import_status: 'none', cutting_sequence_no: 12 }] };
        }
        if (/SELECT existing_job\.cut_job_id/i.test(text)) {
          return { rows: [{ cut_job_id: 80 }] };
        }
        if (/FROM generate_series/i.test(text)) {
          return { rows: [{ cut_job_id: 81 }, { cut_job_id: 82 }] };
        }
        if (/INSERT INTO cut_job\s*\(/i.test(text)) {
          return { rows: [{ cut_job_id: 700, created_at: '2026-07-24T08:00:00.000Z' }] };
        }
        if (/INSERT INTO cut_group\s*\(/i.test(text)) {
          return { rows: [{ cut_group_id: 701 }] };
        }
        if (/INSERT INTO cut_job_item\s*\(/i.test(text)) {
          return { rows: [{ cut_job_item_id: 702 }] };
        }
        if (/INSERT INTO cut_group_sheet\s*\(/i.test(text)) {
          return { rows: [{ cut_group_sheet_id: 703 }] };
        }
        if (/INSERT INTO cut_result\s*\(/i.test(text)) {
          return { rows: [{ cut_result_id: 704 }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              svg_cut_job_id: 700,
              svg_cut_result_id: 704,
              svg_cut_import_status: 'imported',
              svg_cut_import_note: 'SVG layout imported into cut job',
            })],
          };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:svg-cut-conflict',
        cuttingSequenceNo: 12,
        items: [
          {
            sourceItemKey: '2689:31:497x477',
            orderName: '2689',
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            quantity: 1,
            source: 'vector' as const,
            confidence: 1,
            matchOrderId: 2689,
            matchDetailId: 3101,
            matchStatus: 'matched' as const,
          },
        ],
        cutLayout: {
          status: 'valid' as const,
          reasons: [],
          sheet: { widthMm: 2070, heightMm: 2800 },
          partContourCount: 1,
          acceptedItemCount: 1,
          items: [
            {
              orderName: '2689',
              detailNumber: 31,
              widthMm: 497,
              heightMm: 477,
              quantity: 1,
              confidence: 1,
              sourceElementId: 'PartContour-1',
              xMm: 10,
              yMm: 20,
              placedWidthMm: 497,
              placedHeightMm: 477,
              rotated: false,
            },
          ],
        },
      },
      requestId: 'request-cnc-1',
    });

    const importUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets/i.test(query.text) &&
      /svg_cut_import_status = \$2/i.test(query.text),
    );
    const jobInsert = queries.find((query) => /INSERT INTO cut_job\s*\(/i.test(query.text));

    expect(queries.some((query) => /SELECT existing_job\.cut_job_id/i.test(query.text))).toBe(false);
    expect(jobInsert?.params[7]).toBe('1');
    expect(importUpdate?.params.slice(1, 5)).toEqual([
      'imported',
      'SVG layout imported into cut job',
      700,
      704,
    ]);
    expect(result.packet.svgCutImportStatus).toBe('imported');
    expect(result.applied).toBe(true);
  });

  it('imports valid Telegram SVG as an informational cut job when ERP detail match is ambiguous', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status, cutting_sequence_no/i.test(text)) {
          return { rows: [{ svg_cut_job_id: null, svg_cut_result_id: null, svg_cut_import_status: 'none', cutting_sequence_no: 104 }] };
        }
        if (/INSERT INTO cut_job\s*\(/i.test(text)) {
          return { rows: [{ cut_job_id: 800, created_at: '2026-08-17T07:00:00.000Z' }] };
        }
        if (/INSERT INTO cut_group\s*\(/i.test(text)) {
          return { rows: [{ cut_group_id: 801 }] };
        }
        if (/INSERT INTO cut_group_sheet\s*\(/i.test(text)) {
          return { rows: [{ cut_group_sheet_id: 803 }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              cutting_sequence_no: 104,
              svg_cut_job_id: 800,
              svg_cut_result_id: null,
              svg_cut_import_status: 'imported',
            })],
          };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:svg-informational-ambiguous-match',
        cuttingSequenceNo: 104,
        materialName: 'МДФ 16мм',
        items: [
          {
            sourceItemKey: '2800:6:95x720',
            orderName: '2800',
            detailNumber: 6,
            widthMm: 95,
            heightMm: 720,
            quantity: 1,
            source: 'vector' as const,
            confidence: 1,
            matchStatus: 'needs_review' as const,
            reviewNote: 'not unique',
          },
        ],
        cutLayout: {
          status: 'valid' as const,
          reasons: [],
          sheet: { widthMm: 2070, heightMm: 2800 },
          partContourCount: 1,
          acceptedItemCount: 1,
          items: [
            {
              orderName: '2800',
              detailNumber: 6,
              widthMm: 95,
              heightMm: 720,
              quantity: 1,
              confidence: 1,
              sourceElementId: 'PartContour-1',
              xMm: 10,
              yMm: 20,
              placedWidthMm: 95,
              placedHeightMm: 720,
              rotated: false,
            },
          ],
        },
      },
      requestId: 'request-cnc-informational',
    });

    const jobInsert = queries.find((query) => /INSERT INTO cut_job\s*\(/i.test(query.text));
    const sheetInsert = queries.find((query) => /INSERT INTO cut_group_sheet\s*\(/i.test(query.text));
    const importUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets/i.test(query.text) &&
      /svg_cut_import_status = \$2/i.test(query.text),
    );

    expect(jobInsert?.params[7]).toBe('1');
    expect(queries.some((query) => /INSERT INTO cut_job_item\s*\(/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cut_result_command/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO cut_result\s*\(/i.test(query.text))).toBe(false);
    expect(JSON.parse(String(sheetInsert?.params[2]))).toMatchObject({
      pieces: [{ label: { orderId: null, orderName: '2800', detailId: null } }],
    });
    expect(importUpdate?.params.slice(1, 5)).toEqual([
      'imported',
      'SVG layout imported into cut job',
      800,
      null,
    ]);
    expect(result.packet.svgCutJobId).toBe(800);
    expect(result.packet.svgCutResultId).toBeNull();
    expect(result.packet.svgCutImportStatus).toBe('imported');
  });

  it('keeps ERP detail matches when manual SVG upload uses lenient validation', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/WHERE p\.packet_id = \$1::uuid/i.test(text) && /LEFT JOIN cnc_telegram_packet_items/i.test(text)) {
          return { rows: [packetRow({ svg_cut_job_id: 700, svg_cut_result_id: 704, svg_cut_import_status: 'imported' })] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/SELECT\s+lower\(trim\(o\.order_name\)\) AS order_key/i.test(text)) {
          return {
            rows: [{
              order_key: '2689',
              order_id: 2689,
              detail_id: 3101,
              detail_number: 31,
              width: 497,
              height: 477,
            }],
          };
        }
        if (/SELECT\s+order_id,\s+order_name\s+FROM orders\s+WHERE order_id = ANY/i.test(text)) {
          return { rows: [{ order_id: 2689, order_name: '2689' }] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status, cutting_sequence_no/i.test(text)) {
          return { rows: [{ svg_cut_job_id: null, svg_cut_result_id: null, svg_cut_import_status: 'none', cutting_sequence_no: 91 }] };
        }
        if (/SELECT od\.detail_id, od\.order_id/i.test(text)) {
          return {
            rows: [{
              detail_id: 3101,
              order_id: 2689,
              order_name: '2689',
              order_delete_flag: false,
              detail_number: 31,
              detail_name: 'Detail 31',
              height: 477,
              width: 497,
              order_quantity: 4,
              area: 0.237,
              material_id: 10,
              sheet_material_type_id: 77,
              sheet_material_width_mm: 2070,
              sheet_material_height_mm: 2800,
              material_name: 'MDF 18',
              doweling: false,
              milling_type_id: null,
              milling_type_name: null,
              edge_type_id: null,
              edge_type_name: null,
              film_id: 88,
              film_name: 'White',
              priority: null,
              production_status_id: null,
              production_status_name: null,
              joint_order_id: null,
              note: null,
              link_cutting_file: null,
              link_cutting_image_file: null,
              link_cad_file: null,
              link_pdf_file: null,
            }],
          };
        }
        if (/SELECT existing_job\.cut_job_id/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cut_job\s*\(/i.test(text)) {
          return { rows: [{ cut_job_id: 700, created_at: '2026-08-12T08:00:00.000Z' }] };
        }
        if (/INSERT INTO cut_group\s*\(/i.test(text)) {
          return { rows: [{ cut_group_id: 701 }] };
        }
        if (/INSERT INTO cut_job_item\s*\(/i.test(text)) {
          return { rows: [{ cut_job_item_id: 702 }] };
        }
        if (/INSERT INTO cut_group_sheet\s*\(/i.test(text)) {
          return { rows: [{ cut_group_sheet_id: 703 }] };
        }
        if (/INSERT INTO cut_result\s*\(/i.test(text)) {
          return { rows: [{ cut_result_id: 704 }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text) && /p\.workday/i.test(text)) {
          return { rows: [packetRow({ svg_cut_job_id: 700, svg_cut_result_id: 704, svg_cut_import_status: 'imported' })] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);
    const dto = {
      ...manualSvgUploadDto(false, 'cnc:test:manual-svg:lenient-match'),
      validationMode: 'lenient' as const,
      cutLayout: {
        ...manualSvgValidCutLayout(),
        status: 'invalid' as const,
        reasons: ['Размер листа отличается от материала'],
      },
    };

    await repo.manualSvgUpload({
      currentUser: user(),
      dto,
      requestId: 'request-manual-svg-lenient-match',
    });

    const packetItemInsert = queries.find((query) => /INSERT INTO cnc_telegram_packet_items/i.test(query.text));
    const cutJobItemInsert = queries.find((query) => /INSERT INTO cut_job_item\s*\(/i.test(query.text));
    const resultInsert = queries.find((query) => /INSERT INTO cut_result\s*\(/i.test(query.text));
    const snapshot = JSON.parse(String(resultInsert?.params[4]));

    expect(packetItemInsert?.params[9]).toBe(2689);
    expect(packetItemInsert?.params[10]).toBe(3101);
    expect(packetItemInsert?.params[11]).toBe('matched');
    expect(cutJobItemInsert?.params[2]).toBe(3101);
    expect(cutJobItemInsert?.params[3]).toBe(2689);
    expect(snapshot.groups[0].sheets[0].placements.pieces[0].label.detailId).toBe(3101);
    expect(snapshot.groups[0].sheets[0].placements.pieces[0].label.orderName).toBe('2689');
  });

  it('does not consult ERP resolver before same-version payload conflict checks', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          throw new Error('resolver should not run before source-version conflict checks');
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: 'sha256:different-raw-payload',
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await expect(repo.ingest({
      currentUser: user(),
      dto: ingestDto(),
      requestId: 'request-cnc-1',
    })).rejects.toMatchObject({ code: 'SOURCE_VERSION_CONFLICT' });

    expect(queries.some((query) => /FROM orders o\s+JOIN order_details od/i.test(query.text))).toBe(false);
  });

  it('marks only fully cut matched details when a packet first becomes completed and automation is enabled', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    let auditIndex = 0;
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: 'sha256:previous',
              completion_status: 'pending',
              thumbs_up: false,
            }],
          };
        }
        if (/FROM unnest\(\$1::bigint\[\], \$2::bigint\[\]\)/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              source_version: 2,
              completion_status: 'completed',
              thumbs_up: true,
              comments_json: [],
            })],
          };
        }
        if (/FROM app_settings/i.test(text)) {
          return { rows: [{ is_active: true, value_json: { value: true } }] };
        }
        if (/FROM production_statuses/i.test(text) && /lower\(trim\(production_status_name\)\) = 'распилен'/i.test(text)) {
          return {
            rows: [{
              production_status_id: 4,
              production_status_name: 'Распилен',
              production_status_code: 'cut',
              sort_order: 40,
            }],
          };
        }
        if (/FROM production_statuses/i.test(text) && /production_status_id = ANY/i.test(text)) {
          return { rows: [{ production_status_id: 2, sort_order: 20 }] };
        }
        if (/WITH completed_quantities AS/i.test(text)) {
          return { rows: [{ order_id: 2689, detail_id: 3101 }] };
        }
        if (/FROM orders\s+WHERE order_id = ANY/i.test(text)) {
          return {
            rows: [{
              order_id: 2689,
              order_name: '2689',
              client_id: 77,
              version: 8,
              production_status_id: 2,
              production_status_from_details_enabled: true,
            }],
          };
        }
        if (/FROM order_details details/i.test(text) && /FOR UPDATE OF details/i.test(text)) {
          return {
            rows: [{
              order_id: 2689,
              detail_id: 3101,
              production_status_id: 2,
              production_status_sort_order: 20,
            }],
          };
        }
        if (/UPDATE order_details/i.test(text) && /RETURNING order_id, detail_id/i.test(text)) {
          return { rows: [{ order_id: 2689, detail_id: 3101 }] };
        }
        if (/UPDATE orders/i.test(text) && /version = version \+ 1/i.test(text)) {
          return {
            rows: [{
              order_id: 2689,
              order_name: '2689',
              client_id: 77,
              version: 9,
              production_status_id: 4,
              production_status_from_details_enabled: true,
            }],
          };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          auditIndex += 1;
          return { rows: [{ audit_id: `audit-${auditIndex}` }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:auto-cut-status',
      source: { ...ingestDto().source, version: 2 },
      cuttingSequenceNo: 12,
      completionStatus: 'completed' as const,
      comments: [],
    };

    await repo.ingest({ currentUser: user(), dto, requestId: 'request-cnc-auto-cut' });

    const targetQuery = queries.find((query) => /WITH completed_quantities AS/i.test(query.text));
    const orderLockIndex = queries.findIndex((query) =>
      /FROM orders\s+WHERE order_id = ANY/i.test(query.text),
    );
    const targetQueryIndex = queries.findIndex((query) => /WITH completed_quantities AS/i.test(query.text));
    const detailLockIndex = queries.findIndex((query) => /FOR UPDATE OF details/i.test(query.text));
    const currentStatusLockIndex = queries.findIndex((query) =>
      /FROM production_statuses/i.test(query.text)
      && /production_status_id = ANY/i.test(query.text),
    );
    const detailUpdate = queries.find((query) =>
      /UPDATE order_details/i.test(query.text) && /RETURNING order_id, detail_id/i.test(query.text),
    );
    const autoCutOutbox = queries.find((query) =>
      /INSERT INTO outbox_events/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_applied',
    );

    expect(targetQuery?.params).toEqual([[3101], [], [2689]]);
    expect(targetQuery?.text).toContain('SUM(GREATEST(item.quantity, 0))');
    expect(targetQuery?.text).toContain('completed.completed_quantity, 0) >= GREATEST');
    expect(orderLockIndex).toBeGreaterThan(-1);
    expect(targetQueryIndex).toBeGreaterThan(orderLockIndex);
    expect(currentStatusLockIndex).toBeGreaterThan(detailLockIndex);
    expect(queries[currentStatusLockIndex]?.text).toContain('FOR SHARE');
    expect(detailUpdate?.params).toEqual([4, [3101]]);
    expect(queries.some((query) =>
      /SELECT recalc_order_production_status\(\$1\)/i.test(query.text)
      && query.params[0] === 2689,
    )).toBe(true);
    expect(autoCutOutbox?.params[4]).toBe('cnc:test:auto-cut-status:auto-cut-status');
  });

  it('does not run auto-cut status changes when the setting is disabled', async () => {
    const queries = await runAutoCutIngest({ settingRows: [] });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it.each([
    { is_active: false, value_json: { value: true } },
    { is_active: true, value_json: { value: false } },
    { is_active: true, value_json: 'true' },
  ])('rejects inactive or malformed auto-cut setting %#', async (settingRow) => {
    const queries = await runAutoCutIngest({ settingRows: [settingRow] });

    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('accepts the legacy raw-boolean setting representation', async () => {
    const queries = await runAutoCutIngest({
      settingRows: [{ is_active: true, value_json: true }],
    });

    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('reconciles an already-completed packet revision without rewriting an already-cut detail', async () => {
    const queries = await runAutoCutIngest({
      previousCompletionStatus: 'completed',
      previousThumbsUp: true,
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: 4,
        production_status_sort_order: 40,
      }],
    });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /pg_advisory_xact_lock/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('applies auto-cut status when a new packet is initially ingested as completed', async () => {
    const queries = await runAutoCutIngest({ previousExists: false });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('does not run auto-cut status changes while the packet remains pending', async () => {
    const queries = await runAutoCutIngest({
      currentCompletionStatus: 'pending',
      currentThumbsUp: false,
    });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('runs auto-cut status changes for a thumbs-up-only completion transition', async () => {
    const queries = await runAutoCutIngest({
      currentCompletionStatus: 'pending',
      currentThumbsUp: true,
    });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('stops auto-cut status changes when the target production status is unavailable', async () => {
    const queries = await runAutoCutIngest({ statusRows: [] });

    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(true);
    expect(queries.some((query) =>
      /pg_advisory_xact_lock/i.test(query.text)
      && query.params[0] === 'status_automation.cnc_mark_cut_details',
    )).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('resolves the target production status by stable code when its name differs', async () => {
    const queries = await runAutoCutIngest({
      statusRows: [{
        production_status_id: 4,
        production_status_name: 'Распил завершён',
        production_status_code: 'cut',
        sort_order: 40,
      }],
    });

    const targetStatusQuery = queries.find((query) =>
      /FROM production_statuses\s+WHERE/i.test(query.text),
    );
    expect(targetStatusQuery?.text).toContain('FOR SHARE');
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('stops before loading a status when the completed packet has no matched details', async () => {
    const queries = await runAutoCutIngest({ currentItemMatched: false });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('waits for the cumulative completed quantity before marking a detail as cut', async () => {
    const queries = await runAutoCutIngest({ targetRows: [] });

    expect(queries.some((query) => /WITH completed_quantities AS/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('does not downgrade a detail whose production status is later than «Распилен»', async () => {
    const queries = await runAutoCutIngest({
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: 7,
        production_status_sort_order: 70,
      }],
    });

    expect(queries.some((query) => /FOR UPDATE OF details/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('does not rewrite a detail already in the target production status', async () => {
    const queries = await runAutoCutIngest({
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: 4,
        production_status_sort_order: 40,
      }],
    });

    expect(queries.some((query) => /FOR UPDATE OF details/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('stops after the parent lock when all candidate orders disappeared', async () => {
    const queries = await runAutoCutIngest({ orderRows: [] });

    expect(queries.some((query) => /FROM orders\s+WHERE order_id = ANY/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /WITH completed_quantities AS/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('updates eligible details without recalculating an order in manual production-status mode', async () => {
    const queries = await runAutoCutIngest({
      orderRows: [{
        order_id: 2689,
        order_name: '2689',
        client_id: 77,
        version: 8,
        production_status_id: 2,
        production_status_from_details_enabled: false,
      }],
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: null,
        production_status_sort_order: null,
      }],
    });

    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /recalc_order_production_status/i.test(query.text))).toBe(false);
    expect(queries.some((query) =>
      /INSERT INTO outbox_events/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_applied',
    )).toBe(true);
  });

  it('passes an explicitly named whole order to the all-details target branch', async () => {
    const queries = await runAutoCutIngest({ comments: ['2689 — весь заказ'] });
    const orderLock = queries.find((query) =>
      /FROM orders\s+WHERE order_id = ANY/i.test(query.text),
    );
    const targetQuery = queries.find((query) => /WITH completed_quantities AS/i.test(query.text));

    expect(orderLock?.params).toEqual([[2689]]);
    expect(orderLock?.text).not.toContain('lower(trim(order_name))');
    expect(targetQuery?.params).toEqual([[3101], [2689], [2689]]);
    expect(targetQuery?.text).toContain('OR details.order_id = ANY($2::bigint[])');
  });

  it('enables auto-cut status and backfills every existing completed card atomically', async () => {
    const { result, queries } = await runAutoCutConfigure();
    const lockIndex = queries.findIndex((query) => /pg_advisory_xact_lock/i.test(query.text));
    const settingReadIndex = queries.findIndex((query) => /FROM app_settings/i.test(query.text));
    const settingWriteIndex = queries.findIndex((query) => /INSERT INTO app_settings/i.test(query.text));
    const backfillIndex = queries.findIndex((query) => /COUNT\(DISTINCT packet.packet_id\)/i.test(query.text));
    const targetQuery = queries.find((query) => /WITH completed_quantities AS/i.test(query.text));

    expect(result).toEqual({
      settingEnabled: true,
      requestId: 'request-auto-cut-configure',
      auditId: 'audit-configure',
      completedPacketCount: 3,
      matchedDetailCount: 1,
      wholeOrderCount: 1,
      changedOrderCount: 1,
      changedDetailCount: 1,
    });
    expect(lockIndex).toBeGreaterThan(-1);
    expect(settingReadIndex).toBeGreaterThan(lockIndex);
    expect(settingWriteIndex).toBeGreaterThan(settingReadIndex);
    expect(backfillIndex).toBeGreaterThan(settingWriteIndex);
    expect(targetQuery?.params).toEqual([[3101], [2689], [2689]]);
    const configureAudit = queries.find((query) =>
      /INSERT INTO audit_log/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_configured',
    );
    const configureOutbox = queries.find((query) =>
      /INSERT INTO outbox_events/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_configured',
    );
    const expectedCounts = {
      completedPacketCount: 3,
      matchedDetailCount: 1,
      wholeOrderCount: 1,
      changedOrderCount: 1,
      changedDetailCount: 1,
    };
    expect(JSON.parse(String(configureAudit?.params[22]))).toMatchObject(expectedCounts);
    expect(JSON.parse(String(configureOutbox?.params[3]))).toMatchObject(expectedCounts);
    expect(queries.some((query) =>
      /UPDATE command_idempotency_keys/i.test(query.text)
      && query.params[0] === 'cnc-auto-cut-status:test-configure',
    )).toBe(true);
  });

  it('disables auto-cut status without running a backfill', async () => {
    const { result, queries } = await runAutoCutConfigure({ enabled: false });

    expect(result).toMatchObject({
      settingEnabled: false,
      completedPacketCount: 0,
      matchedDetailCount: 0,
      changedDetailCount: 0,
    });
    expect(queries.some((query) => /pg_advisory_xact_lock/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /INSERT INTO app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /COUNT\(DISTINCT packet.packet_id\)/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('replays completed auto-cut configuration without repeating the backfill', async () => {
    const replay = {
      settingEnabled: true,
      requestId: 'request-original',
      auditId: 'audit-original',
      completedPacketCount: 3,
      matchedDetailCount: 1,
      wholeOrderCount: 1,
      changedOrderCount: 1,
      changedDetailCount: 1,
    };
    const { result, queries } = await runAutoCutConfigure({ replay });

    expect(result).toEqual(replay);
    expect(queries.some((query) => /pg_advisory_xact_lock/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO app_settings/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('does not enable auto-cut status when «Распилен» is unavailable', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM app_settings/i.test(text)) return { rows: [] };
        if (/FROM production_statuses/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repo.configureAutoCutStatus({
      currentUser: user(),
      enabled: true,
      idempotencyKey: 'cnc-auto-cut-status:test-missing',
      requestId: 'request-missing',
    })).rejects.toMatchObject({ code: 'CNC_AUTO_CUT_STATUS_NOT_FOUND', statusCode: 409 });

    expect(queries.some((query) => /INSERT INTO app_settings/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('resolves explicit and single-order «весь заказ» comments without guessing across orders', () => {
    const item = (orderName: string) => ({ orderName }) as never;

    expect(cncWholeOrderKeys({
      comments: ['11380 — весь заказ'],
      items: [item('11380'), item('11770')],
    })).toEqual(['11380']);
    expect(cncWholeOrderKeys({
      comments: ['весь заказ'],
      items: [item('11380')],
    })).toEqual(['11380']);
    expect(cncWholeOrderKeys({
      comments: ['весь заказ'],
      items: [item('11380'), item('11770')],
    })).toEqual([]);
    expect(cncWholeOrderKeys({
      comments: ['12345 — весь заказ'],
      items: [item('1234'), item('12345')],
    })).toEqual(['12345']);
    expect(cncWholeOrderKeys({
      comments: ['MDF-12 — весь заказ'],
      items: [item('MDF-1'), item('MDF-12')],
    })).toEqual(['mdf-12']);
    expect(cncWholeOrderKeys({
      comments: ['MDF-1-2 — весь заказ'],
      items: [item('MDF-1'), item('MDF-1-2')],
    })).toEqual(['mdf-1-2']);
    expect(cncWholeOrderKeys({
      comments: ['MDF-1-2 и MDF-1 — весь заказ'],
      items: [item('MDF-1'), item('MDF-1-2')],
    })).toEqual(['mdf-1-2', 'mdf-1']);
    expect(cncWholeOrderKeys({
      comments: ['телефон 77001234567 — весь заказ'],
      items: [item('1234'), item('12345')],
    })).toEqual([]);
  });

  it('resolves whole-order comments only to one stable matched order id', () => {
    const item = (
      orderName: string,
      matchOrderId: number | null,
      matchStatus: 'matched' | 'conflict' = 'matched',
    ) => ({
      orderName,
      matchOrderId,
      matchStatus,
    }) as never;

    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('1234', 100), item('12345', 200), item('12345', 200)],
    })).toEqual([200]);
    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('12345', 200), item('12345', 201)],
    })).toEqual([]);
    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('12345', null)],
    })).toEqual([]);
    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('12345', 200, 'conflict')],
    })).toEqual([]);
  });
});

function user(): CurrentUser {
  return {
    id: '42',
    username: 'operator',
    role: 'operator',
    roleId: 11,
    permissions: ['orders.view', 'cut.manage'],
  };
}

function ingestDto() {
  return {
    idempotencyKey: 'cnc:test:repo',
    externalPacketKey: 'chat:-100:message:10',
    source: {
      chatId: '-100',
      messageId: 10,
      version: 1,
      createdAt: '2026-07-24T07:59:00.000Z',
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
    workday: '2026-07-24',
    machine: 'CNC#1',
    programName: 'CNC#1_2689-HDF.TXT',
    materialName: 'ХДФ',
    thumbsUp: true,
    comments: ['ХДФ!!!'],
    tools: [{ toolNumber: 8, spindleRpm: 15000 }],
    items: [
      {
        sourceItemKey: '2689:31:497x477',
        orderName: '2689',
        detailNumber: 31,
        widthMm: 497,
        heightMm: 477,
        quantity: 4,
        source: 'ocr' as const,
        confidence: 0.94,
        matchOrderId: 2689,
        matchDetailId: 3101,
        matchStatus: 'matched' as const,
      },
    ],
  };
}

function payloadHashForTest(dto: ReturnType<typeof ingestDto> & { cuttingSequenceNo?: number }) {
  const { idempotencyKey: _idempotencyKey, cuttingSequenceNo: _cuttingSequenceNo, ...payload } = dto;
  return `sha256:${createHash('sha256').update(stableStringifyForTest(payload)).digest('hex')}`;
}

function validCutLayout() {
  return {
    status: 'valid' as const,
    reasons: [],
    sheet: { widthMm: 2800, heightMm: 2070 },
    items: [
      {
        orderName: '2723',
        detailNumber: 1,
        widthMm: 500,
        heightMm: 350,
        quantity: 1,
        confidence: 1,
        sourceElementId: 'part-2723-1',
        xMm: 10,
        yMm: 20,
        placedWidthMm: 500,
        placedHeightMm: 350,
        rotated: false,
      },
    ],
  };
}

function stableStringifyForTest(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringifyForTest).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringifyForTest(record[key])}`,
  ).join(',')}}`;
}

function packetRow(overrides: Partial<ReturnType<typeof packetRowBase>> = {}) {
  return { ...packetRowBase(), ...overrides };
}

function packetRowBase() {
  return {
    packet_id: '00000000-0000-0000-0000-000000000001',
    external_packet_key: 'chat:-100:message:10',
    cutting_sequence_no: 12,
    source_chat_id: '-100',
    source_message_id: 10,
    source_thread_id: null,
    source_version: 1,
    source_created_at: '2026-07-24T07:59:00.000Z',
    source_updated_at: '2026-07-24T08:00:00.000Z',
    workday: '2026-07-24',
    machine: 'CNC#1',
    program_name: 'CNC#1_2689-HDF.TXT',
    material_name: 'ХДФ',
    sheet_image_storage_key: 'tg_100_10.jpg',
    sheet_image_content_type: 'image/jpeg',
    sheet_image_size_bytes: 12345,
    parse_status: 'parsed',
    completion_status: 'completed',
    thumbs_up: true,
    completed_at: '2026-07-24T08:00:00.000Z',
    rework: false,
    comments_json: ['ХДФ!!!'],
    tools_json: [{ toolNumber: 8, spindleRpm: 15000 }],
    doweling_links_json: [],
    analysis_warnings_json: [],
    ocr_engine: 'glm-ocr-0.9b-q8-llama.cpp',
    parser_version: 'cnc-telegram-structured-v1',
    cut_layout_json: null,
    svg_cut_job_id: 30,
    svg_cut_job_display_number: '12',
    svg_cut_result_id: 500,
    svg_cut_result_no: null,
    svg_cut_import_status: 'imported',
    svg_cut_import_note: null,
    svg_cut_sheets_json: [
      {
        cutGroupId: 100,
        sheetIndex: 0,
        sheetNumber: 1,
        variant: 'auto',
        detailIds: [3101, 3101],
      },
    ],
    updated_at: '2026-07-24T08:00:10.000Z',
    packet_item_id: '00000000-0000-0000-0000-000000000002',
    source_item_key: '2689:31:497x477',
    order_name: '2689',
    item_order_id: 2689,
    detail_number: 31,
    width_mm: 497,
    height_mm: 477,
    quantity: 4,
    item_source: 'ocr',
    confidence: 0.94,
    match_order_id: 2689,
    match_detail_id: 3101,
    match_detail_quantity: 4,
    match_status: 'matched',
    review_note: null,
    laminated_or_later: false,
    all_linked_order_details_packed_or_later: false,
  };
}

async function runManualSvgMdfFollowupSequence() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const packetId = '00000000-0000-0000-0000-000000000091';
  const dto = manualSvgUploadDto(true, 'cnc:test:manual-svg:mdf-followup-1');
  const payloadHash = manualSvgPayloadHashForTest(dto);
  let completed = false;
  let mdfCardCreated = false;
  let auditIndex = 0;
  const mdfCardEventKey = `cnc-manual-svg:${packetId}:source-1:mdf-card-created`;
  const tx = {
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      queries.push({ text, params });
      if (/INSERT INTO command_idempotency_keys/i.test(text)) {
        return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
      }
      if (/p\.workday/i.test(text) && /p\.packet_id = \$1::uuid/i.test(text)) {
        return {
          rows: [manualSvgPacketRow(packetId, completed)],
        };
      }
      if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
        return {
          rows: [{
            ...manualSvgPacketRow(packetId, completed),
            packet_id: packetId,
            source_version: 1,
            payload_hash: payloadHash,
            cutting_sequence_no: 91,
            completion_status: completed ? 'completed' : 'pending',
            thumbs_up: completed,
          }],
        };
      }
      if (/SELECT\s+order_id,\s+order_name\s+FROM orders\s+WHERE order_id = ANY/i.test(text)) {
        return { rows: [{ order_id: 2689, order_name: '2689' }] };
      }
      if (/SELECT\s+lower\(trim\(o\.order_name\)\) AS order_key/i.test(text)) {
        return {
          rows: [{
            order_key: '2689',
            order_id: 2689,
            detail_id: 3101,
            detail_number: 31,
            width: 497,
            height: 477,
          }],
        };
      }
      if (/SELECT\s+o\.order_id,\s+o\.order_name,\s+od\.detail_id/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            order_name: '2689',
            detail_id: 3101,
            detail_number: 31,
            width: 497,
            height: 477,
            quantity: 4,
          }],
        };
      }
      if (/FROM unnest\(\$1::bigint\[\], \$2::bigint\[\]\)/i.test(text)) {
        return { rows: [] };
      }
      if (/SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status, cutting_sequence_no/i.test(text)) {
        return {
          rows: [{
            ...manualSvgPacketRow(packetId, completed),
            svg_cut_job_id: 30,
            svg_cut_result_id: 500,
            svg_cut_import_status: 'imported',
            cutting_sequence_no: 91,
          }],
        };
      }
      if (/SELECT packet_id, source_version, payload_hash, source_chat_id, source_message_id/i.test(text)) {
        return { rows: [] };
      }
      if (/SELECT EXISTS/i.test(text) && /FROM outbox_events/i.test(text) && /idempotency_key = \$1/i.test(text)) {
        return { rows: [{ exists: mdfCardCreated }] };
      }
      if (/UPDATE cnc_telegram_packets/i.test(text) && /completion_status = 'completed'/i.test(text)) {
        completed = true;
        return { rows: [] };
      }
      if (/INSERT INTO outbox_events/i.test(text)) {
        if (params[4] === mdfCardEventKey) mdfCardCreated = true;
        return { rows: [] };
      }
      if (/FROM cnc_telegram_packets p/i.test(text)) {
        return {
          rows: [manualSvgPacketRow(packetId, completed)],
        };
      }
      if (/FROM app_settings/i.test(text)) {
        return { rows: [] };
      }
      if (/INSERT INTO audit_log/i.test(text)) {
        auditIndex += 1;
        return { rows: [{ audit_id: `manual-svg-audit-${auditIndex}` }] };
      }
      return { rows: [] };
    }),
  };
  const repo = new PgCncTelegramRepository({
    transaction: vi.fn((handler) => handler(tx)),
  } as never);

  const first = await repo.manualSvgUpload({
    currentUser: user(),
    dto,
    requestId: 'request-manual-svg-mdf-followup-1',
  });
  const second = await repo.manualSvgUpload({
    currentUser: user(),
    dto: manualSvgUploadDto(true, 'cnc:test:manual-svg:mdf-followup-2'),
    requestId: 'request-manual-svg-mdf-followup-2',
  });
  return { queries, first, second };
}

function manualSvgPacketRow(packetId: string, completed: boolean) {
  return packetRow({
    packet_id: packetId,
    external_packet_key: manualSvgExternalPacketKeyForTest(manualSvgUploadDto(true, 'cnc:test:manual-svg:mdf-followup-row')),
    source_chat_id: 'erp-manual-svg-upload',
    source_message_id: null,
    source_version: 1,
    cutting_sequence_no: 91,
    machine: 'CNC#1',
    program_name: 'manual.svg',
    material_name: 'МДФ 16мм',
    completion_status: completed ? 'completed' : 'pending',
    thumbs_up: completed,
    completed_at: completed ? '2026-08-12T10:00:00.000Z' : null,
    comments_json: ['2689 — весь заказ'],
    tools_json: [],
    ocr_engine: null,
    parser_version: 'erp-manual-svg-upload-v1',
    cut_layout_json: manualSvgValidCutLayout(),
    svg_cut_job_id: 30,
    svg_cut_result_id: 500,
    svg_cut_import_status: 'imported',
    svg_cut_import_note: 'SVG layout imported into cut job',
    svg_cut_sheets_json: [{ cutGroupId: 100, sheetIndex: 0, sheetNumber: 1, detailIds: [3101] }],
    source_item_key: '2689:31:497x477',
    order_name: '2689',
    item_order_id: 2689,
    detail_number: 31,
    width_mm: 497,
    height_mm: 477,
    quantity: 1,
    item_source: 'vector',
    confidence: 0.99,
    match_order_id: 2689,
    match_detail_id: 3101,
    match_status: 'matched',
  });
}

function manualSvgUploadDto(
  createMdfMachineFileCard: boolean,
  idempotencyKey: string,
  requestedCutJobId: number | null = null,
) {
  return {
    idempotencyKey,
    selectedOrderIds: [2689],
    createMdfMachineFileCard,
    matchMode: 'order_details' as const,
    validationMode: 'strict' as const,
    requestedCutJobId,
    svgContentHash: 'a'.repeat(64),
    workday: '2026-08-12',
    machine: 'CNC#1',
    programName: 'manual.svg',
    materialName: 'МДФ 16мм',
    rework: false,
    comments: ['2689 — весь заказ'],
    tools: [],
    parserVersion: 'erp-manual-svg-upload-v1',
    cutLayout: manualSvgValidCutLayout(),
    items: [{
      sourceItemKey: '2689:31:497x477',
      orderName: '2689',
      detailNumber: 31,
      widthMm: 497,
      heightMm: 477,
      quantity: 1,
      source: 'vector' as const,
      confidence: 0.99,
    }],
  };
}

function manualSvgValidCutLayout() {
  return {
    status: 'valid' as const,
    reasons: [],
    sheet: { widthMm: 2800, heightMm: 2070 },
    rawCommentCount: 1,
    partContourCount: 1,
    acceptedItemCount: 1,
    items: [{
      orderName: '2689',
      detailNumber: 31,
      widthMm: 497,
      heightMm: 477,
      quantity: 1,
      confidence: 0.99,
      sourceElementId: 'PartContour-2689-31',
      xMm: 10,
      yMm: 20,
      placedWidthMm: 497,
      placedHeightMm: 477,
      rotated: false,
    }],
  };
}

function manualSvgPayloadHashForTest(dto: ReturnType<typeof manualSvgUploadDto>) {
  const structured = manualSvgStructuredDtoForTest(dto);
  const sourcePayload = { ...structured, completionStatus: 'pending', thumbsUp: false };
  const { idempotencyKey: _idempotencyKey, cuttingSequenceNo: _cuttingSequenceNo, ...payload } = sourcePayload;
  return `sha256:${createHash('sha256').update(stableStringifyForTest(payload)).digest('hex')}`;
}

function manualSvgStructuredDtoForTest(dto: ReturnType<typeof manualSvgUploadDto>) {
  return {
    idempotencyKey: dto.idempotencyKey,
    externalPacketKey: manualSvgExternalPacketKeyForTest(dto),
    source: {
      chatId: 'erp-manual-svg-upload',
      version: 1,
    },
    workday: dto.workday,
    machine: dto.machine,
    programName: dto.programName,
    materialName: dto.materialName,
    parseStatus: 'parsed',
    completionStatus: 'pending',
    thumbsUp: false,
    rework: dto.rework,
    comments: dto.comments,
    tools: dto.tools,
    analysisWarnings: [],
    ocrEngine: null,
    parserVersion: dto.parserVersion,
    cutLayout: dto.cutLayout,
    items: dto.items.map((item) => ({
      ...item,
      matchOrderId: null,
      matchDetailId: null,
      matchStatus: 'unmatched' as const,
      reviewNote: null,
    })),
  };
}

function manualSvgExternalPacketKeyForTest(dto: ReturnType<typeof manualSvgUploadDto>) {
  const identityHash = sha256JsonForTest({
    kind: 'erp-manual-svg-upload-v1',
    matchMode: dto.matchMode,
    validationMode: dto.validationMode,
    selectedOrderIds: [...dto.selectedOrderIds].sort((a, b) => a - b),
    requestedCutJobId: dto.requestedCutJobId ?? null,
    svgContentHash: dto.svgContentHash.toLowerCase(),
    workday: dto.workday ?? null,
    machine: dto.machine?.trim() || null,
    programName: dto.programName?.trim() || null,
    materialName: dto.materialName?.trim() || null,
    rework: dto.rework === true,
    comments: dto.comments ?? [],
    tools: dto.tools ?? [],
    parserVersion: dto.parserVersion?.trim() || null,
    cutLayout: dto.cutLayout,
    items: dto.items,
  });
  return `erp-svg-upload:${identityHash}`;
}

function sha256JsonForTest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return entry;
  })).digest('hex');
}

interface AutoCutIngestOptions {
  previousExists?: boolean;
  previousCompletionStatus?: 'pending' | 'completed' | 'failed';
  previousThumbsUp?: boolean;
  currentCompletionStatus?: 'pending' | 'completed' | 'failed';
  currentThumbsUp?: boolean;
  currentItemMatched?: boolean;
  comments?: string[];
  settingRows?: Array<{ is_active: boolean; value_json: unknown }>;
  statusRows?: Array<{
    production_status_id: number;
    production_status_name: string;
    production_status_code: string | null;
    sort_order: number;
  }>;
  targetRows?: Array<{ order_id: number; detail_id: number }>;
  orderRows?: Array<{
    order_id: number;
    order_name: string;
    client_id: number | null;
    version: number;
    production_status_id: number | null;
    production_status_from_details_enabled: boolean;
  }>;
  detailRows?: Array<{
    order_id: number;
    detail_id: number;
    production_status_id: number | null;
    production_status_sort_order: number | null;
  }>;
}

async function runAutoCutIngest(options: AutoCutIngestOptions = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let auditIndex = 0;
  const targetRows = options.targetRows ?? [{ order_id: 2689, detail_id: 3101 }];
  const orderRows = options.orderRows ?? [{
    order_id: 2689,
    order_name: '2689',
    client_id: 77,
    version: 8,
    production_status_id: 2,
    production_status_from_details_enabled: true,
  }];
  const detailRows = options.detailRows ?? [{
    order_id: 2689,
    detail_id: 3101,
    production_status_id: 2,
    production_status_sort_order: 20,
  }];
  const tx = {
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      queries.push({ text, params });
      if (/INSERT INTO command_idempotency_keys/i.test(text)) {
        return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
      }
      if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
        return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
      }
      if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
        return {
          rows: options.previousExists === false ? [] : [{
            packet_id: '00000000-0000-0000-0000-000000000001',
            source_version: 1,
            payload_hash: 'sha256:previous',
            completion_status: options.previousCompletionStatus ?? 'pending',
            thumbs_up: options.previousThumbsUp ?? false,
          }],
        };
      }
      if (/FROM unnest\(\$1::bigint\[\], \$2::bigint\[\]\)/i.test(text)) {
        return { rows: [] };
      }
      if (/FROM cnc_telegram_packets p/i.test(text)) {
        return {
          rows: [packetRow({
            source_version: 2,
            completion_status: options.currentCompletionStatus ?? 'completed',
            thumbs_up: options.currentThumbsUp ?? true,
            comments_json: options.comments ?? [],
            ...(options.currentItemMatched === false
              ? { match_order_id: null, match_detail_id: null, match_status: 'unmatched' }
              : {}),
          })],
        };
      }
      if (/FROM app_settings/i.test(text)) {
        return {
          rows: options.settingRows ?? [{ is_active: true, value_json: { value: true } }],
        };
      }
      if (/FROM production_statuses/i.test(text)
        && /lower\(trim\(production_status_name\)\) = 'распилен'/i.test(text)) {
        return {
          rows: options.statusRows ?? [{
            production_status_id: 4,
            production_status_name: 'Распилен',
            production_status_code: 'cut',
            sort_order: 40,
          }],
        };
      }
      if (/FROM production_statuses/i.test(text) && /production_status_id = ANY/i.test(text)) {
        const requestedStatusIds = new Set((params[0] as number[]) ?? []);
        return {
          rows: detailRows
            .filter((row) => row.production_status_id !== null
              && requestedStatusIds.has(row.production_status_id))
            .map((row) => ({
              production_status_id: row.production_status_id,
              sort_order: row.production_status_sort_order,
            })),
        };
      }
      if (/WITH completed_quantities AS/i.test(text)) return { rows: targetRows };
      if (/FROM orders\s+WHERE order_id = ANY/i.test(text)) return { rows: orderRows };
      if (/FROM order_details details/i.test(text) && /FOR UPDATE OF details/i.test(text)) {
        return { rows: detailRows };
      }
      if (/UPDATE order_details/i.test(text) && /RETURNING order_id, detail_id/i.test(text)) {
        return { rows: targetRows };
      }
      if (/UPDATE orders/i.test(text) && /version = version \+ 1/i.test(text)) {
        return {
          rows: orderRows.map((row) => ({
            ...row,
            version: row.version + 1,
            production_status_id: 4,
          })),
        };
      }
      if (/INSERT INTO audit_log/i.test(text)) {
        auditIndex += 1;
        return { rows: [{ audit_id: `audit-${auditIndex}` }] };
      }
      return { rows: [] };
    }),
  };
  const database = { transaction: vi.fn((handler) => handler(tx)) };
  const repo = new PgCncTelegramRepository(database as never);
  const dto = {
    ...ingestDto(),
    idempotencyKey: 'cnc:test:auto-cut-status-guard',
    source: { ...ingestDto().source, version: 2 },
    cuttingSequenceNo: 12,
    completionStatus: options.currentCompletionStatus ?? 'completed',
    thumbsUp: options.currentThumbsUp ?? true,
    comments: options.comments ?? [],
  };

  await repo.ingest({ currentUser: user(), dto, requestId: 'request-cnc-auto-cut-guard' });
  return queries;
}

interface AutoCutConfigureOptions {
  enabled?: boolean;
  replay?: {
    settingEnabled: boolean;
    requestId: string;
    auditId: string;
    completedPacketCount: number;
    matchedDetailCount: number;
    wholeOrderCount: number;
    changedOrderCount: number;
    changedDetailCount: number;
  };
}

async function runAutoCutConfigure(options: AutoCutConfigureOptions = {}) {
  const enabled = options.enabled ?? true;
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const requestHash = createHash('sha256').update(stableStringifyForTest({
    actorUserId: '42',
    commandName: 'cnc.telegram_packet.auto_cut_status.configure',
    enabled,
  })).digest('hex');
  const tx = {
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      queries.push({ text, params });
      if (/INSERT INTO command_idempotency_keys/i.test(text)) {
        return options.replay
          ? { rows: [] }
          : { rows: [{ request_hash: requestHash, response_json: null, status: 'processing' }] };
      }
      if (/FROM command_idempotency_keys/i.test(text)) {
        return {
          rows: [{
            request_hash: requestHash,
            response_json: options.replay ?? null,
            status: options.replay ? 'completed' : 'processing',
          }],
        };
      }
      if (/FROM app_settings/i.test(text)) {
        return { rows: [{ is_active: true, value_json: { value: false } }] };
      }
      if (/FROM production_statuses/i.test(text) && /production_status_id = ANY/i.test(text)) {
        return { rows: [{ production_status_id: 2, sort_order: 20 }] };
      }
      if (/FROM production_statuses/i.test(text)) {
        return {
          rows: [{
            production_status_id: 4,
            production_status_name: 'Распилен',
            production_status_code: 'cut',
            sort_order: 40,
          }],
        };
      }
      if (/COUNT\(DISTINCT packet.packet_id\)/i.test(text)) {
        return {
          rows: [{
            completed_packet_count: 3,
            matched_detail_ids: [3101],
            matched_order_ids: [2689],
          }],
        };
      }
      if (/jsonb_array_elements_text/i.test(text)) {
        return {
          rows: [{
            comments_json: ['2689 — весь заказ'],
            items_json: [{ orderName: '2689', matchOrderId: 2689 }],
          }],
        };
      }
      if (/FROM orders\s+WHERE order_id = ANY/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            order_name: '2689',
            client_id: 77,
            version: 8,
            production_status_id: 2,
            production_status_from_details_enabled: true,
          }],
        };
      }
      if (/WITH completed_quantities AS/i.test(text)) {
        return { rows: [{ order_id: 2689, detail_id: 3101 }] };
      }
      if (/FROM order_details details/i.test(text) && /FOR UPDATE OF details/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            detail_id: 3101,
            production_status_id: 2,
            production_status_sort_order: 20,
          }],
        };
      }
      if (/UPDATE order_details/i.test(text) && /RETURNING order_id, detail_id/i.test(text)) {
        return { rows: [{ order_id: 2689, detail_id: 3101 }] };
      }
      if (/UPDATE orders/i.test(text) && /version = version \+ 1/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            order_name: '2689',
            client_id: 77,
            version: 9,
            production_status_id: 4,
            production_status_from_details_enabled: true,
          }],
        };
      }
      if (/INSERT INTO audit_log/i.test(text)) {
        return { rows: [{ audit_id: 'audit-configure' }] };
      }
      return { rows: [] };
    }),
  };
  const repo = new PgCncTelegramRepository({
    transaction: vi.fn((handler) => handler(tx)),
  } as never);
  const result = await repo.configureAutoCutStatus({
    currentUser: user(),
    enabled,
    idempotencyKey: 'cnc-auto-cut-status:test-configure',
    requestId: 'request-auto-cut-configure',
  });
  return { result, queries };
}

function bathPlacementRow(overrides: Record<string, unknown> = {}) {
  return {
    cut_result_id: 500,
    cut_job_id: 30,
    result_no: 2,
    revision_no: 1,
    result_created_at: '2026-07-24T09:00:00.000Z',
    cut_job_name: 'Ванна 2689',
    order_id: 2689,
    order_detail_id: 3101,
    order_name: '2689',
    detail_number: 31,
    width_mm: 497,
    height_mm: 477,
    completed_quantity: 2,
    laminated_or_later: false,
    packed_or_later: false,
    cut_group_id: 100,
    variant: 'auto',
    sheet_index: 0,
    sheet_ordinal: 1,
    sheet_width_mm: 2070,
    sheet_height_mm: 2800,
    ...overrides,
  };
}
