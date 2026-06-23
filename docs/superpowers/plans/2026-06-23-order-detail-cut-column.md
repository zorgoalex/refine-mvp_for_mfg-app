# Order detail «Раскрой» column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only «Раскрой» column to the order-show details table that links each detail to its last *ready* cut job, navigable via a `/cut?job=:id` deep-link.

**Architecture:** A new `cut.view`-gated backend read endpoint `GET /api/v1/cut-jobs/detail-last-ready` returns, per requested detail, the most recent `status='ready'` cut job that still actively contains it. The order-show page batch-fetches this for its details and renders the job name as a react-router `<Link>`. CutPage reads a `?job=` query param on mount and opens that job. No migration, no permission change.

**Tech Stack:** NestJS + `pg` (backend), Zod, Vitest; React + Refine + Ant Design + react-router-dom (frontend).

## Global Constraints

- Branch base: `feat/backend-erp-stage1`. Branch off it, merge back; never above it.
- Backend is a separate npm package under `backend/`; run backend tests from `backend/` (`cd backend && npm test`). Worktrees must symlink `backend/node_modules`.
- Backend owns the cut command/read API (CLAUDE.md principle 2); RBAC checked server-side. Reads require `cut.view`.
- This endpoint is read-only ⇒ no audit/outbox writes (consistent with `/cut-jobs/placements`, `/cut-jobs/eligible-details`). Do NOT add audit/notification code.
- No migration. Use existing tables `cut_job`, `cut_job_item` and existing index `idx_cut_job_item_order_detail`.
- "Last ready" = `cut_job.status='ready'` AND `cut_job_item.is_active=true`, latest by `cut_job_id DESC` (creation order). Do NOT order by `cut_job.updated_at` — it is bumped by PDF prewarm bookkeeping (`pg-cut-repository.ts:951`), profile changes (`:1181`) and the ready transition (`:514`), so it means "last touched ready job", not "became ready last". `cut_job_id` is monotonic at creation and never mutated.
- Frontend unit tests run under Vitest `environment=node` (no jsdom/testing-library): test pure helpers + source-text guards, not React rendering.
- Money/area/React rendering conventions unchanged; this is additive.
- Review gate: Codex gpt-5.4 high Aggressive Critic — plan review then code review. Any ERP marker / BLOCKER ⇒ CHANGES_REQUESTED.

---

### Task 1: Backend contract — DTO, query type, port method, unavailable stub

**Files:**
- Modify: `backend/src/modules/cut/dto/cut.dto.ts` (append after `CutDetailPlacementsResponseDto`, ~line 147)
- Modify: `backend/src/modules/cut/application/cut-command.types.ts` (add query interface near `DetailPlacementsQuery` ~line 116; add port method to `CutRepositoryPort` ~line 154; add DTO import line 5)
- Modify: `backend/src/modules/cut/adapters/unavailable-cut-repository.ts` (implement the new port method)
- Test: `backend/src/modules/cut/adapters/unavailable-cut-repository.test.ts` (if it exists; else skip — covered by tsc)

**Interfaces:**
- Produces:
  - `CutDetailLastReadyRefDto { orderDetailId: number; cutJobId: number; name: string }`
  - `CutDetailLastReadyResponseDto { details: CutDetailLastReadyRefDto[] }`
  - `DetailLastReadyQuery { currentUser: CurrentUser; detailIds?: number[]; requestId?: string }`
  - `CutRepositoryPort.listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto>`

- [ ] **Step 1: Add DTOs to `cut.dto.ts`**

Append after the `CutDetailPlacementsResponseDto` interface (after line 147):

```typescript

/** One detail's last ready (calculated) cut job. */
export interface CutDetailLastReadyRefDto {
  orderDetailId: number;
  cutJobId: number;
  name: string;
}

/** Per-detail last ready cut job (only details that have one appear). */
export interface CutDetailLastReadyResponseDto {
  details: CutDetailLastReadyRefDto[];
}
```

- [ ] **Step 2: Add the query interface + port method to `cut-command.types.ts`**

Add the DTO to the existing `dto/cut.dto` import block (near line 5, alongside `CutDetailPlacementsResponseDto`):

```typescript
  CutDetailLastReadyResponseDto,
```

