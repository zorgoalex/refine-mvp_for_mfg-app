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

// Generic ru fallback for Refine's per-resource action titles. Refine resolves header buttons / breadcrumbs
// via keys like `${resource}.titles.list` and, when the exact key is absent, falls back to the ENGLISH
// userFriendlyResourceName (e.g. "Doweling Orders"). Enumerating every resource is brittle (new resources
// regress to English). Matching the suffix covers all current + future resources with one rule, so the
// "back to list" button and friends stay Russian everywhere.
const TITLE_SUFFIX_RU: Record<string, string> = {
    list: "Список",
    create: "Создать",
    edit: "Редактировать",
    show: "Просмотр",
    clone: "Клонировать",
};

function resolveTitleSuffix(key: string): string | undefined {
    const match = /\.titles\.([a-z]+)$/.exec(key);
    return match ? TITLE_SUFFIX_RU[match[1]] : undefined;
}

export const i18nProvider: I18nProvider = {
    translate: (key: string, params?: any, defaultMessage?: string) => {
        return translations[key] || resolveTitleSuffix(key) || defaultMessage || key;
    },
    changeLocale: (lang: string) => Promise.resolve(),
    getLocale: () => "ru",
};
