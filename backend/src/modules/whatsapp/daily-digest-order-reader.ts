import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import {
  DAILY_DIGEST_MAX_ORDERS,
  DAILY_DIGEST_RENDERER_VERSION,
  type DailyDigestMaterial,
  type DailyDigestOrderCard,
  type DailyDigestSnapshot,
  type DailyDigestWorkflowDisplay,
} from './daily-digest-snapshot.types';

const WORKFLOW_SETTING_KEY = 'production.workflow.default';
const DEFAULT_LETTERS: Readonly<Record<string, string>> = {
  new: 'Н', drawn: 'О', film_purchase: 'П', cut: 'Р', drilled: 'С',
  sanded: 'Ш', stocked: 'К', laminated: 'З', packed: 'У', issued: 'В',
};

interface OrderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  order_date: string | Date | null;
  planned_completion_date: string | Date;
  client_name: string | null;
  order_status_name: string | null;
  payment_status_name: string | null;
  total_area: string | number | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
}

interface DetailRow extends QueryResultRow {
  order_id: string | number;
  detail_id: string | number;
  detail_number: string | number;
  basis_project: string | null;
  production_status_id: string | number | null;
  production_status_name: string | null;
  milling_type_name: string | null;
  material_name: string | null;
}

interface DowelingRow extends QueryResultRow {
  order_id: string | number;
  doweling_order_link_id: string | number;
  doweling_order_name: string | null;
}

interface EventRow extends QueryResultRow {
  order_id: string | number;
  production_status_id: string | number;
}

interface StatusRow extends QueryResultRow {
  production_status_id: string | number;
  production_status_code: string | null;
  production_status_name: string;
  sort_order: string | number | null;
  is_active: boolean;
}

interface WorkflowSettingRow extends QueryResultRow {
  is_active: boolean;
  value_json: unknown;
}

interface DigestDetail {
  basisProject: string | null;
  productionStatusId: number | null;
  productionStatusName: string | null;
  millingTypeName: string | null;
  materialName: string | null;
}

interface ProductionStatus {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

@Injectable()
export class DailyDigestOrderReader {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async read(businessDate: string): Promise<DailyDigestSnapshot> {
    assertBusinessDate(businessDate);

    return this.database.transaction(
      async (tx) => this.readSnapshot(tx, businessDate),
      { isolation: 'repeatable read' },
    );
  }

