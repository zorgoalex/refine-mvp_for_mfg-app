# ERP

Внутренняя ERP для управления заказами, производством, оплатами, материалами,
импортом, раскроем и интеграциями. Frontend построен на React, Vite, Refine и
Ant Design; command API — на NestJS; read/report/reference слой — Hasura.

## Документация

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
- [Users cutover](docs/users-cutover-readiness.md)
- [Order export cutover](docs/order-export-cutover-readiness.md)
- [VLM cutover](docs/vlm-cutover-readiness.md)
- [Deadline status-transition rules](docs/deadline-status-transition-rules-runbook.md)
