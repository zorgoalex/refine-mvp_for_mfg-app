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

export const i18nProvider: I18nProvider = {
    translate: (key: string, params?: any, defaultMessage?: string) => {
        return translations[key] || resolveListTitle(key) || defaultMessage || key;
    },
    changeLocale: (lang: string) => Promise.resolve(),
    getLocale: () => "ru",
};
