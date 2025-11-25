# Front Refine v1 — Refine + Hasura GraphQL Admin (MVP)

Простой административный интерфейс на базе Refine + Ant Design, работающий с Hasura GraphQL. Проект ориентирован на MVP для сущностей БД и демонстрирует список, просмотр и CRUD-операции для ключевых ресурсов.

## Содержание
- Обзор
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
- Backend: Hasura GraphQL доступен локально по `http://localhost:8585/v1/graphql` с заголовком `x-hasura-admin-secret` (dev).
- Frontend: Refine (+ AntD) на Vite/React.
- Схема БД: **v12**
- Dev server: `http://localhost:5576`
- Статус: **MVP+ завершен** (2025-11-01) - полнофункциональная форма заказов с деталями
- **Печать и экспорт** (2025-11-16) - готовность к production

## Ключевые фичи
- ✅ **CRUD операции** для всех справочников и операционных таблиц (29 ресурсов)
- ✅ **Комплексная форма заказов** (Orders) с деталями, платежами и inline-редактированием
- ✅ **JWT аутентификация** через Vercel Functions (`/api/login`, `/api/refresh`) и `authProvider` с хранением токенов
- 🟡 **Производственный календарь** - визуализация заказов по плановым датам завершения (16 дней: 5 назад + 10 вперед)
  - Адаптивный layout с автоматическим расчетом колонок
  - Цветовая кодировка статусов и материалов
  - Drag & Drop для перемещения заказов между днями
  - Контекстное меню для изменения статусов (заказа, оплаты, производства)
  - Индикаторы статусов производства (З Р Ш П У)
  - Навигация между заказами и календарем
  - Подсветка текущего дня и выданных заказов
- ✅ **is_active фильтры** во всех справочниках (автоматическая фильтрация активных записей)
- ✅ **Audit поля** (created_by, edited_by, created_at, updated_at) отображаются во всех show страницах
- ✅ **Row Highlight** - автоматическая подсветка и скролл к новой/отредактированной записи
- ✅ **Сортировка DESC** по ID по умолчанию - новые записи всегда сверху
- ✅ **Навигация по двойному клику** - быстрый переход на show-страницу из любого списка
- ✅ **GraphQL relationships** - отображение связанных данных (role_name, employee.full_name, etc.)
- ✅ **Фиксированный sidebar** с независимой прокруткой
- ✅ **Цветовая кодировка материалов** - визуальное различение типов материалов в заказах
- ✅ **Delta save** - сохранение только измененных данных для оптимизации
- ✅ **Optimistic locking** - защита от конфликтов при конкурентном редактировании
- ✅ **Печать заказов** - печатная форма на основе react-to-print с форматированием под Excel шаблон
- ✅ **Экспорт в Excel** - генерация .xlsx файлов с шаблоном, формулами и умной агрегацией полей
## Стек и зависимости
- React 18, Vite 4
- Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`
- UI: `antd@^5`
- State Management: `zustand@^5` (для формы заказов)
- Validation: `zod@^4` (для валидации форм)
- Forms: `react-hook-form@^7` + `@hookform/resolvers@^5`
- Print & Export: `react-to-print@^3`, `exceljs@^4` (печать и экспорт заказов)
- Calendar: `date-fns@^4` (работа с датами), `react-dnd@^16` + `react-dnd-html5-backend@^16` (Drag & Drop, подготовка)
- Data provider: Hasura GraphQL провайдер с JWT (`src/utils/dataProvider.ts`)

### Dev Audit Override
- Для ускорения разработки включена подстановка `edited_by` при апдейтах на фронтенде.
- Управление через переменные окружения в `.env`:
  - `VITE_DEV_FORCE_AUDIT=true|false` — включить/выключить режим (по умолчанию true).
  - `VITE_DEV_AUDIT_USER_ID=1` — ID пользователя, который ставится в `edited_by`.
- Перед релизом установите `VITE_DEV_FORCE_AUDIT=false` или удалите обе переменные, чтобы использовать корректный аудит.
- Dev: `@vitejs/plugin-react`

Список версий см. в `package.json`.

## Структура проекта
- `src/index.tsx` — точка входа React.
- `src/App.tsx` — конфигурация Refine: ресурсы, роутинг, аутентификация, layout.
- `src/utils/dataProvider.ts` — Hasura GraphQL `dataProvider`, использующий Bearer токен пользователя.
- `src/components/CustomSider.tsx` — левое меню на основе `useMenu` (AntD 5 `Menu.items`).
- Страницы ресурсов:
  - Orders (read-only view): `src/pages/orders/{list,show}.tsx` (Edit направлен на базовую таблицу `orders`).
  - Calendar: `src/pages/calendar/index.tsx` - производственный календарь
    - `components/CalendarBoard.tsx` - основная доска календаря
    - `components/DayColumn.tsx` - колонка дня
    - `components/OrderCard.tsx` - карточка заказа
    - `hooks/useCalendarData.ts` - загрузка данных
    - `hooks/useCalendarDays.ts` - генерация дней
    - `utils/dateUtils.ts` - утилиты работы с датами
    - `utils/calendarLayout.ts` - расчет адаптивного layout
    - `utils/statusColors.ts` - цветовая кодировка
    - `types/calendar.ts` - TypeScript типы
    - `styles/calendar.css` - стили календаря
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
- Печать и экспорт:
  - `src/pages/orders/components/print/OrderPrintView.tsx` — компонент печатной формы заказа
  - `src/utils/excel/generateOrderExcel.ts` — генерация Excel из шаблона с формулами
  - `src/utils/printFormat.ts` — утилиты форматирования для печати и экспорта
  - `public/templates/order_template.xlsx` — шаблон Excel для экспорта
- Стили:
  - `src/styles/app.css` — глобальные стили (sidebar, row highlight анимация)
  - `src/pages/orders/components/print/OrderPrintView.css` — стили печатной формы
- Инфраструктура:
  - `vite.config.ts` — порт 5576.
  - `index.html`, `vite.svg` — стандартные артефакты Vite.

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
- Переменные окружения (Vite):
  - `VITE_HASURA_GRAPHQL_URL` — URL Hasura GraphQL (например, `http://localhost:8585/v1/graphql` для dev, `https://domain-for-prod/v1/graphql` для prod).

