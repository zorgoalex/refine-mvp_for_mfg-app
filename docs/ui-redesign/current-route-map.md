# Карта текущих маршрутов UI redesign

Дата discovery: 2026-07-21. База после финальной синхронизации перед кодом: `8e6397d2b79f0b8743df70e78c2a03a35f78b4b8` (`origin/feat/backend-erp-stage1`). Визуальный handoff остаётся в `/home/ovhtest/projects/erp_dev/spec_erp/plans/ui-redesign/docs`; branch-local manifest ниже делает каждую ссылку проверяемой.

## Общая архитектура

- Frontend: React 18, React Router 6, Refine 4, Ant Design 5, Vite 4.
- Bootstrap: `src/index.tsx`; runtime config загружается до динамического импорта `App`.
- Маршрутизация и Refine resources: `src/App.tsx`.
- Auth boundary: один `Authenticated` вокруг `WorkspaceLayout`; public routes `/login` и `/auth/workos/callback` находятся снаружи.
- Shared shell: `src/components/workspace/WorkspaceLayout.tsx` → `AppHeader`, `CustomSider`/`MobileSiderDrawer`, `WorkspaceTabs`, `KeepAliveOutlet`, `AppFooter`.
- Navigation/RBAC: `src/utils/siderMenuItems.ts`, `src/utils/navigationPermissions.ts`, `src/utils/resourceVisibility.ts`, `src/utils/permissions.ts`.
- Open pages/dirty state: `src/stores/tabStore.ts`, `src/hooks/useTabSync.ts`, `src/hooks/useTabDirty.ts`, `src/components/workspace/KeepAliveOutlet.tsx`.
- Theme/CSS: `src/theme/ThemeProvider.tsx`, `src/styles/app.css`, `src/styles/mobile.css`; Ant Design token layer is configured in `src/App.tsx`. Profile preferences also persist `pageSizePreferences` through migration 081 and `usePageSizePreference`.
- Shared list foundation: `src/hooks/usePersistentTable.ts` wraps Refine `useTable`, preserves page size across devices and supplies consistent pagination options.
- Existing status-color foundation: `src/components/StatusColor.tsx` provides picker/swatch primitives. `StatusColorSwatch` is color-only and may not replace readable status text.
- Data: shared Refine `dataProvider` for Hasura-compatible reads plus backend-owned services under `src/api/*` where cutover flags are enabled.
- Localization: Refine `i18nProvider`, Ant Design `ru_RU`, existing Russian business labels.
- Tests: Vitest unit/guard tests and Playwright E2E. Repository has no formatter, lint, or frontend typecheck script/config at discovery time.

All ten routes use the same authenticated shell. Navigation visibility is not a route-level authorization boundary: resource visibility is filtered with `canViewNavigationResource` and optional role visibility settings. Большинство business routes имеют только общий authentication gate; page/action checks и backend authority различаются. Новый shell обязан воспроизвести текущее поведение, не трактуя navigation gate как новый route authorization.

## 01. Список заказов

- Route: `/orders`.
- Page: `src/pages/orders/list.tsx::OrderList`.
- Resource: `orders_view`; ID `order_id`.
- Data: shared `usePersistentTable`, Refine `useSelect`, `useMany`, `useList`; `ordersApi`; `findOrderByName`/`countOrdersAfter`; application settings, page-size and order-detail column preferences.
- Permissions/flags: navigation gate `orders.view`; route gate только authentication; create button/action checks `orders.create` в shell, но прямой `/orders/create` не имеет отдельного route guard; backend/data authority остаётся в existing providers/services.
- Main children: `OrderCreateModal`, `GroupFilter`, `AddToCutModal`, `ProductionStagesDisplay`, `OrderCardList`, Ant Design table/filter/form controls.
- Tests: `list.pagination.guard.test.ts`, `list.keepAlive.guard.test.ts`, `mobile/orderListMobile.guard.test.ts`, shared `usePersistentTable.guard.test.ts`/`usePageSizePreference.test.ts`; Playwright `frontend-pages-smoke.spec.ts`, `order-workflows.spec.ts`, `mobile-pages.spec.ts`, `order-trash.spec.ts`, cutover specs.
- Risk: largest list composition; many dependent lookup reads, column preferences, mobile branch, keep-alive state. Phase B must not restyle page internals globally.

## 02. Карточка заказа

