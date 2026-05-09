# Гайд: развертывание VPS одним скриптом

Этот гайд описывает штатный запуск `ops/setup-vps.sh` на новом VPS для ERP:
Docker, Traefik, PostgreSQL, Hasura, backend, восстановление БД, Hasura metadata,
smoke-проверки и полный прогон тестов.

Главный принцип: на VPS остается только положить репозиторий в правильную папку,
заполнить `.env` реальными доменами/секретами и запустить один скрипт.

## Что нужно подготовить заранее

1. VPS с Ubuntu/Debian и пользователем с `sudo`.
2. SSH-доступ к этому пользователю.
3. Папка проекта на VPS:

```bash
/home/<user>/projects/erp
```

4. Два backend-домена с DNS `A` records на IP нового VPS:

```text
hasura-*.example.com
backend-*.example.com
```

5. Один frontend-домен в Vercel:

```text
app-*.example.com
```

6. Если нужно сразу залить данные старого прода:

```text
main DB dump: *.dump, *.backup или *.pgdump
globals dump: *global*.sql или *global*.sql.gz, если есть
Hasura metadata: metadata.json, *.tar, *.tar.gz, *.tgz или *.zip
```

## Когда нужны домены

Домены `HASURA_FQDN` и `BACKEND_FQDN` должны быть заведены до второго запуска
`ops/setup-vps.sh`, то есть до реального deploy.

Причина: Traefik при старте запрашивает Let's Encrypt сертификаты. Для этого
домены уже должны вести на VPS, а порты `80` и `443` должны быть доступны
снаружи.

Frontend-домен тоже лучше подготовить заранее, потому что он нужен в CORS:

```env
FRONTEND_ORIGIN=https://app-test.example.com
HASURA_GRAPHQL_CORS_DOMAIN=https://app-test.example.com
BACKEND_CORS_ALLOWED_ORIGINS=https://app-test.example.com
```

Правила:

- `HASURA_FQDN` и `BACKEND_FQDN` пишутся без `https://` и без `/`.
- `FRONTEND_ORIGIN` пишется с `https://` и без trailing slash.
- Если frontend-домен поменялся, его нужно обновить и в Hasura CORS, и в backend
  CORS, потом пересоздать контейнеры `hasura` и `backend`.

## Первый запуск на пустом VPS

Зайти на VPS:

```bash
ssh <user>@<VPS_IP>
```

Создать структуру папок и положить репозиторий:

```bash
mkdir -p /home/<user>/projects
git clone <repo-url> /home/<user>/projects/erp
cd /home/<user>/projects/erp
```

Запустить скрипт первый раз:

```bash
sudo ops/setup-vps.sh
```

Что произойдет:

- установится Docker и нужные системные пакеты;
- создадутся служебные папки;
- из шаблонов создадутся `docker-compose.yml`, `config/postgres/pg_hba.conf`,
  `.env`;
- скрипт остановится, потому что в `.env` еще placeholder-значения.

Это нормальный ожидаемый результат первого запуска.

## Заполнение `.env`

Открыть `.env`:

```bash
nano /home/<user>/projects/erp/.env
```

Минимально нужно заменить:

```env
HASURA_FQDN=
BACKEND_FQDN=
FRONTEND_ORIGIN=
LETSENCRYPT_EMAIL=
PG_PASSWORD=
HASURA_GRAPHQL_DATABASE_URL=
HASURA_MD_PASSWORD=
HASURA_ADMIN_SECRET=
HASURA_JWT_SECRET=
HASURA_GRAPHQL_CORS_DOMAIN=
BACKEND_REFRESH_TOKEN_PEPPER=
BACKEND_CORS_ALLOWED_ORIGINS=
```

Секреты генерировать на VPS:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Важно:

- `PG_PASSWORD` должен совпадать с паролем внутри
  `HASURA_GRAPHQL_DATABASE_URL`;
- `HASURA_JWT_SECRET` используется и Hasura, и backend;
- `BACKEND_REFRESH_TOKEN_PEPPER` должен быть уникальным и не короче 32 символов;
- `.env` не должен попадать в git.

Пример доменной части:

```env
HASURA_FQDN=hasura-test.mebelkz.app
BACKEND_FQDN=backend-test.mebelkz.app
FRONTEND_ORIGIN=https://app-test.mebelkz.app
HASURA_GRAPHQL_CORS_DOMAIN=https://app-test.mebelkz.app
BACKEND_CORS_ALLOWED_ORIGINS=https://app-test.mebelkz.app
```

## Второй запуск: deploy без restore

Когда `.env` заполнен и DNS уже указывает на VPS:

```bash
cd /home/<user>/projects/erp
sudo ops/setup-vps.sh --yes --expected-ip <VPS_PUBLIC_IP>
```

Что делает скрипт:

1. Проверяет `.env`.
2. Проверяет DNS для `HASURA_FQDN` и `BACKEND_FQDN`.
3. Запускает Traefik, PostgreSQL, Hasura, backend.
4. Ждет health endpoints.
5. Проверяет Hasura CORS preflight.
6. Запускает полный набор тестов:

```text
backend Vitest
frontend/serverless Vitest
Playwright e2e
```

Если IP определился автоматически, `--expected-ip` можно не передавать.

## Второй запуск: deploy с restore БД

Положить бэкапы на VPS, например:

```bash
mkdir -p /home/<user>/projects/erp/restore
```

В папке `restore` могут лежать:

```text
daily_erpdb_YYYYMMDD_HHMMSS.dump
globals_erpdb_globals_YYYYMMDD_HHMMSS.sql.gz
hasura_metadata_YYYY_MM_DD.json
```

