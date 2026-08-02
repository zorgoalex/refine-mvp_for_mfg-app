import { createContext } from 'react';

export interface OrderValidationDetailRef {
  detail_id?: number | null;
  temp_id?: number | null;
  detail_number?: number | null;
}

export interface OrderSaveValidationItem {
  field: string;
  message: string;
  text: string;
  detailIndex: number | null;
  detailNumber: number | null;
  detailKey: string | null;
}

export interface OrderSaveValidationSummary {
  items: OrderSaveValidationItem[];
  invalidDetailKeys: string[];
}

interface RawValidationIssue {
  field: string;
  message: string;
}

interface ParsedField {
  section: string;
  index: number | null;
  property: string;
}

const GENERIC_VALIDATION_MESSAGES = new Set([
  'Order payload validation failed',
  'Ошибка валидации данных заказа',
]);

const FIELD_LABELS: Record<string, string> = {
  orderid: 'Идентификатор заказа',
  id: 'Идентификатор записи',
  ordername: 'Название заказа',
  projectid: 'Проект',
  clientid: 'Клиент',
  orderdate: 'Дата заказа',
  orderstatusid: 'Статус заказа',
  paymentstatusid: 'Статус оплаты',
  productionstatusid: 'Статус производства',
  managerid: 'Менеджер',
  sheetmaterialtypeid: 'Листовой материал',
  materialid: 'Материал',
  millingtypeid: 'Тип фрезеровки',
  edgetypeid: 'Тип обката',
  filmid: 'Плёнка',
  plannedcompletiondate: 'Плановая дата завершения',
  completiondate: 'Дата завершения',
  issuedate: 'Дата выдачи',
  paymentdate: 'Дата платежа',
  discount: 'Скидка',
  surcharge: 'Наценка',
  totalamount: 'Сумма заказа',
  finalamount: 'Итоговая сумма',
  paidamount: 'Оплачено',
  partscount: 'Количество позиций',
  totalarea: 'Общая площадь',
  detailnumber: 'Номер позиции',
  height: 'Высота',
  width: 'Ширина',
  quantity: 'Количество',
  area: 'Площадь',
  millingcostpersqm: 'Цена фрезеровки за м²',
  detailcost: 'Стоимость позиции',
  jointorderid: 'Связанное задание',
  priority: 'Приоритет',
  note: 'Примечание',
  detailname: 'Название детали',
  typepaidid: 'Тип оплаты',
  amount: 'Сумма платежа',
  workshopid: 'Цех',
  responsibleemployeeid: 'Ответственный сотрудник',
  sequenceorder: 'Порядок выполнения',
  receiveddate: 'Дата получения',
  starteddate: 'Дата начала',
  completeddate: 'Дата завершения',
  resourcetype: 'Тип ресурса',
  requiredquantity: 'Требуемое количество',
  finalquantity: 'Итоговое количество',
  unitid: 'Единица измерения',
  requirementstatusid: 'Статус потребности',
  wastepercentage: 'Процент отхода',
  purchaseprice: 'Закупочная цена',
  supplierid: 'Поставщик',
  requisitionid: 'Заявка',
  warehouseid: 'Склад',
  reservedat: 'Дата резервирования',
  consumedat: 'Дата списания',
  dowelingorderid: 'Задание на присадку',
  designengineerid: 'Конструктор',
  detailids: 'Удалённые позиции',
  paymentids: 'Удалённые платежи',
  workshopids: 'Удалённые производства',
  requirementids: 'Удалённые материалы',
  dowelinglinkids: 'Удалённые задания на присадку',
  version: 'Версия заказа',
};

export const OrderSaveValidationContext = createContext<OrderSaveValidationSummary | null>(null);

export function orderValidationDetailKey(detail: OrderValidationDetailRef): string {
  if (Number.isInteger(detail.detail_id) && Number(detail.detail_id) > 0) {
    return `id:${detail.detail_id}`;
  }
  if (Number.isInteger(detail.temp_id)) {
    return `temp:${detail.temp_id}`;
  }
  return `number:${detail.detail_number ?? 0}`;
}

