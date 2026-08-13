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

## Production backup

Перед миграциями, restore rehearsal или prod-to-stage refresh используйте
`ops/backup-prod-packet.sh`, а не legacy DB-only dump. Скрипт сам определяет
Compose project name: `--compose-project-name`, caller `COMPOSE_PROJECT_NAME`,
`.env`, running Docker labels, затем Compose config name. Secrets и raw `.env`
в packet не пишутся.

```bash
cd ~/projects/erp_dev/repo_erp
ops/backup-prod-packet.sh \
  --project-dir ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  --compose-file ~/projects/erp_dev/docker-compose.yml \
  --backup-root ~/projects/erp_dev/backups/prod-packets \
  --include-cnc-media

PACKET_DIR="$(ls -td ~/projects/erp_dev/backups/prod-packets/erp-backup-packet-* | head -n1)"
(cd "$PACKET_DIR" && sha256sum -c SHA256SUMS)
sha256sum -c "$PACKET_DIR.tar.gz.sha256"
```

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
Для общего Telegram-чата допускается только один writer. Test stack должен
иметь `CNC_TELEGRAM_WORKER_ROLE=reader`: читать и парсить файлы, но не писать в чат.
Prod stack должен явно иметь
`ERP_STACK_ENV=prod` и `CNC_TELEGRAM_WORKER_ROLE=writer`.

Обычный deploy/up поднимет prod writer автоматически, если в VPS `.env` есть:

```env
ERP_STACK_ENV=prod
BACKEND_ENABLE_CNC_TELEGRAM=true
COMPOSE_PROFILES=cnc-telegram
CNC_TELEGRAM_WORKER_ROLE=writer
TELEGRAM_API_ID=<api-id>
TELEGRAM_API_HASH=<api-hash>
TELEGRAM_CHAT=<chat-id-or-username>
TELEGRAM_ALLOWED_CHAT_ID=<expected-chat-id>
ERP_WORKER_LOGIN=<erp-user-with-cut.manage>
ERP_WORKER_PASSWORD=<password>
CNC_AUDIT_SPOOL_PATH=/data/cnc-telegram-audit.sqlite3
```

Backend получает явные `CNC_TELEGRAM_WORKER_USERNAME` и
`CNC_TELEGRAM_ALLOWED_CHAT_IDS`; для password-auth сохранены fallback-ы на
`ERP_WORKER_LOGIN` и `TELEGRAM_ALLOWED_CHAT_ID`. При bearer-only auth явное имя
worker-а обязательно. Перед обновлением
worker обязательно применить миграции `107_cnc_telegram_worker_audit.sql`,
`108_cnc_telegram_worker_audit_reason_codes.sql` и
`109_cnc_telegram_worker_audit_classification_codes.sql`:
новая версия проверяет capability endpoint и не читает Telegram при частичной
схеме или неверной service-account политике. SQLite audit spool живёт в том же
постоянном `/data` volume; не удаляйте его при обычном redeploy.

Profile `cnc-telegram` поднимает SVG-only worker без OCR subprocess/service.
GLM-OCR не запускается и не вызывается автоматически: model init, llama server
и runner находятся в отдельном opt-in profile `cnc-telegram-glm`, а вызов OCR
защищён отдельным `CNC_ENABLE_GLM_OCR` gate.

Перед daemon нужен один интерактивный Telethon login:

```bash
repo_erp/ops/cnc-telegram-worker.sh login
repo_erp/ops/cnc-telegram-worker.sh up
```

Явный временный GLM fallback:

```bash
repo_erp/ops/cnc-telegram-worker.sh up-glm
repo_erp/ops/cnc-telegram-worker.sh logs-glm
```

`up-glm` сначала ждёт healthy runner (его healthcheck также проверяет llama) до
30 минут и только затем запускает worker. При timeout worker не запускается и
не фиксирует ложный завершённый fallback pass.

Вернуться к SVG-only обработке и удалить старые GLM containers, сохранив model
cache:

```bash
repo_erp/ops/cnc-telegram-worker.sh up
```

Для постоянного fallback задаются одновременно
`COMPOSE_PROFILES=cnc-telegram,cnc-telegram-glm`, `CNC_ENABLE_GLM_OCR=true` и
`CNC_OCR_COMMAND="python -m cnc_telegram_worker.glm_ocr_client --image {image}"`,
плюс `CNC_OCR_COMMAND_TIMEOUT_SECONDS=720` и
`CNC_OCR_ENGINE=glm-ocr-0.9b-q8` для корректного source fingerprint. Outer
timeout обязан быть больше `GLM_OCR_CLIENT_TIMEOUT_SECONDS` (default 660).

Backfill за неделю:

```bash
repo_erp/ops/cnc-telegram-worker.sh backfill 7
```

Worker internal-only: без ports/traefik. `/data` хранит только Telethon session,
state, durable audit spool и temp; temp hard-delete ограничен `CNC_TEMP_TTL_HOURS<=24`.
При включённом `cnc-telegram` `deploy-stack.sh` всегда добавляет tracked overlay
`ops/templates/docker-compose.cnc-telegram-worker.yml`. Его explicit profile
overrides не дают старому live `docker-compose.yml` вернуть GLM в обычный
profile. Для безопасной замены старого списка profiles используется Compose
`!override`, поэтому deploy fail-closed требует Docker Compose `>=2.24.4`.

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
