# Scripts для настройки аутентификации

## generate-passwords.js

Генерирует bcrypt хэши для тестовых пользователей и SQL statements для их создания/обновления.

### Использование:

1. Установите зависимость (если еще не установлена):
```bash
npm install bcryptjs
```

2. Запустите скрипт:
```bash
node scripts/generate-passwords.js
```

3. Скопируйте сгенерированные SQL statements и выполните их в вашей PostgreSQL базе данных.

### Тестовые пароли:

- **admin**: `admin123`
- **manager**: `manager123`
- **operator**: `operator123`
- **top_manager**: `topmanager123`
- **worker**: `worker123`

## Deadline scheduler external-owner canary

Run only against the isolated stage/test contour after the backend runtime is
configured with `BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER=external`.

```bash
DEADLINE_WORKER_FIXTURE_KEY=deadline-scheduler-external-canary-YYYY-MM-DD \
DEADLINE_WORKER_FIXTURE_ORDER_ID=11192 \
DEADLINE_WORKER_FIXTURE_RESTORE=true \
DEADLINE_WORKER_TARGET_ENV=backend-test \
npm run test:e2e:deadline-scheduler-external-canary
```

Expected evidence:

- `POST /api/v1/deadline-worker/process-due-scheduled` returns one processed
  fixture deadline, then zero on repeat.
- The expired fixture deadline has one `deadline-engine-scheduler` audit row,
  zero `deadline-engine-manual` audit rows, one outbox row, and no action
  executions.
- Fixture restore returns zero deadline/event/audit/outbox/action-execution
  rows for the fixture key.
- **viewer**: `viewer123`

⚠️ **ВНИМАНИЕ:** Эти пароли предназначены ТОЛЬКО для разработки и тестирования! Никогда не используйте их в production!

### Вывод скрипта:

Скрипт генерирует:
1. Bcrypt хэши для каждого пароля
2. SQL для обновления существующих пользователей
3. SQL для создания новых тестовых пользователей

### Пример вывода:

```sql
-- Update admin user
UPDATE users
SET password_hash = '$2a$10$...'
WHERE username = 'admin';

-- Create admin user (if not exists)
INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
VALUES ('admin', 'admin@mebelkz.local', '$2a$10$...', 1, 'Admin User', true)
ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash;
```

## Следующие шаги:

После генерации и применения SQL:

1. Проверьте, что пользователи созданы:
```sql
SELECT user_id, username, role_id, is_active FROM users;
```

2. Примените миграцию для настройки аутентификации:
```bash
psql -U pguser -d erpdb -f ai_docs/db_migrations/001_auth_setup.sql
```

3. Переходите к настройке Hasura (Этап 2).
