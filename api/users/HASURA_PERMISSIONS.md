# Hasura Permissions для таблицы users

## Важно: Безопасность

Поле `password_hash` **НИКОГДА** не должно быть доступно через GraphQL.
Все операции создания/изменения пользователей и паролей выполняются через API endpoints:
- `/api/users/create` - создание пользователя
- `/api/users/change-password` - изменение пароля

## Настройка Permissions в Hasura Console

### Таблица: `users`

#### Роль: `admin`

##### SELECT (чтение)

**Row select permissions:**
```json
{}
```
(Без ограничений - админ видит всех пользователей)

**Column select permissions:**
Выбрать все колонки **КРОМЕ**:
- ❌ `password_hash` (ИСКЛЮЧИТЬ!)

Разрешенные колонки:
- ✅ `user_id`
- ✅ `username`
- ✅ `email`
- ✅ `full_name`
- ✅ `role_id`
- ✅ `is_active`
- ✅ `created_at`
- ✅ `updated_at`
- ✅ `last_login_at`

**Aggregation queries:** Разрешить

##### INSERT (создание)

**НЕ РАЗРЕШАТЬ** ❌

Создание пользователей только через `/api/users/create`

##### UPDATE (изменение)

**НЕ РАЗРЕШАТЬ** ❌

Изменение данных пользователей:
- Общие данные (username, email, etc.) - через обычный GraphQL update (если требуется, можно разрешить позже)
- Пароль - только через `/api/users/change-password`

##### DELETE (удаление)

**НЕ РАЗРЕШАТЬ** ❌

Удаление пользователей не предусмотрено. Используйте `is_active = false` для деактивации.

---

#### Роль: `manager`, `operator`, `viewer` (другие роли)

Для всех остальных ролей доступ к таблице `users` **полностью запрещен**:
- SELECT: ❌
- INSERT: ❌
- UPDATE: ❌
- DELETE: ❌

---

## Проверка безопасности

После настройки permissions проверьте:

1. **GraphQL запрос от админа:**
   ```graphql
   query {
     users {
       user_id
       username
       email
       role_id
       is_active
     }
   }
   ```
   ✅ Должен работать

2. **Попытка получить password_hash:**
   ```graphql
   query {
     users {
       user_id
       password_hash  # <-- это поле не должно быть доступно
     }
   }
   ```
   ❌ Должна вернуться ошибка

3. **Попытка вставить пользователя через GraphQL:**
   ```graphql
   mutation {
     insert_users_one(object: {
       username: "test"
       password_hash: "hash"
     }) {
       user_id
     }
   }
   ```
   ❌ Должна вернуться ошибка "permission denied"

4. **Запрос от не-админа:**
   ```graphql
   query {
     users {
       user_id
     }
   }
   ```
   ❌ Должна вернуться ошибка "permission denied"

---

## Примечания

- Permissions можно настроить через Hasura Console → Data → users → Permissions
- После изменения permissions Hasura применяет их моментально, перезапуск не требуется
- Для автоматизации можно экспортировать metadata и добавить в систему контроля версий
