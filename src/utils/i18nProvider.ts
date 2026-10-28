import { I18nProvider } from "@refinedev/core";

const translations: Record<string, string> = {
    "actions.show": "Просмотр",
    "actions.edit": "Редактировать",
    "actions.create": "Создать",
    "actions.delete": "Удалить",
    "actions.list": "Список",
    "actions.save": "Сохранить",
    "actions.cancel": "Отмена",
    "actions.refresh": "Обновить",
    "buttons.show": "Просмотр",
    "buttons.edit": "Редактировать",
    "buttons.create": "Создать",
    "buttons.delete": "Удалить",
    "buttons.save": "Сохранить",
    "buttons.cancel": "Отмена",
    "buttons.confirm": "Подтвердить",
    "buttons.list": "Список",
    "buttons.refresh": "Обновить",
    "titles.list": "Список",
    "titles.create": "Создать",
    "titles.edit": "Редактировать",
    "titles.show": "Просмотр",
    "core.titles.list": "Список",
    "pages.titles.list": "Список",
    "workshops.titles.list": "Список",
    "work_centers.titles.list": "Список",
    "milling_types.titles.list": "Список",
    "film_types.titles.list": "Список",
    "payment_types.titles.list": "Список",
    "edge_types.titles.list": "Список",
    "transaction_direction.titles.list": "Список",
    "material_types.titles.list": "Список",
    "material_transaction_types.titles.list": "Список",
    "production_statuses.titles.list": "Список",
    "resource_requirements_statuses.titles.list": "Список",
    "payment_statuses.titles.list": "Список",
    "requisition_statuses.titles.list": "Список",
    "order_statuses.titles.list": "Список",
    "movements_statuses.titles.list": "Список",
    "employees.titles.list": "Список",
    "vendors.titles.list": "Список",
    "users.titles.list": "Список",
    "units.titles.list": "Список",
    "materials.titles.list": "Список",
    "films.titles.list": "Список",
    "payments.titles.list": "Список",
    "clients.titles.list": "Список",
    "suppliers.titles.list": "Список",
};

export const REFERENCE_RESOURCE_LABELS: Record<string, string> = {
    clients: "клиента",
    materials: "материал",
    sheet_material_types: "листовой материал",
    milling_types: "тип фрезеровки",
    films: "плёнку",
    edge_types: "тип обката",
    vendors: "производителя",
    suppliers: "поставщика",
    film_types: "тип плёнки",
    material_types: "тип материала",
    units: "единицу измерения",
    order_statuses: "статус заказа",
    payment_statuses: "статус платежа",
    payment_types: "тип оплаты",
    requisition_statuses: "статус заявки на закупку",
    movements_statuses: "статус перемещения",
    material_transaction_types: "тип операции с материалом",
    transaction_direction: "направление движения",
    production_statuses: "статус производства",
    resource_requirements_statuses: "статус потребности в ресурсах",
    workshops: "цех",
    work_centers: "участок цеха",
};

// Generic ru fallback for ONLY the per-resource list title `${resource}.titles.list` — the key Refine's
// "back to list" ListButton resolves. When the exact key is absent Refine falls back to the ENGLISH
// userFriendlyResourceName (e.g. "Doweling Orders"); enumerating every resource is brittle (new resources
// regress to English), so one suffix rule keeps the back-to-list button Russian everywhere.
// Scope is intentionally NARROW: do NOT map create/edit/show/clone — Refine reuses those same
// `${resource}.titles.<action>` keys for create/edit/show PAGE HEADER (H3) titles on pages that pass no
// explicit `title`, and overriding them would replace resource-specific headers with generic words.
function resolveListTitle(key: string): string | undefined {
    return /\.titles\.list$/.test(key) ? "Список" : undefined;
}

function resolveReferenceTitle(key: string): string | undefined {
    const match = /^([^.]+)\.titles\.(create|edit)$/.exec(key);
    if (!match) return undefined;
    const label = REFERENCE_RESOURCE_LABELS[match[1]];
    if (!label) return undefined;
    return match[2] === "create" ? `Создать ${label}` : `Редактировать ${label}`;
}

