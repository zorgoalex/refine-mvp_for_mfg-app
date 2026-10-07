import type { OnecConsumptionRunDto, OnecIssueDto, StockDocumentSummaryDto, WarehouseDto } from '../../api/types/inventoryApi.types';

// Расход плёнки из документов 1С: подписи и тексты экрана склада (backend — /inventory/onec-consumption).

/** Причины, по которым строка 1С не попала в остатки ERP. */
export const ONEC_ISSUE_LABEL: Record<string, string> = {
  FILM_UNLINKED: 'Позиция 1С не связана с плёнкой',
  UNIT_PACKAGE: 'Единица — упаковка, нужны пог. м',
  UNIT_MISMATCH: 'Единица не пог. м',
  WAREHOUSE_UNLINKED: 'Склад 1С не связан со складом ERP',
  NO_CUTOFF: 'У склада нет даты начала расхода',
  NO_BASELINE: 'Нужна инвентаризация склада',
  BEFORE_CUTOFF: 'До инвентаризации (уже учтено в ней)',
  AMBIGUOUS_SOURCE: 'Склад есть в нескольких базах 1С',
  LINE_CONFLICT: 'Строка загружена с конфликтом',
  MISSING_IN_SOURCE: 'Документ пропал из выгрузки 1С',
  NO_DOC_AT: 'У документа нет времени',
};

/** Что сделать пользователю по причине (подсказка в таблице). */
export const ONEC_ISSUE_HINT: Record<string, string> = {
  FILM_UNLINKED: 'Свяжите плёнку с позицией 1С в каталоге плёнок — строка применится при следующем пересчёте.',
  UNIT_PACKAGE: 'В документе 1С количество в упаковках — исправьте единицу в 1С.',
  UNIT_MISMATCH: 'В документе 1С единица не пог. м — исправьте единицу в 1С.',
  NO_BASELINE: 'Проведите инвентаризацию склада с моментом подсчёта.',
  BEFORE_CUTOFF: 'Документ 1С раньше момента подсчёта инвентаризации — он уже учтён в её количестве.',
  AMBIGUOUS_SOURCE: 'Склад 1С найден в нескольких базах — расход по складу заморожен до устранения.',
  LINE_CONFLICT: 'Строка документа 1С загружена с конфликтом — см. загрузку 1С.',
  MISSING_IN_SOURCE: 'Документ больше не приходит из 1С — применённое оставлено как есть.',
  NO_DOC_AT: 'Документ загружен без времени — дождитесь перезагрузки документов 1С.',
};

export const onecIssueLabel = (code: string): string => ONEC_ISSUE_LABEL[code] ?? code;

const DOC_KIND_LABEL: Record<string, string> = {
  sales_shipment: 'Реализация', supplier_return: 'Возврат поставщику', inventory_writeoff: 'Списание', inventory_transfer: 'Перемещение',
  purchase_receipt: 'Поступление',
};

const ruDate = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
};

/** «Реализация № 15 от 28.09.2026» — документ 1С строки «Не учтено». */
export function onecIssueDocument(issue: Pick<OnecIssueDto, 'docKind' | 'docNumber' | 'docDate' | 'onecDocumentId'>): string {
  const kind = issue.docKind ? DOC_KIND_LABEL[issue.docKind] ?? issue.docKind : 'Документ 1С';
  const number = issue.docNumber ? ` № ${issue.docNumber}` : ` (id ${issue.onecDocumentId})`;
  return `${kind}${number}${issue.docDate ? ` от ${ruDate(issue.docDate)}` : ''}`;
}

/** Итог ручного пересчёта для сообщения. */
export function onecRunText(result: OnecConsumptionRunDto): { tone: 'success' | 'warning' | 'info'; text: string } {
  if (result.status === 'skipped') {
    if (result.reason === 'disabled') return { tone: 'warning', text: 'Расход из 1С выключен на сервере' };
    if (result.reason === 'onec_unavailable') return { tone: 'warning', text: 'Документы 1С сейчас недоступны — пересчёт пропущен' };
    return { tone: 'info', text: 'Пересчёт уже идёт — обновите список через минуту' };
  }
  const text = `Документов 1С: ${result.candidates}, пересчитано ${result.processed}, записано изменений ${result.documents}`;
  return result.failed > 0
    ? { tone: 'warning', text: `${text}, с ошибкой ${result.failed} — они повторятся при следующем проходе` }
    : { tone: 'success', text };
}

/** Backend знает расход 1С (поле есть в ответе). Старый backend поле не принимает — форма его не показывает. */
export const supportsOnecConsumption = (warehouse: Pick<WarehouseDto, 'onecConsumptionSince'>): boolean =>
  warehouse.onecConsumptionSince !== undefined;

/** Один и тот же момент (ISO в разных записях) или оба пусты. */
export function sameMoment(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

/** Основание документа в журнале: у документа 1С — какой документ 1С, у импорта — файл. */
export function documentBasis(row: Pick<StockDocumentSummaryDto, 'source' | 'comment' | 'fileName'>): string {
  if (row.source === 'onec') return row.comment ?? 'Документ 1С';
  return row.fileName ?? row.comment ?? '—';
}

export const formatMoment = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
