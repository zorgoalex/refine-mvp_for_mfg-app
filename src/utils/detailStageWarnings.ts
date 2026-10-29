import { notification } from 'antd';

/**
 * A detail that sits both in a Bazis cut set and in a CNC cut job: the backend adds it
 * anyway and reports it here (its production status is not changed by the second one).
 */
export type DetailStageWarning =
  | { code: 'DETAIL_ALSO_IN_CNC'; detailId: number; orderId: number; cutJobIds: number[] }
  | { code: 'DETAIL_ALSO_IN_BAZIS'; detailId: number; orderId: number; bazisCutSetIds: number[] };

const WARNING_TEXTS: Record<DetailStageWarning['code'], string> = {
  DETAIL_ALSO_IN_CNC: 'Деталь уже в задании ЧПУ — добавлена, статус не изменён',
  DETAIL_ALSO_IN_BAZIS: 'Деталь уже в карточке «Базис раскрой» — добавлена в задание ЧПУ',
};

/** One Russian text per warning code, with the count when several details are affected. */
export function buildDetailStageWarningTexts(warnings: readonly DetailStageWarning[] | null | undefined): string[] {
  const counts = new Map<DetailStageWarning['code'], Set<number>>();
  for (const warning of warnings ?? []) {
    if (!WARNING_TEXTS[warning?.code]) continue;
    const ids = counts.get(warning.code) ?? new Set<number>();
    ids.add(warning.detailId);
    counts.set(warning.code, ids);
  }
  return [...counts.entries()].map(([code, ids]) => (
    ids.size > 1
      ? `${WARNING_TEXTS[code].replace(/^Деталь/, 'Детали')} (деталей: ${ids.size})`
      : WARNING_TEXTS[code]
  ));
}

/** Shows an antd warning for the warnings of a successful cut / Bazis cut mutation. */
export function notifyDetailStageWarnings(warnings: readonly DetailStageWarning[] | null | undefined): void {
  for (const text of buildDetailStageWarningTexts(warnings)) {
    notification.warning({ message: 'Деталь в двух раскроях', description: text, duration: 8 });
  }
}