// Resource name in Refine CRUD notifications: Refine asks `${resource}.${resource}` with the English singular
// (e.g. "supplier") as the default. Nominative singular. Unknown resources resolve to undefined, so Refine keeps
// its own default: the notification templates below treat a Latin name as «no name» (neutral «запись»), and the
// menu/breadcrumb (which use the same key only when a resource has no meta.label) keep their previous label.
export const RESOURCE_NOTIFICATION_NAMES: Record<string, string> = {
    orders: "заказ",
    orders_view: "заказ",
    order_details: "деталь заказа",
    order_details_view: "деталь заказа",
    order_workshops: "цех заказа",
    order_resource_requirements: "потребность заказа",
    order_doweling_links: "связь с Базис-проектом",
    doweling_orders: "Базис-проект",
    doweling_orders_view: "Базис-проект",
    production_status_events: "событие статуса производства",
    groups: "группа",
    projects: "группа",
    clients: "клиент",
    client_phones: "телефон клиента",
    client_contacts: "контакт клиента",
    payments: "платёж",
    payments_view: "платёж",
    materials: "материал",
    sheet_material_types: "листовой материал",
    milling_types: "тип фрезеровки",
    extra_resources: "дополнительный ресурс",
    catalog_items: "позиция каталога",
    films: "плёнка",
    film_vendors: "поставщик плёнки",
    edge_types: "тип обката",
    vendors: "производитель",
    suppliers: "поставщик",
    film_types: "тип плёнки",
    material_types: "тип материала",
    units: "единица измерения",
    order_statuses: "статус заказа",
    payment_statuses: "статус платежа",
    payment_types: "тип оплаты",
    requisition_statuses: "статус заявки на закупку",
    movements_statuses: "статус перемещения",
    material_transaction_types: "тип операции с материалом",
    transaction_direction: "направление движения",
    production_statuses: "статус производства",
    resource_requirements_statuses: "статус потребности в ресурсах",
    employees: "сотрудник",
    users: "пользователь",
    roles: "роль",
    workshops: "цех",
    work_centers: "участок цеха",
    app_settings: "настройка",
    vlm_providers: "провайдер распознавания",
    vlm_provider_models: "модель распознавания",
    vlm_prompts: "шаблон запроса распознавания",
    bitrix24_incoming_requests: "заявка Bitrix24",
    onec_purchase_documents: "документ закупки 1С",
};

function resolveResourceName(key: string): string | undefined {
    const match = /^([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(key);
    if (!match || match[1] !== match[2]) return undefined;
    return RESOURCE_NOTIFICATION_NAMES[match[1]];
}

// Refine CRUD/progress notifications. Refine passes the resource already translated (see above), but
// updateMany/deleteMany pass the raw resource name — anything with Latin letters counts as «no name».
type NotificationParams = { resource?: unknown; statusCode?: unknown; seconds?: unknown; processed?: unknown; total?: unknown };

function resourceOf(params: NotificationParams | undefined): string {
    const value = typeof params?.resource === "string" ? params.resource.trim() : "";
    return value && !/[A-Za-z]/.test(value) ? value : "";
}

function codeSuffix(params: NotificationParams | undefined): string {
    const code = params?.statusCode;
    return code !== undefined && code !== null && code !== "" ? ` (код ${code})` : "";
}

const NOTIFICATION_TEMPLATES: Record<string, (params: NotificationParams | undefined) => string> = {
    "notifications.success": () => "Успешно",
    "notifications.error": (p) => `Ошибка${codeSuffix(p)}`,
    "notifications.createSuccess": (p) => (resourceOf(p) ? `Создано: ${resourceOf(p)}` : "Запись создана"),
    "notifications.editSuccess": (p) => (resourceOf(p) ? `Сохранено: ${resourceOf(p)}` : "Изменения сохранены"),
    "notifications.deleteSuccess": (p) => (resourceOf(p) ? `Удалено: ${resourceOf(p)}` : "Запись удалена"),
    "notifications.createError": (p) =>
        `${resourceOf(p) ? `Не удалось создать: ${resourceOf(p)}` : "Не удалось создать запись"}${codeSuffix(p)}`,
    "notifications.editError": (p) =>
        `${resourceOf(p) ? `Не удалось сохранить: ${resourceOf(p)}` : "Не удалось сохранить изменения"}${codeSuffix(p)}`,
    "notifications.deleteError": (p) =>
        `${resourceOf(p) ? `Не удалось удалить: ${resourceOf(p)}` : "Не удалось удалить запись"}${codeSuffix(p)}`,
    "notifications.undoable": (p) => `Отменить можно ещё ${p?.seconds ?? ""} с`,
    "notifications.importProgress": (p) => `Импорт: ${p?.processed ?? 0} из ${p?.total ?? 0}`,
};

// Other built-in Refine/AntD texts that reach the user (autosave indicator, unsaved-changes prompt,
// access tooltip on buttons, remaining buttons).
const REFINE_UI_TEXTS: Record<string, string> = {
    "autoSave.success": "Сохранено",
    "autoSave.loading": "Сохранение…",
    "autoSave.idle": "Ожидает сохранения",
    "autoSave.error": "Ошибка автосохранения",
    warnWhenUnsavedChanges: "Есть несохранённые изменения. Уйти со страницы?",
    "buttons.notAccessTitle": "Нет прав на это действие",
    "buttons.clone": "Копировать",
    "buttons.clear": "Очистить",
    "buttons.export": "Экспорт",
    "buttons.import": "Импорт",
    "buttons.filter": "Фильтр",
    "buttons.logout": "Выйти",
};

export const i18nProvider: I18nProvider = {
    translate: (key: string, params?: any, defaultMessage?: string) => {
        const template = NOTIFICATION_TEMPLATES[key];
        if (template) return template(typeof params === "object" && params !== null ? params : undefined);
        const resourceName = resolveResourceName(key);
        if (resourceName) return resourceName;
        // Refine also calls translate(key, defaultMessage) with two arguments.
        const fallback = defaultMessage ?? (typeof params === "string" ? params : undefined);
        return translations[key] || REFINE_UI_TEXTS[key] || resolveReferenceTitle(key) || resolveListTitle(key) || fallback || key;
    },
    changeLocale: (lang: string) => Promise.resolve(),
    getLocale: () => "ru",
};
