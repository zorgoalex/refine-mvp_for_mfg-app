export type GroupReportFilterMode = 'any' | 'all' | 'primary' | 'none';

export type GroupReportTemporalFilter =
  | { mode: 'current' }
  | { mode: 'asOf'; asOf: string }
  | { mode: 'overlap'; from: string; to: string }
  | { mode: 'factTime'; factTimeExpression: string };

export interface GroupReportFilter {
  mode: GroupReportFilterMode;
  groupIds?: readonly string[];
  temporal: GroupReportTemporalFilter;
}

export interface AppendGroupReportPredicateInput {
  params: unknown[];
  orderIdExpression: string;
  filter: GroupReportFilter;
  tableAlias?: string;
}

export function appendGroupReportPredicate(input: AppendGroupReportPredicateInput): string {
  const alias = input.tableAlias ?? 'pop_filter';
  assertSafeSqlIdentifier(alias, 'tableAlias');
  assertSafeSqlExpression(input.orderIdExpression, 'orderIdExpression');

  const temporalPredicate = appendTemporalPredicate(input.params, alias, input.filter.temporal);
  const orderPredicate = `${alias}.order_id = ${input.orderIdExpression}`;
  const productionPredicate = `EXISTS (
        SELECT 1 FROM public.orders eligible_order
        WHERE eligible_order.order_id = ${input.orderIdExpression}
          AND eligible_order.order_kind = 'production_order'
      )`;

  if (input.filter.mode === 'none') {
    return `
      ${productionPredicate}
      AND NOT EXISTS (
        SELECT 1
        FROM public.group_order_groups ${alias}
        WHERE ${orderPredicate}
          AND ${temporalPredicate}
      )
    `;
  }

  const groupIds = normalizeGroupIds(input.filter.groupIds);
  const groupIdsIndex = input.params.push(groupIds);
  const groupPredicate = `${alias}.group_id = ANY($${groupIdsIndex}::uuid[])`;

  if (input.filter.mode === 'all') {
    return `
      ${productionPredicate}
      AND (
        SELECT COUNT(DISTINCT ${alias}.group_id)::int
        FROM public.group_order_groups ${alias}
        WHERE ${orderPredicate}
          AND ${temporalPredicate}
          AND ${groupPredicate}
      ) = cardinality($${groupIdsIndex}::uuid[])
    `;
  }

  const primaryPredicate = input.filter.mode === 'primary' ? `\n          AND ${alias}.is_primary` : '';

  return `
    ${productionPredicate}
    AND EXISTS (
      SELECT 1
      FROM public.group_order_groups ${alias}
      WHERE ${orderPredicate}
        AND ${temporalPredicate}${primaryPredicate}
        AND ${groupPredicate}
    )
  `;
}

function appendTemporalPredicate(
  params: unknown[],
  alias: string,
  temporal: GroupReportTemporalFilter,
): string {
  if (temporal.mode === 'current') {
    return `${alias}.valid_to IS NULL`;
  }

  if (temporal.mode === 'asOf') {
    const asOfIndex = params.push(temporal.asOf);
    return `${alias}.valid_from <= $${asOfIndex}::timestamptz
          AND COALESCE(${alias}.valid_to, 'infinity'::timestamptz) > $${asOfIndex}::timestamptz`;
  }

  if (temporal.mode === 'overlap') {
    const fromIndex = params.push(temporal.from);
    const toIndex = params.push(temporal.to);
    return `tstzrange(${alias}.valid_from, COALESCE(${alias}.valid_to, 'infinity'::timestamptz), '[)')
          && tstzrange($${fromIndex}::timestamptz, $${toIndex}::timestamptz, '[)')`;
  }

  assertSafeSqlExpression(temporal.factTimeExpression, 'factTimeExpression');
  return `${alias}.valid_from <= ${temporal.factTimeExpression}
          AND COALESCE(${alias}.valid_to, 'infinity'::timestamptz) > ${temporal.factTimeExpression}`;
}

function normalizeGroupIds(groupIds: readonly string[] | undefined): string[] {
  const unique = [...new Set((groupIds ?? []).map((id) => id.toLowerCase()))];
  if (unique.length === 0) {
    throw new Error('groupIds are required unless mode is none');
  }
  if (unique.length > 50) {
    throw new Error('groupIds supports at most 50 IDs');
  }
  return unique;
}

function assertSafeSqlExpression(expression: string, fieldName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?(::timestamptz)?$/.test(expression)) {
    throw new Error(`${fieldName} must be a trusted SQL identifier expression`);
  }
}

function assertSafeSqlIdentifier(identifier: string, fieldName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`${fieldName} must be a trusted SQL identifier`);
  }
}
