# VLM Cutover Readiness

Purpose: move VLM health, image upload, and image analyze from legacy Vercel
Functions to the stage-1 backend VLM API while keeping rollback available.

## Runtime Flags

Backend:

```env
BACKEND_ENABLE_AUTH=true
BACKEND_ENABLE_VLM=true
BACKEND_VLM_DISABLED=false
VLM_API_URL=<set>
AUTH0_M2M_DOMAIN=<set>
AUTH0_M2M_CLIENT_ID=<set>
AUTH0_M2M_CLIENT_SECRET=<set>
AUTH0_M2M_AUDIENCE=<set>
```

Frontend:

```env
VITE_USE_BACKEND_VLM=true
```

Keep legacy `/api/vlm/health`, `/api/vlm/upload`, and `/api/vlm/analyze`
deployed until canary and rollback checks pass.

## Pre-Cutover Checklist

- Backend compiled build starts with DB/auth/VLM provider env configured.
- `/health/ready` returns `status=ready` and `database.status=ok`.
- Admin login through `/api/v1/auth/login` succeeds.
- `GET /api/v1/vlm/health` returns safe status data and no provider secrets.
- `POST /api/v1/vlm/upload` accepts allowed image MIME types, enforces size
  limits, creates a `file_uploads` row, and returns `uploadId`.
- Frontend photo import analyzes through `uploadId` after backend upload.
- `POST /api/v1/vlm/analyze` rejects arbitrary external `imageUrl` unless it
  belongs to a stored upload.
- Backend writes `vlm.upload` and `vlm.analyze` audit events.
- Rate limit and daily analyze quota return `RATE_LIMIT_EXCEEDED`.
- Rollback with `BACKEND_VLM_DISABLED=true` returns 503 for upload/analyze.

## Smoke

Automated mocked frontend cutover smoke:

```bash
npm run test:e2e:vlm-cutover
```

Runtime backend smoke should be run against the stage/test DB with real auth,
VLM provider, and Auth0 M2M env:

```bash
cd backend
npm run build
set -a
. ./.env.test-bd.local
set +a
PORT=3315 \
READINESS_REQUIRE_DATABASE=true \
BACKEND_ENABLE_AUTH=true \
BACKEND_ENABLE_VLM=true \
BACKEND_VLM_DISABLED=false \
JWT_ACCESS_SECRET=<local-smoke-secret> \
REFRESH_TOKEN_PEPPER=<local-smoke-pepper> \
npm start
```

Then verify:

- login as a user with `vlm.health.view` and `vlm.use`;
- call `GET /api/v1/vlm/health`;
- upload a small PNG through `POST /api/v1/vlm/upload`;
- analyze the returned `uploadId` through `POST /api/v1/vlm/analyze`;
- confirm arbitrary external `imageUrl` is rejected;
- confirm `audit_log` contains `vlm.upload` and `vlm.analyze`;
- clean up the smoke `audit_log` and `file_uploads` rows;
- confirm rollback with `BACKEND_VLM_DISABLED=true`.

Do not print real env values, bearer tokens, Auth0 tokens, VLM provider URLs,
uploaded file URLs/keys, or raw VLM provider responses in logs.

## Rollback

Frontend-only rollback:

```env
VITE_USE_BACKEND_VLM=false
```

Backend actions rollback:

```env
BACKEND_VLM_DISABLED=true
```

Backend module rollback:

```env
BACKEND_ENABLE_VLM=false
```

Rollback is acceptable only while legacy `/api/vlm/health`,
`/api/vlm/upload`, and `/api/vlm/analyze` remain deployed.