export function summarizeOrderValidation(
  source: unknown,
  details: readonly OrderValidationDetailRef[],
): OrderSaveValidationSummary | null {
  const issues = extractIssues(source);
  if (issues.length === 0) {
    const fallback = validationFallbackMessage(source);
    if (!fallback) return null;
    return {
      items: [{
        field: '',
        message: fallback,
        text: fallback,
        detailIndex: null,
        detailNumber: null,
        detailKey: null,
      }],
      invalidDetailKeys: [],
    };
  }

  const seen = new Set<string>();
  const invalidDetailKeys = new Set<string>();
  const items: OrderSaveValidationItem[] = [];

  for (const issue of issues) {
    const signature = `${issue.field}\u0000${issue.message}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    const parsed = parseField(issue.field);
    const detail = parsed.section === 'details' && parsed.index !== null
      ? details[parsed.index]
      : undefined;
    const detailNumber = detail?.detail_number ?? (parsed.section === 'details' && parsed.index !== null
      ? parsed.index + 1
      : null);
    const detailKey = detail ? orderValidationDetailKey(detail) : null;
    if (detailKey) invalidDetailKeys.add(detailKey);

    const scope = fieldScope(parsed, detailNumber);
    const fieldLabel = humanFieldLabel(parsed.property);
    const humanized = humanizeMessage(issue.message);
    const prefix = humanized.includeField && fieldLabel
      ? `${scope} — ${fieldLabel}`
      : scope;
    const text = prefix ? `${prefix}: ${humanized.message}` : humanized.message;

    items.push({
      field: issue.field,
      message: humanized.message,
      text,
      detailIndex: parsed.section === 'details' ? parsed.index : null,
      detailNumber,
      detailKey,
    });
  }

  return { items, invalidDetailKeys: [...invalidDetailKeys] };
}

function extractIssues(source: unknown): RawValidationIssue[] {
  const direct = Array.isArray(source) ? source : null;
  const record = asRecord(source);
  const details = asRecord(record?.details);
  const candidates = direct
    ?? arrayValue(details?.errors)
    ?? arrayValue(details?.issues)
    ?? arrayValue(record?.errors)
    ?? arrayValue(record?.issues)
    ?? [];

  return candidates.flatMap((candidate) => {
    const issue = asRecord(candidate);
    const message = typeof issue?.message === 'string' ? issue.message.trim() : '';
    if (!message) return [];
    const field = typeof issue?.field === 'string'
      ? issue.field
      : Array.isArray(issue?.path)
        ? pathToField(issue.path)
        : '';
    return [{ field, message }];
  });
}

function validationFallbackMessage(source: unknown): string | null {
  const record = asRecord(source);
  const status = typeof record?.status === 'number' ? record.status : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  const validationLike = status === 422 || code === 'VALIDATION_ERROR' || code.endsWith('_VALIDATION_ERROR');
  if (!validationLike) return null;

  if (code === 'ORDER_FINAL_AMOUNT_NEGATIVE') {
    return 'Итоговая сумма заказа не может быть отрицательной';
  }
  const message = typeof record?.message === 'string' ? record.message.trim() : '';
  if (message && !GENERIC_VALIDATION_MESSAGES.has(message)) return humanizeMessage(message).message;
  return 'Проверьте заполнение обязательных полей заказа';
}

function parseField(field: string): ParsedField {
  const normalized = field
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[\]/g, '')
    .replace(/^\./, '');
  const parts = normalized.split('.').filter(Boolean);
  const section = parts[0] ?? '';
  const index = parts.length > 1 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  const propertyIndex = index === null ? 1 : 2;
  return { section, index, property: parts.slice(propertyIndex).join('.') };
}

function fieldScope(field: ParsedField, detailNumber: number | null): string {
  if (field.section === 'details') {
    return field.index === null ? 'Позиции заказа' : `Позиция №${detailNumber ?? field.index + 1}`;
  }
  if (field.section === 'header') return 'Основная информация';
  if (field.section === 'payments') return field.index === null ? 'Платежи' : `Платёж №${field.index + 1}`;
  if (field.section === 'workshops') return field.index === null ? 'Производство' : `Производство №${field.index + 1}`;
  if (field.section === 'requirements') return field.index === null ? 'Материалы' : `Материал №${field.index + 1}`;
  if (field.section === 'dowelingLinks') return field.index === null ? 'Присадка' : `Присадка №${field.index + 1}`;
  if (field.section === 'deleted') return 'Удалённые записи';
  return field.section ? 'Данные заказа' : '';
}

function humanFieldLabel(property: string): string {
  const key = property.split('.').pop()?.replace(/_/g, '').toLocaleLowerCase('ru-RU') ?? '';
  return FIELD_LABELS[key] ?? 'Поле';
}

function humanizeMessage(message: string): { message: string; includeField: boolean } {
  const value = message.trim();
  const lower = value.toLocaleLowerCase('ru-RU');

  if (lower.includes('material_id') && lower.includes('sheet_material_type_id')) {
    return { message: 'выберите листовой материал заново', includeField: true };
  }
  if (lower.includes('hidden sheet shadow') || lower.includes('shadow of a different sheet')) {
    return { message: 'выбран некорректный внутренний материал; выберите листовой материал заново', includeField: true };
  }
  if (lower.includes('sheet_material_type') && lower.includes('does not exist')) {
    return { message: 'выбранный листовой материал больше не существует; выберите другой', includeField: true };
  }
  if (lower.includes('non-cuttable sheet material')) {
    return { message: 'этот материал нельзя использовать для раскроя', includeField: true };
  }
  if (lower.includes('discount and surcharge cannot both')) {
    return { message: 'скидку и наценку нельзя указывать одновременно', includeField: true };
  }
  if (lower.includes('finalquantity cannot be less than requiredquantity')) {
    return { message: 'итоговое количество не может быть меньше требуемого', includeField: true };
  }
  if (lower.includes('unsupported resource type')) {
    return { message: 'выбран неподдерживаемый тип ресурса', includeField: true };
  }
  if (lower.includes('dowelingorderid must be unique')) {
    return { message: 'одно задание добавлено несколько раз', includeField: true };
  }
  if (lower.includes('must be unique') || lower.includes('duplicate active id')) {
    return { message: 'одно значение добавлено несколько раз', includeField: true };
  }
  if (lower.includes('duplicate deleted id')) {
    return { message: 'удалённая запись указана несколько раз', includeField: true };
  }
  if (lower.includes('cannot be active and deleted')) {
    return { message: 'запись одновременно изменяется и удаляется; обновите карточку', includeField: true };
  }
  if (lower.includes('must be absent on create') || lower.includes('must be empty on create')) {
    return { message: 'поле должно быть пустым при создании заказа', includeField: true };
  }
  if (lower.includes('must match path order id')) {
    return { message: 'идентификатор не совпадает с открытым заказом; обновите карточку', includeField: true };
  }
  if (lower.includes('must be a positive integer')) {
    return { message: 'укажите корректное значение', includeField: true };
  }
  if (lower.includes('must be a non-negative integer')) {
    return { message: 'укажите целое число не меньше нуля', includeField: true };
  }
  if (lower.includes('must be greater than or equal to zero')) {
    return { message: 'значение не может быть отрицательным', includeField: true };
  }
  if (lower.includes('must be greater than zero')) {
    return { message: 'значение должно быть больше нуля', includeField: true };
  }
  if (lower.includes('must be a valid number') || lower.includes('must be finite')) {
    return { message: 'укажите корректное число', includeField: true };
  }
  if (lower.includes('must be yyyy-mm-dd') || lower.includes('must be a valid calendar date')) {
    return { message: 'укажите корректную дату', includeField: true };
  }
  if (lower.includes('must be an iso datetime')) {
    return { message: 'укажите корректные дату и время', includeField: true };
  }
  if (lower.includes('must be an array')) {
    return { message: 'список имеет некорректный формат', includeField: true };
  }
  if (lower === 'required' || lower.includes('is required') || lower.includes('не может быть пустым')) {
    return { message: 'заполните обязательное поле', includeField: true };
  }
  if (/[А-Яа-яЁё]/.test(value)) {
    return { message: value, includeField: false };
  }
  return { message: 'проверьте значение поля', includeField: true };
}

function pathToField(path: unknown[]): string {
  return path.reduce<string>((field, part) => {
    if (typeof part === 'number') return `${field}[${part}]`;
    if (typeof part !== 'string') return field;
    return field ? `${field}.${part}` : part;
  }, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
