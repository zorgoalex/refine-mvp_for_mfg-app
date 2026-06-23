import { APP_VERSION } from "./version";

export type ReleaseNoteService = "ERP" | "CRM" | "Cutting" | "SVG/DXF";

export interface ReleaseNoteEntry {
  version: string;
  date: string;
  title: string;
  services: ReleaseNoteService[];
  added?: string[];
  changed?: string[];
  fixed?: string[];
}

export const SERVICE_LABELS: Record<ReleaseNoteService, string> = {
  ERP: "ERP",
  CRM: "CRM",
  Cutting: "Раскрой",
  "SVG/DXF": "SVG/DXF макеты",
};

export const releaseNotes: ReleaseNoteEntry[] = [
  {
    version: APP_VERSION,
    date: "2026-06-23",
    title: "Журнал изменений и версионирование",
    services: ["ERP", "CRM", "Cutting", "SVG/DXF"],
    added: [
      "Добавлен журнал изменений, доступный из нижней статусной строки.",
      "Добавлен единый номер версии приложения: 0.5.0.",
      "Добавлен ежедневный patch-version bump для дней, когда в коде были изменения.",
    ],
    changed: [
      "Версия в интерфейсе теперь берется из одного источника и отображается одинаково в сайдбаре и журнале изменений.",
      "Контекст проекта закрепляет правило обновлять Release Notes после каждой новой фичи или заметного пользовательского изменения.",
    ],
  },
];

