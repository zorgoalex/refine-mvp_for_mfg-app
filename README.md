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
- Схема БД: **v11.8**
- Dev server: `http://localhost:5576`
- Статус: **MVP+ завершен** (2025-11-01) - полнофункциональная форма заказов с деталями

## Ключевые фичи
- ✅ **CRUD операции** для всех справочников и операционных таблиц (28 ресурсов)
- ✅ **Комплексная форма заказов** (Orders) с деталями, платежами и inline-редактированием
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

## Стек и зависимости
- React 18, Vite 4
- Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`
- UI: `antd@^5`
- State Management: `zustand@^5` (для формы заказов)
- Validation: `zod@^4` (для валидации форм)
- Forms: `react-hook-form@^7` + `@hookform/resolvers@^5`
- Data provider: встроенный минимальный Hasura GraphQL провайдер (`src/utils/dataProvider.ts`)

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
- `src/utils/dataProvider.ts` — минимальный Hasura GraphQL `dataProvider`, добавляющий заголовок `x-hasura-admin-secret`.
- `src/components/CustomSider.tsx` — левое меню на основе `useMenu` (AntD 5 `Menu.items`).
- Страницы ресурсов:
  - Orders (read-only view): `src/pages/orders/{list,show}.tsx` (Edit направлен на базовую таблицу `orders`).
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
- Стили:
  - `src/styles/app.css` — глобальные стили (sidebar, row highlight анимация)
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
  - `VITE_HASURA_GRAPHQL_URL` — URL Hasura GraphQL (например, `http://localhost:8585/v1/graphql`).
  - `VITE_HASURA_ADMIN_SECRET` — admin secret для заголовка `x-hasura-admin-secret` (только для dev!).
- Auth в `src/App.tsx` — минимальный `authProvider` для dev-режима: проверяет наличие `VITE_HASURA_GRAPHQL_URL` и `VITE_HASURA_ADMIN_SECRET`. Страница `/login` декоративна.
- Data provider (`src/utils/dataProvider.ts`) использует Hasura GraphQL и пробрасывает `x-hasura-admin-secret`.

Пример `.env` (не коммитить в VCS):
```
VITE_HASURA_GRAPHQL_URL=http://localhost:8585/v1/graphql
VITE_HASURA_ADMIN_SECRET=your_dev_secret_here
```

Важно: admin secret не использовать в продакшене. Для prod — Hasura роли и JWT.

## Установка и запуск
1) Установить зависимости:
```
npm install
```
2) Создать `.env` по примеру выше.
3) Запуск в dev-режиме:
```
npm run dev
```
Приложение доступно на `http://localhost:5573`. Hasura должен быть доступен по `VITE_HASURA_GRAPHQL_URL`.

## Примечания по реализации

### Orders (комплексная форма)
- **Создание/Редактирование**: Полнофункциональная форма с Zustand store для управления состоянием
- **Order Details**: Inline-редактирование деталей заказа с авто-расчетом площади (мм² → м²)
- **Payments**: Управление платежами с контролем суммы
- **Валидация**: Zod schemas с cross-field валидацией (даты, финансы, уникальность)
- **Сохранение**: Delta save (обновляются только измененные записи) + rollback при ошибках
- **UX**: Цветовая кодировка материалов, визуальные разделители, подсветка изменений
- **Просмотр**: Используется `orders_view` для отображения агрегированных данных

### Общие паттерны
- Формы: `useForm` из Refine; справочники подключаются через `useSelect` с `optionLabel`/`optionValue`.
- Даты: `DatePicker` (AntD). Значение приводится к ISO-формату в `onFinish` формы перед отправкой.
- Идентификаторы: в ресурсах задан `meta.idColumnName` (orders_view: `order_id`; clients: `client_id`; materials: `material_id`; milling_types: `milling_type_id`; films: `film_id`; и т.д.). Это важно для корректной работы `Show/Edit` и `rowKey`.
- Меню (Sider): `CustomSider` использует `useMenu` из Refine и маппит в `Menu.items` AntD 5.
- Локализация: Русская локаль (`ruRU`) для календарей и форматирования

## Известные ограничения
- Авторизация упрощена: секрет читается из `.env`, вход через `/login` декоративный. Для production требуется полноценный `authProvider` (login/JWT/роли Hasura).
- Типизация: ts-конфигурация минимальна; для строгой типизации рекомендуется усилить настройки.
- Тесты отсутствуют.

## Дальнейшие шаги (Roadmap)

### Ближайшие задачи
- ✅ ~~Расширить CRUD для `orders`~~ (завершено 2025-10-30)
- **Разделение кнопок сохранения** - независимое сохранение деталей от заказа (см. `ai_docs/PLAN_separate_details_save.md`)
- Добавить Payments Tab с управлением платежами
- Добавить Workshops Tab (привязка к цехам)
- Добавить Requirements Tab (потребности в ресурсах)
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
- Примеры провайдера GraphQL/Hasura: `ai_docs/data-provider-graphql`, `ai_docs/data-provider-hasura`
