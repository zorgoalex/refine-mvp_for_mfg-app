# Variant coverage matrix

Legend: `L` = legacy shell/body. `E-shell` = evolution shell with unchanged shared page body. `E-view` is a future migrated page view. Roles reflect current `ROLE_PERMISSIONS`; per-user permission arrays and resource-visibility settings may narrow navigation further.

Every Phase B row has `rollout ready = no`: isolated shell review is allowed, general user selector/default is not.

| Route | Role(s) | Navigation gate | Route gate | Page/action/backend authority | Legacy | Evolution | Shared/fallback | Tests/evidence | Rollout ready |
|---|---|---|---|---|---|---|---|---|---|
| `/orders` | superadmin, admin, top_manager, manager, operator | `orders.view`; create shown with `orders.create` | authenticated only | existing list scopes; create/update/export permissions and backend policies | L | E-shell | shared `OrderList` | `navigationPermissions.test.ts`; `frontend-pages-smoke.spec.ts`; new variant parity E2E | no |
| `/orders` | worker, viewer | `orders.view`; no create button | authenticated only | scoped/read-only backend policy | L | E-shell | shared `OrderList` | same + `backend/src/permissions/permissions.test.ts` | no |
| `/orders/show/:id` | superadmin, admin, top_manager, manager | `orders.view` | authenticated only | current financial/cut/delete/action permissions and order scope | L | E-shell | shared `OrderShow` | `show.cut.guard.test.ts`; `order-workflows.spec.ts`; new parity E2E | no |
| `/orders/show/:id` | operator | `orders.view` | authenticated only | no financial permission; current cut/update scope | L | E-shell | shared `OrderShow` | same + permissions tests | no |
| `/orders/show/:id` | worker, viewer | `orders.view` | authenticated only | read/scope plus currently permitted production/cut actions only | L | E-shell | shared `OrderShow` | same + direct deep-link parity | no |
| `/orders/create` | superadmin, admin, top_manager, manager, operator | create entry checks `orders.create` | direct route is authenticated only | form/backend enforce current create/reference rules | L | E-shell | shared `OrderCreate`/`OrderForm` | `OrderForm.cut.guard.test.ts`; `order-ui-full-form-coverage.spec.ts`; direct-link parity | no |
| `/orders/create` | worker, viewer | create entry hidden | direct route still authenticated only | current form/backend denial behavior; shell must not invent a new gate | L | E-shell | shared body if deep-linked | new denied/direct-link parity test | no |
| `/calendar` | superadmin, admin, top_manager, manager, operator, worker, viewer | `orders.view` in current nav (backend role also has `calendar.view`) | authenticated only | existing move/status services and scope/version checks | L | E-shell | shared `CalendarList` | `calendar-frontend.spec.ts`; production-action specs; new nav parity | no |
| `/clients` | superadmin, admin, top_manager, manager, operator, viewer | current nav maps `references.view`; roles also have `clients.view` | authenticated only | Refine/Hasura/backend client authority | L | E-shell | shared `ClientList` | `reference-workflows.spec.ts`; new role parity | no |
| `/clients` | worker | current nav maps `references.view` although role lacks explicit `clients.view` | authenticated only | current data authority decides; known mapping gap preserved/documented | L | E-shell | shared `ClientList` | direct-link/data-denial parity required | no |
| `/clients/show/:id` | superadmin, admin, top_manager, manager, operator, viewer | same as `/clients` | authenticated only | current record/phone read authority | L | E-shell | shared `ClientShow` | client-phone specs; new role parity | no |
| `/clients/show/:id` | worker | same known navigation gap | authenticated only | current data authority decides | L | E-shell | shared `ClientShow` | direct-link/data-denial parity required | no |
| `/payments` | superadmin, admin, top_manager, manager | `payments.view` | authenticated only | payment scopes; create/update permissions; backend/Hasura cutover | L | E-shell | shared `PaymentList` | `payments-backend-cutover.spec.ts`; `payments-stage-canary.spec.ts`; new parity | no |
| `/payments` | operator, worker, viewer | navigation hidden: no `payments.view` | direct route authenticated only | existing data/backend denial behavior | L | E-shell | shared body if deep-linked | denied/direct-link parity required | no |
| `/materials` | superadmin, admin, top_manager, manager, operator, worker, viewer | `references.view` | authenticated only | current Refine/Hasura reference authority; manage actions vary | L | E-shell | shared `MaterialList` | `reference-workflows.spec.ts`; new role/action parity | no |
| `/cut` | superadmin, admin, top_manager, manager, operator | flag `useBackendCut` + `cut.view` | authenticated route registered only when flag on | page `cut.view`; writes `cut.manage`; backend service checks | L | E-shell | shared `CutPage` | `CutPage.guard.test.ts`; `cut-frontend.spec.ts`; new parity | no |
| `/cut` | worker, viewer | flag + `cut.view` | same | read allowed; no `cut.manage`; backend rejects writes | L | E-shell | shared `CutPage` | cut service/permissions tests; mutation denial parity | no |
| `/configuration` | superadmin, admin | settings category visible via `settings.view/manage` | authenticated only | mixed tab-specific guards; backend settings/audit authority | L | E-shell | shared `ConfigurationPage` | `configurationTabs.guard.test.ts`; component guards; new parity | no |
| `/configuration` | top_manager, manager, operator, worker, viewer | navigation hidden: no settings permissions | direct route authenticated only | some tabs lack a shared page gate; current behavior must be captured, not silently changed | L | E-shell | shared body if deep-linked | direct-link/tab/action parity required | no |

## Coverage conclusions

- Same role does not always imply the same effective permissions; test fixtures must carry explicit permission arrays and role-visibility settings.
- Navigation parity is necessary but not authorization proof. E2E compares visible items and direct deep-link behavior; backend tests remain authoritative for data/actions.
- Phase B is an isolated `E-shell` pilot only. Ten internal screen migrations remain Phases C–E.
- Per-user selector is withheld until every target role/route row reaches `E-view` or an explicitly approved shared view and all rows become rollout-ready.
