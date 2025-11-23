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
};

export const i18nProvider: I18nProvider = {
    translate: (key: string, params?: any, defaultMessage?: string) => {
        return translations[key] || defaultMessage || key;
    },
    changeLocale: (lang: string) => Promise.resolve(),
    getLocale: () => "ru",
};
