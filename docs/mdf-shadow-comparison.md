# MDF shadow comparison

The optional backend observer compares the existing server return-preview source
model with an independent candidate calculation. It does **not** change the
board, orders, details, manual moves, accepted evidence, allocations, or jobs.

Enable `BACKEND_MDF_SHADOW_INTAKE=true` and
`BACKEND_MDF_SHADOW_COMPARE=true` after migrations 165–167, 169 and 171. Both default
to false. The engine must remain `legacy` or `shadow`. Disable the comparison
flag to stop polling; an already-running bounded diagnostic transaction may
finish. This does not disable existing business logic.

One committed intake observation is examined per 60-second tick. The observer
uses a global nonblocking lock and a repeatable-read transaction. Limits:
100 connected owners, 250 sources, 5,000 composition rows, 1,000 explicit commands,
10,000 frozen command lines, 15 seconds of snapshot
work, 5 seconds per SQL statement. Hidden and older connected sources participate;
the legacy readiness window is two calendar months. Exceeded limits produce a
blocked report, not truncated success. Transient failures retry with backoff;
after three attempts they produce a blocked report. Other observations can proceed.

## Reading results

Authorized operators can inspect diagnostic tables with SQL; no new public API
or Hasura write access is provided:

```sql
SELECT c.created_at, c.source_kind, c.source_id, c.status, c.duration_ms,
       c.algorithm_version,
       c.report->'differenceCount' AS raw_differences,
       c.report->'comparableDifferenceCount' AS comparable_differences,
       c.report->'unverifiedDifferenceCount' AS unverified_differences,
       r.actor_user_id, r.request_id,
       c.report->'issues' AS issues,
       c.report->'columns' AS columns,
       c.report->'positions' AS positions
FROM mdf_shadow_comparisons c
JOIN mdf_evidence_revisions r USING (source_kind, source_id, revision_key)
ORDER BY c.created_at DESC LIMIT 50;

SELECT source_kind, source_id, attempts, next_attempt_at, error_code
FROM mdf_shadow_comparison_attempts ORDER BY next_attempt_at LIMIT 50;
```

Reports are immutable and keyed by observation plus algorithm version. They
compare **current state at the recorded snapshot**, not the state at the earlier
event. `triggerSuperseded` records a changed source digest. This is explicitly
`surface=legacy-server-return-model`, not browser filter/visibility parity or a
simulation of all auto-status rule actions.

Version `source-scope-v3` uses the pure `resolveMdfSourceColumn` resolver for all
three source kinds. Its inputs are complete **own** composition/statuses, cut
confirmation, manual visual target and allocation readiness (ready/not-ready/
unknown). Discovery, material/identity matching and allocation remain separate
responsibilities. No date, visibility filter or order-header status enters this
resolver. It is connected to shadow only; legacy production readers/handlers
have **not** been switched to it.

- CNC: cut confirmation (including visual manual completion) plus all own
  details at least packed, or all own details at least issued, means terminal.
- BASIS: all own details at least packed means terminal without a CNC signal.
- Bath: all own details at least packed means terminal; all at least laminated
  means laminated, without an additional preliminary cut-readiness gate.
  Otherwise automatic readiness requires the allocation planner's decision.
- Manual visual placement is preserved below automatic terminal priority. It
  does not create physical supply. Actual backwards correction is a separate
  command that must change the underlying facts/statuses.
- Empty/incomplete composition, missing relevant thresholds and invalid
  source-kind/manual-column combinations fail closed.

`columns` contains old/candidate placement, calculation `reason`, `comparable`
and issues preventing comparison.
`positions` and `orders` contain position-local cut-not-rolled, rolled, credited
quantities and remaining demand for known live MDF positions. The independent
legacy arithmetic is checked against the frontend formula. Candidate physical
quantities use strictly linked raw CNC completion and validated explicit command
proofs described below; manual/BASIS facts without immutable provenance and unfrozen whole-order declarations are reported
as gaps, not accepted manufacturing evidence. Candidate raw rework remains in
statistics but grants no normal-demand credit.

