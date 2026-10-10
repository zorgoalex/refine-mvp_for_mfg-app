import type { SiderMenuItem } from './siderMenuItems';

/**
 * «NewLine»: единый перечень справочников для левой панели экранов-справочников.
 * Только группировка и подписи: состав берётся из уже отфильтрованного по правам меню,
 * поэтому панель никогда не покажет экран, которого нет в боковом меню пользователя.
 */
export interface ReferenceGroupDefinition {
  label: string;
  resources: readonly string[];
}

export const REFERENCE_GROUPS: readonly ReferenceGroupDefinition[] = [
  {
    label: 'Материалы',
    resources: [
      'materials',
      'sheet_material_types',
      'films',
      'film_types',
      'material_types',
      'edge_types',
      'milling_types',
      'extra_resources',
      'vendors',
      'film_vendors',
      'units',
      'catalog_items',
    ],
  },
  { label: 'Производство', resources: ['workshops', 'work_centers', 'order_workshops', 'production_statuses'] },
  {
    label: 'Статусы',
    resources: ['order_statuses', 'payment_statuses', 'requisition_statuses', 'resource_requirements_statuses', 'movements_statuses'],
  },
  { label: 'Склад', resources: ['inventory-warehouses', 'material_transaction_types', 'transaction_direction'] },
  { label: 'Финансы', resources: ['payment_types'] },
  { label: 'Персонал', resources: ['employees'] },
  { label: 'Партнёры', resources: ['suppliers'] },
];

/** Категория бокового меню, чьи экраны считаются справочниками, даже если их нет в перечне выше. */
export const REFERENCE_MENU_CATEGORY = 'Данные';
export const REFERENCE_OTHER_GROUP = 'Прочее';
/** Экраны категории «Данные», которые справочниками не являются. */
const NOT_REFERENCES: ReadonlySet<string> = new Set(['orders-trash']);

/** Одна строка под заголовком справочника: где он используется. */
export const REFERENCE_DESCRIPTIONS: Record<string, string> = {
  materials: 'Выбираются в деталях заказа.',
  sheet_material_types: 'Листы для деталей и раскроя: размеры листа и связь с номенклатурой.',
  films: 'Плёнки для деталей заказа и закупа.',
  film_types: 'Группировка плёнок; используется в фильтрах.',
  material_types: 'Группировка материалов.',
  edge_types: 'Кромка деталей заказа.',
  milling_types: 'Выбираются в деталях заказа; здесь же цена за м² и минимальный размер детали.',
  extra_resources: 'Дополнительные ресурсы в потребностях заказа.',
  vendors: 'Производители материалов.',
  film_vendors: 'Производители плёнок.',
  units: 'Единицы в потребностях, закупе и складских документах.',
  catalog_items: 'Позиции каталога для заказов и закупа.',
  workshops: 'Производственные цеха.',
  work_centers: 'Участки внутри цеха.',
  order_workshops: 'В какие цеха направлен заказ.',
  production_statuses: 'Этапы производства деталей и заказа.',
  order_statuses: 'Статус заказа в списках и карточке; здесь же его цвет.',
  payment_statuses: 'Состояние оплаты заказа.',
  requisition_statuses: 'Состояния заявки на закуп.',
  resource_requirements_statuses: 'Состояния потребности заказа.',
  movements_statuses: 'Состояния складского движения.',
  'inventory-warehouses': 'Склады для остатков и движений.',
  material_transaction_types: 'Виды складских движений.',
  transaction_direction: 'Направление складского движения.',
  payment_types: 'Способы оплаты в платежах.',
  employees: 'Сотрудники и их рабочие контакты.',
  suppliers: 'Поставщики для заявок на закуп.',
};

/** Справочники с широкими таблицами: на нешироком экране панель для них по умолчанию свёрнута. */
const WIDE_REFERENCES: ReadonlySet<string> = new Set(['films', 'inventory-warehouses', 'sheet_material_types', 'catalog_items']);
export const REFERENCE_RAIL_ROOMY_WIDTH = 1600;

/**
 * Свёрнута ли панель: явный выбор пользователя главнее; без него панель свёрнута только
 * у широких справочников на экране уже `REFERENCE_RAIL_ROOMY_WIDTH`.
 */
export function isReferenceRailHidden(choice: boolean | null, resourceName: string, viewportWidth: number): boolean {
  if (choice !== null) return choice;
  return isWideReference(resourceName) && viewportWidth < REFERENCE_RAIL_ROOMY_WIDTH;
}

/** Выбор «свернуть/показать» запоминается отдельно для широких и обычных справочников. */
export function isWideReference(resourceName: string): boolean {
  return WIDE_REFERENCES.has(resourceName);
}

/** Группа, в которую справочник входит на панели; `null` — экран не из перечня справочников. */
export function referenceGroupLabel(resourceName: string | undefined): string | null {
  if (!resourceName) return null;
  return REFERENCE_GROUPS.find((group) => group.resources.includes(resourceName))?.label ?? null;
}

export interface ReferenceRailItem extends SiderMenuItem {
  group: string;
}

export interface ReferenceRailGroup {
  label: string;
  items: ReferenceRailItem[];
}

/**
 * Собирает группы панели из разложенного по категориям меню (оно уже учитывает права и видимость по ролям).
 * Порядок внутри группы — как в перечне; экраны категории «Данные» вне перечня попадают в «Прочее».
 */
export function buildReferenceRail(categorizedResources: Record<string, readonly SiderMenuItem[]>): ReferenceRailGroup[] {
  const visible = new Map<string, SiderMenuItem>();
  Object.values(categorizedResources).forEach((items) => items.forEach((item) => visible.set(item.name, item)));

  const listed = new Set<string>();
  const groups: ReferenceRailGroup[] = [];
  REFERENCE_GROUPS.forEach((definition) => {
    const items: ReferenceRailItem[] = [];
    definition.resources.forEach((name) => {
      listed.add(name);
      const item = visible.get(name);
      if (item) items.push({ ...item, group: definition.label });
    });
    if (items.length > 0) groups.push({ label: definition.label, items });
  });

  const other = (categorizedResources[REFERENCE_MENU_CATEGORY] ?? [])
    .filter((item) => !listed.has(item.name) && !NOT_REFERENCES.has(item.name))
    .map((item) => ({ ...item, group: REFERENCE_OTHER_GROUP }));
  if (other.length > 0) groups.push({ label: REFERENCE_OTHER_GROUP, items: other });

  return groups;
}

const trimPath = (path: string) => path.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';

/** Справочник, чей список открыт по этому адресу (только сам список, не карточка и не форма). */
export function findReferenceByPath(groups: readonly ReferenceRailGroup[], pathname: string): ReferenceRailItem | null {
  const path = trimPath(pathname);
  for (const group of groups) {
    const match = group.items.find((item) => trimPath(item.route) === path);
    if (match) return match;
  }
  return null;
}

/** Поиск по названию справочника; пустые группы отбрасываются. */
export function filterReferenceRail(groups: readonly ReferenceRailGroup[], query: string): ReferenceRailGroup[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return [...groups];
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLocaleLowerCase('ru').includes(needle)) }))
    .filter((group) => group.items.length > 0);
}
