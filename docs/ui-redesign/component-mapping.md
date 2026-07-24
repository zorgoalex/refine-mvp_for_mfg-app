# Сопоставление компонентов foundation

## Решение по границе Phase B

Legacy shell и десять page components остаются неизменными. Evolution получает отдельный presentation shell, но использует те же routes, Refine resources, навигационные selectors, permission helpers, open-tab store и `KeepAliveOutlet`. Это даёт обратимость без копирования domain/data слоя.

| Target pattern | Текущая реализация | Решение Phase B | Причина / граница |
|---|---|---|---|
| Semantic tokens | CSS variables в `src/styles/app.css`; часть Ant tokens в `App.tsx` | Расширить: scoped evolution variables + Ant token adapter | Legacy values не менять; hardcoded target palette не разносить по screens |
| Sidebar/grouped navigation | `CustomSider`, `MobileSiderDrawer`, `useSiderMenuItems` | Создать evolution view; переиспользовать selector/permissions/icons | Текущий shell содержит много inline styles; отдельный view безопаснее для rollback |
| Compact icon rail | Ant `Sider` collapse state | Создать в evolution shell | Сохранить 56px rail и tooltips/accessible labels |
| Top service bar | `AppHeader` | Создать evolution view; reuse identity/logout/theme/notification/Kbar behavior | Legacy header не менять; search только как честный “Быстрый переход” к Kbar |
| Global search | `RefineKbar` + `useRefineKbar()` | Расширить существующий command palette trigger | Не обещать поиск сущностей, которого нет |
| Open/recent-page strip | `WorkspaceTabs`, `tabStore`, `useTabSync` | Создать evolution view над тем же store | Dirty marker, close confirmation, deep links и session persistence сохраняются |
| Footer/status bar | `AppFooter` | Переиспользовать с evolution CSS/compact wrapper | Release notes и session metadata остаются доступны |
| Page header | Несогласованные Refine/Ant headings | Создать `EvolutionPageHeader` для последующих фаз | В Phase B не внедрять в 10 screens |
| Primary/secondary/destructive actions | Ant `Button` | Расширить через scoped Ant tokens/CSS; не создавать вторую button API | Существующие semantics и loading/disabled behavior уже надёжны |
| Status badge | `Badge`, `Tag`, page-local colors; `StatusColorPicker/Swatch` | Создать `EvolutionStatusBadge`; reuse normalization/swatch only as secondary cue | `StatusColorSwatch` alone is color-only; readable status text mandatory |
| Quick views/filters | Page-local tabs/forms | Позже расширять per screen | Foundation даёт tokens/classes, но не меняет queries |
| Data table | Ant `Table`, `TableTopScroll`, mobile card views, `usePersistentTable` | Reuse hook; создать scoped visual class/token layer | Preserve profile-backed page-size behavior; не менять columns/sort/filter/pagination |
| Summary metrics | Page-local `Card`/`Statistic` | Создать лёгкий primitive позже при первой list migration | Не плодить неиспользуемые cards сейчас |
| Entity tabs | Ant `Tabs` | Переиспользовать + scoped evolution tokens | Existing horizontal/wrap semantics сохраняются |
| Dialog/drawer | Ant `Modal`/`Drawer`, draggable wrapper | Переиспользовать | Focus trap/return и portal behavior уже библиотечные; order modal не переписывать |
| Form section | Ant `Form`, page-local blocks | Создать `EvolutionFormSection` style contract | Реальные validation/name rules остаются в forms |
| Field validation | Ant `Form.Item` | Расширить theme/CSS | Не создавать параллельную validation abstraction |
| Loading/empty/error/forbidden | `Spin`, `Empty`, `Alert`, page-local branches | Создать `EvolutionStatePanel` | Единый accessible status surface для будущих migrations |
| Unsaved changes | `useTabDirty`, global unload guard, tab close confirm | Переиспользовать без изменений | Единственный источник dirty state; variant switch не экспонировать в pilot |
| Permissions | `navigationPermissions`, `resourceVisibility`, `permissions` | Переиспользовать без изменений | UI variant никогда не участвует в authorization |

