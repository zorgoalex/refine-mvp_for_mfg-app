/**
 * «NewLine»: разделы экрана «Конфигурация» для левого списка вместо ряда вкладок.
 * Только группировка, подписи и пояснения: состав разделов и права по-прежнему задаёт сам экран,
 * поэтому список никогда не покажет раздел, которого нет среди доступных вкладок.
 */
export interface ConfigurationSectionGroup {
  label: string;
  keys: readonly string[];
}

export const CONFIGURATION_SECTION_GROUPS: readonly ConfigurationSectionGroup[] = [
  { label: 'Общие', keys: ['orders', 'finance', 'org-structure', 'client-screen'] },
  { label: 'Производство', keys: ['production', 'production-thresholds', 'cut'] },
  { label: 'Автоматизация', keys: ['status-automation', 'deadline-rules', 'notification-rules'] },
  {
    label: 'Сообщения',
    keys: ['message-processing', 'whatsapp-connection', 'whatsapp-automation', 'whatsapp-technical-logs', 'daily-order-digest'],
  },
  { label: 'Снабжение', keys: ['procurement-settings'] },
  { label: 'Печать и экспорт', keys: ['labels', 'export-templates'] },
  { label: 'Доступ', keys: ['table-visibility', 'roles-permissions'] },
  { label: 'Другое', keys: ['vlm'] },
];

/** Группа для разделов, которых нет в перечне выше (новая вкладка экрана). */
export const CONFIGURATION_OTHER_GROUP = 'Другое';

export const CONFIGURATION_SECTION_LABELS: Record<string, string> = {
  orders: 'Заказы',
  finance: 'Финансы',
  'org-structure': 'Орг-структура',
  'client-screen': 'Экран клиента',
  production: 'Этапы производства',
  'production-thresholds': 'Пороги техпроцессов',
  cut: 'Раскрой',
  'status-automation': 'Автостатусы',
  'deadline-rules': 'Дедлайн-правила',
  'notification-rules': 'Уведомления',
  'message-processing': 'Обработка сообщений',
  'whatsapp-connection': 'WhatsApp',
  'whatsapp-automation': 'WhatsApp-правила',
  'whatsapp-technical-logs': 'WhatsApp-журнал',
  'daily-order-digest': 'Рассылка сообщений',
  'procurement-settings': 'Закупки',
  labels: 'Бирки',
  'export-templates': 'Шаблоны экспорта',
  'table-visibility': 'Видимость экранов',
  'roles-permissions': 'Права ролей',
  vlm: 'Анализ фото',
};

/** Одна строка под заголовком раздела. */
export const CONFIGURATION_SECTION_DESCRIPTIONS: Record<string, string> = {
  orders: 'Правила оформления заказов.',
  finance: 'Базовая валюта и доступ к финансовым данным заказа.',
  'org-structure': 'Направления и руководители цехов — им адресуются уведомления.',
  production: 'Этапы деталей, их порядок на экранах и плановые сроки.',
  'status-automation': 'Правила, которые сами меняют статусы по событиям в цехе и в оплате.',
  'deadline-rules': 'Что происходит при переходе заказа между этапами со сроками.',
  'notification-rules': 'Кому и о чём система сообщает сама.',
  'whatsapp-connection': 'Подключение WhatsApp для сообщений клиентам.',
  'whatsapp-automation': 'Когда и что отправляется в WhatsApp автоматически.',
  'whatsapp-technical-logs': 'Технические события подключения и отправки.',
  'daily-order-digest': 'Регулярные рассылки сотрудникам и клиентам.',
  labels: 'Шаблоны бирок деталей и их распознавание.',
  'table-visibility': 'Какие экраны видят роли и отдельные пользователи.',
  'roles-permissions': 'Что разрешено каждой роли.',
  vlm: 'Распознавание фото заказов и эскизов.',
};

/** Разделы, которые сами выводят свой заголовок: общий заголовок над ними не повторяется. */
const SECTIONS_WITH_OWN_HEADING: ReadonlySet<string> = new Set([
  'procurement-settings',
  'client-screen',
  'cut',
  'export-templates',
  'production-thresholds',
  'message-processing',
]);

export function configurationSectionHasOwnHeading(key: string): boolean {
  return SECTIONS_WITH_OWN_HEADING.has(key);
}

export interface ConfigurationNavItem {
  key: string;
  /** подпись из перечня; `null` — раздела нет в перечне, показывается подпись самой вкладки */
  label: string | null;
}

export interface ConfigurationNavGroup {
  label: string;
  items: ConfigurationNavItem[];
}

/** Раскладывает доступные вкладки по группам; порядок внутри группы — как в перечне. */
export function buildConfigurationNav(availableKeys: readonly string[]): ConfigurationNavGroup[] {
  const available = new Set(availableKeys);
  const listed = new Set<string>();
  const groups: ConfigurationNavGroup[] = [];
  CONFIGURATION_SECTION_GROUPS.forEach((definition) => {
    const items: ConfigurationNavItem[] = [];
    definition.keys.forEach((key) => {
      listed.add(key);
      if (available.has(key)) items.push({ key, label: CONFIGURATION_SECTION_LABELS[key] ?? null });
    });
    if (items.length > 0) groups.push({ label: definition.label, items });
  });

  const unlisted = availableKeys.filter((key) => !listed.has(key)).map((key) => ({ key, label: null }));
  if (unlisted.length > 0) {
    const other = groups.find((group) => group.label === CONFIGURATION_OTHER_GROUP);
    if (other) other.items.push(...unlisted);
    else groups.push({ label: CONFIGURATION_OTHER_GROUP, items: unlisted });
  }
  return groups;
}

/** Поиск по названию раздела и группы; разделы без подписи в перечне ищутся по ключу. */
export function filterConfigurationNav(groups: readonly ConfigurationNavGroup[], query: string): ConfigurationNavGroup[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return [...groups];
  return groups
    .map((group) => {
      if (group.label.toLocaleLowerCase('ru').includes(needle)) return group;
      return { ...group, items: group.items.filter((item) => (item.label ?? item.key).toLocaleLowerCase('ru').includes(needle)) };
    })
    .filter((group) => group.items.length > 0);
}
