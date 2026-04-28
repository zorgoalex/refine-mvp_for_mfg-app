# ERP Frontend — Refine + Hasura GraphQL

Веб-интерфейс ERP для управления заказами, производством, оплатами, материалами и справочниками. Приложение построено на React, Refine и Ant Design, работает с Hasura GraphQL и использует Vercel Functions для серверных API.

## Содержание

- Обзор
- Возможности
- Стек
- Структура проекта
- Ресурсы и маршруты
- Конфигурация и авторизация
- Установка и запуск
- Тесты
- Примечания по реализации

## Обзор

- Frontend: React + Vite + Refine + Ant Design.
- Backend data API: Hasura GraphQL.
- Serverless API: Vercel Functions в каталоге `api/`.
- Локальный dev server: `http://localhost:5173`.
- Локальный Hasura GraphQL по умолчанию: `http://localhost:8585/v1/graphql`.
- Актуальная схема БД: v14.

## Возможности

- Комплексная форма заказов: шапка, детали, платежи, присадки, статусы, даты, файлы и примечания.
- Список заказов с серверной сортировкой, поиском, расширенными фильтрами, быстрым фильтром "Мои заказы" и подсветкой строк.
- Финансы: платежи, статусы оплат, итоговые суммы, пересчёт оплачено/остаток.
- Производственный календарь: диапазон дат, Drag & Drop, контекстное меню статусов, компактные виды карточек, цветовая кодировка материалов.
- Этапы производства: независимые toggle-этапы, хранение фактов в `production_status_events`, отображение в списке, карточках календаря и карточке заказа.
- Настройки приложения: `app_settings`, вкладки заказов, финансов, этапов производства, видимости ресурсов и анализа фото.
- Импорт деталей: Excel, PDF и фото через VLM API.
- VLM-конфигурация из БД: провайдеры, модели, промпты и дефолтные настройки запросов.
- Печать заказа и экспорт в Excel.
- Экспорт заказов в Google Drive через защищённый Vercel API proxy к Google Apps Script.
- JWT-аутентификация с refresh token rotation и Hasura role-based permissions.
- Управление пользователями, ролями и ключевыми справочниками.

## Стек

