export type LabelFieldType = 'string' | 'number' | 'boolean' | 'date';

export interface LabelFieldCatalogItem {
  id: string;
  source: 'bazis' | 'dynamic' | 'detail' | 'order';
  sourceColumn: string | null;
  label: string;
  type: LabelFieldType;
  category: string;
}

export interface DetailFieldColumnMetadata {
  columnName: string;
  dataType: string;
}

export const BAZIS_COLUMN_LABELS = [
  '№',
  '№ п/п',
  'Номер заказа',
  'Примечание к заказу',
  'Обозначение изделия',
  'Заказ модели',
  'Имя модели',
  'Артикул модели',
  'Материал',
  'Артикул материала',
  'Номер плиты',
  'Номер карты',
  'ID детали',
  'Наименование',
  'Позиция в изделии',
  'Обозначение в изделии',
  'Позиция',
  'Кол-во',
  'Толщина',
  'Длина детали',
  'Ширина детали',
  'Длина детали без кромки',
  'Ширина детали без кромки',
  'Длина заготовки',
  'Ширина заготовки',
  'Длина распиловочная',
  'Ширина распиловочная',
  'Гнутая',
  'Обрезок',
  'Срощенная деталь',
  'Размер объединения',
  'Повернута',
  'Ориентация',
  'См. чертеж',
  'Кромка L1 поз.',
  'Кромка L1 наим.',
  'Кромка L1 обозн.',
  'Кромка L1 толщ.',
  'Кромка L1 прип.',
  'Очередность L1',
  'Кромка L2 поз.',
  'Кромка L2 наим.',
  'Кромка L2 обозн.',
  'Кромка L2 толщ.',
  'Кромка L2 прип.',
  'Очередность L2',
  'Кромка W1 поз.',
  'Кромка W1 наим.',
  'Кромка W1 обозн.',
  'Кромка W1 толщ.',
  'Кромка W1 прип.',
  'Очередность W1',
  'Кромка W2 поз.',
  'Кромка W2 наим.',
  'Кромка W2 обозн.',
  'Кромка W2 толщ.',
  'Кромка W2 прип.',
  'Очередность W2',
  'Припуск слева',
  'Припуск сверху',
  'Припуск снизу',
  'Припуск справа',
  'Паз',
  'Комментарий',
  'X панели',
  'Y панели',
  'Периметр',
  'Площадь',
  'Объем',
  'Пластик',
  'Контур',
  'Кол. гл. отв. в пласть',
  'Кол. гл. отв. в пласть верх',
  'Кол. гл. отв. в пласть низ',
  'Кол. скв. отв. в пласть',
  'Кол. отв. в торец',
  'Кол. выемок',
  'Кол. прямол. пазов',
  'Кол. кривол. пазов',
  'Кол. отрезков',
  'Кол. окружностей',
  'Кол. дуг',
  'Эскиз',
  'Шаблон бирки',
  'Кол. панелей',
  'Кол. бирок',
  'N п/п',
  'Длина',
  'Ширина',
  'См.черт.',
  'Длина обрезка',
  'Ширина обрезка',
  'Приоритет',
  'Примечание',
  'Проект',
  'Кол. площ. панелей',
  'Лицевая сторона',
  'Сращивание',
  'Обозначение',
  'Номер позиции',
  'Доп. список',
  'Модель b3d',
  'Облицовка лицевая 1 Артикул',
  'Облицовка лицевая 1 Материал',
  'Облицовка лицевая 1 Толщина',
  'Облицовка лицевая 2 Артикул',
  'Облицовка лицевая 2 Материал',
  'Облицовка лицевая 2 Толщина',
  'Облицовка лицевая 3 Артикул',
  'Облицовка лицевая 3 Материал',
  'Облицовка лицевая 3 Толщина',
  'Облицовка не лицевая 1 Артикул',
  'Облицовка не лицевая 1 Материал',
  'Облицовка не лицевая 1 Толщина',
  'Облицовка не лицевая 2 Артикул',
  'Облицовка не лицевая 2 Материал',
  'Облицовка не лицевая 2 Толщина',
  'Облицовка не лицевая 3 Артикул',
  'Облицовка не лицевая 3 Материал',
  'Облицовка не лицевая 3 Толщина',
  '%Пользовательское свойство',
] as const;

const SEMANTIC_IDS: Record<string, string> = {
  'Номер заказа': 'order_number',
  Материал: 'material',
  'ID детали': 'detail_id',
  Наименование: 'name',
  'Позиция в изделии': 'position_in_product',
  'Обозначение в изделии': 'designation_in_product',
  Позиция: 'position',
  'Кол-во': 'quantity',
  Толщина: 'thickness',
  'Длина детали': 'detail_length',
  'Ширина детали': 'detail_width',
  'Длина распиловочная': 'cut_length',
  'Ширина распиловочная': 'cut_width',
  Комментарий: 'comment',
  Примечание: 'note',
  Проект: 'project',
  Обозначение: 'designation',
  'Номер позиции': 'position_number',
  'Кромка L1 наим.': 'edge_l1_name',
  'Кромка L2 наим.': 'edge_l2_name',
  'Кромка W1 наим.': 'edge_w1_name',
  'Кромка W2 наим.': 'edge_w2_name',
};

