# Запуск WhatsApp-бота в production

WAHA работает как внутренний Docker-сервис. Публичного поддомена, порта,
dashboard или Swagger у него нет. Администрирование выполняется в ERP:
`Конфигурация → WhatsApp` и `Конфигурация → WhatsApp-правила`.

## Условия запуска

- В `main` должен находиться одобренный release SHA с миграцией
  `152_whatsapp_admin.sql`.
- Frontend и backend build зелёные.
- На VPS свободно минимум 1 GiB RAM и 2–3 GiB диска. Начальный лимит WAHA:
  1 CPU, 1 GiB RAM, 256 PID.
- Назначен оператор, который отсканирует QR, и отдельный номер WhatsApp.
- Подготовлены два разных секрета длиной не менее 32 символов:
  `WAHA_API_KEY` и `WAHA_WEBHOOK_HMAC_SECRET`.

## 1. Проверить release

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git status --short
npm ci
npm run build
npm --prefix backend ci
npm --prefix backend run build

ERP_RELEASE_SHA="$(git rev-parse HEAD)"
git show --stat --oneline "$ERP_RELEASE_SHA"
git cat-file -e "$ERP_RELEASE_SHA:backend/db/migrations/152_whatsapp_admin.sql"
```

## 2. Обновить production checkout с WhatsApp выключенным

На VPS:

```bash
cd ~/projects/erp_dev/repo_erp
test -z "$(git status --porcelain)"
git fetch origin
git switch main
git pull --ff-only origin main
ERP_RELEASE_SHA=<approved-main-sha>
test "$(git rev-parse HEAD)" = "$ERP_RELEASE_SHA"
```

Первый deploy выполняется с безопасными значениями:

```env
BACKEND_ENABLE_WHATSAPP=false
BACKEND_WHATSAPP_RELAY_OWNER=none
BACKEND_WHATSAPP_CLEANUP_OWNER=none
```

Live Compose обычно расположен в `~/projects/erp_dev/docker-compose.yml`.
`deploy-stack.sh` не перезаписывает существующий файл. Сравните его с
`ops/templates/docker-compose.vps.yml` и вручную перенесите только изменения:
backend-переменные WhatsApp, сервис `waha`, сеть `whatsapp_egress` и volume
`waha-sessions`. Не заменяйте live-файл вслепую.

```bash
diff -u ~/projects/erp_dev/docker-compose.yml \
  ~/projects/erp_dev/repo_erp/ops/templates/docker-compose.vps.yml || true
cd ~/projects/erp_dev/repo_erp
ops/deploy-stack.sh \
  --project-dir ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  --compose-file ~/projects/erp_dev/docker-compose.yml
curl -fsS https://<backend-fqdn>/health/live
curl -fsS https://<backend-fqdn>/health/ready
test "$(git rev-parse HEAD)" = "$ERP_RELEASE_SHA"
```

## 3. Backup и миграция 152

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

ERP_PG_CONTAINER="$(docker compose \
  --project-directory ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  -f ~/projects/erp_dev/docker-compose.yml ps -q postgresdb)"
test -n "$ERP_PG_CONTAINER"
ops/apply-migrations.sh auto --container "$ERP_PG_CONTAINER" --detect-only
```

Не продолжать при неожиданном pending-наборе или checksum drift. После проверки:

```bash
ops/apply-migrations.sh auto --container "$ERP_PG_CONTAINER" --yes --skip-041
ops/apply-migrations.sh status --container "$ERP_PG_CONTAINER"
ops/apply-migrations.sh probe 152 --container "$ERP_PG_CONTAINER"
```

Требуется `152: PRESENT` и `pending: 0`.

## 4. Настроить secrets и canary-режим

Не печатайте `.env` и secrets в терминал/логи. В production `.env` добавьте:

