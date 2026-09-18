# Backend на production: версия, настройки, обновление и откат

Обновлено: 2026-09-18. Основной документ: [Деплой и эксплуатация](deployment-and-operations.md).

## Что изменилось и почему

Разделяем **постоянную конфигурацию** и **версию приложения**:

| Файл в runtime-каталоге | Назначение | Кто меняет |
|---|---|---|
| `.env` | Секреты, подключения, CORS, feature flags и владельцы обработчиков | Оператор при изменении настроек |
| `docker-compose.yml` | Один основной рабочий Compose | Оператор по согласованным изменениям |
| `backend-release.env` | Образ и SHA установленного backend | Команды ниже, автоматически |
| `backend-release.candidate.env` | Проверяемый новый релиз | Команды ниже, автоматически |
| `backend-release.previous.env` | Предыдущий релиз для возможного отката | Копируется перед сменой версии |

Расширение `.env` означает формат `КЛЮЧ=значение`, не секретность. Release-файлы
не содержат паролей/токенов, не являются дополнительными Compose-файлами и не
коммитятся: это состояние конкретного сервера. Число файлов фиксированное.
SHA вручную не переписывается: текущий берётся из проверенного Docker-образа,
новый — из выбранного чистого коммита `main`.

Повод для изменения: в production-диагностике контейнер имел `relay_owner=external`,
а текущий Compose выдавал `in_process`; одновременно Compose выбирал старый образ,
не совпадающий с запущенным. Это два подтверждённых расхождения, но точный источник
старого значения при прошлом деплое не установлен. Последняя обработка 15 сентября
сама по себе не доказывает точное время/причину остановки.

**Граница автоматизации:** здесь автоматизировано получение SHA и формирование
файлов командами. Запуск шагов, решение об откате и проверки выполняет оператор.
Единого production deploy-скрипта с транзакционным управлением release-файлами
пока нет. `ops/deploy-stack.sh` вычисляет SHA, но не поддерживает этот жизненный
цикл и добавляет overlays; `ops/up-all.sh` выбирает test-template. Не смешивать
эти пути с процедурой ниже. Код deploy-скриптов данным обновлением документации
не меняется.

## 1. Предусловия и новая терминальная сессия

Команды предназначены для **production VPS** с подтверждённой раскладкой:

- runtime `/home/ovhnewesm/projects/erp_dev`;
- checkout `/home/ovhnewesm/projects/erp_dev/repo_erp`, production-ветка `main`;
- Compose project `erp_test`, backend `erp_test-backend-1`, БД `erp_test-postgresdb-1`;
- API `https://backend-ovh.mebelkz.app`.

Имя `erp_test` здесь историческое: **это не разрешение менять production-данные**.
На другом сервере эти значения нельзя использовать без отдельной проверки.
Нужны Bash, Docker Compose v2 с повторным `--env-file`, `jq`, `curl`, Git.
Не запускать два деплоя/изменения конфигурации одновременно. При любой ошибке
остановиться: следующие блоки не исполнять автоматически.

В начале каждой новой сессии проверить контейнеры и реальные файлы, не использовать
старые `$BACKEND_CID`/`$PG_CID`/`$C`. Все исполняемые блоки ниже однострочные.

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

```bash
docker inspect erp_test-backend-1 --format 'project={{index .Config.Labels "com.docker.compose.project"}} working_dir={{index .Config.Labels "com.docker.compose.project.working_dir"}} config_files={{index .Config.Labels "com.docker.compose.project.config_files"}} environment_file={{index .Config.Labels "com.docker.compose.project.environment_file"}}'
```

Ожидаются указанный runtime/project и **один** live `docker-compose.yml`. Если
пути/проект отличаются — STOP, не подменять конфигурацию шаблоном. После перехода
в env-file label могут быть оба файла переменных; формат label зависит от Compose.