  private async readSnapshot(
    tx: TransactionClient,
    businessDate: string,
  ): Promise<DailyDigestSnapshot> {
    // LIMIT 501 is a completeness proof: either the full day fits the 500-order
    // contract or this read fails before any snapshot can be rendered/stored.
    const orderResult = await tx.query<OrderRow>(
      `
      SELECT
        o.order_id, o.order_name, o.order_date, o.planned_completion_date,
        c.client_name, os.order_status_name, pay_s.payment_status_name,
        o.total_area, o.production_status_id, prod_s.production_status_name
      FROM orders o
      LEFT JOIN clients c ON c.client_id = o.client_id
      LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
      LEFT JOIN payment_statuses pay_s ON pay_s.payment_status_id = o.payment_status_id
      LEFT JOIN production_statuses prod_s ON prod_s.production_status_id = o.production_status_id
      WHERE o.order_kind = 'production_order'
        AND o.delete_flag = false
        AND o.planned_completion_date = $1::date
      ORDER BY o.order_id ASC
      LIMIT $2
      `,
      [businessDate, DAILY_DIGEST_MAX_ORDERS + 1],
    );
    if (orderResult.rows.length > DAILY_DIGEST_MAX_ORDERS) {
      throw new ApiError(
        422,
        'DAILY_DIGEST_ORDER_LIMIT_EXCEEDED',
        `За выбранную дату найдено больше ${DAILY_DIGEST_MAX_ORDERS} заказов. Полный снимок не создан; сообщение не будет отправлено.`,
        { orderLimit: DAILY_DIGEST_MAX_ORDERS },
      );
    }

    const ids = orderResult.rows.map((row) => Number(row.order_id));
    const [detailResult, dowelingResult, eventResult, statusResult, settingResult] = ids.length
      ? await Promise.all([
          tx.query<DetailRow>(
            `
            SELECT
              od.order_id, od.detail_id, od.detail_number, od.basis_project,
              od.production_status_id, detail_status.production_status_name,
              mt.milling_type_name,
              COALESCE(NULLIF(BTRIM(smt.name), ''), NULLIF(BTRIM(m.material_name), '')) AS material_name
            FROM order_details od
            LEFT JOIN production_statuses detail_status
              ON detail_status.production_status_id = od.production_status_id
            LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
            LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
            LEFT JOIN materials m ON m.material_id = od.material_id
            WHERE od.order_id = ANY($1::bigint[])
              AND od.delete_flag = false
            ORDER BY od.order_id ASC, od.detail_number ASC, od.detail_id ASC
            `,
            [ids],
          ),
          tx.query<DowelingRow>(
            `
            SELECT DISTINCT ON (odl.order_id)
              odl.order_id, odl.order_doweling_link_id AS doweling_order_link_id,
              d.doweling_order_name
            FROM order_doweling_links odl
            LEFT JOIN doweling_orders d ON d.doweling_order_id = odl.doweling_order_id
            WHERE odl.order_id = ANY($1::bigint[])
              AND odl.delete_flag = false
            ORDER BY odl.order_id ASC, odl.order_doweling_link_id DESC
            `,
            [ids],
          ),
          // Calendar queries order-level events by order_id. Detail statuses are
          // resolved from the same live, non-deleted detail rows fetched above.
          tx.query<EventRow>(
            `
            SELECT pse.order_id, pse.production_status_id
            FROM production_status_events pse
            WHERE pse.order_id = ANY($1::bigint[])
            ORDER BY pse.order_id ASC, pse.event_id ASC
            `,
            [ids],
          ),
          tx.query<StatusRow>(
            `
            SELECT production_status_id, production_status_code,
                   production_status_name, sort_order, is_active
            FROM production_statuses
            ORDER BY sort_order ASC NULLS LAST, production_status_id ASC
            `,
          ),
          tx.query<WorkflowSettingRow>(
            `
            SELECT is_active, value_json
            FROM app_settings
            WHERE setting_key = $1
            LIMIT 1
            `,
            [WORKFLOW_SETTING_KEY],
          ),
        ])
      : await Promise.all([
          Promise.resolve({ rows: [] as DetailRow[] }),
          Promise.resolve({ rows: [] as DowelingRow[] }),
          Promise.resolve({ rows: [] as EventRow[] }),
          tx.query<StatusRow>(
            `
            SELECT production_status_id, production_status_code,
                   production_status_name, sort_order, is_active
            FROM production_statuses
            ORDER BY sort_order ASC NULLS LAST, production_status_id ASC
            `,
          ),
          tx.query<WorkflowSettingRow>(
            `
            SELECT is_active, value_json
            FROM app_settings
            WHERE setting_key = $1
            LIMIT 1
            `,
            [WORKFLOW_SETTING_KEY],
          ),
        ]);

    const statuses = statusResult.rows.map(mapStatus);
    const workflow = resolveWorkflowDisplay(statuses, settingResult.rows[0]);
    const detailsByOrder = new Map<number, DigestDetail[]>();
    for (const row of detailResult.rows) {
      const orderId = Number(row.order_id);
      const details = detailsByOrder.get(orderId) ?? [];
      details.push({
        basisProject: row.basis_project,
        productionStatusId: toNullableNumber(row.production_status_id),
        productionStatusName: row.production_status_name,
        millingTypeName: row.milling_type_name,
        materialName: row.material_name,
      });
      detailsByOrder.set(orderId, details);
    }

    const dowelingByOrder = new Map<number, string>();
    for (const row of dowelingResult.rows) {
      if (row.doweling_order_name?.trim()) {
        dowelingByOrder.set(Number(row.order_id), row.doweling_order_name.trim());
      }
    }
    const eventCodesByOrder = new Map<number, string[]>();
    for (const row of eventResult.rows) {
      const orderId = Number(row.order_id);
      const code = workflow.lookup.idToCode.get(Number(row.production_status_id));
      if (!code) continue;
      const codes = eventCodesByOrder.get(orderId) ?? [];
      if (!codes.includes(code)) codes.push(code);
      eventCodesByOrder.set(orderId, codes);
    }

    const orders = orderResult.rows.map((row) => {
      const orderId = Number(row.order_id);
      const details = detailsByOrder.get(orderId) ?? [];
      const area = toNumber(row.total_area);
      return {
        orderId,
        orderName: row.order_name,
        orderDate: toDateOnly(row.order_date),
        plannedCompletionDate: toDateOnly(row.planned_completion_date) ?? businessDate,
        clientName: row.client_name,
        orderStatusName: row.order_status_name ?? '',
        paymentStatusName: row.payment_status_name ?? '',
        totalArea: area,
        basisProjectDisplay: resolveBasisProjectDisplay(
          dowelingByOrder.get(orderId),
          details,
        ),
        materials: resolveMaterials(details),
        millingDisplay: resolveMillingDisplay(details),
        passedProductionCodes: resolvePassedCodes({
          eventCodes: eventCodesByOrder.get(orderId) ?? [],
          orderStatusId: toNullableNumber(row.production_status_id),
          orderStatusName: row.production_status_name,
          details,
          lookup: workflow.lookup,
        }),
      } satisfies DailyDigestOrderCard;
    });

    return {
      businessDate,
      rendererVersion: DAILY_DIGEST_RENDERER_VERSION,
      cardsPerMessage: 2,
      totalArea: orders.reduce((sum, order) => sum + order.totalArea, 0),
      orders,
      workflowDisplay: workflow.display,
    };
  }
}

interface StatusLookup {
  idToCode: Map<number, string>;
  uniqueNameToCode: Map<string, string>;
}

function mapStatus(row: StatusRow): ProductionStatus {
  return {
    id: Number(row.production_status_id),
    code: String(row.production_status_code ?? '').trim(),
    name: row.production_status_name,
    sortOrder: toNumber(row.sort_order),
    isActive: row.is_active,
  };
}

function resolveWorkflowDisplay(
  statuses: ProductionStatus[],
  setting?: WorkflowSettingRow,
): { display: DailyDigestWorkflowDisplay; lookup: StatusLookup } {
  const raw = setting?.is_active ? unwrapSetting(setting.value_json) : null;
  const storedOrder = isRecord(raw) && Array.isArray(raw.status_codes_order)
    ? raw.status_codes_order.filter((code): code is string => typeof code === 'string')
    : statuses.map((status) => status.code).filter(Boolean);
  const displayOrderCodes = [
    ...storedOrder,
    ...statuses
      .filter((status) => status.isActive && status.code && !storedOrder.includes(status.code))
      .map((status) => status.code),
  ];

  const codeToName: Record<string, string> = {};
  const idToCode = new Map<number, string>();
  const codesByName = new Map<string, Set<string>>();
  for (const status of statuses) {
    if (!status.code) continue;
    idToCode.set(status.id, status.code);
    codeToName[status.code] = status.name;
    const normalizedName = normalizeName(status.name);
    if (!normalizedName) continue;
    const codes = codesByName.get(normalizedName) ?? new Set<string>();
    codes.add(status.code);
    codesByName.set(normalizedName, codes);
  }

  const uniqueNameToCode = new Map<string, string>();
  for (const [name, codes] of codesByName) {
    if (codes.size === 1) uniqueNameToCode.set(name, [...codes][0]);
  }

  const rawLetters = isRecord(raw) && isRecord(raw.letters_by_code)
    ? raw.letters_by_code
    : {};
  const codeToLetter: Record<string, string> = {};
  for (const status of statuses) {
    if (!status.code) continue;
    const configuredValue = rawLetters[status.code];
    const configured = typeof configuredValue === 'string'
      ? configuredValue.trim().slice(0, 1)
      : '';
    const letter = configured || DEFAULT_LETTERS[status.code] || status.name.trim().slice(0, 1) || '?';
    codeToLetter[status.code] = letter.toLocaleUpperCase('ru-RU');
  }

  return {
    display: { displayOrderCodes, codeToLetter, codeToName },
    lookup: { idToCode, uniqueNameToCode },
  };
}

function unwrapSetting(value: unknown): unknown {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  return isRecord(parsed) && 'value' in parsed ? parsed.value : parsed;
}

function resolvePassedCodes(input: {
  eventCodes: string[];
  orderStatusId: number | null;
  orderStatusName: string | null;
  details: DigestDetail[];
  lookup: StatusLookup;
}): string[] {
  const codes = new Set<string>();
  const add = (code: string | null | undefined) => {
    const normalized = code?.trim();
    if (normalized) codes.add(normalized);
  };
  input.eventCodes.forEach(add);
  if (input.orderStatusId !== null) add(input.lookup.idToCode.get(input.orderStatusId));
  if (input.orderStatusName) {
    add(input.lookup.uniqueNameToCode.get(normalizeName(input.orderStatusName)));
  }
  for (const detail of input.details) {
    if (detail.productionStatusId !== null) add(input.lookup.idToCode.get(detail.productionStatusId));
    else if (detail.productionStatusName) {
      add(input.lookup.uniqueNameToCode.get(normalizeName(detail.productionStatusName)));
    }
  }
  return [...codes];
}

function resolveBasisProjectDisplay(
  dowelingOrderName: string | undefined,
  details: DigestDetail[],
): string | null {
  if (dowelingOrderName?.trim()) return dowelingOrderName.trim();
  const seen = new Set<string>();
  const values: string[] = [];
  for (const detail of details) {
    const value = detail.basisProject?.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase('ru-RU');
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values.length ? values.join(', ') : null;
}

function resolveMaterials(details: DigestDetail[]): DailyDigestMaterial[] {
  const seen = new Set<string>();
  const materials: DailyDigestMaterial[] = [];
  for (const detail of details) {
    const fullName = detail.materialName?.trim();
    if (!fullName || isDefaultMdf16(fullName) || seen.has(fullName)) continue;
    seen.add(fullName);
    materials.push({ fullName, label: shortMaterialName(fullName) });
  }
  return materials;
}

function shortMaterialName(material: string): string {
  const lower = material.toLocaleLowerCase('ru-RU');
  if (lower.includes('чернов')) {
    const match = material.match(/(\d+)\s*мм/i) ?? material.match(/(\d+)/);
    return match ? `Черн. ${match[1]}мм` : 'Черн.';
  }
  if (lower.includes('фанера')) return 'фанера';
  if (lower.includes('лдсп')) return 'ЛДСП';
  if (lower.includes('мдф')) {
    const match = material.match(/(\d+)\s*мм/i) ?? material.match(/(\d+)/);
    return match ? `${match[1]}мм` : material;
  }
  return material;
}

function isDefaultMdf16(material: string): boolean {
  return /^мдф\s*16мм$/u.test(
    material.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').replace(/\s*мм$/u, 'мм').trim(),
  );
}

function resolveMillingDisplay(details: DigestDetail[]): string {
  const millingTypes = details
    .map((detail) => detail.millingTypeName)
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLocaleLowerCase('ru-RU'));
  if (millingTypes.length === 0) return '';
  if (millingTypes.some((name) => name.includes('выборка'))) return 'Выборка';
  return millingTypes.some((name) => name !== 'модерн' && !name.includes('модерн'))
    ? 'Фрезеровка'
    : 'Модерн';
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU');
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, 'DAILY_DIGEST_DATE_INVALID', 'Дата должна быть указана в формате ГГГГ-ММ-ДД.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ApiError(422, 'DAILY_DIGEST_DATE_INVALID', 'Указана несуществующая календарная дата.');
  }
}

function toDateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function toNumber(value: string | number | null): number {
  const result = value === null ? 0 : Number(value);
  return Number.isFinite(result) ? result : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
