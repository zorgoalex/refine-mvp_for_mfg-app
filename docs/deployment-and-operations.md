# Деплой и эксплуатация

## Контуры

- Vercel: frontend и serverless runtime-config endpoint.
- VPS: NestJS backend, Hasura, PostgreSQL, Redis/Valkey, Traefik и связанные
  сервисы.

Production source of truth — ветка `main`. Production Vercel deploy и VPS
checkout выполняются из `main`. `feat/backend-erp-stage1` остаётся stage-веткой;
`feat/backend-erp-prevprod` retired.

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

## CNC Telegram worker

Prod worker для рабочего Telegram-чата включается profile `cnc-telegram`.
Обычный deploy/up поднимет его автоматически, если в VPS `.env` есть:

```env
BACKEND_ENABLE_CNC_TELEGRAM=true
COMPOSE_PROFILES=cnc-telegram
TELEGRAM_API_ID=<api-id>
TELEGRAM_API_HASH=<api-hash>
TELEGRAM_CHAT=<chat-id-or-username>
TELEGRAM_ALLOWED_CHAT_ID=<expected-chat-id>
ERP_WORKER_LOGIN=<erp-user-with-cut.manage>
ERP_WORKER_PASSWORD=<password>
```

Этот же profile поднимает OCR stack:

- `glm-ocr-model-init`: one-shot download of `GLM-OCR-Q8_0.gguf` and
  `mmproj-GLM-OCR-Q8_0.gguf` into the shared Docker volume;
- `glm-ocr-llama`: official `ghcr.io/ggml-org/llama.cpp:server`, local model
  files, internal network only;
- `glm-ocr-runner`: internal FastAPI wrapper `/ocr`, возвращает structured JSON;
- `cnc-telegram-worker`: вызывает runner через default
  `python -m cnc_telegram_worker.glm_ocr_client --image {image}`.

Перед daemon нужен один интерактивный Telethon login:

```bash
repo_erp/ops/cnc-telegram-worker.sh login
repo_erp/ops/cnc-telegram-worker.sh up
```

Backfill за неделю:

```bash
repo_erp/ops/cnc-telegram-worker.sh backfill 7
```

Worker internal-only: без ports/traefik. `/data` хранит только Telethon session,
state и temp; temp hard-delete ограничен `CNC_TEMP_TTL_HOURS<=24`.
Если `deploy-stack.sh` запускается со старым live `docker-compose.yml`, где ещё
нет этого service, script добавляет tracked overlay
`ops/templates/docker-compose.cnc-telegram-worker.yml` при включённом profile.

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