- React 18, Vite 4.
- Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`.
- UI: `antd@^5`.
- State: `zustand@^5`.
- Forms/validation: `react-hook-form@^7`, `@hookform/resolvers@^5`, `zod@^4`.
- Import/export/print: `xlsx`, `pdfjs-dist`, `exceljs`, `react-to-print`.
- Calendar: `date-fns`, `react-dnd`, `react-dnd-html5-backend`.
- Serverless/API: `@vercel/node`, `jsonwebtoken`, `bcryptjs`.
- Tests: Vitest, Playwright.

Точные версии указаны в `package.json`.

## Структура проекта

- `src/index.tsx` — точка входа React.
- `src/App.tsx` — Refine resources, routes, providers, layout и auth.
- `src/authProvider.ts` — Refine auth provider для `/api/login` и `/api/refresh`.
- `src/utils/dataProvider.ts` — кастомный Hasura GraphQL data provider с JWT.
- `src/components/CustomLayout.tsx`, `src/components/CustomSider.tsx` — основной layout и меню.
- `src/pages/orders/` — список, просмотр, создание и редактирование заказов.
- `src/pages/orders/components/` — форма заказа, таблицы, вкладки, модальные окна, печать и импорт.
- `src/pages/calendar/` — производственный календарь, карточки, DnD, контекстные меню и хуки данных.
- `src/pages/configuration/` — настройки приложения, производства и VLM.
- `src/hooks/` — shared hooks: сохранение заказов, настройки, VLM, экспорт, подсветка, production events.
- `src/stores/` — Zustand stores для формы заказа и уведомлений.
- `src/schemas/` — Zod-схемы валидации.
- `src/types/` — типы доменных сущностей.
- `src/utils/excel/` — подготовка и отправка данных для Excel/Google Drive.
- `api/` — Vercel Functions: auth, users, refresh, VLM, export.
- `public/templates/order_template.xlsx` — шаблон Excel.
- `vercel.json` — rewrites, headers и настройки функций.
- `vite.config.ts` — порт dev server и proxy `/api`.

## Ресурсы и маршруты

Ключевые routes:

- `/orders` — список заказов (`orders_view`).
- `/orders/edit/:id` — форма редактирования заказа, запись в `orders` и связанные таблицы.
- `/orders/show/:id` — просмотр заказа.
- `/calendar` — производственный календарь.
- `/doweling-orders` — присадки.
- `/payments` — платежи.
- `/payments-analytics` — агрегированный список платежей (`payments_view`).
- `/clients` и `/clients-analytics` — клиенты и клиентская аналитика.
- `/configuration` — настройки приложения.

Справочники и производственные сущности также зарегистрированы в `src/App.tsx`: материалы, плёнки, типы фрезеровок, типы кромок, поставщики, производители, статусы заказов/оплат/производства, цеха, участки, сотрудники, пользователи и другие ресурсы.

## Конфигурация и авторизация

Frontend env:

```env
VITE_HASURA_GRAPHQL_URL=http://localhost:8585/v1/graphql
```

Backend env для Vercel Functions:

```env
HASURA_URL=http://localhost:8585/v1/graphql
HASURA_ADMIN_SECRET=...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
GAS_WEBAPP_URL=...
GAS_API_KEY=...
VLM_API_URL=...
AUTH0_M2M_DOMAIN=...
AUTH0_M2M_CLIENT_ID=...
AUTH0_M2M_CLIENT_SECRET=...
AUTH0_M2M_AUDIENCE=...
```

Аутентификация:

- `/api/login` проверяет пользователя через Hasura admin query, выдаёт access token и refresh token.
- `/api/refresh` выполняет refresh token rotation.
- Access token содержит Hasura claims: allowed roles, default role и user id.
- Frontend хранит токены в `localStorage` и автоматически обновляет access token при истечении.

Audit:

- `created_by`, `edited_by`, `created_at`, `updated_at` управляются серверной стороной.
- Клиентские create/update payload очищаются от audit-полей в `dataProvider`.

## Установка и запуск

```bash
npm install
npm run dev
```

Полный локальный запуск UI + API:

```bash
npm run dev:full
```

Доступные скрипты:

- `npm run dev` — только Vite UI на `5173`.
- `npm run dev:api` — только Vercel Functions на `3001`.
- `npm run dev:full` — UI и API вместе.
- `npm run build` — production build.
- `npm run preview` — preview build.
- `npm run test` — unit/API tests через Vitest.
- `npm run test:e2e` — Playwright tests.

## Тесты

Unit/API:

```bash
npm run test
```

E2E:

```bash
npm run test:e2e
```

Playwright запускает `npm run dev:full` через `webServer` и использует `http://localhost:5173` как `baseURL`.

## Примечания по реализации

- `orders_view` и аналитические views используются для чтения; запись идёт в базовые таблицы.
- Для новых ресурсов нужно добавить primary key в `ID_COLUMNS` и selection fields в `RESOURCE_FIELDS`.
- `dataProvider` автоматически добавляет `is_active = true` для активируемых справочников, если фильтр `is_active` не задан явно.
- Форма заказа хранит черновик в Zustand store и использует `temp_id` для новых строк до сохранения.
- Сохранение заказа последовательное: header, детали, удаления, пересчёт итогов, платежи, production/workshop/resource блоки, присадки, invalidation.
- Этапы производства отображаются по workflow-настройке из `app_settings`; факты этапов хранятся отдельно от текущего статуса заказа.
- VLM upload/analyze проходит через Vercel API, проверку ERP JWT и Auth0 M2M token.
- Google Drive export не раскрывает GAS API key на frontend: ключ добавляется только в serverless function.
- Глобальная локаль интерфейса — `ru_RU`.