Candidate quantity semantics are `observed-cnc-and-audited-command-proofs`. A zero
is zero **observed evidence**, not proof that no work occurred. Each position and
order has `comparable` and `issues`; manual/BASIS provenance, historical
lamination, different historical scope and rework-statistics semantics prevent
quantity comparison. Unresolved or unfrozen membership conservatively blocks
all quantities in the connected scope, not just its resolved subset. An order
is comparable only when every one of its positions is comparable. Comparability
is local to these diagnostic projections, never verification of the baseline.

Old/hidden bath consumption and accepted allocations without verified baseline
mapping block allocation comparison. A manual ready column does not create
physical cut supply. Unknown manual/BASIS supply (including automatic terminal
BASIS placement from packed/issued statuses outside the visible window) also
blocks an apparently definitive not-ready result for baths. Allocation output, when possible, is a
proposal only.

From v2, `differenceCount` retains all raw differing columns/positions;
`comparableDifferenceCount` counts only comparable differing rows, and
`unverifiedDifferenceCount` counts the rest. The two sum to `differenceCount`.
Multiple differing fields in one position count as one row, not several defects.
`differences` means at least one **comparable** diagnostic row differs; it still
does not prove a business bug. `blocked` can have a nonzero raw difference count
when every difference is unverified. It also covers equality and limits/missing
inputs. Version v1 reports retain their original semantics and are never
overwritten; a new version may compare the same observation's current state.
There is deliberately no `match`
status, and `cutoverReady` is always false: baseline and producer migration are
not complete. These reports cannot authorize active cutover.

Tests: backend `src/modules/mdf-board`, real PostgreSQL tests opt in through
`MDF_ENGINE_INTEGRATION=1`; frontend parity in
`src/pages/orderStatusBoard/model.test.ts`. Run heavy checks through the project
resource guard and with one Vitest worker.

## Explicit command journal

With intake enabled, manual production-card PUT, DELETE and confirmed production
return also append to `mdf_shadow_commands`. Orders are not part of this producer
increment. The source's normalized own membership is captured at the command
point, before forward automation; each explicit command survives a later generic
dispatch for the same card. Production-return preview and idempotent replay do
not append. Feature off performs no extra source reads or hook registration.

```sql
SELECT c.observation_id, c.source_kind, c.source_id, c.command_kind,
       c.target_column, c.target_stage_id, c.target_stage_code, c.preview_digest,
       c.audit_event_id, c.composition_digest, r.actor_user_id, r.request_id
FROM mdf_shadow_commands c
JOIN mdf_evidence_revisions r USING (source_kind, source_id, revision_key)
ORDER BY c.observation_id DESC LIMIT 50;
```

`manual_move` records user intent, `manual_clear` only removes visual placement,
and `production_return` records an explicit correction with the actual selected
stage and preview digest. Clearing a visual override does not delete an earlier
journal entry. Source-local append order is `observation_id`; it is not a global
production chronology or an active-mode correction fence. Audit UUID deliberately
has no retention-coupled foreign key. Command, existing audit, receipt, frozen
membership and journal commit or roll back together. Reused causes with changed
immutable metadata conflict. Intake verifies the persisted audit's event, entity,
actor, request and target, plus actual return stage ID and preview digest; absent
or mismatched audit rolls back the transaction. Receipt lines are **derived membership only**, not
physical work; ready baths never manufacture anonymous cut supply.

The composition digest ignores timestamps, visual columns and completion flags;
it includes row identity, quantities, relevant-material eligibility, rework and
resolution/whole-order flags. It is not a dimensions/material-version receipt.
The separately bound receipt digest includes command/audit/actor/request/cause
metadata and the raw command-point snapshot. Comparison observations retain the
raw-row digest so `triggerSuperseded` remains a like-for-like check.

