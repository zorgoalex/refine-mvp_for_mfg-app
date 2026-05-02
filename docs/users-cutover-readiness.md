# Users Cutover Readiness

Purpose: switch the users workflow from legacy Hasura/Vercel paths to the stage-1
backend users API without losing rollback.

## Runtime Flags

Backend:

```env
BACKEND_ENABLE_AUTH=true
BACKEND_ENABLE_USERS=true
```

Frontend:

```env
VITE_USE_BACKEND_AUTH=true
VITE_USE_BACKEND_PERMISSIONS=true
VITE_USE_BACKEND_USERS=true
```

Keep legacy functions deployed until the canary and rollback checks pass.

## Pre-Cutover Checklist

- Backend compiled build starts with DB/auth/users env configured.
- `/health/ready` returns `status=ready` and `database.status=ok`.
- Admin login through `/api/v1/auth/login` succeeds.
- `GET /api/v1/users` returns users without `password` or `password_hash`.
- Frontend users list/show/create/edit/password all call `/api/v1/users*`.
- Frontend users pages do not send `role_id`; they send canonical `role`.
- User create/update/change-password/deactivate/activate write `audit_log`.
- Password change and deactivate revoke active sessions/refresh tokens.
- A non-users permission account cannot access users pages or users API.

## Smoke

Automated mocked frontend cutover smoke:

```bash
npm run test:e2e:users-cutover
```

Runtime backend smoke should be run against the stage/test DB with real auth env:

```bash
cd backend
npm run build
set -a
. ./.env.test-bd.local
set +a
PORT=3313 \
READINESS_REQUIRE_DATABASE=true \
BACKEND_ENABLE_AUTH=true \
BACKEND_ENABLE_USERS=true \
JWT_ACCESS_SECRET=<local-smoke-secret> \
REFRESH_TOKEN_PEPPER=<local-smoke-pepper> \
npm start
```

Then verify:

- login as an admin user;
- list users;
- create temporary user;
- update temporary user;
- change temporary user's password;
- deactivate and reactivate temporary user;
- remove temporary user from the test DB;
- confirm rollback by setting either `VITE_USE_BACKEND_USERS=false` or
  `BACKEND_ENABLE_USERS=false`.

Do not print real env values or bearer/refresh tokens in logs.

## Rollback

Frontend-only rollback:

```env
VITE_USE_BACKEND_USERS=false
```

Backend fail-closed rollback:

```env
BACKEND_ENABLE_USERS=false
```

Rollback is acceptable only while legacy `/api/users/create`,
`/api/users/change-password`, and Hasura users CRUD remain deployed.
