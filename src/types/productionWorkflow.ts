import { PRODUCTION_STATUS_CODE_LETTERS } from './orders';

export type ProductionWorkflowSchemaVersion = 1;

export interface ProductionWorkflowConfigV1 {
  schema_version: ProductionWorkflowSchemaVersion;
  workflow_key: string;

  /**
   * Canonical display/progress order for stages (by production_status_code).
   * Used for UI ordering and consistent rendering.
   */
  status_codes_order: string[];

  /**
   * Presentation-only rows for the production diagram.
   * Transitions remain the sole source of workflow and deadline dependencies.
   */
  layout_rows?: string[][];

  order: {
    initial_code: string;
    allowed_codes: string[];
  };

  detail: {
    initial_code: string;
    allowed_codes: string[];
  };

  transitions_order?: Record<string, string[]>;
  transitions_detail?: Record<string, string[]>;

  events_policy?: {
    unique_status_per_target?: boolean;
    allow_repeat?: boolean;
    current_status_cache?: boolean;
    [key: string]: any;
  };

  aggregation_policy?: {
    order_from_details_mode?: string;
    progress_metric?: string;
    detail_progress_source?: string;
    order_progress_source?: string;
    [key: string]: any;
  };

  /**
   * Temporary UI-only letters for stage badges.
   * Stored in app_settings (not in production_statuses table).
   */
  letters_by_code?: Record<string, string>;
}

export type ProductionWorkflowConfig = ProductionWorkflowConfigV1;

export interface ProductionStatusRef {
  production_status_id: number;
  production_status_code: string;
  production_status_name: string;
  sort_order: number;
  color?: string | null;
  is_active: boolean;
}

const getFallbackLetter = (code: string, name?: string) => {
  const mapped = PRODUCTION_STATUS_CODE_LETTERS[code];
  if (mapped) return mapped;
  const first = (name || '').trim().slice(0, 1);
  return first ? first.toUpperCase() : '?';
};

const compareStatusRefs = (a: ProductionStatusRef, b: ProductionStatusRef) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.production_status_id ?? 0) - (b.production_status_id ?? 0);

/**
 * Codes always placed by their step, whatever a stored order says: «Базис» (saw, migration 282) shares the step of
 * «Отрисован» and its letter goes right after «О» everywhere (a config saved earlier may hold it at the end).
 */
export const STEP_PLACED_STATUS_CODES: readonly string[] = ['saw'];
/** The code a step-placed code goes right after when it is in the order (whatever the other codes' order). */
const STEP_PLACED_ANCHORS: Readonly<Record<string, string>> = { saw: 'drawn' };

/**
 * Active statuses missing from a stored display order (a status added later) and the step-placed codes go to their
 * place by sort_order — after the last stored code of the same or an earlier step — not to the end.
 */
export const insertMissingStatusCodes = (storedOrder: string[], statuses: ProductionStatusRef[]): string[] => {
  const stored = storedOrder.filter((code) => !STEP_PLACED_STATUS_CODES.includes(code));
  const sortByCode = new Map(statuses.map((status) => [status.production_status_code, status.sort_order ?? 0]));
  const result = [...stored];
  [...statuses]
    .filter((status) => status.is_active && !stored.includes(status.production_status_code))
    .sort(compareStatusRefs)
    .forEach((status) => {
      const anchor = STEP_PLACED_ANCHORS[status.production_status_code];
      if (anchor && result.includes(anchor)) {
        result.splice(result.indexOf(anchor) + 1, 0, status.production_status_code);
        return;
      }
      const sort = status.sort_order ?? 0;
      let at = 0;
      result.forEach((code, index) => {
        const known = sortByCode.get(code);
        if (known !== undefined && known <= sort) at = index + 1;
      });
      result.splice(at, 0, status.production_status_code);
    });
  return result;
};

/** Codes missing from the stored menu layout get their own row right after the row of the code before them. */
const insertMissingLayoutRows = (rows: string[][], layoutCodes: Set<string>, order: string[]): string[][] => {
  const result = rows.map((row) => [...row]);
  order.forEach((code, index) => {
    if (layoutCodes.has(code)) return;
    const previous = order.slice(0, index).reverse().find((candidate) => result.some((row) => row.includes(candidate)));
    const rowIndex = previous === undefined ? -1 : result.findIndex((row) => row.includes(previous));
    result.splice(rowIndex + 1, 0, [code]);
  });
  return result;
};