Определить helper **заново в каждой сессии**. Первый аргумент — release-файл,
остальные передаются Compose. `env -i` создаёт изолированное окружение:
BACKEND/Bitrix/DB/CORS/COMPOSE переменные терминала не могут перекрыть файлы.
Сохраняются только HOME/PATH и перечисленные transport-переменные Docker/SSH,
чтобы обращаться к тому же Docker daemon/context, который проверен выше.
Эти transport-ключи нельзя использовать как бизнес-настройки в Compose.
Сам основной `.env` через shell не исполняется и не меняется helper-ом.

```bash
erp_compose() { local release="$1" key; shift; local -a transport=(); for key in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION SSH_AUTH_SOCK XDG_RUNTIME_DIR; do if [[ -v $key ]]; then transport+=("$key=${!key}"); fi; done; env -i HOME="$HOME" PATH="$PATH" "${transport[@]}" docker compose --project-directory /home/ovhnewesm/projects/erp_dev --env-file /home/ovhnewesm/projects/erp_dev/.env --env-file "$release" -p erp_test -f /home/ovhnewesm/projects/erp_dev/docker-compose.yml "$@"; }
```

Helper проверки файла и итоговой конфигурации (без вывода секретов). Ничего не
запускает. Здесь осознанно закреплена работа **прямого** Bitrix worker внутри
backend; для отдельного external worker нужен другой согласованный runbook.

```bash
erp_release_check() ( set -euo pipefail; local file="$1" image sha; test -f "$file" || exit 1; test "$(wc -l < "$file")" -eq 2 || exit 1; test "$(grep -c '^BACKEND_BUILD_IMAGE=' "$file")" -eq 1 || exit 1; test "$(grep -c '^BACKEND_BUILD_SHA=' "$file")" -eq 1 || exit 1; image=$(sed -n 's/^BACKEND_BUILD_IMAGE=//p' "$file"); sha=$(sed -n 's/^BACKEND_BUILD_SHA=//p' "$file"); [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1; test "$image" = "erp-backend:$sha" || exit 1; test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$sha" || exit 1; erp_compose "$file" config --format json | jq -e --arg image "$image" --arg sha "$sha" '.services.backend | {image,sha:.environment.BACKEND_BUILD_SHA,enabled:.environment.BACKEND_ENABLE_BITRIX24_SYNC,owner:.environment.BACKEND_BITRIX24_SYNC_RELAY_OWNER,dry_run:.environment.BACKEND_BITRIX24_SYNC_DRY_RUN} | if .image==$image and .sha==$sha and (.enabled|tostring)=="true" and .owner=="in_process" and (.dry_run|tostring)=="false" then . else error("STOP: image/SHA or forward Bitrix flags mismatch") end'; )
```

Helper проверки запущенного релиза: container image ID должен совпасть с образом
из файла, внутренние runtime flags — с нужным режимом, HTTPS readiness — вернуть
`ready` и тот же SHA. Не считывает `.env` через `source`, не печатает Docker Env.

```bash
erp_release_verify() ( set -euo pipefail; local file="$1" image sha; erp_release_check "$file" || exit 1; image=$(sed -n 's/^BACKEND_BUILD_IMAGE=//p' "$file"); sha=$(sed -n 's/^BACKEND_BUILD_SHA=//p' "$file"); test "$(docker inspect erp_test-backend-1 --format '{{.Image}}')" = "$(docker image inspect "$image" --format '{{.Id}}')" || exit 1; docker exec erp_test-backend-1 sh -ec 'test "$BACKEND_BUILD_SHA" = "$1" || exit 1; test "$BACKEND_ENABLE_BITRIX24_SYNC" = true || exit 1; test "$BACKEND_BITRIX24_SYNC_RELAY_OWNER" = in_process || exit 1; test "$BACKEND_BITRIX24_SYNC_DRY_RUN" = false' sh "$sha" || exit 1; curl --max-time 15 -fsS https://backend-ovh.mebelkz.app/health/ready | jq -e --arg sha "$sha" 'if .status=="ready" and .deployment.gitCommitSha==$sha then {status,sha:.deployment.gitCommitSha,checks} else error("STOP: readiness or SHA mismatch") end'; )
```