Comparator **v3 consumes the journal for diagnostic projection only**; receipts
remain unaccepted. `proofs` reports per-source cut/lamination flags, contributing
command revisions, command count and blocking issues. It validates the sealed
manual receipt, actual audit (actor/request/entity/target, return stage/digest),
observation, composition digest and exact frozen membership. Missing/expired audit
is unknown provenance. Only `EXPLICIT_COMMAND_UNVERIFIED` is retired locally;
`SHADOW_ONLY`/`INCOMPLETE_PRODUCER_COVERAGE` remain report-level limitations, and
other observation issues block proof. Legacy v1/v2 reports remain immutable.

- Explicit CNC/BASIS move to `completed` confirms its own cut portion; explicit
  bath move to `baths_laminated` confirms its own laminated portion. Terminal
  archive placement alone is not a physical confirmation.
- Same-source reconfirmation replaces proof, never adds another shipment. Raw
  CNC and manual confirmation of the same source count once. Independent CNC
  and BASIS portions add; normal readiness remains capped per order position.
- `manual_clear` removes visual placement only; recorded work survives.
- Confirmed return to `parsed` revokes that source's cut proof. Return to
  `completed` preserves earlier cut. Bath return to `baths`/`baths_ready` revokes
  lamination, while `baths_laminated` preserves earlier lamination. Return never
  creates missing physical proof and never revokes independent sources.
  These are the owning command's validated stage bands, including custom stages;
  a later catalogue edit does not reinterpret the historical return.
- Current effective raw CNC confirmation remains authoritative, subject to the
  existing completion-returned barrier. This is not replay of CNC event history.
- Any observed command composition differing from current composition blocks
  that source, including changes back to a formerly observed composition. New
  quantity cannot inherit old manual proof. Frozen journal members participate
  in ownership discovery even after current membership is removed/reassigned.
  Timestamp/visual changes alone do not change the composition digest.
- Known bath lamination can contribute observed quantities, but historical
  consumption still blocks allocation until reservation baseline is verified.
  Bath readiness never manufactures cut supply.

Reports always set `cutoverReady=false`. Unknown history and unobserved lifecycle
changes remain baseline/producer gaps. Do not treat journal presence as proof
that quantities have been accepted, allocations exist, or historical evidence is
complete. Acceptance, composition/demand preflight and remaining producer
migration are required before activating the new engine. Disable intake
to stop new entries without removing history; rollback of the backend leaves the
additive diagnostic table intact.

## Live command rule bridge

`BACKEND_MDF_PINNED_DISPATCH=true` connects all five existing MDF command events
to the shared pinned rule executor. It requires `BACKEND_STATUS_AUTOMATION=true`.
The new flag defaults to **false**, including Compose; enable per environment.
It does not enable disabled rules in the Auto statuses settings.

The server still resolves card membership and current readiness. Before status
writes, it resolves affected baths in their own context. At the first MDF
dispatch in a transaction, it snapshots the enabled MDF and downstream production
composition rule IDs/versions. Later source dispatches reuse that selection;
new rules take effect only in the next transaction. Exact versions are locked and
checked before execution; missing/disabled/edited rules are skipped, not replaced.
Both direct and nested rule audits carry `executionMode=live_command`.

The bridge preserves transaction-wide recursion guards, own-detail-only and
advance-only updates, full-position coverage, uniform order composition,
HDF exclusion, existing audit/outbox and shadow observation. It does not run
the legacy and pinned action paths together. The authoritative CNC AutoCut path
is unchanged. Disable the new flag to return to the old synchronous dispatch.

This is **not** the accepted-evidence accounting cutover: current resolver output
does not become verified physical evidence. Quantity formulas, allocation,
asynchronous queue, engine mode and historical baseline remain unchanged. Failed
commands still roll back as a whole; no durable receipt-survival guarantee is
introduced by this bridge.

## Accepted-evidence allocation port (not enabled)

### Pinned automation execution port (not enabled)

`executePinnedMdfAutomation(tx, input)` executes server-resolved MDF events using
only the supplied durable rule pins. It is an internal transaction primitive,
not a job handler, public command, scheduler or evidence acceptance operation.
No production caller is registered for this accepted-job port. The opt-in live
bridge above shares its private action engine, but not its evidence contract;
deploying either does not switch the accounting engine.