Add after `DetailPlacementsQuery` (after line 116):

```typescript

export interface DetailLastReadyQuery {
  currentUser: CurrentUser;
  /** detail ids whose last ready cut job is resolved (one row max per detail) */
  detailIds?: number[];
  requestId?: string;
}
```

Add to `CutRepositoryPort` (after the `listDetailPlacements` line 154):

```typescript
  listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto>;
```

- [ ] **Step 3: Implement the stub in `unavailable-cut-repository.ts`**

Open the file, find how an existing read (e.g. `listDetailPlacements`) throws the unavailable error, and add a matching method. Example (match the file's existing throw helper/pattern exactly):

```typescript
  async listDetailLastReady(): Promise<CutDetailLastReadyResponseDto> {
    throw unavailable();
  }
```

Import `CutDetailLastReadyResponseDto` from the dto module if the file references DTO types directly; otherwise follow the file's existing return-type style.

- [ ] **Step 4: Verify it compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (no missing-method error on `CutRepositoryPort` implementers).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/cut/dto/cut.dto.ts backend/src/modules/cut/application/cut-command.types.ts backend/src/modules/cut/adapters/unavailable-cut-repository.ts
git commit -m "feat(cut): add detail-last-ready port contract + DTOs"
```

---

### Task 2: Backend — pg repository query + integration test

**Files:**
- Modify: `backend/src/modules/cut/adapters/pg-cut-repository.ts` (add method near `listDetailPlacements` ~line 893; import the new DTO/query types)
- Test: `backend/src/modules/cut/adapters/pg-cut-repository.integration.ts` (add a `describe`/`it` block)

**Interfaces:**
- Consumes: `DetailLastReadyQuery`, `CutDetailLastReadyResponseDto` (Task 1)
- Produces: `PgCutRepository.listDetailLastReady` returning one ref per detail that has a ready, active placement.

- [ ] **Step 1: Write the failing integration test**

In `pg-cut-repository.integration.ts`, inside the integration `describe`, add a test that: seeds an order + details, creates two cut jobs containing detail A (one calculated to `ready`, one left `draft`), and asserts `listDetailLastReady` returns the ready job for A and nothing for a detail only in a draft. Reuse the file's existing schema/seed helpers and the stubbed FreecutClient `happyResponse` to drive a job to `ready`. Sketch (adapt names to the file's helpers):

```typescript
it('listDetailLastReady returns the most recent ready job per detail, ignoring drafts', async () => {
  // seed order with detail ids dA, dB using the file's existing seed helper
  // create job1 with [dA], calculate -> ready (status='ready')
  // create job2 with [dA] (draft, NOT calculated)
  const res = await repo.listDetailLastReady({ currentUser: currentUser(), detailIds: [dA, dB] });
  const byDetail = new Map(res.details.map((d) => [d.orderDetailId, d]));
  expect(byDetail.get(dA)?.cutJobId).toBe(readyJobId);
  expect(byDetail.has(dB)).toBe(false);
});
```

Add a second case for `is_active=false`: set dA's item `is_active=false` in the ready job and assert it no longer appears.

Add a THIRD case proving the selector does NOT depend on `updated_at` (covers the BLOCKER): put dA in TWO ready jobs (jobOld with lower id, jobNew with higher id), then bump `jobOld.updated_at` to `now()` so the *older* job is the most-recently-touched:

```typescript
it('listDetailLastReady ignores updated_at noise — picks the latest ready job by id', async () => {
  // jobOld (lower id) and jobNew (higher id) both ready and both contain dA
  await pool.query(
    `UPDATE cut_job SET updated_at = now() WHERE cut_job_id = $1`, [jobOldId],
  ); // jobOld now has the newest updated_at, but jobNew has the higher id
  const res = await repo.listDetailLastReady({ currentUser: currentUser(), detailIds: [dA] });
  expect(res.details.find((d) => d.orderDetailId === dA)?.cutJobId).toBe(jobNewId);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && CUT_INTEGRATION_DATABASE_URL=<throwaway> npm run test:backend:cut-integration`
(Use the project's cut-integration DB URL. The orchestrator supplies it; without a DB the suite skips — in that case verify failure logically and rely on Step 4 real run.)
Expected: FAIL — `listDetailLastReady is not a function` / assertion mismatch.

- [ ] **Step 3: Implement the repository method**

Add to `pg-cut-repository.ts` after `listDetailPlacements` (after line 893):

```typescript
  async listDetailLastReady(query: DetailLastReadyQuery): Promise<CutDetailLastReadyResponseDto> {
    const detailIds = query.detailIds ?? [];
    if (detailIds.length === 0) return { details: [] };
    // One row per detail: the latest READY (calculated) job (by creation order,
    // cut_job_id DESC) that still actively contains it. Archiving overwrites
    // status off 'ready', so archived jobs are naturally excluded. We order by
    // cut_job_id (monotonic, immutable) NOT updated_at, which is bumped by
    // prewarm/profile/ready events and would yield "last touched" not "last
    // ready". Uses idx_cut_job_item_order_detail (migr 031).
    const rows = await this.database.query<{
      order_detail_id: string | number;
      cut_job_id: string | number;
      name: string;
    }>(
      `
      SELECT DISTINCT ON (cji.order_detail_id)
             cji.order_detail_id, cj.cut_job_id, cj.name
      FROM cut_job_item cji
      JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
      WHERE cji.order_detail_id = ANY($1::bigint[])
        AND cji.is_active = true
        AND cj.status = 'ready'
      ORDER BY cji.order_detail_id, cj.cut_job_id DESC
      `,
      [[...detailIds]],
    );
    return {
      details: rows.rows.map((row) => ({
        orderDetailId: toNum(row.order_detail_id),
        cutJobId: toNum(row.cut_job_id),
        name: row.name,
      })),
    };
  }
```

Add `DetailLastReadyQuery` and `CutDetailLastReadyResponseDto` to the existing type imports at the top of `pg-cut-repository.ts` (follow the existing import grouping from `../application/cut-command.types` and `../dto/cut.dto`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && CUT_INTEGRATION_DATABASE_URL=<throwaway> npm run test:backend:cut-integration`
Expected: PASS (the new cases plus existing ones).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/cut/adapters/pg-cut-repository.ts backend/src/modules/cut/adapters/pg-cut-repository.integration.ts
git commit -m "feat(cut): pg listDetailLastReady query + integration test"
```

---

### Task 3: Backend — service method + controller route + unit tests

**Files:**
- Modify: `backend/src/modules/cut/application/cut.service.ts` (add method after `listDetailPlacements` ~line 86; import `DetailLastReadyQuery`)
- Modify: `backend/src/modules/cut/http/cut.controller.ts` (add route after `placements` ~line 103; import `CutDetailLastReadyResponseDto`)
- Test: `backend/src/modules/cut/application/cut.service.test.ts` (gate tests)

**Interfaces:**
- Consumes: `CutService.ports.cut.listDetailLastReady` (Task 2); `requireRead`, `parseCsvIds` (existing in controller).
- Produces: `GET /api/v1/cut-jobs/detail-last-ready?detailIds=1,2,3` → `CutDetailLastReadyResponseDto`.

- [ ] **Step 1: Write the failing service unit tests**

In `cut.service.test.ts`, mirroring the existing `listSheetTypesForCut` gate tests, add:

```typescript
it('denies detail-last-ready read without cut.view', async () => {
  const service = new CutService({ cut: repo() });
  await expect(
    service.listDetailLastReady({ currentUser: user([]), detailIds: [1] }),
  ).rejects.toBeInstanceOf(ApiError);
});

it('allows detail-last-ready read with cut.view and delegates', async () => {
  const listDetailLastReady = vi.fn().mockResolvedValue({ details: [] });
  const service = new CutService({ cut: repo({ listDetailLastReady }) });
  await service.listDetailLastReady({ currentUser: user(['cut.view']), detailIds: [1] });
  expect(listDetailLastReady).toHaveBeenCalledOnce();
});
```

Add `listDetailLastReady` to the `repo()` helper's default stub object (returns `{ details: [] }`) so it satisfies `CutRepositoryPort`.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run src/modules/cut/application/cut.service.test.ts`
Expected: FAIL — `service.listDetailLastReady is not a function`.

- [ ] **Step 3: Implement the service method**

In `cut.service.ts`, add `DetailLastReadyQuery` to the type import block, and add after `listDetailPlacements` (after line 86):

```typescript
  async listDetailLastReady(query: DetailLastReadyQuery) {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.listDetailLastReady(query);
  }
```

- [ ] **Step 4: Add the controller route**

In `cut.controller.ts`, add `CutDetailLastReadyResponseDto` to the dto import block (line 8-13), and add this handler AFTER `detailPlacements` (after line 103), BEFORE the `:cutJobId` routes:

```typescript
  @ApiOperation({
    operationId: 'cutDetailLastReady',
    summary: 'Per-detail last ready (calculated) cut job, for the order-detail Раскрой column',
  })
  @Get('detail-last-ready')
  async detailLastReady(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string>,
  ): Promise<CutDetailLastReadyResponseDto> {
    // Registered BEFORE ':cutJobId' so the literal path is not captured as an id.
    const currentUser = this.requireRead(request);
    return this.cut.listDetailLastReady({
      currentUser,
      detailIds: parseCsvIds(query.detailIds),
      requestId: request.requestId,
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/modules/cut/application/cut.service.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/cut/application/cut.service.ts backend/src/modules/cut/application/cut.service.test.ts backend/src/modules/cut/http/cut.controller.ts
git commit -m "feat(cut): detail-last-ready service gate + controller route"
```

---

### Task 4: Frontend — types, route, cutApi method + helper

**Files:**
- Modify: `src/api/types/cutApi.types.ts` (add types near `CutDetailPlacements` ~line 156)
- Modify: `src/api/apiRoutes.ts` (add `detailLastReady` to `cutJobs` ~line 60)
- Modify: `src/api/cutApi.ts` (add method after `listPlacements` ~line 74)
- Create: `src/pages/orders/cutColumnHelpers.ts`
- Test: `src/pages/orders/cutColumnHelpers.test.ts`

**Interfaces:**
- Produces:
  - `CutDetailLastReadyRef { orderDetailId: number; cutJobId: number; name: string }`
  - `CutDetailLastReadyResponse { details: CutDetailLastReadyRef[] }`
  - `cutApi.listDetailLastReady(detailIds: number[]): Promise<CutDetailLastReadyResponse>`
  - `buildCutJobByDetailId(refs: CutDetailLastReadyRef[]): Map<number, CutDetailLastReadyRef>`
  - `cutJobDeepLink(cutJobId: number): string` → `/cut?job=<id>`

- [ ] **Step 1: Add the frontend types**

In `cutApi.types.ts`, after `CutDetailPlacements` (after line ~156):

```typescript

export interface CutDetailLastReadyRef {
  orderDetailId: number;
  cutJobId: number;
  name: string;
}

export interface CutDetailLastReadyResponse {
  details: CutDetailLastReadyRef[];
}
```

- [ ] **Step 2: Add the route**

In `apiRoutes.ts`, inside `cutJobs` after `placements` (line 58):

```typescript
    detailLastReady: backendApiPath('/cut-jobs/detail-last-ready'),
```

- [ ] **Step 3: Add the cutApi method**

In `cutApi.ts`, import the new types, and add after `listPlacements` (after line 74):

```typescript
  /** Per-detail last ready (calculated) cut job, for the order-detail Раскрой column. */
  async listDetailLastReady(detailIds: number[]): Promise<CutDetailLastReadyResponse> {
    const ids = detailIds.filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return { details: [] };
    const query = new URLSearchParams({ detailIds: ids.join(',') });
    return httpClient.get<CutDetailLastReadyResponse>(
      `${apiRoutes.cutJobs.detailLastReady}?${query.toString()}`,
    );
  },
```

- [ ] **Step 4: Write the failing helper test**

Create `src/pages/orders/cutColumnHelpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildCutJobByDetailId, cutJobDeepLink } from './cutColumnHelpers';

describe('cutColumnHelpers', () => {
  it('buildCutJobByDetailId maps each detail to its ref', () => {
    const map = buildCutJobByDetailId([
      { orderDetailId: 1, cutJobId: 9, name: 'A' },
      { orderDetailId: 2, cutJobId: 9, name: 'A' },
    ]);
    expect(map.get(1)?.cutJobId).toBe(9);
    expect(map.get(2)?.name).toBe('A');
    expect(map.has(3)).toBe(false);
  });

  it('cutJobDeepLink builds the /cut?job= path', () => {
    expect(cutJobDeepLink(45)).toBe('/cut?job=45');
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run src/pages/orders/cutColumnHelpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the helpers**

Create `src/pages/orders/cutColumnHelpers.ts`:

```typescript
import type { CutDetailLastReadyRef } from '../../api/types/cutApi.types';

/** Map detail id → its last ready cut job ref (one ref per detail). */
export function buildCutJobByDetailId(
  refs: CutDetailLastReadyRef[],
): Map<number, CutDetailLastReadyRef> {
  const map = new Map<number, CutDetailLastReadyRef>();
  for (const ref of refs) map.set(ref.orderDetailId, ref);
  return map;
}

/** Deep-link to the cut page opened on a specific job. */
export function cutJobDeepLink(cutJobId: number): string {
  return `/cut?job=${cutJobId}`;
}
```

- [ ] **Step 7: Run tests + typecheck to verify pass**

Run: `npx vitest run src/pages/orders/cutColumnHelpers.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/api/types/cutApi.types.ts src/api/apiRoutes.ts src/api/cutApi.ts src/pages/orders/cutColumnHelpers.ts src/pages/orders/cutColumnHelpers.test.ts
git commit -m "feat(cut): frontend detail-last-ready api + column helpers"
```

---

### Task 5: Frontend — «Раскрой» column on order show page

**Files:**
- Modify: `src/pages/orders/show.tsx` (add gate + fetch effect near line 258; add column in the details table columns array, between «Пр-е» note and pricing columns ~line 904)
- Test: `tests/cut-frontend.spec.ts` or a source-text guard test — add an assertion that the column + deep-link exists (mocked).

**Interfaces:**
- Consumes: `cutApi.listDetailLastReady`, `buildCutJobByDetailId`, `cutJobDeepLink` (Task 4); existing `can`, `featureFlags`, `Link`, `details`.
- Produces: a «Раскрой» column rendering `<Link to={cutJobDeepLink(id)}>name</Link>` or `—`.

- [ ] **Step 1: Add the read gate + batched fetch in `show.tsx`**

Near the existing cut state (after line 261), add:

```typescript
  // Read-only «Раскрой» column gate (cut.view; distinct from the cut.manage
  // add-to-cut button gate above). Off ⇒ no fetch, no column (legacy behavior).
  const cutColumnEnabled = featureFlags.useBackendCut && can('cut.view');
  const [cutJobByDetailId, setCutJobByDetailId] = useState<Map<number, CutDetailLastReadyRef>>(
    () => new Map(),
  );

  // Stable positive detail ids + a primitive key so the fetch effect does NOT
  // re-run on every rerender just because `details` is a fresh array identity
  // (it is derived inline each render from backendOrder?.details or a sorted
  // query array). Keying on the joined id string makes the fetch fire only when
  // the actual set of detail ids changes.
  const cutDetailIds = useMemo(
    () =>
      details
        .map((d: any) => d?.detail_id)
        .filter((id: unknown): id is number => Number.isInteger(id) && (id as number) > 0),
    [details],
  );
  const cutDetailIdsKey = cutDetailIds.join(',');

  useEffect(() => {
    if (!cutColumnEnabled || cutDetailIds.length === 0) {
      setCutJobByDetailId(new Map());
      return;
    }
    let cancelled = false;
    cutApi
      .listDetailLastReady(cutDetailIds)
      .then((res) => {
        if (!cancelled) setCutJobByDetailId(buildCutJobByDetailId(res.details));
      })
      .catch(() => {
        if (!cancelled) setCutJobByDetailId(new Map());
      });
    return () => {
      cancelled = true;
    };
    // cutDetailIdsKey is the primitive identity of cutDetailIds; intentionally
    // depend on it instead of the array to avoid redundant fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutColumnEnabled, cutDetailIdsKey]);
```

Add the imports at the top of `show.tsx`:

```typescript
import { cutApi } from "../../api/cutApi";
import type { CutDetailLastReadyRef } from "../../api/types/cutApi.types";
import { buildCutJobByDetailId, cutJobDeepLink } from "./cutColumnHelpers";
```

(`Link`, `useState`, `useEffect`, `featureFlags`, `can` are already imported.)

- [ ] **Step 2: Add the column to the details table**

In the details `<Table>` columns array, insert after the «Пр-е» (note) column object (~line 913), only when enabled. The simplest stable approach: build the columns array as a variable and conditionally push, OR inline-guard the render. Inline render approach — add this column object:

```typescript
  ...(cutColumnEnabled
    ? [
        {
          title: 'Раскрой',
          key: 'cut_job',
          width: 150,
          render: (_: unknown, record: any) => {
            const ref = cutJobByDetailId.get(record.detail_id);
            if (!ref) return '—';
            return <Link to={cutJobDeepLink(ref.cutJobId)}>{ref.name}</Link>;
          },
        },
      ]
    : []),
```

If the columns array is a literal passed directly to `columns={[...]}`, spread the conditional array element inside it at the chosen position. Keep one render path; do not duplicate the column.

- [ ] **Step 3: Add a guard/assertion test**

In `tests/cut-frontend.spec.ts` (mocked Playwright) or a source-text guard under `tests/`, assert the show page exposes the column. If using a source-text guard, add to an existing frontend guard test:

```typescript
const showSrc = readFileSync('src/pages/orders/show.tsx', 'utf8');
expect(showSrc).toContain("title: 'Раскрой'");
expect(showSrc).toContain('cutJobDeepLink');
expect(showSrc).toContain("can('cut.view')");
```

(Place it where the repo keeps such source guards; if none exists for show.tsx, add a minimal `tests/cut-detail-column.guard.test.ts` Vitest file.)

- [ ] **Step 4: Run frontend unit tests + build**

Run: `npx vitest run src/pages/orders/cutColumnHelpers.test.ts tests/cut-detail-column.guard.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Update the mandatory full-coverage spec note**

Per the project rule, large order-UI changes must update `tests/order-ui-full-form-coverage.spec.ts`. Add an assertion that, when on the order show page with cut enabled, the details table header contains «Раскрой». Because the column only renders against a deployed backend with the new endpoint, gate the assertion behind the existing cut-enabled condition in that spec and add a comment that a live run is deferred to activation (backend rebuild + Vercel redeploy). Document this deferral in the PR/commit message.

- [ ] **Step 6: Commit**

```bash
git add src/pages/orders/show.tsx tests/
git commit -m "feat(cut): Раскрой column on order show page with deep-link"
```

---

### Task 6: Frontend — CutPage `?job=` deep-link

**Files:**
- Modify: `src/pages/cut/CutPage.tsx` (add a one-shot mount effect after the `loadJobs` mount effect ~line 216; import `useSearchParams`)
- Modify: `src/pages/cut/cutPageHelpers.ts` (add `parseJobQueryParam`)
- Test: `src/pages/cut/cutPageHelpers.test.ts` (add cases) — check the file exists; if not, create it.

**Interfaces:**
- Consumes: existing `openJob` (CutPage), `can('cut.view')`.
- Produces: `parseJobQueryParam(search: string): number | null`; CutPage auto-opens the job from `?job=` once on mount.

- [ ] **Step 1: Write the failing helper test**

In `src/pages/cut/cutPageHelpers.test.ts` (create if missing, mirroring `cutColumnHelpers.test.ts` imports):

```typescript
import { parseJobQueryParam } from './cutPageHelpers';

describe('parseJobQueryParam', () => {
  it('parses a positive integer job id', () => {
    expect(parseJobQueryParam('?job=45')).toBe(45);
  });
  it('returns null for missing/invalid', () => {
    expect(parseJobQueryParam('')).toBeNull();
    expect(parseJobQueryParam('?job=abc')).toBeNull();
    expect(parseJobQueryParam('?job=-3')).toBeNull();
    expect(parseJobQueryParam('?foo=1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/cut/cutPageHelpers.test.ts`
Expected: FAIL — `parseJobQueryParam` not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/pages/cut/cutPageHelpers.ts`:

```typescript
/** Parse a `?job=<id>` deep-link param into a positive cut job id, or null. */
export function parseJobQueryParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('job');
  if (raw === null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/pages/cut/cutPageHelpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the deep-link effect in `CutPage.tsx`**

Add to imports:

```typescript
import { useSearchParams } from 'react-router-dom';
```

Add `parseJobQueryParam` to the existing `./cutPageHelpers` import list. Inside the component (after the mount `loadJobs` effect, ~line 216), add a one-shot auto-open:

```typescript
  // Deep-link: /cut?job=<id> opens that job once on mount (e.g. from the order
  // show page «Раскрой» column). Guarded so it fires a single time per mount.
  // openJob(id) loads ANY existing job by id (getJob/loadJob do not filter
  // archived) and shows it read-only; a missing/invalid id throws and is caught
  // by openJob's handleError toast. The column only links ready jobs, so the
  // normal flow never deep-links archived — only a stale/hand-edited URL can,
  // and viewing an archived layout read-only is acceptable (no rejection added).
  const [searchParams] = useSearchParams();
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!can('cut.view')) return;
    const jobId = parseJobQueryParam(`?${searchParams.toString()}`);
    if (jobId === null) return;
    deepLinkHandledRef.current = true;
    void openJob(jobId);
  }, [searchParams, openJob]);
```

(`useRef`, `useEffect`, `can` are already imported. `openJob` is defined above this point.)

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/pages/cut/cutPageHelpers.test.ts && npm run build`
Expected: PASS, build clean.

- [ ] **Step 7: Commit**

```bash
git add src/pages/cut/CutPage.tsx src/pages/cut/cutPageHelpers.ts src/pages/cut/cutPageHelpers.test.ts
git commit -m "feat(cut): CutPage ?job= deep-link auto-open"
```

---

### Task 7: Full gate run + review

**Files:** none (verification only)

- [ ] **Step 1: Backend full suite + typecheck**

Run: `cd backend && npm test && npx tsc --noEmit`
Expected: PASS (note any pre-existing audit-redaction-coverage cwd-sensitivity per memory; run that guard with `cd backend`).

- [ ] **Step 2: Backend cut integration**

Run: `cd backend && CUT_INTEGRATION_DATABASE_URL=<throwaway> npm run test:backend:cut-integration`
Expected: PASS.

- [ ] **Step 3: Frontend unit + build**

Run: `npm test && npm run build`
Expected: PASS, build clean.

- [ ] **Step 4: Codex Aggressive Critic code review**

Assemble a review packet in `spec_erp/reviews/` (branch diff, this plan, ERP invariants, gates run) and run Codex gpt-5.4 high. Resolve any marker / BLOCKER and re-review until APPROVED.

- [ ] **Step 5: Merge to `feat/backend-erp-stage1`**

Fast-forward/merge the feature branch back into `feat/backend-erp-stage1` only after gates + Critic APPROVED. Record activation steps (backend rebuild on erp_test + Vercel redeploy) in CONTEXT.md.

---

## Self-Review

**Spec coverage:**
- Last-ready definition (ready + is_active + recency) → Task 2 SQL + tests. ✓
- New `cut.view` endpoint → Task 3. ✓
- No migration / reuse index → Global Constraints + Task 2 comment. ✓
- No audit/outbox (read) → Global Constraints; no audit code in any task. ✓
- Frontend column + deep-link label = job name → Task 5. ✓
- `/cut?job=:id` navigation → Task 6. ✓
- Edge cases (draft-only, multi-ready, archived, removed, empty, flag off) → Task 2 tests + Task 5 gate. ✓
- Tests (backend unit+integration, frontend helpers, full-coverage note) → Tasks 2,3,4,6 + Task 5 step 5. ✓
- Review gate → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows code. The full-coverage live run is explicitly deferred to activation (documented), not a placeholder.

**Type consistency:** `CutDetailLastReadyRef(Dto)` / `CutDetailLastReadyResponse(Dto)` / `DetailLastReadyQuery` / `listDetailLastReady` / `buildCutJobByDetailId` / `cutJobDeepLink` / `parseJobQueryParam` used identically across tasks. Backend DTO suffix `Dto`, frontend without — matches existing convention (`CutDetailPlacementsResponseDto` vs `CutDetailPlacements`). ✓
</content>