Проверка readiness — не доказательство обработки очереди; раздел 6 обязателен.

## 2. Однократный переход на файл версии

### 2.1. Снять текущую версию с работающего образа

Это операция **adopt**, не выбор нового релиза из Git. Проверяется OCI label,
имя тега и точное соответствие тега image ID контейнера. Файл создаётся атомарно
в том же каталоге. Если `backend-release.env` уже существует — команда остановится;
не перезаписывать его вслепую, проверить содержимое и запущенный образ.

```bash
bash -euc 'file=/home/ovhnewesm/projects/erp_dev/backend-release.env; test ! -e "$file" || { echo "STOP: release file exists; inspect it first"; exit 1; }; image=$(docker inspect erp_test-backend-1 --format "{{.Config.Image}}"); image_id=$(docker inspect erp_test-backend-1 --format "{{.Image}}"); sha=$(docker image inspect "$image_id" --format "{{index .Config.Labels \"org.opencontainers.image.revision\"}}"); [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; test "$image" = "erp-backend:$sha"; test "$(docker image inspect "$image" --format "{{.Id}}")" = "$image_id"; tmp=$(mktemp "${file}.XXXXXX"); trap '\''rm -f "$tmp"'\'' EXIT; printf "BACKEND_BUILD_IMAGE=%s\nBACKEND_BUILD_SHA=%s\n" "$image" "$sha" > "$tmp"; chmod 644 "$tmp"; mv "$tmp" "$file"; echo "Current image recorded; no deploy performed"'
```

```bash
cat /home/ovhnewesm/projects/erp_dev/backend-release.env
```

**Комментарий:** это единственный `.env`-форматный файл, который разрешено
печатать в этом runbook: в нём строго два несекретных поля версии. Основной
`.env`, webhook URLs, OAuth-токены и полный `docker compose config` не печатать.

### 2.2. Один раз настроить live Compose

Открыть существующий файл, не создавать override и не заменять весь сервис:

```bash
nano /home/ovhnewesm/projects/erp_dev/docker-compose.yml
```

Ниже **YAML, не команда**. Обновить соответствующие ключи внутри существующего
`services.backend`; не дублировать `environment`, не удалять другие настройки:

```yaml
services:
  backend:
    image: ${BACKEND_BUILD_IMAGE:?Use backend-release.env}
    environment:
      BACKEND_BUILD_SHA: ${BACKEND_BUILD_SHA:?Use backend-release.env}
      BACKEND_ENABLE_BITRIX24_SYNC: ${BACKEND_ENABLE_BITRIX24_SYNC:-false}
      BACKEND_BITRIX24_SYNC_RELAY_OWNER: ${BACKEND_BITRIX24_SYNC_RELAY_OWNER:-none}
      BACKEND_BITRIX24_SYNC_DRY_RUN: ${BACKEND_BITRIX24_SYNC_DRY_RUN:-false}
```

`build` и другие поля оставить; кандидат ниже собирается отдельной командой.
Required-подстановка `:?` намеренно запрещает обычный `compose up` без версии:
лучше явная ошибка, чем незаметный откат к старому образу или `:local`.

```bash
nano /home/ovhnewesm/projects/erp_dev/.env
```

Удалить только `BACKEND_BUILD_IMAGE`/`BACKEND_BUILD_SHA`; они теперь в release-файле.
Для существующей постоянной прямой синхронизации оставить `true/in_process/false`.
Не менять `REVERSE_SYNC`, actor ID, токены, платёжные системы, CORS и другие owners.
В редакторе сохранить: Ctrl+O → Enter → Ctrl+X.

```bash
erp_release_check /home/ovhnewesm/projects/erp_dev/backend-release.env
```

Если проверка прошла — применить настройки по разделу 3. Если не прошла — STOP.

## 3. Применить настройки без смены версии

Повторить helpers раздела 1, если терминал новый. Release-файл **не генерировать
заново** и не брать Git HEAD. Не делать pull/build. До изменения настроек иметь
защищённую локальную копию меняемых конфигурационных файлов для их отдельного
восстановления; release previous не содержит конфигурацию и секреты.