- Route: `/orders/show/:id`.
- Page: `src/pages/orders/show.tsx::OrderShow`.
- Resource: `orders_view`.
- Data: Refine `useShow`, `useOne`, `useList`, `useUpdate`; `ordersApi`, `cutApi`, `projectsApi`; export/download helpers; order-detail column preferences.
- Permissions/flags: navigation gate `orders.view`; route gate только authentication; page/action gates include `orders.delete`, `cut.view`/`cut.manage`; backend commands remain authoritative.
- Main children: summary blocks (`OrderShowHeader`, dates, finance, production, files, meta), detail table/grouping, deadline panel, linked groups, cut/Bazis actions, mobile `DetailCardList`, print/export surfaces.
- Tests: `show.detailGrouping.test.ts`, `show.cut.guard.test.ts`, `show.detailColumnWidths.guard.test.ts`, `mobile/orderShowMobile.guard.test.ts`, section/table/labels tests; Playwright `order-workflows.spec.ts`, `order-ui-full-form-coverage.spec.ts`, export and production-action specs.
- Risk: permission-sensitive destructive actions and status transitions; nested cut view; multiple async exports. Shell change must preserve mounted tab state.

## 03. Создание заказа

- Route: `/orders/create`.
- Page: `src/pages/orders/create.tsx::OrderCreate`; primary form `src/pages/orders/components/OrderForm.tsx`.
- Alternate entry: `OrderCreateModal` from desktop/mobile navigation and orders list. Current target explicitly preserves large dialog flow.
- Data: `OrderForm` shares Refine/backend order reads/writes, reference hooks/services, draft store, import helpers and project/cut/label integrations.
- Permissions/flags: navigation create action checks `orders.create`; direct route has authentication only; form/action and backend orders/reference/project/label/cut guards remain unchanged.
- Main children: form tabs/sections, detail table, import dropdown/modals, quick-create modals, finance/payment controls.
- Tests: `OrderForm.cut.guard.test.ts`, import parser/validation tests, detail/finance tests; dirty-tab guard tests; Playwright `order-workflows.spec.ts`, `order-finance-quick-add.spec.ts`, `order-ui-full-form-coverage.spec.ts`.
- Risk: real dirty/draft semantics. Mockup autosave copy conflicts with implementation: no autosave claim may be shown unless the existing behavior proves it.

## 04. Производственный календарь

- Route: `/calendar`.
- Page: `src/pages/calendar/index.tsx::CalendarList`.
- Data: `CalendarBoard` with `useCalendarData`, `useCalendarDays`, `useOrderStatuses`, `useOrderMove`, `useOrderStatusUpdate`, drag/drop hook; production-action backend path when enabled.
- Permissions/flags: navigation gate `orders.view`; route gate authentication only; mutation authority stays in production-action path/version checks/backend.
- Main children: `CalendarBoard`, `DayColumn`/`DayColumnBrief`, `OrderCard`/`OrderCardCompact`, `OrderContextMenu`.
- Tests: hook/layout/status/color/context-menu/CSS tests; Playwright `calendar-frontend.spec.ts`, `mobile-pages.spec.ts`, production-action canaries.
- Risk: existing drag/drop is real and persistence-aware; target instruction “do not introduce DnD” does not mean remove it. Dense responsive CSS is page-owned.

## 05. Список клиентов

- Route: `/clients`.
- Page: `src/pages/clients/list.tsx::ClientList`.
- Resource: `clients`; ID `client_id`.
- Data: shared `usePersistentTable`; report search `findClientByName`/`countClientsAfter`; row highlighting and profile page-size preference.
- Permissions/flags: navigation gate `references.view`; route gate authentication only; Refine action/data/backend authority remains unchanged.
- Main children: Ant Design table/search, `ReferenceSortOrderColumn`, Refine create/show/edit actions.
- Tests: reference workflow/regression and frontend page smoke E2E; shared navigation/permission tests.
- Risk: target asks order/debt signals absent from current list contract. Requires an existing analytics view or backend/report extension in a later phase; no fabricated values.

## 06. Карточка клиента

- Route: `/clients/show/:id`.
- Page: `src/pages/clients/show.tsx::ClientShow`.
- Resource: `clients`.
- Data: Refine `useShow` and `useList` for phones/related records; current record tab-title helper.
- Permissions/flags: navigation gate `references.view`; route gate authentication only; client-phone backend authority applies to phone operations elsewhere.
- Main children: Refine `Show`, descriptions/text/date fields, phone table, reference sort-order presentation.
- Tests: `client-phones-backend-cutover.spec.ts`, `client-phones-stage-canary.spec.ts`, reference workflow/smoke E2E.
- Risk: target active/recent orders, debt, notes and communication history exceed current page data. Later phase must reuse existing reports/CRM link or declare backend contract.