export const DYNAMIC_LABEL_FIELDS: readonly LabelFieldCatalogItem[] = [
  { id: 'date.today', source: 'dynamic', sourceColumn: null, label: 'Сегодня', type: 'date', category: 'Динамические' },
  {
    id: 'label.counter',
    source: 'dynamic',
    sourceColumn: null,
    label: 'Номер бирки',
    type: 'number',
    category: 'Динамические',
  },
  {
    id: 'label.counter_total',
    source: 'dynamic',
    sourceColumn: null,
    label: 'Всего бирок',
    type: 'number',
    category: 'Динамические',
  },
  {
    id: 'label.counter_text',
    source: 'dynamic',
    sourceColumn: null,
    label: 'Бир. № X / Y',
    type: 'string',
    category: 'Динамические',
  },
];

const DETAIL_FIELD_LABELS: Record<string, string> = {
  detail_id: 'ID детали',
  order_id: 'ID заказа',
  detail_number: '№',
  detail_name: 'Название детали',
  height: 'Высота',
  width: 'Ширина',
  quantity: 'Кол-во',
  area: 'Площадь',
  material_id: 'ID материала',
  sheet_material_type_id: 'Материал',
  material_name: 'Материал',
  milling_type_id: 'Фрезеровка',
  edge_type_id: 'Обкат',
  film_id: 'Пленка',
  milling_cost_per_sqm: 'Цена за кв.м.',
  detail_cost: 'Сумма',
  priority: 'Пр-т',
  production_status_id: 'Статус',
  joint_order_id: 'ID объединенного заказа',
  note: 'Примечание',
  link_cutting_file: 'Файл раскроя',
  link_cutting_image_file: 'Картинка раскроя',
  link_cad_file: 'CAD файл',
  link_pdf_file: 'PDF файл',
  ref_key_1c: 'Ключ 1C детали',
  basis_project: 'Базис проект',
  basis_product: 'Базис обозн. изделия',
  basis_data: 'Базис данные',
  basis_designation: 'Базис обозн. детали',
  doweling: 'Присадка',
};

const ORDER_FIELD_LABELS: Record<string, string> = {
  order_id: 'ID заказа',
  order_name: 'Номер заказа',
  order_name_numeric: 'Номер заказа числом',
  client_id: 'ID клиента',
  client_name: 'Клиент',
  order_date: 'Дата заказа',
  priority: 'Приоритет',
  doweling_order_id: 'ID присадки',
  doweling_order_name: 'Присадка',
  design_engineer: 'Конструктор',
  completion_date: 'Дата выполнения',
  planned_completion_date: 'Плановая дата выполнения',
  order_status_name: 'Статус заказа',
  payment_status_name: 'Статус оплаты',
  production_status_name: 'Статус производства',
  issue_date: 'Дата выдачи',
  total_amount: 'Сумма',
  final_amount: 'Итоговая сумма',
  discount: 'Скидка',
  surcharge: 'Наценка',
  paid_amount: 'Оплачено',
  payment_date: 'Дата оплаты',
  parts_count: 'Количество деталей',
  total_area: 'Площадь итого',
  milling_type_name: 'Фрезеровка',
  edge_type_name: 'Кромка',
  film_name: 'Пленка',
  material_name: 'Материал заказа',
  notes: 'Примечание заказа',
  link_cutting_file: 'Файл раскроя заказа',
  link_cutting_image_file: 'Картинка раскроя заказа',
  order_ref_key_1c: 'Ключ 1C заказа',
  client_ref_key_1c: 'Ключ 1C клиента',
  manager_id: 'ID менеджера',
  created_by: 'Создал',
  edited_by: 'Изменил',
  created_at: 'Создан',
  updated_at: 'Обновлен',
  version: 'Версия',
  sheet_material_type_id: 'ID листового материала заказа',
};

export const BAZIS_FIELD_CATALOG: readonly LabelFieldCatalogItem[] = BAZIS_COLUMN_LABELS.map((label, index) => ({
  id: `bazis.${SEMANTIC_IDS[label] ?? `col_${String(index + 1).padStart(3, '0')}`}`,
  source: 'bazis',
  sourceColumn: label,
  label,
  type: inferType(label),
  category: inferCategory(label),
}));

export const DETAIL_FIELD_CATALOG: readonly LabelFieldCatalogItem[] = Object.entries(DETAIL_FIELD_LABELS)
  .map(([column, label]) => ({
    id: `detail.${column}`,
    source: 'detail',
    sourceColumn: column,
    label,
    type: inferViewFieldType(column),
    category: 'Деталь',
  }));

