import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { OnecUnitCode } from '../domain/onec-document-normalizer';
import {
  CONSUMPTION_DOC_KINDS,
  type ConsumptionCandidatesFilter,
  type ConsumptionDocKind,
  type ConsumptionDocumentView,
  type OnecDocumentsReaderPort,
} from './onec-documents-reader.types';

interface DocumentRow {
  onec_document_id: string;
  source_id: string;
  onec_ref_key: string;
  doc_kind: ConsumptionDocKind;
  number: string;
  applied_revision: string;
  posted: boolean;
  deleted_in_onec: boolean;
  missing: boolean;
  doc_date: string;
  doc_at: string | null;
  warehouse_ref_key: string | null;
  destination_warehouse_ref_key: string | null;
}

interface LineRow {
  onec_document_id: string;
  onec_document_line_id: string;
  line_no: number;
  warehouse_ref_key: string | null;
  nomenclature_ref_key: string | null;
  quantity: string;
  unit_code: OnecUnitCode | null;
  unit_is_package: boolean;
  is_stock_item: boolean;
  removed: boolean;
  load_conflict_code: string | null;
}

const DOCUMENT_COLUMNS = `d.onec_document_id::text, d.source_id::text, lower(d.onec_ref_key::text) AS onec_ref_key, d.doc_kind, d.number,
  d.applied_revision::text, d.posted, d.deleted_in_onec, d.missing_in_source_at IS NOT NULL AS missing,
  to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date, to_char(d.doc_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS doc_at,
  lower(d.warehouse_ref_key::text) AS warehouse_ref_key, lower(d.destination_warehouse_ref_key::text) AS destination_warehouse_ref_key`;
const LINE_SELECT = `SELECT l.onec_document_id::text, l.onec_document_line_id::text, l.line_no, lower(l.warehouse_ref_key::text) AS warehouse_ref_key,
  lower(l.nomenclature_ref_key::text) AS nomenclature_ref_key, l.quantity::text, l.unit_code, l.unit_is_package, l.is_stock_item,
  l.removed_in_onec_at IS NOT NULL AS removed, l.load_conflict_code
  FROM onec_document_lines l`;

/**
 * Read-порт слоя документов 1С для проекции склада (план 2026-09-30-onec-consumption-documents-plan.md, §3.5).
 * Только чтение документов видов расхода; сопоставление складов/плёнок и источник склада — у потребителя.
 */
@Injectable()
export class OnecDocumentsReader implements OnecDocumentsReaderPort {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
  ) {}

  private available(): void {
    if (this.config.get('BACKEND_ONEC_DOCUMENTS_LOAD', { infer: true }) !== true
      || this.config.get('BACKEND_ENABLE_ONEC_AGENT', { infer: true }) !== true) {
      throw new ApiError(409, 'ONEC_DOCUMENTS_UNAVAILABLE', 'Документы 1С недоступны: загрузка выключена');
    }
  }

  async consumptionCandidates(filter: ConsumptionCandidatesFilter, client: DatabaseClient = this.database): Promise<ConsumptionDocumentView[]> {
    this.available();
    const kinds = (filter.kinds ?? CONSUMPTION_DOC_KINDS).filter((kind) => (CONSUMPTION_DOC_KINDS as readonly string[]).includes(kind));
    if (filter.sourceIds.length === 0 || kinds.length === 0) return [];
    const params: unknown[] = [filter.sourceIds.map(Number), kinds];
    const clauses = ['d.source_id = ANY($1::bigint[])', 'd.doc_kind = ANY($2::text[])'];
    if (filter.documentIds) clauses.push(`d.onec_document_id = ANY($${params.push(filter.documentIds.map(Number))}::bigint[])`);
    if (filter.warehouseRefKeys) {
      const keys = `$${params.push(filter.warehouseRefKeys.map((key) => key.toLowerCase()))}::uuid[]`;
      clauses.push(`(d.destination_warehouse_ref_key = ANY(${keys}) OR d.warehouse_ref_key = ANY(${keys})
        OR EXISTS (SELECT 1 FROM onec_document_lines x WHERE x.onec_document_id = d.onec_document_id AND x.warehouse_ref_key = ANY(${keys})))`);
    }
    const documents = (await client.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM onec_documents d WHERE ${clauses.join(' AND ')} ORDER BY d.onec_document_id`, params,
    )).rows;
    if (documents.length === 0) return [];
    const lines = (await client.query<LineRow>(
      `${LINE_SELECT} WHERE l.onec_document_id = ANY($1::bigint[]) ORDER BY l.onec_document_id, l.line_no, l.onec_document_line_id`,
      [documents.map((row) => Number(row.onec_document_id))],
    )).rows;
    return this.assemble(documents, lines);
  }

  async lockDocumentForProjection(documentId: number, client: DatabaseClient): Promise<ConsumptionDocumentView | null> {
    this.available();
    // FOR SHARE шапки: загрузчик меняет документ и его строки только под FOR NO KEY UPDATE шапки — ждёт commit вызывающего.
    const documents = (await client.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM onec_documents d
        WHERE d.onec_document_id = $1 AND d.doc_kind = ANY($2::text[]) FOR SHARE OF d`,
      [documentId, CONSUMPTION_DOC_KINDS],
    )).rows;
    if (documents.length === 0) return null;
    const lines = (await client.query<LineRow>(
      `${LINE_SELECT} WHERE l.onec_document_id = $1 ORDER BY l.line_no, l.onec_document_line_id`, [documentId],
    )).rows;
    return this.assemble(documents, lines)[0];
  }

  private assemble(documents: DocumentRow[], lines: LineRow[]): ConsumptionDocumentView[] {
    const byDocument = new Map<string, LineRow[]>();
    for (const line of lines) byDocument.set(line.onec_document_id, [...(byDocument.get(line.onec_document_id) ?? []), line]);
    return documents.map((row) => ({
      documentId: Number(row.onec_document_id),
      sourceId: Number(row.source_id),
      onecRefKey: row.onec_ref_key,
      docKind: row.doc_kind,
      number: row.number,
      revision: Number(row.applied_revision),
      posted: row.posted,
      deletedInOnec: row.deleted_in_onec,
      missingInSource: row.missing,
      docDate: row.doc_date,
      docAt: row.doc_at,
      warehouseRefKey: row.warehouse_ref_key,
      destinationWarehouseRefKey: row.destination_warehouse_ref_key,
      lines: (byDocument.get(row.onec_document_id) ?? []).map((line) => ({
        lineId: Number(line.onec_document_line_id),
        lineNo: line.line_no,
        warehouseRefKey: line.warehouse_ref_key,
        nomenclatureRefKey: line.nomenclature_ref_key,
        quantity: line.quantity,
        unitCode: line.unit_code,
        unitIsPackage: line.unit_is_package,
        isStockItem: line.is_stock_item,
        removedInOnec: line.removed,
        loadConflictCode: line.load_conflict_code,
      })),
    }));
  }
}
