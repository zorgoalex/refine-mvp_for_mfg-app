# Front Refine v1 — Refine + PostgREST Admin (MVP)

Простой административный интерфейс на базе Refine + Ant Design, работающий с REST API PostgREST. Проект ориентирован на MVP для сущностей БД и демонстрирует список, просмотр и CRUD-операции для ключевых ресурсов.

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
- Backend: PostgREST доступен локально по `http://localhost:3000` с авторизацией через Bearer-токен.
- Frontend: Refine (+ AntD) на Vite/React.

## Стек и зависимости
- React 18, Vite 4
- Refine: `@refinedev/core`, `@refinedev/antd`, `@refinedev/react-router-v6`, `@refinedev/kbar`
- UI: `antd@^5`
- Data provider: `@ffimnsr/refine-postgrest`
- Dev: `@vitejs/plugin-react`

Список фиксированных версий см. в `package.json`.

## Структура проекта
- `src/index.tsx` — точка входа React.
- `src/App.tsx` — конфигурация Refine: ресурсы, роутинг, аутентификация, layout.
- `src/utils/dataProvider.ts` — клиент PostgREST и `dataProvider`, добавляющий заголовок `Authorization: Bearer`.
- `src/components/CustomSider.tsx` — левое меню на основе `useMenu` (AntD 5 `Menu.items`).
- Страницы ресурсов:
  - Orders (read-only view): `src/pages/orders/{list,show}.tsx` (Create/Edit присутствуют, но не подключены в роуты).
  - Materials: `src/pages/materials/{list,create,edit,show}.tsx`
  - Milling Types: `src/pages/milling_types/{list,create,edit,show}.tsx`
  - Films: `src/pages/films/{list,create,edit,show}.tsx`
  - Clients: `src/pages/clients/{list,create,edit,show}.tsx`
- Инфраструктура:
  - `vite.config.ts` — порт 5573.
  - `index.html`, `vite.svg` — стандартные артефакты Vite.

## Ресурсы и маршруты
Определены в `src/App.tsx` внутри `resources` и роутов React Router:
- `orders_view`
  - `list`: `/orders`
  - `show`: `/orders/show/:id`
  - `meta.idColumnName`: `order_id`
  - Назначение: только чтение (read-only), отражает агрегированный вид заказа.
- `materials`
  - `list/create/edit/show` с `meta.idColumnName`: `material_id`
- `milling_types`
  - `list/create/edit/show` с `meta.idColumnName`: `milling_type_id`
- `films`
  - `list/create/edit/show` с `meta.idColumnName`: `film_id`
- `clients`
  - `list/create/edit/show` с `meta.idColumnName`: `client_id`

Навигация по умолчанию ведёт к `orders_view` (список). Боковое меню строится автоматически из ресурсов при помощи `useMenu`.

## Конфигурация и авторизация
- Переменные окружения (Vite):
  - `VITE_API_URL` — URL PostgREST (например, `http://localhost:3000`).
  - `VITE_API_TOKEN` — Bearer-токен для заголовка `Authorization`.
- Auth в `src/App.tsx` — минимальный `authProvider` для dev-режима: проверяет наличие `VITE_API_TOKEN`. Страница `/login` декоративна.
- Data provider (`src/utils/dataProvider.ts`) создаёт PostgREST-клиент и пробрасывает `Authorization: Bearer ${VITE_API_TOKEN}`.

Пример `.env` (не коммитить в VCS):
```
VITE_API_URL=http://localhost:3000
VITE_API_TOKEN=your_dev_token_here
```

Важно: убедитесь, что PostgREST настроен с корректными CORS/заголовками и принимает `Authorization: Bearer`.

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
Приложение поднимется на `http://localhost:5573` (см. `vite.config.ts`). Backend PostgREST должен быть доступен по `VITE_API_URL`.

## Примечания по реализации
- Orders (read-only): для отображения используется `orders_view`. Файлы Create/Edit для Orders присутствуют, но не подключены в роутинг. Для полноценного CRUD следует оперировать базовой таблицей `orders`.
- Формы: `useForm` из Refine; связки (`clients/materials/milling_types/films`) реализованы `useSelect` с `optionLabel`/`optionValue`.
- Дата: `DatePicker` (AntD). Значение приводится к ISO-формату в `onFinish` формы перед отправкой (см. Orders Create/Edit как пример техники).
- Идентификаторы: в ресурсах задан `meta.idColumnName` (orders_view: `order_id`; clients: `client_id`; materials: `material_id`; milling_types: `milling_type_id`; films: `film_id`). Это важно для корректной работы `Show/Edit` и табличных `rowKey`.
- Меню (Sider): `CustomSider` использует `useMenu` из Refine и маппит в `Menu.items` AntD 5. Активный пункт и раскрытие подменю управляются `selectedKey`/`defaultOpenKeys`.
- Vite: порт 5573.

## Известные ограничения
- Авторизация упрощена: токен читается из `.env`, вход через `/login` декоративный. Для production требуется полноценный `authProvider` (логин/логика хранения и обновления токена).
- `orders_view` read-only: нет подключённых роутов для Create/Edit; настоящие изменения должны идти через таблицу `orders`.
- Типизация: отсутствует `tsconfig.json`; проект компилируется Vite’ом, но для строгой типизации рекомендуется добавить конфигурацию TypeScript.
- OpenAPI не используется для автогенерации форм/валидаторов: поля и правила заданы вручную; несоответствие схеме может потребовать доработки.
- Тесты отсутствуют.

## Дальнейшие шаги (Roadmap)
- Подключить CRUD для `orders` (использовать таблицу вместо `orders_view`), добавить маршруты Create/Edit в `App.tsx`.
- Реализовать полноценную аутентификацию/авторизацию (login flow, хранение токена, refresh/логика ошибок).
- Включить генерацию типов/клиента из OpenAPI или централизовать схемы форм, привести в соответствие правилам nullable/default.
- Добавить `tsconfig.json` и усилить типизацию.
- Обработать CORS и заголовки в PostgREST для продакшена.
- Вынести конфигурацию колонок/форм в единое место для переиспользования.
- Добавить тесты (e2e на Playwright/юнит на React Testing Library).

## Ссылки и материалы
- Refine документация: https://refine.dev/docs/
- Пример провайдера PostgREST: https://github.com/ffimnsr/refine-postgrest-ts