- **Аутентификация:** JWT-based через Vercel Functions
  - Backend: `/api/login`, `/api/refresh` endpoints
  - Frontend: `authProvider` с localStorage token management
  - Hasura: JWT mode с role-based permissions

- **Data Provider:** `src/utils/dataProvider.ts` использует JWT токены пользователя (`Authorization: Bearer <token>`)

Пример `.env.local` для локальной разработки (не коммитить в VCS):
```
VITE_HASURA_GRAPHQL_URL=http://localhost:8585/v1/graphql
```

**Production:** Все запросы используют JWT токены. Admin secret используется только в Vercel Functions на backend.

## Установка и запуск

### 1. Установить зависимости
```bash
npm install
```

### 2. Настроить Environment Variables
Создать `.env` файл из примера:
```bash
cp .env.example .env
```

Заполнить обязательные переменные:
- `HASURA_URL` - URL вашего Hasura GraphQL endpoint
- `HASURA_ADMIN_SECRET` - admin secret для Hasura
- `JWT_SECRET` и `JWT_REFRESH_SECRET` - секреты для JWT токенов (256-bit base64)
- `VITE_HASURA_GRAPHQL_URL` - то же что HASURA_URL (для frontend)

**Генерация JWT секретов:**
```bash
node scripts/generate-jwt-secret.js
```

### 3. Выбрать режим запуска

#### Вариант A: Vercel Dev (рекомендуется для работы с аутентификацией)
```bash
# Установить Vercel CLI (если еще не установлен)
npm install -g vercel

# Запустить с поддержкой Vercel Functions
npm run dev:vercel
```
Приложение доступно на **`http://localhost:3000`** (или 3001 если 3000 занят)

**Важно:** Проверьте в консоли на каком порту запустился сервер

**Используйте этот режим когда:**
- ✅ Тестируете аутентификацию (login/logout)
- ✅ Работаете с API endpoints (`/api/login`, `/api/refresh`)
- ✅ Запускаете E2E тесты


#### Вариант B: Vite Dev (только для UI разработки без аутентификации)
```bash
npm run dev
```
Приложение доступно на **`http://localhost:5173`**

