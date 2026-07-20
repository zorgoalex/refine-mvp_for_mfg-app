# Деплой и эксплуатация

## Контуры

- Vercel: frontend и serverless runtime-config endpoint.
- VPS: NestJS backend, Hasura, PostgreSQL, Redis/Valkey, Traefik и связанные
  сервисы.

Frontend и backend feature flags независимы:

```env
# Vercel runtime config
RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS=true

# VPS backend
BACKEND_ENABLE_PRODUCTION_ACTIONS=true
```

## Source of truth

Tracked Compose template:
`ops/templates/docker-compose.vps.yml`.

Tracked env shape:
`ops/templates/env.vps.example`.

Реальные secrets находятся только во внешнем VPS `.env`. В tracked templates
допустимы только `${VARIABLE}` references.

`ops/setup-vps.sh` и `ops/deploy-stack.sh` создают live Compose из template,
если live-файл отсутствует. Любое non-secret ручное изменение live Compose
нужно переносить обратно в tracked template.

Полный runbook: [VPS Bootstrap And Deploy](../ops/README.md).

## Запуск tracked template

Если runtime root и checkout различаются, всегда задавайте
`--project-directory`; от него Compose ищет `.env`, `data/`, `config/`,
`backups/` и `restore/`.

```bash
cd ~/path/to/project

docker compose \
  --project-directory ~/path/to/project \
  -p <test-compose-project> \
  --env-file .env \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  up -d
```

Для layout, где backend находится в `repo_erp/backend`, задайте:

```env
BACKEND_BUILD_CONTEXT=./repo_erp/backend
```

В обычном checkout с `backend/` в runtime root работает default
`./backend`.

## Пересборка backend

```bash
cd ~/path/to/project

docker compose \
  --project-directory ~/path/to/project \
  -p <test-compose-project> \
  --env-file .env \
  -f repo_erp/ops/templates/docker-compose.vps.yml \
  up -d --build --no-deps backend
```

После rebuild проверьте `/health/live`, `/health/ready`, нужные route mappings
и runtime flags.

## Redis/Valkey для rate limit

В staging/production backend rate limit требует Redis/Valkey storage.

Минимальные backend env:

```env
BACKEND_RATE_LIMIT_STORE=redis
RATE_LIMIT_REDIS_URL=redis://valkey:6379
READINESS_REQUIRE_REDIS=true
```

Для managed Redis/Valkey локальный Compose service не нужен; используйте
`RATE_LIMIT_REDIS_URL` либо `REDIS_URL`.

## PostgreSQL bind

Bind address задаётся `PG_TAILSCALE_BIND_IP`, затем fallback
`PG_BIND_IP`, затем `127.0.0.1`:

```text
${PG_TAILSCALE_BIND_IP:-${PG_BIND_IP:-127.0.0.1}}:5432:5432
```

Не публикуйте PostgreSQL на публичный интерфейс.

## Безопасность эксплуатации

- Не коммитьте `.env`, credentials, webhook URLs и API keys.
- Не печатайте secrets в логах диагностики.
- Перед protected stage smoke проверяйте наличие bypass secret без вывода
  значения.
- Применяйте DB migrations до включения зависящих от них runtime flags.
- Не смешивайте production и test target variables в canary-командах.
- После изменения Compose/env запускайте tracked smoke scripts из `ops/`.

## Связанные документы

- [VPS Bootstrap And Deploy](../ops/README.md)
- [Frontend runtime config](frontend-runtime-config-readiness.md)
- [Runtime config canary](runtime-config-canary-readiness.md)
- [Stage cutover smoke](stage-cutover-smoke-2026-05-18.md)
