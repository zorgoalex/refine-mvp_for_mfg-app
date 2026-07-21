# Архитектура UI variant

## Текущее состояние

- `src/index.tsx` ждёт `/runtime-config.json` до импорта `App`, поэтому bootstrap уже имеет безопасную точку выбора shell без flash.
- `src/App.tsx` содержит один набор public/business routes и один authenticated `WorkspaceLayout`.
- Profile preferences (`GET/PATCH /api/v1/me/preferences`) поддерживают `themeMode`, `uiSize`, order columns, recent references и `pageSizePreferences` (migration 081). `uiVariant` отсутствует.
- Tabs/dirty state живут независимо от shell в Zustand/sessionStorage и hooks.
- Feature flags могут приходить из Vite env и runtime config; неизвестный/отсутствующий key безопасно получает fallback.

## Тип и границы

```ts
export type UiVariant = 'legacy' | 'evolution';
```

Variant управляет только presentation composition и theme tokens. Он не передаётся в API clients, data hooks, validation, permission helpers, status transitions, accounting/cut calculations или route guards.

## Phase B: реализуемый resolver

```text
runtime uiForceLegacy === true -> legacy
runtime uiEvolution === true   -> evolution
missing/false/invalid/timeout   -> legacy
```

Runtime config завершается до импорта `App`. `src/index.tsx` ставит `document.documentElement.dataset.uiVariant` до динамического импорта `App`. `UiVariantProvider` получает уже финальное значение и не делает асинхронный переход после первого paint. Для UI-флагов отсутствие/ошибка runtime endpoint означает legacy независимо от build-time evolution value; isolated preview поставляет собственный same-origin runtime config.

Это сознательный pilot boundary: user-facing переключатель не показывается, поэтому нет потери dirty data при live switch и нет ложного обещания cross-device persistence.

## Target resolver после backend preference

```text
1. emergency forceLegacy=true       -> legacy
2. authenticated user preference    -> legacy | evolution
3. organization default             -> configured variant
4. per-user local cache             -> cache only while GET is pending
5. safe default                     -> legacy
```

Требования target:

- bootstrap endpoint или auth/session payload должен вернуть resolved variant до shell paint;
- cache key включает user ID and organization ID;
- cache never grants permissions and is replaced by server value;
- PATCH failure restores confirmed value and reports error;
- logout clears active in-memory/cache association, не стирая server preference;
- evolution selector появляется только после полной route/role coverage.

## Минимальный backend contract — blocker для user opt-in

Расширить существующий endpoint, без нового route:

```json
GET /api/v1/me/preferences
{
  "preferences": {
    "themeMode": "light",
    "uiSize": "default",
    "pageSizePreferences": { "refine:orders_view": 20 },
    "uiVariant": "legacy"
  }
}
```

```json
PATCH /api/v1/me/preferences
{ "uiVariant": "evolution" }
```

- Validate enum `legacy|evolution` with Zod.
- Add nullable/defaulted `ui_variant` to `user_preferences`; normalize invalid/missing to organization default or `legacy`.
- Preserve partial PATCH semantics and mixed-deploy compatibility: frontend treats absent `uiVariant` as legacy; older frontend ignores extra response field.
- If organization default is introduced, expose only resolved value to frontend; do not make UI preference authorization.
- Migration number must be chosen against current upstream at implementation time. No migration is included in Phase B.

Affected future files:

- `backend/src/modules/profile/profile-preferences.types.ts`
- `profile-preferences.controller.ts`
- `pg-profile-preferences.repository.ts`
- their tests and a new additive migration
- `src/api/types/profileApi.types.ts`
- `src/theme/ThemeProvider.tsx` or a dedicated preference coordinator

## Provider and registry

- `UiVariantProvider` owns immutable boot variant for Phase B.
- `useUiVariant()` returns value for shell selection and conditional Ant tokens.
- `App.tsx` keeps one route tree and selects only layout component.
- Shell registry dynamically imports both `WorkspaceLayout` and `EvolutionWorkspaceLayout`; выбранный boot variant загружает только свой shell chunk.
- Later screen migrations use a registry keyed by route capability, not duplicate routes. Domain hooks stay above or outside variant views.
- No silent legacy fallback inside an enabled evolution shell after general launch. During staged screen work, coverage matrix explicitly marks shared legacy body under evolution shell.

## CSS isolation

- Legacy CSS remains as-is.
- Every new selector starts under `[data-ui-variant="evolution"]`.
- Evolution Ant tokens are passed conditionally through existing `ConfigProvider`.
- Portals (dropdown/modal/tooltip) inherit Ant tokens; any custom portal selectors include a root/overlay variant class rather than unscoped overrides.
- No target hex values in ten screen files.

## Routing and state safety

- Both variants use identical paths and `NavigateToResource` behavior.
- Deep links resolve before shell composition; entity IDs/query strings are unchanged.
- Same `useTabSync`, `tabStore`, `KeepAliveOutlet`, `useGlobalUnloadGuard` and modal close confirmation.
- Pilot does not live-switch. Future selector must refuse/confirm when `hasAnyDirty(tabs)` or when an operation registry reports export/import/upload/payment in progress.
- After confirmed future switch, retain `location.pathname + search`; remount only presentation shell and rehydrate shared route state where safe.

## Alternatives rejected

| Alternative | Почему не выбран |
|---|---|
| Copy entire app into legacy/evolution trees | Duplicates API/RBAC/validation; parity drift |
| `/legacy/*` and `/evolution/*` routes | Breaks deep links and public route contract |
| Query string/localStorage as final preference | Not cross-device; wrong user leakage risk; URL pollution |
| Global unscoped CSS rewrite | Legacy regression and rollback uncertainty |
| Switch after profile fetch inside mounted App | Wrong-shell flash and possible dirty/remount loss |
| Embed prototype HTML | Static mock data, inaccessible, no business behavior |

## Human decisions required before general rollout

1. Approve backend `uiVariant` preference and organization default policy.
2. Choose roles/organizations for pilot and success metrics.
3. Decide whether live switching is allowed during long-running operations or only after reload.
4. Approve full route/role coverage matrix after Phases C–E.
