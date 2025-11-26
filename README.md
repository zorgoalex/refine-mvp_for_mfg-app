 # Front Refine v1 - Refine + Hasura GraphQL Admin (MVP)

  Простой административный интерфейс на базе Refine + Ant Design, работающий с Hasura GraphQL. Проект ориентирован на MVP для сущностей БД и демонстрирует список, просмотр и CRUD-операции для ключевых ресурсов.

  ## Содержание
  - Обзор
  - Ключевые фичи
  - Стек и зависимости
  - Структура проекта
  - Ресурсы и маршруты
  - Конфигурация и авторизация
  - Установка и запуск
  - Примечания по реализации
  - Известные ограничения
  - Дальнейшие шаги (Roadmap)
  - Ссылки и материалы

  ## Обзор
  - Backend: Hasura GraphQL доступен локально по `http://localhost:8585/v1/graphql`.
  - Frontend: Refine (+ AntD) на Vite/React.
  - Схема БД: **v12**
  - Dev server: `http://localhost:5576`
  - Статус: **MVP+ завершен** (2025-11-01) — полнофункциональная форма заказов с деталями и платежами
  - **Печать/экспорт** (2025-11-16) — готовность к production
  - **Экспорт в Google Drive** (2025-11-24) — защищённый прокси через Vercel API → GAS

  ## Ключевые фичи
  - **CRUD** для 29 ресурсов + комплексная форма заказов (детали, платежи, статусы)
  - **Финансы**: вкладка платежей с inline CRUD, итогами и автозаполнением даты оплаты по последнему платежу
  - **Присадки (doweling_orders)**: связь 1→many, выбор и быстрое создание из формы заказа, поля видны в списке/просмотре
  - **JWT аутентификация и управление пользователями**: `/api/login` и `/api/refresh` с ротацией refresh-токенов; страницы users (create/edit/show/list) со сменой пароля; токены в localStorage, роли Hasura
  - **Производственный календарь** (16 дней: 5 назад + 10 вперед): адаптивный layout, Drag & Drop, контекстное меню статусов заказа/оплаты/производства, три вида карточек (стандарт/компакт/краткий), цветовая кодировка материалов
  - **Автоэкспорт заказов в Google Drive**: Vercel API proxy → Google Apps Script, JSON payload без фронтовых секретов, автоэкспорт после сохранения
  - **Аудит через Hasura presets**: created_by/edited_by проставляются сервером, без dev-override
  - **Row Highlight и быстрые переходы**: подсветка новых/отредактированных записей, двойной клик открывает show-
  страницу
  - **Сортировка DESC по ID**, **is_active** фильтры, фиксированный sidebar, цветовая кодировка материалов
  - **Печать и экспорт**: react-to-print под A4 и ExcelJS экспорт по шаблону с формулами

  ## Стек и зависимости
  - React 18, Vite 4
  - Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`
  - UI: `antd@^5`
  - State Management: `zustand@^5` (для формы заказов)
  - Validation: `zod@^4` (для валидации форм)
  - Forms: `react-hook-form@^7` + `@hookform/resolvers@^5`
  - Print & Export: `react-to-print@^3`, `exceljs@^4` (печать и экспорт заказов)
  - Calendar: `date-fns@^4`, `react-dnd@^16`, `react-dnd-html5-backend@^16` (Drag & Drop)
  - Data provider: Hasura GraphQL провайдер с JWT (`src/utils/dataProvider.ts`)

  ### Audit
  - Поля аудита заполняются Hasura column presets по `x-hasura-user-id` из JWT. Дополнительных dev-переменных не требуется.

  Список версий см. в `package.json`.

  ## Структура проекта
  - `src/index.tsx` — точка входа React.
  - `src/App.tsx` — конфигурация Refine: ресурсы, роутинг, аутентификация, layout.
  - `src/utils/dataProvider.ts` — Hasura GraphQL `dataProvider`, использующий Bearer токен пользователя.
  - `src/components/CustomSider.tsx` — левое меню на основе `useMenu` (AntD 5 `Menu.items`).
  - Страницы ресурсов:
    - Orders (read-only view): `src/pages/orders/{list,show}.tsx` (Edit направлен на базовую таблицу `orders`).
    - Calendar: `src/pages/calendar/index.tsx` — производственный календарь
      - `components/CalendarBoard.tsx` — основная доска календаря
      - `components/DayColumn.tsx` — колонка дня
      - `components/OrderCard.tsx` — карточка заказа (три вида)
      - `components/OrderCardCompact.tsx`, `components/DayColumnBrief.tsx` — компактные виды
      - `components/OrderContextMenu.tsx` — ПКМ для статусов
      - `hooks/useCalendarData.ts` — загрузка данных
      - `hooks/useCalendarDays.ts` — генерация дней
      - `hooks/useOrderStatusUpdate.ts`, `hooks/useOrderStatuses.ts` — обновление/загрузка статусов
      - `hooks/useOrderMove.ts` — перемещение заказов между днями
      - `utils/dateUtils.ts`, `calendarLayout.ts`, `statusColors.ts`
      - `types/calendar.ts`, `styles/calendar.css`
    - Orders — ключевые секции формы: `OrderForm.tsx`, табы деталей и платежей (`OrderDetailsTab.tsx`,
  `OrderPaymentsTab.tsx`), модалки (`OrderDetailModal.tsx`, `PaymentModal.tsx`), быстрые действия для присадки
  (`DowellingOrderQuickCreate.tsx`)
    - Materials: `src/pages/materials/{list,create,edit,show}.tsx`
    - Milling Types: `src/pages/milling_types/{list,create,edit,show}.tsx`
    - Films: `src/pages/films/{list,create,edit,show}.tsx`
    - Clients: `src/pages/clients/{list,create,edit,show}.tsx`
    - Edge Types: `src/pages/edge_types/{list,create,edit,show}.tsx`
    - Vendors: `src/pages/vendors/{list,create,edit,show}.tsx`
    - Suppliers: `src/pages/suppliers/{list,create,edit,show}.tsx`
    - Film Vendors: `src/pages/film_vendors/{list,create,edit,show}.tsx`
    - Film Types: `src/pages/film_types/{list,create,edit,show}.tsx`
    - Material Types: `src/pages/material_types/{list,create,edit,show}.tsx`
    - Order Statuses: `src/pages/order_statuses/{list,create,edit,show}.tsx`
    - Payment Statuses: `src/pages/payment_statuses/{list,create,edit,show}.tsx`
    - Payment Types: `src/pages/payment_types/{list,create,edit,show}.tsx`
    - Units: `src/pages/units/{list,create,edit,show}.tsx`
    - Employees: `src/pages/employees/{list,create,edit,show}.tsx`
    - Users: `src/pages/users/{list,create,edit,show}.tsx`
    - Workshops: `src/pages/workshops/{list,create,edit,show}.tsx`
    - Work Centers: `src/pages/work_centers/{list,create,edit,show}.tsx`
    - Production Statuses: `src/pages/production_statuses/{list,create,edit,show}.tsx`
    - Resource Requirements Statuses: `src/pages/resource_requirements_statuses/{list,create,edit,show}.tsx`
  - Хуки:
    - `src/hooks/useFormWithHighlight.ts` — навигация с подсветкой после create/edit
    - `src/hooks/useHighlightRow.ts` — подсветка и скролл к строке в таблице
    - `src/hooks/useOrderSave.ts` — delta-save для заказа, деталей, платежей
  - Печать и экспорт:
    - `src/pages/orders/components/print/OrderPrintView.tsx` — компонент печатной формы заказа
    - `public/templates/order_template.xlsx` — шаблон Excel для экспорта
    - `src/hooks/useOrderExport.ts`, `src/utils/excel/uploadToApi.ts` — автоэкспорт в Google Drive через Vercel API
  → GAS
  - Стили:
    - `src/styles/app.css` — глобальные стили (sidebar, row highlight анимация)
    - `src/pages/orders/components/print/OrderPrintView.css` — стили печатной формы
  - Инфраструктура:
    - `vite.config.ts` — порт 5576 и proxy для /api
    - `vercel.json` — security headers, rewrites для API
    - `package.json` — скрипты `dev`, `dev:api`, `dev:full`

  ## Ресурсы и маршруты
  Определены в `src/App.tsx` внутри `resources` и роутов React Router:
  - `orders_view`
    - `list`: `/orders`
    - `show`: `/orders/show/:id`
    - `meta.idColumnName`: `order_id`
    - Назначение: только чтение (read-only), агрегированный вид заказа.
  - `calendar`
    - `list`: `/calendar`
    - `meta.label`: `Календарь`
    - Назначение: визуализация заказов по плановым датам завершения (производственный календарь).
    - Использует `orders_view` как источник данных
  - `materials`
    - `list/create/edit/show` с `meta.idColumnName`: `material_id`
  - `milling_types`
    - `list/create/edit/show` с `meta.idColumnName`: `milling_type_id`
  - `films`
    - `list/create/edit/show` с `meta.idColumnName`: `film_id`
  - `clients`
    - `list/create/edit/show` с `meta.idColumnName`: `client_id`
  - `edge_types`, `vendors`, `suppliers`
    - `list/create/edit/show` с соответствующими `*_id`
  - `film_vendors`, `film_types`, `material_types`
    - `list/create/edit/show` с соответствующими `*_id`
  - `order_statuses`, `payment_statuses`, `payment_types`
    - `list/create/edit/show` с соответствующими `*_id`
  ## Конфигурация и авторизация
  - Переменные окружения (frontend / Vite):
    - `VITE_HASURA_GRAPHQL_URL` — URL Hasura GraphQL.
  - Переменные окружения (backend / Vercel Functions):
    - `HASURA_URL`, `HASURA_ADMIN_SECRET`
    - `JWT_SECRET`, `JWT_REFRESH_SECRET`
    - `GAS_WEBAPP_URL`, `GAS_API_KEY`
  - **Аутентификация:** JWT через Vercel Functions; frontend `authProvider` с auto-refresh; Hasura с role-based
  permissions и audit presets.
  - **Data Provider:** `src/utils/dataProvider.ts` добавляет JWT и обновляет истёкший токен.

  Пример `.env.local`:

  VITE_HASURA_GRAPHQL_URL=http://localhost:8585/v1/graphql


  ## Установка и запуск
  - Скрипты: `npm run dev` (только UI), `npm run dev:api` (только API), `npm run dev:full` (UI+API, proxy).
  - Env: заполняем HASURA_URL, HASURA_ADMIN_SECRET, JWT_SECRET/REFRESH_SECRET, VITE_HASURA_GRAPHQL_URL, при экспорте также GAS_WEBAPP_URL/GAS_API_KEY.

  ## Примечания по реализации
  - Orders: детали (inline), платежи (вкладка Финансы, итоги, автодата), присадки, Zod-валидация, delta save, очистка audit-полей, optimistic locking, печать/Excel, автоэкспорт в GDrive.
  - Календарь: 16 дней, три вида карточек, Drag&Drop, ПКМ статусов, сокращённые материалы, фиксированная шапка.
  - Общие: `meta.idColumnName` во всех ресурсах, `CustomSider` с календарём и заказами на верхнем уровне, локаль ruRU.

  ## Известные ограничения
  - Проверить CORS и роли Hasura перед prod; типизация базовая; автотесты минимальны (unit для auth, E2E логин).

  ## Дальнейшие шаги (Roadmap)
  - Done: CRUD orders, Печать/экспорт, Payments Tab (25.11.2025).
  - Календарь ~60% (осталось: печать плана дня, фильтры/поиск).
  - План: Workshops/Materials Tabs, Quick Create для справочников, nested insert/upsert, динамическая видимость ресурсов по ролям, виртуализация таблиц, soft-delete/версионирование, E2E.