```bash
erp_release_check /home/ovhnewesm/projects/erp_dev/backend-release.env && erp_compose /home/ovhnewesm/projects/erp_dev/backend-release.env up -d --no-deps --no-build --force-recreate backend
```

Будет кратковременный перерыв API. `docker restart` не применяет новый env.
Дождаться старта (до двух минут), затем выполнить:

```bash
erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.env
```

Если старт ещё идёт, повторить проверку в пределах двух минут. Если не готов —
смотреть `docker logs --tail 100 erp_test-backend-1`, не менять release-файл и не
объявлять успех. Проверить очередь по разделу 6. При ошибке именно настроек
восстановить их проверенную предыдущую конфигурацию; откат образа её не заменяет.

## 4. Обновить код backend на новый релиз

Это отдельная операция, не средство включить worker. Предусловия:

- согласован и прошёл CI production-коммит `main`; dirty checkout запрещён;
- миграции и совместимость отката проверены отдельно; перед миграциями —
  [production backup](deployment-and-operations.md#production-backup);
- frontend/Hasura/CAD/worker и их миграции данным backend-only шагом не обновляются;
- текущий release-файл соответствует установленному образу и readiness;
- нет незавершённого candidate от прошлого деплоя; если есть — сначала выяснить,
  какой образ реально запущен, не перетирать candidate/previous;
- сборка не должна занимать все четыре ядра; CPU3 оставить системе. При нехватке
  ресурсов или устойчивом D-state отложить сборку. Агент на shared host обязан
  использовать `rtk-heavy-guard`; `taskset` клиентского Docker не ограничивает daemon.

```bash
erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.env
```

Показать изменения и обновить checkout только если он чистый (не использовать reset):

```bash
git -C /home/ovhnewesm/projects/erp_dev/repo_erp status --short --branch
```

```bash
bash -euc 'cd /home/ovhnewesm/projects/erp_dev/repo_erp; test -z "$(git status --porcelain)"; git fetch origin; git switch main; git pull --ff-only origin main; test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"; git log -1 --format="%H %s"'
```

Сверить полученный коммит с согласованным релизом. Если main ушёл вперёд — STOP,
не считать неизвестный новый коммит автоматически разрешённым для production.
Зафиксировать SHA в **этой сессии** автоматически и убедиться, что candidate отсутствует:

```bash
RELEASE_SHA="$(git -C /home/ovhnewesm/projects/erp_dev/repo_erp rev-parse HEAD)" && test ! -e /home/ovhnewesm/projects/erp_dev/backend-release.candidate.env && printf 'Candidate SHA: %s\n' "$RELEASE_SHA"
```

### Gate схемы и связанных контрактов — до сборки и запуска кандидата

Команда ниже допускает этот backend-only маршрут только если между установленным
и выбранным SHA не менялись migrations, Hasura metadata и backend contracts.
При изменениях выводит список и останавливается. Отсутствующий Git object — тоже
STOP. Здесь нет команды «применить все миграции» и нет обхода gate.

```bash
bash -euc 'old=$(sed -n "s/^BACKEND_BUILD_SHA=//p" /home/ovhnewesm/projects/erp_dev/backend-release.env); new="$1"; [[ "$old" =~ ^[0-9a-f]{40}$ && "$new" =~ ^[0-9a-f]{40}$ ]]; cd /home/ovhnewesm/projects/erp_dev/repo_erp; git cat-file -e "$old^{commit}"; git cat-file -e "$new^{commit}"; git diff --name-status "$old" "$new" -- backend/db/migrations ops/hasura backend/contracts; git diff --quiet "$old" "$new" -- backend/db/migrations ops/hasura backend/contracts || { echo "STOP: separate schema/contract rollout required"; exit 1; }' sh "$RELEASE_SHA"
```

Далее проверить **реальную БД**, даже если diff пуст. Проверка read-only; её
результат сохраняется локально как evidence данного SHA. Требуется ноль pending,
ноль checksum drift и отсутствие WARNING. Это не применение миграций.

```bash
bash -euo pipefail -c 'sha="$1"; [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; umask 077; mkdir -p /home/ovhnewesm/projects/erp_dev/logs; file="/home/ovhnewesm/projects/erp_dev/logs/backend-release-${sha}-migrations.log"; /home/ovhnewesm/projects/erp_dev/repo_erp/ops/apply-migrations.sh status --container erp_test-postgresdb-1 > "$file" 2>&1 || { cat "$file"; exit 1; }; cat "$file"; grep -Eq "pending: 0[[:space:]]+drift: 0$" "$file"; if grep -q "WARNING:" "$file"; then echo "STOP: inspect migration warning"; exit 1; fi' sh "$RELEASE_SHA"
```

Если любой gate не прошёл, backend не пересоздавать. Для такого релиза нужен
отдельный согласованный план: backup packet и проверка checksum → конкретные
миграции в установленном порядке → SQL/effect/ledger проверки → при необходимости
Hasura metadata/frontend/CAD/worker → проверка совместимости отката → deploy.
Сохранить список применённых миграций, resulting schema level и результат проверок
в evidence релиза. `baseline`/`mark-applied` не являются способом убрать ошибку
gate. Этот runbook не подменяет более широкий rollout и не разрешает его сам.

### Сборка образа и переключение

Сборка для оператора на четырёхъядерном production VPS, одним ядром daemon build.
Команда требует legacy builder (`DOCKER_BUILDKIT=0`); если он недоступен — STOP,
не убирать ограничения ради запуска. Нужен отдельно подготовленный bounded builder.
На агентском shared host эту же тяжёлую операцию запускать только через guard.
Если тег этого SHA уже существует, не пересобирать его поверх: проверить его
происхождение и OCI label, затем использовать проверенный существующий образ.
Перед сборкой проверить наличие тега (успех означает «образ уже есть»; при ошибке
соединения с Docker сначала восстановить доступ, а не считать образ отсутствующим):

```bash
test -n "$RELEASE_SHA" && docker image inspect "erp-backend:$RELEASE_SHA" --format 'image_id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Следующую команду выполнять только если Docker явно ответил, что такого образа нет.

```bash
test -n "$RELEASE_SHA" && test "$(git -C /home/ovhnewesm/projects/erp_dev/repo_erp rev-parse HEAD)" = "$RELEASE_SHA" && test -z "$(git -C /home/ovhnewesm/projects/erp_dev/repo_erp status --porcelain)" && DOCKER_BUILDKIT=0 docker build --cpuset-cpus 0 --cpu-period 100000 --cpu-quota 100000 --build-arg BACKEND_BUILD_SHA="$RELEASE_SHA" -t "erp-backend:$RELEASE_SHA" /home/ovhnewesm/projects/erp_dev/repo_erp/backend
```

Только после успешной сборки сформировать candidate автоматически. Checkout не
должен меняться во время сборки. При смене сессии не продолжать с потерянным SHA.

```bash
bash -euc 'sha="$1"; file=/home/ovhnewesm/projects/erp_dev/backend-release.candidate.env; [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; test ! -e "$file"; test "$(git -C /home/ovhnewesm/projects/erp_dev/repo_erp rev-parse HEAD)" = "$sha"; test -z "$(git -C /home/ovhnewesm/projects/erp_dev/repo_erp status --porcelain)"; test "$(docker image inspect "erp-backend:$sha" --format "{{index .Config.Labels \"org.opencontainers.image.revision\"}}")" = "$sha"; tmp=$(mktemp "${file}.XXXXXX"); trap '\''rm -f "$tmp"'\'' EXIT; printf "BACKEND_BUILD_IMAGE=erp-backend:%s\nBACKEND_BUILD_SHA=%s\n" "$sha" "$sha" > "$tmp"; chmod 644 "$tmp"; mv "$tmp" "$file"' sh "$RELEASE_SHA"
```

Проверить кандидат; сохранить текущую версию для отката **до** переключения:

```bash
erp_release_check /home/ovhnewesm/projects/erp_dev/backend-release.candidate.env && erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.env && bash -euc 'src=/home/ovhnewesm/projects/erp_dev/backend-release.env; dst=/home/ovhnewesm/projects/erp_dev/backend-release.previous.env; tmp=$(mktemp "${dst}.XXXXXX"); trap '\''rm -f "$tmp"'\'' EXIT; cp "$src" "$tmp"; cmp -s "$src" "$tmp"; chmod 644 "$tmp"; mv "$tmp" "$dst"'
```

```bash
erp_compose /home/ovhnewesm/projects/erp_dev/backend-release.candidate.env up -d --no-deps --no-build --force-recreate backend
```

До двух минут на старт; затем проверить candidate:

```bash
erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.candidate.env
```

Выполнить также раздел 6 и релизные smoke-проверки нужных бизнес-сценариев.
Только после успеха повторно проверить readiness и атомарно сделать candidate текущим:

```bash
erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.candidate.env && mv /home/ovhnewesm/projects/erp_dev/backend-release.candidate.env /home/ovhnewesm/projects/erp_dev/backend-release.env
```

После переключения label контейнера может указывать на старое имя candidate-файла:
это историческая команда создания, не источник версии для следующего запуска.
Использовать current-файл, не воссоздавать отсутствующий candidate по label.
При прерывании до promotion сохранить файлы, сверить фактический container image
с candidate/current и решить: завершить проверку и promotion либо откатить.

## 5. Откат образа

Не автоматический. Прежде проверить совместимость старого кода с уже применённой
схемой и записанными данными. Эта процедура не откатывает БД, бизнес-операции и `.env`.
Не откатываться на код с известной уязвимостью/ошибкой платежей ради зелёного health.
Нужен существующий `backend-release.previous.env` и сохранённый локальный образ;
не выполнять `docker image prune` до завершения окна проверки релиза.

После разрешённого отката:

```bash
erp_release_check /home/ovhnewesm/projects/erp_dev/backend-release.previous.env && erp_compose /home/ovhnewesm/projects/erp_dev/backend-release.previous.env up -d --no-deps --no-build --force-recreate backend
```

Дождаться старта, выполнить раздел 6 и проверить previous:

```bash
erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.previous.env
```

После успеха атомарно восстановить current-файл, сохраняя previous:

```bash
erp_release_verify /home/ovhnewesm/projects/erp_dev/backend-release.previous.env && bash -euc 'file=/home/ovhnewesm/projects/erp_dev/backend-release.env; tmp=$(mktemp "${file}.XXXXXX"); trap '\''rm -f "$tmp"'\'' EXIT; cp /home/ovhnewesm/projects/erp_dev/backend-release.previous.env "$tmp"; chmod 644 "$tmp"; mv "$tmp" "$file"'
```

Оставшийся candidate не активен; сохранить его как evidence перед отдельной очисткой.
Не начинать следующий релиз, пока не разобрана незавершённая попытка.

## 6. Обязательная проверка Bitrix после пересоздания

Показать только несекретные режимы обоих направлений:

```bash
docker exec erp_test-backend-1 sh -lc 'printf "forward=%s/%s/%s\nreverse=%s/%s/%s\n" "$BACKEND_ENABLE_BITRIX24_SYNC" "$BACKEND_BITRIX24_SYNC_RELAY_OWNER" "$BACKEND_BITRIX24_SYNC_DRY_RUN" "$BACKEND_ENABLE_BITRIX24_REVERSE_SYNC" "$BACKEND_BITRIX24_REVERSE_SYNC_RELAY_OWNER" "$BACKEND_BITRIX24_REVERSE_SYNC_DRY_RUN"'
```

Forward ожидается `true/in_process/false`. Reverse сверить с согласованной
конфигурацией до изменения; прямую и обратную очереди не путать. `external` не
ошибка сам по себе, но требует отдельного реально работающего worker. В этом
runbook принят in-process режим. Значение из первой загрузки/backfill не переносить
в очередной production deploy.

Через 2–3 минуты (при poll 60000 мс) проверить:

```bash
docker logs --since 5m erp_test-backend-1 2>&1 | grep -E -A 16 'crm_sync_relay_batch_finished|crm_sync_scheduler_tick_failed' | tail -120
```

```bash
docker exec erp_test-postgresdb-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -P pager=off -c "$1"' sh "SELECT now() AS db_time; SELECT event_type,status,count(*) AS count,max(attempts) AS max_attempts,max(processed_at) AS last_processed FROM crm_sync_outbox GROUP BY event_type,status ORDER BY event_type,status; SELECT lock_name,locked_at FROM crm_sync_writer_lock;"
```

При существующем backlog ожидается прогресс `processed`/`last_processed` и
сокращение `pending` (новые события могут одновременно прибывать). При пустой
очереди отсутствие нового `last_processed` нормально; ожидаются ticks с claimed=0.
Если очередь движется в `failed`, восстановлен запуск worker, но не бизнес-успех:
прочитать ошибки и разобраться, не объявлять всю интеграцию исправной.

Следующий вывод предназначен **только для локального просмотра оператором**.
`last_error` может содержать чувствительные данные от внешнего API. Не отправлять
его целиком в чат/issue: сначала скрыть токены, APP_SID, полный webhook URL и
секретные query-параметры. Это относится и к `docker logs` выше.

```bash
docker exec erp_test-postgresdb-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -P pager=off -c "$1"' sh "SELECT entity_type,erp_id,bitrix_id,status,attempts,left(last_error,1000) AS last_error,updated_at FROM crm_sync_mapping WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 20;"
```

Присылая логи, скрыть токены/полный webhook URL/APP_SID. Не делать backfill для
уже поставленных pending, не удалять locks/очередь и не сбрасывать attempts массово.
Старые exhausted `failed` сами не оживают от переключения owner. Ошибки изменения
суммы/удаления уже оплаченной записи требуют отдельного финансового разбора,
не автоматического снятия признака оплаты.

`healthy` и запись о создании заказа в бизнес-аудите не заменяют проверку очереди.
В техническом аудите `crm_sync.upsert`/`crm_sync.failed`, источник `crm-sync`;
его UI-списки ограничены недавними записями, отсутствие пункта в фильтре не
доказывает отсутствие события в БД.

## 7. Что ещё нужно автоматизировать в deploy-скрипте

Это требования к следующему изменению кода, **не реализованные гарантии**:

- единый backend-only entrypoint: `deploy`, `apply-config`, `rollback`, `status`;
- межпроцессная блокировка, fail-closed выбор production target и проверенного SHA;
- ограниченная сборка, проверка OCI label/image ID и миграционного gate;
- автоматическое создание candidate, durable previous, promotion только после
  readiness с ожидаемым SHA и проверки бизнес-сценариев/очереди;
- восстановление после прерывания без перетирания предыдущего рабочего релиза;
- совместимый и явно разрешённый rollback, сохранение необходимых образов;
- проверка env-флагов, исключение shell overrides, безопасный вывод без секретов;
- тот же release-файл для config-only операций, без чтения нового Git HEAD.

До реализации не выдавать `ops/deploy-stack.sh` за такой entrypoint и не предлагать
непроверенную команду «обновить всё» вместо текущего runbook.

## Архив и источники

Предыдущие варианты сохранены побайтово, не являются актуальной инструкцией:

- [Деплой и эксплуатация до изменения](archive/deployment-and-operations.before-backend-release-2026-09-18.md).
- [VPS Bootstrap And Deploy до изменения](archive/ops-readme.before-backend-release-2026-09-18.md).

Порядок подстановки переменных: [Docker Compose interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
Последний `--env-file` перекрывает предыдущий; shell может перекрыть оба для
любого ключа, поэтому helper изолирует окружение, а не только удаляет SHA.
Уже созданный контейнер не перечитывает
файлы автоматически; применение env требует recreation.
