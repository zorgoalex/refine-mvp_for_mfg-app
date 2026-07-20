# Обзор ERP

## Назначение

ERP управляет заказами, производством мебели, оплатами, материалами,
справочниками, импортом Excel/PDF/фото, VLM-анализом, раскроем и экспортом.

Основные компоненты:

- frontend: React + Vite + Refine + Ant Design;
- command/business API: NestJS в `backend/`;
- read/report/reference API: Hasura GraphQL;
- serverless API: Vercel Functions в `api/`;
- база данных: PostgreSQL;
- локальный frontend: `http://localhost:5173`;
- локальный Hasura GraphQL по умолчанию:
  `http://localhost:8585/v1/graphql`.

## Возможности

- Комплексная форма заказа: шапка, детали, платежи, присадки, статусы, даты,
  файлы и примечания.
- Список заказов с серверной сортировкой, поиском, расширенными фильтрами,
  фильтром «Мои заказы» и подсветкой строк.
- Финансы: платежи, статусы оплат, итоговые суммы, оплачено и остаток.
- Производственный календарь: диапазоны дат, Drag & Drop, контекстные действия,
  компактные карточки и цветовая кодировка материалов.
- Две доски статусов: общий и производственный поток.
- Независимые производственные этапы и переключаемый автоматический расчёт
  производственного статуса заказа по деталям.
- Настройки приложения, производственного workflow, справочников и VLM.
- Импорт деталей из Excel, PDF и фото.
- Печать заказа, Excel-экспорт, JSON snapshot и экспорт в Google Drive.
- JWT-аутентификация с refresh token rotation и Hasura role-based permissions.
- Управление пользователями, ролями, справочниками и уведомлениями.
- Группы и проекты заказов за соответствующими feature flags.
- Базис-раскрой: сохранённые наборы деталей и повторный BIFF8 `.xls` экспорт.
- Переход из ERP в Битрикс24 и backend-синхронизация ERP→Bitrix24.

Подробные пользовательские и операторские контракты:
[Функциональные разделы ERP](feature-guides.md).

## Стек

- React 18, Vite 4.
- Refine: `@refinedev/core`, `@refinedev/antd`,
  `@refinedev/react-router-v6`, `@refinedev/kbar`.
- UI: `antd@^5`.
- State: `zustand@^5`.
- Forms/validation: `react-hook-form@^7`, `@hookform/resolvers@^5`, `zod@^4`.
- Import/export/print: `xlsx`, `pdfjs-dist`, `exceljs`, `react-to-print`.
- Calendar: `date-fns`, `react-dnd`, `react-dnd-html5-backend`.
- Backend: NestJS + PostgreSQL.
- Tests: Vitest + Playwright.

Точные версии находятся в `package.json` и `backend/package.json`.

## Структура репозитория

- `src/index.tsx` — точка входа React.
- `src/App.tsx` — resources, routes, providers, layout и auth.
- `src/authProvider.ts` — legacy и backend auth flows.
- `src/utils/dataProvider.ts` — Hasura data provider и backend read cutover.
- `src/components/CustomLayout.tsx`, `src/components/CustomSider.tsx` — layout
  и меню.
- `src/pages/orders/` — список, просмотр, создание и редактирование заказов.
- `src/pages/orders/components/` — форма заказа, таблицы, вкладки, модальные
  окна, печать и импорт.
- `src/pages/calendar/` — календарь, карточки, DnD и хуки данных.
- `src/pages/configuration/` — настройки приложения, производства, VLM,
  автоматизации и шаблонов.
- `src/hooks/` — shared hooks.
- `src/stores/` — Zustand stores.
- `src/schemas/` — Zod-схемы.
- `src/types/` — доменные типы.
- `src/utils/excel/` — Excel/Google Drive export.
- `api/` — Vercel Functions.
- `backend/` — NestJS `/api/v1/*`, health endpoints, command modules и
  миграции.
- `docs/` — публичная developer-документация.
- `ops/` — VPS bootstrap/deploy scripts и Compose templates.
- `public/templates/order_template.xlsx` — Excel-шаблон.
- `vercel.json` — rewrites, headers и Vercel Functions.
- `vite.config.ts` — dev server и proxy.

## Основные маршруты

- `/orders` — список заказов.
- `/orders/edit/:id` — редактирование заказа.
- `/orders/show/:id` — просмотр заказа.
- `/orders/trash` — корзина заказов.
- `/calendar` — производственный календарь.
- `/order-status-board` — доски статусов.
- `/doweling-orders` — присадки.
- `/payments` — платежи.
- `/payments-analytics` — аналитика платежей.
- `/clients`, `/clients-analytics` — клиенты и аналитика.
- `/groups` — группы заказов.
- `/projects` — проекты.
- `/configuration` — настройки.
- `/cut` — задания раскроя.
- `/bazis-cut`, `/bazis-cut/:id` — Базис-раскрой.

Остальные справочники и производственные ресурсы зарегистрированы в
`src/App.tsx`.

## Ключевые соглашения реализации

- Legacy `orders_view` и аналитические views используются только для чтения;
  запись выполняется в базовые таблицы или через backend commands.
- В backend-orders режиме `OrderList`, `OrderShow`, `OrderForm` и
  `useOrderSave` используют `/api/v1/orders`.
- Новому Hasura-ресурсу нужны primary key в `ID_COLUMNS` и selection fields в
  `RESOURCE_FIELDS`.
- `dataProvider` автоматически добавляет `is_active=true` для активируемых
  справочников, если фильтр не задан явно.
- Форма заказа хранит draft в Zustand и использует `temp_id` для новых строк.
- Сохранение заказа включает header, детали, удаления, totals, платежи,
  production/workshop/resource блоки, присадки и invalidation.
- Производственные этапы отображаются по workflow из `app_settings`; журнал
  этапов отделён от текущего статуса.
- VLM проходит через защищённый API и Auth0 M2M.
- GAS API key добавляется только serverless-функцией и не раскрывается
  frontend.
- Глобальная локаль — `ru_RU`.
