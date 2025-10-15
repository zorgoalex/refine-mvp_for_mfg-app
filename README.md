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

## Стек и зависимости
- React 18, Vite 4
- Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`
- UI: `antd@^5`
- Data provider: встроенный минимальный Hasura GraphQL провайдер (`src/utils/dataProvider.ts`)
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
- Инфраструктура:
  - `vite.config.ts` — порт 5573.
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
- Orders (read-only): для отображения используется `orders_view`. Редактирование направлено на базовую таблицу `orders`.
- Формы: `useForm` из Refine; справочники подключаются через `useSelect` с `optionLabel`/`optionValue`.
- Даты: `DatePicker` (AntD). Значение приводится к ISO-формату в `onFinish` формы перед отправкой.
- Идентификаторы: в ресурсах задан `meta.idColumnName` (orders_view: `order_id`; clients: `client_id`; materials: `material_id`; milling_types: `milling_type_id`; films: `film_id`; и т.д.). Это важно для корректной работы `Show/Edit` и `rowKey`.
- Меню (Sider): `CustomSider` использует `useMenu` из Refine и маппит в `Menu.items` AntD 5.

## Известные ограничения
- Авторизация упрощена: секрет читается из `.env`, вход через `/login` декоративный. Для production требуется полноценный `authProvider` (login/JWT/роли Hasura).
- Типизация: ts-конфигурация минимальна; для строгой типизации рекомендуется усилить настройки.
- Тесты отсутствуют.

## Дальнейшие шаги (Roadmap)
- Расширить CRUD для `orders` (операции в базовой таблице `orders`).
- Реализовать полноценную аутентификацию/авторизацию (login flow, JWT/роли, refresh).
- Вынести конфигурацию колонок/форм в единое место для переиспользования.
- Добавить тесты (e2e/юнит), покрыть ошибки сети/авторизации.

## Ссылки и материалы
- Refine документация: https://refine.dev/docs/
- Примеры провайдера GraphQL/Hasura: `ai_docs/data-provider-graphql`, `ai_docs/data-provider-hasura`