```env
# Сохранить уже используемые profiles через запятую, затем добавить whatsapp.
COMPOSE_PROFILES=whatsapp
BACKEND_ENABLE_WHATSAPP=true
WAHA_BASE_URL=http://waha:3000
WAHA_API_KEY=<independent-secret-min-32>
WAHA_SESSION_NAME=erp
WAHA_WEBHOOK_HMAC_SECRET=<different-secret-min-32>
WAHA_REQUEST_TIMEOUT_MS=10000

# Canary принимает webhook и ставит ответ в очередь, но не отправляет его.
BACKEND_WHATSAPP_RELAY_OWNER=none
BACKEND_WHATSAPP_RELAY_POLL_INTERVAL_MS=10000
BACKEND_WHATSAPP_RELAY_BATCH_SIZE=20
BACKEND_WHATSAPP_RELAY_WORKER_ID=whatsapp-prod
BACKEND_WHATSAPP_RELAY_MAX_ATTEMPTS=5
BACKEND_WHATSAPP_RELAY_STALE_LOCK_MS=600000
BACKEND_WHATSAPP_CLEANUP_OWNER=in_process

WAHA_CPUS=1.0
WAHA_MEM_LIMIT=1024m
WAHA_PIDS_LIMIT=256
```

Если уже используются другие profiles, не удаляйте их, например:
`COMPOSE_PROFILES=cnc-telegram,whatsapp`.

```bash
cd ~/projects/erp_dev/repo_erp
ops/check-env.sh \
  --env-file ~/projects/erp_dev/.env \
  --compose-file ~/projects/erp_dev/docker-compose.yml
docker compose \
  --project-directory ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  -f ~/projects/erp_dev/docker-compose.yml \
  --profile whatsapp config --quiet
```

В rendered Compose проверить: у WAHA нет `ports`, Traefik labels, `edge` или
`host_access`; сеть `whatsapp_egress` подключена только к WAHA.

## 5. Запустить WAHA и выполнить pairing

```bash
cd ~/projects/erp_dev/repo_erp
ops/deploy-stack.sh \
  --project-dir ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  --compose-file ~/projects/erp_dev/docker-compose.yml
docker compose \
  --project-directory ~/projects/erp_dev \
  --env-file ~/projects/erp_dev/.env \
  -f ~/projects/erp_dev/docker-compose.yml ps backend waha
```

В Vercel пока оставить `RUNTIME_CONFIG_BACKEND_WHATSAPP=false`. Для pairing
временно включить его для production deployment либо получить QR через API с
администраторской сессией. UI-вариант: открыть
`Конфигурация → WhatsApp → Показать QR-код`, затем WhatsApp → Связанные
устройства → Привязка устройства. QR не сохраняется frontend-ом и отдаётся с
`Cache-Control: no-store`. Включение UI не включает отправку: relay ещё `none`.

## 6. Canary входящего сообщения

1. Создать шаблон ответа и правило с уникальным canary-словом.
2. Отправить слово на подключённый номер из личного чата.
3. Убедиться, что delivery job имеет `pending`.
4. Повторная доставка того же webhook ID не должна создать дубль.
5. Проверить: аудит не содержит тело, JID, API key или HMAC.

Групповые/пустые сообщения, исходящие самого бота и события другой сессии не
должны создавать delivery job.

## 7. Включить отправку

```env
BACKEND_WHATSAPP_RELAY_OWNER=in_process
```

Повторить `ops/check-env.sh` и `ops/deploy-stack.sh`. Canary job должен перейти
в `sent`, а ответ появиться ровно один раз. Затем оставить в Vercel:

```env
RUNTIME_CONFIG_BACKEND_WHATSAPP=true
```

После Vercel redeploy проверить `/api/runtime-config`: поле
`features.backendWhatsApp=true`, frontend build SHA ожидаемый, две вкладки
доступны только с `whatsapp.view`/`whatsapp.manage`.

## 8. Наблюдение и rollback

Первые 30–60 минут наблюдать CPU/RAM/restarts WAHA, очередь, свежесть webhook и
capping/timelock. `unknown` нельзя повторять автоматически: отправка могла
состояться. Ручной retry разрешён только для `failed`.

Fail-closed остановка отправки:

```env
BACKEND_WHATSAPP_RELAY_OWNER=none
RUNTIME_CONFIG_BACKEND_WHATSAPP=false
```

После backend и Vercel redeploy входящие сообщения продолжат попадать в очередь.
Для полной остановки сначала остановить WAHA/remove profile, затем выставить
`BACKEND_ENABLE_WHATSAPP=false` и `BACKEND_WHATSAPP_CLEANUP_OWNER=none`. Volume
`waha-sessions` и таблицы migration 152 не удалять.