export function buildDetailFieldCatalog(columns: readonly DetailFieldColumnMetadata[]): LabelFieldCatalogItem[] {
  return columns
    .map(({ columnName, dataType }) => ({
      id: `detail.${columnName}`,
      source: 'detail' as const,
      sourceColumn: columnName,
      label: DETAIL_FIELD_LABELS[columnName] ?? humanizeColumnName(columnName),
      type: inferDatabaseFieldType(dataType),
      category: 'Деталь',
    }));
}

export function buildRuntimeLabelFieldCatalog(
  detailColumns: readonly DetailFieldColumnMetadata[],
): LabelFieldCatalogItem[] {
  return [
    ...BAZIS_FIELD_CATALOG,
    ...buildDetailFieldCatalog(detailColumns),
    ...ORDER_FIELD_CATALOG,
    ...DYNAMIC_LABEL_FIELDS,
  ];
}

export const ORDER_FIELD_CATALOG: readonly LabelFieldCatalogItem[] = Object.entries(ORDER_FIELD_LABELS).map(([column, label]) => ({
  id: `order.${column}`,
  source: 'order',
  sourceColumn: column,
  label,
  type: inferViewFieldType(column),
  category: 'Заказ',
}));

export const LABEL_FIELD_CATALOG: readonly LabelFieldCatalogItem[] = [
  ...BAZIS_FIELD_CATALOG,
  ...DETAIL_FIELD_CATALOG,
  ...ORDER_FIELD_CATALOG,
  ...DYNAMIC_LABEL_FIELDS,
] as const;

const LABEL_FIELD_IDS = new Set(LABEL_FIELD_CATALOG.map((field) => field.id));

export function isBuiltInLabelFieldId(value: string, runtimeFieldIds?: ReadonlySet<string>): boolean {
  return LABEL_FIELD_IDS.has(value) || runtimeFieldIds?.has(value) === true;
}

export function isSupportedFieldBinding(
  value: string | null | undefined,
  customFieldSchema?: unknown,
  runtimeFieldIds?: ReadonlySet<string>,
): value is string {
  if (!value) {
    return false;
  }
  if (isBuiltInLabelFieldId(value, runtimeFieldIds)) {
    return true;
  }
  return getCustomFieldIds(customFieldSchema).has(value);
}

function humanizeColumnName(columnName: string): string {
  const normalized = columnName.replaceAll('_', ' ').trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : columnName;
}

function inferDatabaseFieldType(dataType: string): LabelFieldType {
  const normalized = dataType.toLowerCase();
  if (normalized === 'boolean') return 'boolean';
  if (normalized.includes('date') || normalized.includes('timestamp')) return 'date';
  if (
    normalized.includes('int') ||
    normalized.includes('numeric') ||
    normalized.includes('decimal') ||
    normalized.includes('real') ||
    normalized.includes('double')
  ) return 'number';
  return 'string';
}

export function getCustomFieldIds(customFieldSchema: unknown): Set<string> {
  if (!customFieldSchema || typeof customFieldSchema !== 'object' || Array.isArray(customFieldSchema)) {
    return new Set();
  }
  return new Set(
    Object.keys(customFieldSchema as Record<string, unknown>).filter((key) => /^[a-zA-Z0-9_.-]+$/.test(key)),
  );
}

function inferType(label: string): LabelFieldType {
  if (
    /^(№|№ п\/п|N п\/п|Кол\.|Кол-во|Длина|Ширина|Толщина|Периметр|Площадь|Объем|X панели|Y панели|Припуск|Очередность|Номер плиты|Номер карты|Номер позиции|ID детали)/.test(
      label,
    )
  ) {
    return 'number';
  }
  if (/^(Гнутая|Обрезок|Срощенная деталь|Повернута|См\. ?черт|Лицевая сторона|Сращивание)$/.test(label)) {
    return 'boolean';
  }
  return 'string';
}

function inferCategory(label: string): string {
  if (label.startsWith('Кромка ')) return 'Кромки';
  if (label.startsWith('Облицовка ')) return 'Облицовка';
  if (/^(Длина|Ширина|Толщина|Периметр|Площадь|Объем|X панели|Y панели|Припуск)/.test(label)) return 'Размеры';
  if (/^(Кол\.|Кол-во)/.test(label)) return 'Количество';
  if (label.includes('отв.') || label.includes('паз') || label.includes('выемок')) return 'Обработка';
  if (/^(Номер заказа|Примечание к заказу|Проект|Заказ модели|Имя модели|Артикул модели)/.test(label)) return 'Заказ';
  return 'Деталь';
}

function inferViewFieldType(column: string): LabelFieldType {
  if (/(^|_)(id|count|amount|area|height|width|quantity|cost|priority|discount|surcharge|version|numeric)$/.test(column)) {
    return 'number';
  }
  if (/(^|_)(date|created_at|updated_at)$/.test(column)) {
    return 'date';
  }
  return 'string';
}