The owning handler must first verify active mode under the cutover lock, claim
the durable job, load its original pins/actor, authorize scope, lock owners and
sources in order, and resolve events from accepted evidence against fenced demand.
Never pass request-body events or promote shadow receipts to accepted facts.
Source IDs use the board format: packet UUID, decimal BASIS ID, `cut-result:<id>`
for baths. Full batch syntax and consistent position ownership/demand are checked
before effects, but syntax checks do not prove physical work.

Rule rows are locked in ID order through transaction end. Only enabled rules
whose versions still match the pins execute, in priority/ID order. Missing,
disabled and edited pins produce `status_automation.rule_skipped` audit entries
with expected/current version, actor, request and normalized order links. Newly
created or enabled rules are never substituted. Pins must include intended
downstream composition rules: an absent downstream pin executes nothing, even
when a matching current rule exists.

The same pinned set covers nested detail-to-order evaluation. MDF actions remain
own-detail-only and advance-only; partial position quantities do not advance.
Full order composition still governs order changes, excluding HDF. Existing
business action audit and idempotent outbox are reused. Legacy MDF re-resolution,
manual refresh and nested pinned executions are forbidden inside the boundary.
The owning transaction/savepoint rolls back effects on failure; per-execution
in-memory recursion guards are restored even after errors, allowing safe retry.

`status=evaluated` is not job completion or publication; `disabled` means the
automation flag prevented evaluation. This port neither accepts receipts nor
changes heads, reservations, engine mode or board revisions. Frozen demand/event
context, producer integration, acceptance, coherent publication and verified
historical baseline remain prerequisites for an active worker.

### Allocation execution

`executeMdfAllocation(tx, jobId)` is an internal transactional accounting port,
not a complete job handler, HTTP endpoint or registered scheduler. The shadow
observer never calls it. Its existence does not make `active` safe to enable.

The port requires a pending durable job, active engine mode and READ COMMITTED
transaction. Actor/request come from the stored job. It discovers the connected
owners through received/accepted membership and historical unreleased allocations,
locks owners before source heads, and checks the closure again after waiting.
Limits are 100 owners, 250 sources and 5,000 evidence/allocation rows (accepted and
received revisions combined). Limits, invalid identities, structural corruption
or a changed locked closure stop the transaction. Unverified accounting data is
quarantined locally as described below, not a component-wide processing failure.
All future acceptance commands must use the same owner-before-source lock order.

Only accepted physical, non-rework CNC/BASIS cut evidence is reservable. Independent
portions add; each reservation references an exact immutable evidence line. Baths
are considered oldest first by original result creation time, and only complete
sets reserve new stock. Existing reservations win over newly discovered older
baths. Hidden/absent consumers do not free stock; an explicit correction must
release or replace allocations. Full matching accepted physical lamination can
change reservations to consumed. Rework baths require a separate supply policy
and are not handled by this normal-stock port.

Reservation and consumption emit `mdf_board.bath_supply_reserved` and
`mdf_board.bath_supply_consumed` audit events with source, actor, request and
normalized order/detail links. Repeating the same accounting step creates no
duplicate reservations or audits. Failures roll back with the caller transaction.
The owning job must still execute pinned rules, publish a coherent board revision,
write its transition outbox and mark the job complete. None of those operations,
nor acceptance/backfill, are performed by this port.

### Dependency-local quarantine

The port returns `quarantine` reasons with source kind/id, `positionKeys` and an
explicit widened `orderIds` boundary when membership is unknown. It also returns
`blockedPositionKeys`. These describe accounting uncertainty, not card visibility.
`status=allocated` means the safe accounting pass ran; it does not mean every
source is verified. The future owning handler must retain these reasons for
explanation and reprocessing, not mark the whole component successfully resolved.

- Pending/invalid CNC or BASIS evidence is excluded source-by-source. Confirmed
  independent supply remains usable even for the same order position.
