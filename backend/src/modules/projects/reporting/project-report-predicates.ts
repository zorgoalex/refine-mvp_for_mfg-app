export type ProjectReportFilterMode = 'any' | 'all' | 'primary' | 'none';

export type ProjectReportTemporalFilter =
  | { mode: 'current' }
  | { mode: 'asOf'; asOf: string }
  | { mode: 'overlap'; from: string; to: string }
  | { mode: 'factTime'; factTimeExpression: string };

export interface ProjectReportFilter {
  mode: ProjectReportFilterMode;
  projectIds?: readonly string[];
  temporal: ProjectReportTemporalFilter;
}

export interface AppendProjectReportPredicateInput {
  params: unknown[];
  orderIdExpression: string;
  filter: ProjectReportFilter;
  tableAlias?: string;
}

export function appendProjectReportPredicate(input: AppendProjectReportPredicateInput): string {
  const alias = input.tableAlias ?? 'pop_filter';
  assertSafeSqlIdentifier(alias, 'tableAlias');
  assertSafeSqlExpression(input.orderIdExpression, 'orderIdExpression');

  const temporalPredicate = appendTemporalPredicate(input.params, alias, input.filter.temporal);
  const orderPredicate = `${alias}.order_id = ${input.orderIdExpression}`;

  if (input.filter.mode === 'none') {
    return `
      NOT EXISTS (
        SELECT 1
        FROM public.project_order_projects ${alias}
        WHERE ${orderPredicate}
          AND ${temporalPredicate}
      )
    `;
  }

  const projectIds = normalizeProjectIds(input.filter.projectIds);
  const projectIdsIndex = input.params.push(projectIds);
  const projectPredicate = `${alias}.project_id = ANY($${projectIdsIndex}::uuid[])`;

  if (input.filter.mode === 'all') {
    return `
      (
        SELECT COUNT(DISTINCT ${alias}.project_id)::int
        FROM public.project_order_projects ${alias}
        WHERE ${orderPredicate}
          AND ${temporalPredicate}
          AND ${projectPredicate}
      ) = cardinality($${projectIdsIndex}::uuid[])
    `;
  }

  const primaryPredicate = input.filter.mode === 'primary' ? `\n          AND ${alias}.is_primary` : '';

  return `
    EXISTS (
      SELECT 1
      FROM public.project_order_projects ${alias}
      WHERE ${orderPredicate}
        AND ${temporalPredicate}${primaryPredicate}
        AND ${projectPredicate}
    )
  `;
}

function appendTemporalPredicate(
  params: unknown[],
  alias: string,
  temporal: ProjectReportTemporalFilter,
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

function normalizeProjectIds(projectIds: readonly string[] | undefined): string[] {
  const unique = [...new Set((projectIds ?? []).map((id) => id.toLowerCase()))];
  if (unique.length === 0) {
    throw new Error('projectIds are required unless mode is none');
  }
  if (unique.length > 50) {
    throw new Error('projectIds supports at most 50 IDs');
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
