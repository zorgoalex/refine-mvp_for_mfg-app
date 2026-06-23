# Order detail «Раскрой» column — design

Date: 2026-06-23
Branch base: `feat/backend-erp-stage1`
Status: approved (brainstorming)

## Goal

On the order show page (карточка заказа, `/orders/show/:id`), the order-details
table gets a new column **«Раскрой»**. For each detail that belongs to its *last
ready* cut job, the cell shows that job's name as a clickable link. Clicking it
navigates to the cut page opened on that specific job. Details with no ready cut
job show an em dash (`—`).

## Definition: "последнее актуальное задание"

"Last actual cut job" for a detail = the most recent **ready** cut job that
still actively contains the detail:

- `cut_job.status = 'ready'` (calculated). Drafts / calculating / failed /
  archived jobs do NOT qualify. Archiving a job overwrites its status away from
  `ready`, so the column naturally clears when the job is archived — this
  matches the "actual" intent.
- `cut_job_item.is_active = true` (the detail has not been removed from that
  job's layout).
- When a detail is in multiple ready jobs, pick the latest by **`cut_job_id
  DESC`** (creation order). We deliberately do NOT order by `cut_job.updated_at`:
  that column is bumped by non-ready events (PDF prewarm bookkeeping while status
  stays `ready`, profile changes, the ready transition itself), so it reflects
  "last touched" not "became ready last". `cut_job_id` is monotonic at creation
  and never mutated, so the highest-id ready job is the most recently *created*
  ready job. Accepted tradeoff: a job calculated to `ready` out of creation order
  (rare) is ordered by creation, not by ready time — acceptable for an
  informational link.

## Backend

### New read endpoint (no migration)

`GET /api/v1/cut-jobs/detail-last-ready?detailIds=1,2,3`

- Permission: `cut.view` (read-only informational column; consistent with the
  existing `/cut-jobs/placements` and `/cut-jobs/eligible-details` reads).
- Why a new endpoint instead of extending `/cut-jobs/placements`: placements
  returns a flat *union* of jobs across all requested details with no per-detail
  mapping, no ready filter and no recency ordering, and it is already consumed by
  `AddToCutModal`. A new endpoint is additive and carries zero regression risk
  to that contract.
- Response shape (only details that have a qualifying ready job appear):

  ```json
  {
    "details": [
      { "orderDetailId": 12, "cutJobId": 45, "name": "Раскрой 2026-06-23 #45" }
    ]
  }
  ```

- Query: set-based `DISTINCT ON (order_detail_id)` over
  `cut_job_item (is_active = true) JOIN cut_job (status = 'ready')` filtered by
  the requested `detailIds`, ordered by `order_detail_id, cut_job_id DESC`
  (stable creation order; NOT `updated_at`, see definition above). No N+1; uses
  the existing `idx_cut_job_item_order_detail` index (migration 031).
- Empty `detailIds` ⇒ `{ "details": [] }` without touching the DB.
- Read-only ⇒ no audit / outbox writes (consistent with other cut reads). No new
  audit or notification contract is introduced.

### Files

- `backend/src/modules/cut/http/cut.controller.ts` — new route, registered
  before `:cutJobId` to avoid path collision (same pattern as `placements`).
- `backend/src/modules/cut/application/cut.service.ts` — new
  `listDetailLastReady` method, `cut.view` gate.
- cut repository — new set-based query.
- `backend/src/modules/cut/dto/cut.dto.ts` — new response DTO.
- No migration, no permission change (`cut.view` already exists).

## Frontend

- `src/api/cutApi.ts` — `listDetailLastReady(detailIds: number[])` → new
  endpoint; new type `CutDetailLastReadyRef` in `cutApi.types.ts`.
- `src/pages/orders/show.tsx`:
  - New gate `cutColumnEnabled = featureFlags.useBackendCut && can('cut.view')`
    (read gate; distinct from the existing add-to-cut button which uses
    `cut.manage`).
  - After details load, when `cutColumnEnabled` and there is at least one
    `detail_id`, one batched fetch builds `Map<detailId, {cutJobId, name}>`.
  - New column «Раскрой» renders a react-router `<Link to={`/cut?job=${id}`}>`
    with the job name, or `—` when absent. Same-tab navigation.
- `src/pages/cut/CutPage.tsx`: on mount, read the `job` query param; if present,
  call the existing `openJob(jobId)`. Behavior of `openJob`: it calls
  `cutApi.get(id)` then `setJob`; a missing/invalid id throws and is caught by
  `openJob`'s existing `handleError` toast. NOTE (corrected): `getJob`/`loadJob`
  do **not** filter archived jobs, so a deep-link to an *archived* job loads and
  displays it read-only rather than failing. This is benign: the column only ever
  links `ready` jobs, so the normal flow never deep-links an archived job; only a
  stale/hand-edited URL (or a job archived after the page rendered) can, and
  viewing an archived layout read-only is acceptable. No new rejection logic is
  added. No route change — `/cut` already exists.

## Edge cases

- Detail only in draft/calculating/failed/archived jobs ⇒ no ready ⇒ `—`.
- Detail in several ready jobs ⇒ most recent wins.
- Job archived after being ready ⇒ column clears.
- Detail removed from a ready job (`is_active=false`) ⇒ ignored.
- Empty detail list / feature flag off ⇒ no fetch, no column, legacy behavior.

## Tests

- Backend unit + real-DB integration (cut-integration, `CUT_INTEGRATION_DATABASE_URL`):
  per-detail last-ready selection, `is_active` filter, ready-only filter, recency
  tiebreak, `cut.view` gate, empty input.
- Frontend pure-helper tests (Vitest node env): map build, label/link render,
  `?job=` query-param parse → `openJob` trigger; source-text guards.
- Update `tests/order-ui-full-form-coverage.spec.ts` for the new show-page column
  per the mandatory front-change rule.

## Review gate

Codex gpt-5.4 high Aggressive Critic — plan review, then code review. ERP markers
apply; any marker or BLOCKER ⇒ CHANGES_REQUESTED.

## Open decision (resolved)

- Column visibility gate: `cut.view` (read roles incl. worker/viewer can see the
  informational link). Chosen over `cut.manage` because the column is read-only.
</content>
</invoke>