**Используйте этот режим когда:**
- Работаете только с UI (без аутентификации)
- Нужна максимальная скорость hot reload

**Важно:** API endpoints (`/api/*`) НЕ работают в этом режиме!

## Примечания по реализации

### Orders (комплексная форма)
- **Создание/Редактирование**: Полнофункциональная форма с Zustand store для управления состоянием
- **Order Details**: Inline-редактирование деталей заказа с авто-расчетом площади (мм² → м²)
- **Payments**: Управление платежами с контролем суммы
- **Валидация**: Zod schemas с cross-field валидацией (даты, финансы, уникальность)
- **Сохранение**: Delta save (обновляются только измененные записи) + rollback при ошибках
- **UX**: Цветовая кодировка материалов, визуальные разделители, подсветка изменений
- **Авто-настройки**: Предзаполнение статусов/дат/скидок и предупреждение о несохраненных изменениях при уходе
- **Просмотр**: Используется `orders_view` для отображения агрегированных данных
- **Печать**: Печатная форма (OrderPrintView) с @media print стилями, форматирование под A4
- **Экспорт**: Генерация .xlsx через ExcelJS с шаблоном, сохранение формул Excel, умная агрегация полей
- **Экспорт в google-drive**: POST-запрос на URL-GAS скрипта с JSON-данными заказа. GAS заполняет шаблон xlsx и сохраняет на google-drive.

### Общие паттерны
- Формы: `useForm` из Refine; справочники подключаются через `useSelect` с `optionLabel`/`optionValue`.
- Даты: `DatePicker` (AntD). Значение приводится к ISO-формату в `onFinish` формы перед отправкой.
- Идентификаторы: в ресурсах задан `meta.idColumnName` (orders_view: `order_id`; clients: `client_id`; materials: `material_id`; milling_types: `milling_type_id`; films: `film_id`; и т.д.). Это важно для корректной работы `Show/Edit` и `rowKey`.
- Меню (Sider): `CustomSider` использует `useMenu` из Refine и маппит в `Menu.items` AntD 5.
- Локализация: Русская локаль (`ruRU`) для календарей и форматирования

## Известные ограничения
- Авторизация: реализованы login/refresh, перед продом проверьте CORS, секреты и роли в Hasura.
- Типизация: ts-конфигурация минимальна; для строгой типизации рекомендуется усилить настройки.
- Тесты отсутствуют.

## Дальнейшие шаги (Roadmap)

### Ближайшие задачи
- ✅ ~~Расширить CRUD для `orders`~~ (завершено 2025-10-30)
- ✅ ~~Печать и экспорт заказов~~ (завершено 2025-11-16)
- 🟡 **Производственный календарь** (в процессе, завершено ~60%)
  - ✅ Базовая визуализация заказов по датам
  - ✅ Адаптивный layout и навигация
  - ✅ Цветовая кодировка и индикаторы статусов
  - ✅ Drag & Drop для перемещения заказов между днями
  - ✅ Контекстное меню для изменения статусов
  - 🟡 Печать плана дня
  - 🟡 Фильтрация и поиск в календаре
- **Разделение кнопок сохранения** - независимое сохранение деталей от заказа
- Добавить Payments Tab с управлением платежами
- Добавить Workshops Tab (привязка к цехам)
- Добавить Materials Tab (потребности в ресурсах)
- Реализовать Quick Create для справочников (Material, Client, etc.)

### Средний срок
- Hasura nested insert/upsert для атомарного сохранения
- Полноценная аутентификация/авторизация (login flow, JWT/роли, refresh)
- **Добавить в схему БД таблицу управления видимостью страниц/ресурсов для ролей** - таблица связи ролей с ресурсами для динамического управления доступом на фронтенде
- Виртуализация таблиц для больших объемов данных (>100 строк)
- Софт удаление деталей/ удаление заказа - реализация soft-delete
- Реализация версионирования для записей, имеющих поле version (optimistic locking)
- E2E тесты (Playwright/Cypress)

### Долгосрочные
- Внедрить i18n систему (react-intl/i18next) для мультиязычности
- Offline режим с синхронизацией (IndexedDB)
- WebSocket подписки для real-time обновлений
- История изменений (audit log с версионированием)

## Ссылки и материалы
- Refine документация: https://refine.dev/docs/

