# ERP

Внутренняя ERP для управления заказами, производством, оплатами, материалами,
импортом, раскроем и интеграциями. Frontend построен на React, Vite, Refine и
Ant Design; command API — на NestJS; read/report/reference слой — Hasura.

## Рабочие ветки

- Stage-интеграция и stage-deploy: `feat/backend-erp-stage1`.
- Рабочая и deploy-ветка production: `main`.
- `feat/backend-erp-prevprod` выведена из эксплуатации и не используется для
  production deploy.
- Канонический тестовый контур: frontend `https://app-test.example.com`,
  backend `https://backend-test.example.com`.

## Документация

### CAD: редактор фрезеровок

В «Производство → CAD» выберите заказ и нажмите «Отрисовать заказ».
Оригинал остаётся неизменным; сначала открывается рабочий вариант. Его изменения
сохраняются автоматически. «Новый вариант» создаёт отдельную вкладку для сравнения.
Выберите деталь на поле или в списке: справа доступны понятные параметры фрезеровки.
На планшете список и свойства открываются кнопками. Режим «Выбрать несколько»
позволяет менять положение группы; V/H/M/F переключают выбор, панораму, измерение
и показ всего комплекта. Стрелки перемещают выбранное, Shift увеличивает шаг.

«Расширенный режим» раскрывает технические данные, но не расширяет права.
`cad.technology` разрешает защищённые настройки; `cad.approve` — индивидуальное
одобрение с причиной и подтверждением CAD. Оба права по умолчанию только у
админа/суперадмина. Библиотека фрез, рецепты и разрешённые диапазоны настраиваются
в отдельном CAD-сервисе, не на рабочем экране менеджера.

«Скачать фрезеровки» сохраняет, рассчитывает все включённые позиции и показывает
сводку перед ZIP. Изменение исходного заказа требует явного подтверждения;
изменение после сводки требует повторной проверки. Ошибочные детали не исключаются
из архива автоматически. «Готово к скачиванию» не означает готовность станка:
параметры обработки проверяются в CAM.

Включение: сначала CAD с `editor_version=2`, затем миграция
`160_cad_editor_workflow.sql` и ERP backend/frontend; последним
`BACKEND_CAD_EDITOR_V2=true` (по умолчанию false). `BACKEND_ENABLE_CAD=true`
остаётся обязательным. Флаг нового UI не отключает серверные проверки; откат
допустим через этот флаг, не на backend без поддержки политик/подтверждений.

### Общие руководства

- [Обзор проекта, возможности, стек и структура](docs/project-overview.md)
- [Конфигурация, feature flags, авторизация и аудит](docs/configuration-and-auth.md)
- [Функциональные разделы ERP](docs/feature-guides.md)
- [Установка, разработка и тестирование](docs/development-and-testing.md)
- [Деплой и эксплуатация](docs/deployment-and-operations.md)
- [Полный VPS runbook](ops/README.md)

## Специализированные документы

- [Контракт JSON snapshot заказов](docs/order-json-snapshot-v1.md)
- [Frontend runtime config](docs/frontend-runtime-config-readiness.md)
- [Runtime config canary](docs/runtime-config-canary-readiness.md)
- [UI variant: архитектура и rollout](docs/ui-redesign/ui-variant-architecture.md)
- [Users cutover](docs/users-cutover-readiness.md)
- [Order export cutover](docs/order-export-cutover-readiness.md)
- [VLM cutover](docs/vlm-cutover-readiness.md)
- [Deadline status-transition rules](docs/deadline-status-transition-rules-runbook.md)
- [Канал уведомлений Telegram: настройка бота и эксплуатация](../spec_erp/plans/telegram-notification-channel.md)
