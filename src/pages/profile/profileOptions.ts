import type { UiVariant } from "../../ui-variant/uiVariant";

export const roleNames: Record<string, string> = {
  admin: "Администратор",
  manager: "Менеджер",
  top_manager: "Топ-менеджер",
  operator: "Оператор",
  worker: "Работник",
  packer: "Упаковщик",
  viewer: "Наблюдатель",
  onec_operator: "Оператор интеграции 1С",
};

export function profileRoleName(role: string | null | undefined): string {
  return role ? roleNames[role] ?? role : "—";
}

/** «NewLine»: карточки вариантов оформления — короткое имя, подпись и вид миниатюры. */
export const uiVariantCards: Array<{ value: UiVariant; title: string; caption: string; fresh?: boolean }> = [
  { value: "workbench", title: "NewLine", caption: "Панели, быстрый просмотр", fresh: true },
  { value: "evolution", title: "Эволюция", caption: "Цветная шапка, вкладки" },
  { value: "line", title: "Line", caption: "Линии вместо панелей" },
  { value: "air", title: "Air", caption: "Просторный, мягкий" },
  { value: "neutral", title: "Нейтральная", caption: "Светлая, спокойная" },
  { value: "legacy", title: "Классический", caption: "Исходный вид ERP" },
];

/** Инициалы для круглой отметки: «Тест Иванов» → «ТИ», «codex_playwright» → «CP». */
export function profileInitials(username: string | null | undefined): string {
  const parts = (username ?? "").trim().split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toLocaleUpperCase("ru");
}
