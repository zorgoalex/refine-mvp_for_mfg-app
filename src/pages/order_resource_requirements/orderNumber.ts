/**
 * Отображение номера заказа во всех вкладках экрана «Потребности заказов в
 * ресурсах» и на экране снабжения: сначала номер заказа (`orderName`), затем —
 * код проекта. Чистые функции здесь вычисляют текст; визуальный компонент —
 * `OrderNumber.tsx` (номер + код проекта мелким серым текстом после него).
 */

export interface OrderNumberInput {
  orderName?: string | null;
  orderId?: number | null;
  projectCode?: string | null;
  /** `${projectCode}-${orderName}` — источник кода проекта, когда его нет отдельным полем в DTO. */
  fullNumber?: string | null;
}

/** Номер заказа для отображения: `orderName`, запасной вариант `#id` — когда имени нет. */
export function resolveOrderNumberText(orderName: string | null | undefined, orderId?: number | null): string {
  const trimmed = orderName?.trim();
  if (trimmed) return trimmed;
  return orderId != null ? `#${orderId}` : '';
}

/**
 * Код проекта из `fullNumber`, когда отдельного поля `projectCode` нет (рабочий
 * список снабжения, заявки поставщикам, подбор прихода 1С): `fullNumber` имеет
 * вид `<projectCode>-<orderName>`, отрезаем суффикс `-orderName`. Формат не
 * совпал — код проекта не показываем, а не угадываем часть номера.
 */
export function deriveProjectCodeFromFullNumber(
  fullNumber: string | null | undefined,
  orderName: string | null | undefined,
): string | null {
  const name = orderName?.trim();
  const full = fullNumber?.trim();
  if (!full || !name) return null;
  const suffix = `-${name}`;
  if (!full.endsWith(suffix)) return null;
  const prefix = full.slice(0, full.length - suffix.length).trim();
  return prefix || null;
}

/** Код проекта для отображения: явное поле важнее производного из `fullNumber`. */
export function resolveProjectCode(input: OrderNumberInput): string | null {
  const explicit = input.projectCode?.trim();
  if (explicit) return explicit;
  return deriveProjectCodeFromFullNumber(input.fullNumber, input.orderName);
}

/**
 * Текстовая форма «номер проект» — для aria-label, сортировки и подобных
 * plain-text мест. Не использовать для файлов выгрузки — там формат колонок
 * не меняется.
 */
export function orderNumberText(input: OrderNumberInput): string {
  const number = resolveOrderNumberText(input.orderName, input.orderId);
  const project = resolveProjectCode(input);
  return project ? `${number} ${project}` : number;
}
