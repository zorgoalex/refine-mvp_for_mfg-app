# Архитектура UI variant

## Текущее состояние

- `src/index.tsx` ждёт `/runtime-config.json` до импорта `App`, поэтому bootstrap уже имеет безопасную точку выбора shell без flash.
- `src/App.tsx` содержит один набор public/business routes и один authenticated `WorkspaceLayout`.
- Profile preferences (`GET/PATCH /api/v1/me/preferences`) поддерживают
  `themeMode`, `uiSize`, `uiVariant`, order columns, recent references и
  `pageSizePreferences` (migration 084).
- Tabs/dirty state живут независимо от shell в Zustand/sessionStorage и hooks.
- Feature flags могут приходить из Vite env и runtime config; неизвестный/отсутствующий key безопасно получает fallback.

## Тип и границы

```ts
export type UiVariant = 'legacy' | 'evolution';
```

Variant управляет только presentation composition и theme tokens. Он не передаётся в API clients, data hooks, validation, permission helpers, status transitions, accounting/cut calculations или route guards.

## Текущий resolver

```text
runtime forceLegacy === true                 -> legacy
runtime evolutionEnabled !== true            -> legacy
confirmed user preference legacy|evolution   -> selected value
same-user confirmed cache while GET fails    -> cached value
missing/invalid/timeout/user-change           -> legacy
```

Runtime config, session restore и preferences GET завершаются до импорта
`App`. `src/index.tsx` ставит
`document.documentElement.dataset.uiVariant` до динамического импорта `App`.
`UiVariantProvider` получает финальное значение и не делает асинхронный
переход после первого paint.

Password login после подтверждённой аутентификации переходит новым документом
на валидный same-origin `?to=` deep link (иначе `/`), а WorkOS login callback —
на `/`. Это повторно запускает bootstrap уже для известного пользователя;
consumed WorkOS callback URL никогда не перезагружается.

Per-user cache содержит только подтверждённое сервером значение и ключ с user
ID. Он нужен лишь на случай временной ошибки GET, не участвует в разрешениях и
не является источником cross-device persistence.

## Backend contract

Существующий endpoint расширен без нового route:

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

- Zod принимает только `legacy|evolution`.
- Migration 084 добавляет `user_preferences.ui_variant` с default `legacy`,
  `NOT NULL` и check constraint.
- Partial PATCH semantics сохранены.
- Старый backend может ответить 200 без нового поля; frontend считает такой
  ответ неподтверждённым, не пишет cache и не перезагружает shell.

## Provider and registry

- `UiVariantProvider` owns immutable boot variant.
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
- Selector refuses PATCH while any workspace tab is dirty.
- After a confirmed PATCH, `window.location.reload()` retains
  `location.pathname + search` and remounts the presentation shell cleanly.

## Alternatives rejected

| Alternative | Почему не выбран |
|---|---|
| Copy entire app into legacy/evolution trees | Duplicates API/RBAC/validation; parity drift |
| `/legacy/*` and `/evolution/*` routes | Breaks deep links and public route contract |
| Query string/localStorage as final preference | Not cross-device; wrong user leakage risk; URL pollution |
| Global unscoped CSS rewrite | Legacy regression and rollback uncertainty |
| Switch after profile fetch inside mounted App | Wrong-shell flash and possible dirty/remount loss |
| Embed prototype HTML | Static mock data, inaccessible, no business behavior |

## Rollout boundary

- Existing and new users remain on `legacy` by database default.
- `RUNTIME_CONFIG_UI_EVOLUTION=true` only makes evolution selectable.
- `RUNTIME_CONFIG_UI_FORCE_LEGACY=true` immediately overrides all stored
  preferences without deleting them.
- Migration must precede backend; backend and the new resolver must precede the
  availability flag in every environment.
