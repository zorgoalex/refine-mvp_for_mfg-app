# Dark Theme Design

## Goal

Add a user-scoped light/dark theme setting with a fast header toggle, a profile page checkbox for the default theme, and persistent storage across browsers.

## Scope

- Add a persisted user preference for `themeMode`, with values `light` and `dark`.
- Expose the preference through authenticated backend endpoints for the current user.
- Apply Ant Design 5 `defaultAlgorithm` or `darkAlgorithm` at the root `ConfigProvider`.
- Replace local hard-coded light colors that block dark mode with CSS variables.
- Add a header switch for immediate theme changes.
- Add a `/profile` page with current user info and a checkbox labeled `Использовать темную тему по умолчанию`.

## Architecture

Backend stores one row per user preference in `user_preferences`. This avoids widening the legacy `users` table and keeps UI preferences isolated from account-management data. New endpoints live under `/api/v1/me/preferences` and require the authenticated current user.

Frontend owns theme state in a small React context. It initializes from a user-scoped `localStorage` cache to avoid a bright flash, then refreshes from backend when authenticated. Updates optimistically apply the selected theme, write the cache, and persist to backend.

## UX

The header contains a compact switch next to notifications/account controls. Changing it applies the theme immediately.

The profile page is reachable from the user dropdown. It shows username, role, and the default-theme checkbox. The checkbox writes the same persisted `themeMode` preference as the header switch.

## Data Flow

1. User logs in.
2. `ThemeProvider` reads `erp.themeMode.<userId>` from `localStorage`.
3. `ThemeProvider` fetches `/api/v1/me/preferences`.
4. Backend returns `{ preferences: { themeMode } }`, defaulting to `light` when no row exists.
5. Changing the switch or checkbox updates React state, updates `localStorage`, and sends `PATCH /api/v1/me/preferences`.

## Backend Contract

`GET /api/v1/me/preferences`

```json
{
  "preferences": {
    "themeMode": "light"
  }
}
```

`PATCH /api/v1/me/preferences`

```json
{
  "themeMode": "dark"
}
```

Returns the same response shape as `GET`.

Invalid values return `422`.

## Testing

- Backend unit tests cover default `light`, persisted `dark`, update validation, and current-user scoping.
- Frontend tests cover localStorage initialization, header toggle persistence call, and profile checkbox behavior.
- Build must pass with `npm run build`.