## Переиспользовать без изменений

- `src/utils/siderMenuItems.ts`: построение top/categorized menu, route selection.
- `src/utils/navigationPermissions.ts`, `src/utils/resourceVisibility.ts`, `src/utils/permissions.ts`: RBAC и role visibility.
- `src/components/siderResourceIcons.tsx`: semantic resource icons.
- `src/hooks/usePersistentTable.ts`, `src/hooks/usePageSizePreference.ts`: shared pagination and cross-device page-size preference.
- `src/components/StatusColor.tsx`: reuse picker/normalization where status configuration needs it; swatch only beside text.
- `src/stores/tabStore.ts`, `src/hooks/useTabSync.ts`, `src/hooks/useTabDirty.ts`: tab/dirty semantics.
- `src/components/workspace/KeepAliveOutlet.tsx`: mounted state and cache policy.
- `src/components/NotificationBell.tsx`, `src/components/AppFooter.tsx`: service behavior.
- `src/theme/ThemeProvider.tsx`: light/dark and density preference; evolution consumes it.
- All ten page components, API clients, data hooks, validation and status-transition code.

## Расширить

- `src/config/featureFlags.ts`: boot-time `uiEvolution` and higher-priority `uiForceLegacy`, both default false.
- `api/_lib/frontend-runtime-config.ts`: delivery of the same non-secret runtime flag.
- `src/config/runtimeConfig.ts`: validation stays generic; types receive the new feature key through `RuntimeFeatureFlagSource`.
- `src/index.tsx`: resolve variant after runtime config, set root marker before App import/render.
- `src/App.tsx`: consume immutable boot variant, lazy-load exactly one shell and provide scoped Ant tokens.
- `src/styles/app.css`: no legacy value changes; only any truly shared accessibility reset with regression proof.

## Создать

- `src/ui-variant/uiVariant.ts`: `legacy | evolution`, pure resolver, runtime false/failure fail-closed and emergency legacy precedence.
- `src/ui-variant/shellRegistry.ts`: dynamic import registry for both shells; no static legacy shell import.
- `src/ui-variant/UiVariantProvider.tsx`: stable boot-resolved context and root `data-ui-variant` marker.
- `src/ui-evolution/theme/evolutionTheme.ts`: semantic palette → Ant Design token mapping.
- `src/ui-evolution/styles/evolution.css`: all new selectors scoped below `[data-ui-variant="evolution"]`.
- `src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx`.
- `src/ui-evolution/shell/EvolutionSider.tsx` and mobile drawer view.
- `src/ui-evolution/shell/EvolutionHeader.tsx`.
- `src/ui-evolution/shell/EvolutionWorkspaceTabs.tsx`.
- `src/ui-evolution/components/EvolutionStatusBadge.tsx`.
- `src/ui-evolution/components/EvolutionStatePanel.tsx`.
- `src/ui-evolution/components/EvolutionPageHeader.tsx` and style contracts for form/table surfaces.

## Не создавать

- Копии API clients, Refine resources, permission maps, form validation, order draft store, status transitions.
- `/v1` или `/v2` UI routes.
- Mock data, static prototype embedding, screenshot-like pixel canvas.
- Fake autosave, fake global entity search, inferred material colors, client debt/payment metrics without real contracts.

## Design engineering constraints

- Target palette is semantic, not decorative. Status always includes text.
- Radii are concentric: controls inside surfaces use smaller radii than container.
- Shadows remain subtle and reserved for floating/raised surfaces.
- Root font smoothing, balanced headings, pretty body wrapping and tabular numbers remain active.
- No `transition: all`; only transform/color/background/border/shadow properties.
- Interactive targets are at least 40px where layout permits; icon-only controls receive `aria-label` and tooltip.
- `:focus-visible` receives a high-contrast two-ring treatment.
- Motion respects `prefers-reduced-motion`.