export const buildDefaultProductionWorkflowConfig = (
  statuses: ProductionStatusRef[],
  workflowKey: string
): ProductionWorkflowConfig => {
  const sorted = [...(statuses || [])].sort(compareStatusRefs);
  const codes = sorted.map((s) => s.production_status_code).filter(Boolean);
  const initial = codes[0] || 'new';

  const lettersByCode: Record<string, string> = {};
  sorted.forEach((s) => {
    lettersByCode[s.production_status_code] = getFallbackLetter(
      s.production_status_code,
      s.production_status_name
    );
  });

  return {
    schema_version: 1,
    workflow_key: workflowKey,
    status_codes_order: codes,
    layout_rows: codes.map((code) => [code]),
    order: { initial_code: initial, allowed_codes: [...codes] },
    detail: { initial_code: initial, allowed_codes: [...codes] },
    transitions_order: {},
    transitions_detail: {},
    events_policy: {
      unique_status_per_target: true,
      allow_repeat: false,
      current_status_cache: true,
    },
    aggregation_policy: {
      order_from_details_mode: 'min_progress',
      progress_metric: 'sort_order',
      detail_progress_source: 'events',
      order_progress_source: 'details',
    },
    letters_by_code: lettersByCode,
  };
};

export const normalizeProductionWorkflowConfig = (
  input: any,
  statuses: ProductionStatusRef[],
  workflowKey: string
): ProductionWorkflowConfig => {
  const base =
    input && typeof input === 'object'
      ? (input as Partial<ProductionWorkflowConfigV1>)
      : undefined;

  const fallback = buildDefaultProductionWorkflowConfig(statuses, workflowKey);

  const storedStatusCodesOrder = Array.isArray(base?.status_codes_order)
    ? base!.status_codes_order.filter((x) => typeof x === 'string')
    : fallback.status_codes_order;
  const statusCodesOrder = insertMissingStatusCodes(storedStatusCodesOrder, statuses);
  const storedLayoutRowsSource: unknown[] = Array.isArray(base?.layout_rows)
    ? base.layout_rows
    : [];
  const storedLayoutRows = storedLayoutRowsSource
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.filter((code): code is string => typeof code === 'string' && !STEP_PLACED_STATUS_CODES.includes(code)))
    .filter((row) => row.length > 0);
  const layoutCodes = new Set(storedLayoutRows.flat());
  const layoutRows =
    storedLayoutRows.length > 0
      ? insertMissingLayoutRows(storedLayoutRows, layoutCodes, statusCodesOrder)
      : statusCodesOrder.map((code) => [code]);

  const orderAllowed = Array.isArray(base?.order?.allowed_codes)
    ? base!.order!.allowed_codes.filter((x) => typeof x === 'string')
    : fallback.order.allowed_codes;

  const detailAllowed = Array.isArray(base?.detail?.allowed_codes)
    ? base!.detail!.allowed_codes.filter((x) => typeof x === 'string')
    : fallback.detail.allowed_codes;

  const lettersByCode: Record<string, string> = {
    ...(fallback.letters_by_code || {}),
    ...((base?.letters_by_code && typeof base.letters_by_code === 'object'
      ? base.letters_by_code
      : {}) as Record<string, string>),
  };

  return {
    schema_version: 1,
    workflow_key: workflowKey,
    status_codes_order: statusCodesOrder,
    layout_rows: layoutRows,
    order: {
      initial_code:
        typeof base?.order?.initial_code === 'string' ? base.order.initial_code : fallback.order.initial_code,
      allowed_codes: orderAllowed,
    },
    detail: {
      initial_code:
        typeof base?.detail?.initial_code === 'string' ? base.detail.initial_code : fallback.detail.initial_code,
      allowed_codes: detailAllowed,
    },
    transitions_order:
      base?.transitions_order && typeof base.transitions_order === 'object'
        ? (base.transitions_order as Record<string, string[]>)
        : fallback.transitions_order,
    transitions_detail:
      base?.transitions_detail && typeof base.transitions_detail === 'object'
        ? (base.transitions_detail as Record<string, string[]>)
        : fallback.transitions_detail,
    events_policy:
      base?.events_policy && typeof base.events_policy === 'object'
        ? (base.events_policy as ProductionWorkflowConfigV1['events_policy'])
        : fallback.events_policy,
    aggregation_policy:
      base?.aggregation_policy && typeof base.aggregation_policy === 'object'
        ? (base.aggregation_policy as ProductionWorkflowConfigV1['aggregation_policy'])
        : fallback.aggregation_policy,
    letters_by_code: lettersByCode,
  };
};