## 07. Платежи

- Route: `/payments`.
- Page: `src/pages/payments/list.tsx::PaymentList`.
- Resource: `payments`; ID `payment_id`.
- Data: shared `usePersistentTable`, Refine `useMany`, `useSelect`; orders/payment-types/users lookups; shared number/date formatting and profile page-size preference.
- Permissions/flags: navigation gate `payments.view`; route gate authentication only; user lookup/action/backend payment authority remains in current helpers/services.
- Main children: filter form, table, `PaymentCardList`, highlight-row behavior.
- Tests: mobile card model unit test; Playwright `payments-backend-cutover.spec.ts`, `payments-stage-canary.spec.ts`, smoke/regression tests.
- Risk: target export and summary are not owned by this component today. Later phase must locate a real export contract; calculations cannot move client-side without parity proof.

## 08. Материалы

- Route: `/materials`.
- Page: `src/pages/materials/list.tsx::MaterialList`.
- Resource: `materials`; ID `material_id`.
- Data: shared `usePersistentTable`, Refine `useMany` for types/vendors/suppliers/units; row highlighting and profile page-size preference.
- Permissions/flags: navigation gate `references.view`; route gate authentication only; sheet-material feature/backend authority is separate from this catalogue.
- Main children: `LocalizedList`, `ReferenceSortOrderColumn`, Ant Design table/badge, Refine show/edit actions.
- Tests: reference workflows/regression and frontend page smoke E2E; shared permission/navigation tests.
- Risk: visual swatches lack a guaranteed source field. Use neutral fallback later; never infer colors from material names.

## 09. Раскрой

- Route: `/cut`, registered only when `featureFlags.useBackendCut` is true.
- Page: `src/pages/cut/CutPage.tsx::CutPage`.
- Resource: `cut-jobs`.
- Data: backend-owned `cutApi`, `cutConfigApi`, `useCutSheetTypeOptions`; local editor/history/geometry helpers.
- Permissions/flags: registration flag `useBackendCut`; route gate authentication only; page gate `cut.view`; action/backend authority `cut.manage` and command validation.
- Main children: criteria/filter form, jobs/items tables, `SheetPreview`, `SheetEditor`, label action, PDF preview/download.
- Tests: extensive geometry/helper/guard tests plus Playwright `cut-frontend.spec.ts`, `cut-manual-layout.spec.ts`, `cut-editor-snap-rotate.spec.ts`.
- Risk: high-state production workflow with concurrency versions and manual-layout history. Phase B may style shell only; no algorithm or table contract change.

## 10. Конфигурация

- Route: `/configuration`.
- Page: `src/pages/configuration/index.tsx::ConfigurationPage`.
- Resource: `configuration`.
- Data: `useAppSettings`; Refine resources/lists; backend services inside VLM, deadline, automation, notification, organization, cut and labels tabs.
- Permissions/flags: navigation category gate `settings.view|settings.manage`; route gate authentication only; only some tabs have explicit `status_automation.*`, `cut.*`, `labels.view` guards. Evolution must preserve these exact gaps, not silently add/remove authorization.
- Main children: horizontal wrapped tabs; settings cards; `ProductionWorkflowTab`, deadline/status/notification/org components, `CutConfigTab`, `LabelsConfigTab`, `VlmConfigTab`.
- Tests: `configurationTabs.guard.test.ts` and component unit/guard tests; Playwright org/notification/deadline/labels/VLM canaries.
- Risk: mixed save semantics across tabs. Target “before/after + deliberate publish” cannot be applied globally without auditing each tab’s existing mutation behavior.

## Handoff conflicts and backend candidates

1. Global search: Refine Kbar infrastructure exists, but current `useRefineKbar()` API only opens existing command navigation. Phase B may expose that command palette; it must not imply full-text entity search.
2. Client list/card enrichment, payment summary/export, and material swatches are later-phase data-contract questions. No Phase B backend change.
3. UI variant persistence: current profile contract stores `themeMode`, `uiSize`, column preferences and recent references, not `uiVariant`. Public user selection across devices needs a minimal backend preference extension; Phase B isolated preview uses boot-time runtime config only.
4. Dark theme remains supported. Evolution palette needs an explicit scoped dark token set rather than forcing light mode.
5. Existing footer/session data is low-value in target shell but remains accessible; evolution may compact it, legacy stays untouched.