- Existing allocations referencing excluded/invalid supply block the affected
  position balance. They are never deleted, freed or reassigned.
- An unverified bath blocks its possible consumption positions from accepted and
  received revisions plus historical allocations. Missing revision membership
  widens the boundary to known owners; if none can be bounded, the full locked
  owner scope is explicitly quarantined.
- Missing bath metadata, unsupported rework consumption, changed allocated bath
  composition and unaccounted lamination are local blockers. Disjoint verified
  positions in the same order can still progress.
- A bath touching a blocked position cannot reserve a partial set or consume any
  reservations. Its existing reservations on OTHER positions still debit stock.
  Only final-ready baths with complete accepted lamination can consume.
- Tentative plans are recalculated monotonically after new blockers; no tentative
  reservation is persisted. Replay does not add reservations or duplicate audit.

This policy is implemented in the dormant allocation port only. The diagnostic
shadow comparator above retains its own conservative comparability rules; the
live legacy handlers and UI are unchanged. Historical sources absent from the
receipt graph still require baseline discovery. Neither quarantine nor these
tests permit activation before producer coverage, baseline and cutover are ready.

### Accepted-job execution and compact reader (disabled by default)

Migration `174_mdf_execution_context.sql` adds sealed command-time context and
owning MDF demand, plus compact source/member/position publication tables. It does
not activate the engine or backfill historical evidence. Apply after migrations
165 and 166; existing applied migrations must not be rewritten.

`executeMdfAcceptedJob` combines strict allocation, pinned scoped rules and
publication in the durable job transaction. Failures roll back effects while
retaining the receipt for retry. Compatible forward revisions retain exact stock
allocations; changed composition, quantities or missing proof require correction.

`BACKEND_MDF_JOB_WORKER=false` controls the registered scheduler independently of
notifications. It processes at most ten jobs sequentially per tick; active engine
mode is a second mandatory gate. `BACKEND_MDF_PUBLISHED_READS=false` controls
`GET /api/v1/orders/status-board/mdf`. Disabled reads return 503. Enabled reads
use an authorized, read-only repeatable-read snapshot and do not enqueue work.
The two-calendar-month period filters visibility, not accepted accounting history;
an exact source focus can retrieve older cards. Unaccepted cards retain visibility
with issues but provide no unverified production credit.

Keep both flags false until live producers, corrections, frontend, verified
historical baseline and the cutover procedure are connected and checked together.
The current shadow producer does not supply execution context. Setting the engine
to active directly is not a supported activation procedure.

### Manual commands through the queue (activation still gated)

Migration `175_mdf_command_placement.sql` adds sealed manual placement and an
immutable actor-scoped command-result journal. Production-card PUT/DELETE can
route to accepted accounting in active mode; legacy/shadow keep the existing
command path. This does not complete producer/return/UI/baseline coverage or
authorize enabling the engine.

Active clients send `X-Mdf-Source-Token` from `cards[].commandToken` and a unique
`Idempotency-Key`. Reuse both for an identical network retry. Token is null while
the card is unverified or its head is newer than the publication. A 409 requires
refresh/reconciliation, not a blind retry with changed parameters. Authorization
is checked for every owning order, including on a saved-response replay.

- `completed` for a file/BASIS records only the missing own cut quantity.
- `baths_laminated` records only the missing own lamination quantity.
- Terminal visual placement creates no physical proof; DELETE removes only
  manual placement and preserves confirmed work.
- Backward movement requires the separate production-correction workflow.
  Unsupported history is never implicitly accepted from its old visual column.
- Response `jobId` means durable queued work, not finished status changes.
  Audit, receipt, rule pins and replay response commit or roll back together.

Tagged command transactions acquire the shared cutover fence before business
effects and explicitly use READ COMMITTED. Stricter isolation is rejected before
starting: an advisory-lock wait under a repeatable snapshot could otherwise read
the pre-cutover mode. This boundary must cover the remaining writers before any
activation. Ordinary unsupported writers and serializable returns are not yet
connected by this increment.