Запуск:

```bash
cd /home/<user>/projects/erp
sudo ops/setup-vps.sh --yes \
  --expected-ip <VPS_PUBLIC_IP> \
  --restore-backup restore \
  --hasura-metadata restore/hasura_metadata.json \
  --require-restore-backup
```

Что делает restore:

- находит main dump в `restore`;
- если рядом есть globals dump, восстанавливает globals;
- останавливает Hasura перед restore;
- делает pre-restore backup текущей БД, если она уже есть;
- пересоздает целевую БД;
- восстанавливает dump;
- запускает Hasura;
- применяет Hasura metadata;
- затем идут smoke-проверки и полный прогон тестов.

Если `--hasura-metadata` не указан, скрипт сам ищет metadata рядом с backup.
Если metadata нет, скрипт делает fallback: auto-track public tables/views в
Hasura. Для production-переноса лучше всегда передавать настоящий metadata
export, потому что fallback не восстанавливает кастомные relationships и
permission rules.

`--require-restore-backup` нужен, чтобы скрипт упал с ошибкой, если backup не
найден. Без него отсутствие backup считается skip.

## Проверка после deploy

Проверить контейнеры:

```bash
docker compose --env-file .env -f docker-compose.yml ps
```

Проверить health вручную:

```bash
curl -fsS https://<HASURA_FQDN>/healthz
curl -fsS https://<BACKEND_FQDN>/health/live
```

Проверить smoke отдельно:

```bash
ops/smoke-vps.sh
```

Проверить тесты отдельно:

```bash
sudo ops/run-vps-tests.sh
```

Запустить только часть тестов:

```bash
sudo ops/run-vps-tests.sh --skip-e2e
sudo ops/run-vps-tests.sh --skip-backend --skip-frontend
sudo ops/run-vps-tests.sh --skip-backend --skip-e2e
```

## Как временно пропустить тесты

По умолчанию `ops/setup-vps.sh` после deploy запускает все тесты.

Для аварийного deploy можно явно отключить тесты:

```bash
sudo ops/setup-vps.sh --yes --skip-tests
```

Штатно лучше тесты не пропускать: они проверяют backend, frontend/serverless
слой и реальные browser workflows через Playwright.

## Повторный deploy на уже настроенном VPS

```bash
cd /home/<user>/projects/erp
git pull --ff-only
sudo ops/setup-vps.sh --yes
```

Если менялись только CORS-домены:

```bash
nano .env
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura backend
ops/smoke-vps.sh
sudo ops/run-vps-tests.sh
```

Если нужно принудительно пересоздать контейнеры:

```bash
sudo ops/setup-vps.sh --yes --force-recreate
```

## Vercel переменные для отдельного frontend

Для frontend, который должен ходить на этот VPS:

```env
VITE_API_URL=https://<BACKEND_FQDN>
VITE_HASURA_GRAPHQL_URL=https://<HASURA_FQDN>/v1/graphql
```

Флаги backend cutover выставляются по текущей задаче. Для полного backend-режима
обычно нужны:

```env
VITE_USE_BACKEND_AUTH=true
VITE_USE_BACKEND_PERMISSIONS=true
VITE_USE_BACKEND_ORDERS_READ=true
VITE_USE_BACKEND_ORDERS_WRITE=true
VITE_USE_BACKEND_USERS=true
VITE_USE_BACKEND_ORDER_EXPORT=true
VITE_USE_BACKEND_VLM=true
```

После изменения Vercel env нужно сделать новый deploy frontend.

## Типовые ошибки

### DNS не совпадает с VPS IP

Проверить:

```bash
dig +short <HASURA_FQDN>
dig +short <BACKEND_FQDN>
```

Если DNS еще не обновился, подождать propagation или временно запустить с
правильным ожиданием:

```bash
sudo ops/setup-vps.sh --yes --expected-ip <VPS_PUBLIC_IP>
```

### CORS в браузере

Проверить, что frontend origin есть в `.env`:

```bash
grep -E 'FRONTEND_ORIGIN|HASURA_GRAPHQL_CORS_DOMAIN|BACKEND_CORS_ALLOWED_ORIGINS' .env
```

Пересоздать нужные контейнеры:

```bash
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate hasura backend
ops/smoke-vps.sh
```

### Hasura metadata не применилась

Проверить health:

```bash
curl -fsS https://<HASURA_FQDN>/healthz
```

Применить metadata отдельно:

```bash
ops/apply-hasura-metadata.sh --metadata restore/hasura_metadata.json
```

### Нужно посмотреть логи

```bash
docker compose --env-file .env -f docker-compose.yml logs --tail=200 backend
docker compose --env-file .env -f docker-compose.yml logs --tail=200 hasura
docker compose --env-file .env -f docker-compose.yml logs --tail=200 traefik
docker compose --env-file .env -f docker-compose.yml logs --tail=200 postgresdb
```

## Шпаргалка команд

Первый запуск:

```bash
mkdir -p /home/<user>/projects
git clone <repo-url> /home/<user>/projects/erp
cd /home/<user>/projects/erp
sudo ops/setup-vps.sh
```

Deploy без restore:

```bash
sudo ops/setup-vps.sh --yes --expected-ip <VPS_PUBLIC_IP>
```

Deploy с restore:

```bash
sudo ops/setup-vps.sh --yes \
  --expected-ip <VPS_PUBLIC_IP> \
  --restore-backup restore \
  --hasura-metadata restore/hasura_metadata.json \
  --require-restore-backup
```

Ручной прогон всех тестов:

```bash
sudo ops/run-vps-tests.sh
```

