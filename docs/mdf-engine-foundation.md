# MDF engine foundation

Status: **active receipt/correction foundation with bounded CNC observation and
a distinct CNC-priority executor, still opt-in**. Applying migrations 165–180
does not enable automation, modify existing production statuses, or turn on the
CNC worker lane.

## Boundaries

`backend/src/modules/mdf-board` contains per-position quantity arithmetic,
deterministic bath allocation, active transactional command/correction adapters,
and the accepted-job runner. CNC observation HTTP endpoints are separately
available for bounded worker claims. CNC physical authority has a distinct
accepted-job path; it is not substituted with ordinary rule17. Neither migration
application nor endpoint registration enables the engine or starts the worker.
Do not enable the engine by manually changing its mode.

`BACKEND_MDF_SHADOW_INTAKE=true` connects the existing MDF event dispatch to a
transaction-finalization capture. The default is false. It works in `legacy` or
`shadow` mode; it does not switch modes. Legacy automation and notification flags
do not disable capture. All source snapshots are read after owning command writes,
then persisted in deterministic source-lock order before the same COMMIT. A failed
capture rolls back the command. The generic database hook never does external I/O.

Shadow capture reads exact linked packet/BASIS/effective-bath composition and
explicit completion/manual signals. It never opens `snapshot_job`, reads every
historical source, applies the visible date filter, or treats detail/order status
as physical production. Unresolved identities and whole-order declarations are
diagnostic blockers, never guessed quantities. Source quantities in
`mdf_shadow_observations` are NOT full order readiness or board-parity results.

All shadow revisions remain unaccepted (`accept=false`); jobs require attention,
no allocations or statuses are changed, and no published board revision advances.
Revision/line storage records actor, request/cause and order/detail dimensions;
existing owning-command audit remains unchanged. No extra notification is sent
for a diagnostic observation. Disable the flag to stop intake without deleting
history. Applied migrations165–167 are additive.

## Bounded CNC observation lane

Migration `180_mdf_cnc_observations.sql` adds immutable observation targets,
receipts, and CNC-authority markers. Successful explicit Telegram import is the
only registration path; older and manual-send sources are not backfilled. The
worker flag `CNC_TELEGRAM_MDF_OBSERVATIONS_ENABLED` defaults to `false`, so the
new endpoints do not cause polling unless the worker is deliberately enabled.
Apply migrations 165–180 before deploying this backend version; this preserves
the accepted-job authority lookup even while the worker lane is disabled. Keep
the flags below off until separately approved. The API also
requires `BACKEND_ENABLE_CNC_TELEGRAM=true`; when that flag is off its routes
return 503. In `legacy` or `shadow`, claim returns `{claim:null}` and
complete/fail return 503 `MDF_CNC_OBSERVATION_MODE_DISABLED`. In `read_only`,
the observer may acquire and persist CNC observation facts, but the accepted-job
runner remains inactive and no production-status automation runs. An active or
read-only claim with no eligible source also returns `{claim:null}`.

Packet membership is invariant: every current packet writer (manual/explicit
import creation, CNC cut receipts, corrections/returns) carries the accepted
membership unchanged, so the registered membership digest of an observation
target is never re-baselined. A mismatch can therefore only mean drift or
tampering and fails closed: `claim` quarantines the target (`membership_changed`,
needs_reconciliation), `complete`/`fail` answer `MDF_CNC_OBSERVATION_STALE`, and
an accepted CNC-authority job ends `needs_attention` with
`MDF_CNC_AUTHORITY_MEMBERSHIP_BINDING_INVALID` without status writes. After an
explicit return, an old thumbs-up cannot restore the reverted fact: the return
fence requires a fresh not-completed observation before a new completion is
credited. CNC never changes a completed order's header status and never lowers
a detail status.

The server issues each claim with the accepted MDF head, correction epoch,
unchanged raw packet `source_version`, independent observation version, and the
exact bounded Telegram message IDs/roles/hashes. The worker refetches only that
group and submits its presence/thumbs-up observations; it cannot choose a
packet, source version, or completion state. Failure to fetch or validate any
group member uses the failure endpoint, never a partial pending report. No
history scan, local cache reuse, file parsing, or generic ingest is part of this
lane. Preserving raw `source_version` keeps existing packet label-map and
evidence projections valid.

After a correction, an old in-flight claim becomes stale. The return fence needs
a fresh no-like observation followed by a separate later fresh like before the
return marker can clear. A fresh accepted completion creates an immutable CNC
physical receipt and a separately marked job. Its dedicated executor verifies
that authority against the exact completed observation, accepted packet revision,
head/epoch and freshness fence before applying any scalar effect. A missing or
corrupt observation authority never falls through to the ordinary packet rule.

The CNC executor selects only normal details in that packet's sealed membership
and requires the packet's own complete physical cut receipt. A selected detail
advances only when verified accepted packet/BASIS evidence covers its full live
quantity; quantities never move between details, and rework-only membership does
not advance a normal detail. At observation-receipt intake, exact unchanged normal
physical cut pins can be released and replaced against the new packet revision
in the same transaction, preserving quantities, bath revisions and reserved/
consumed states. The full bounded owner/source component is locked before
acceptance; affected bath context and debits must remain valid. There is one
accepted-head increment, no declaration-to-physical debit conversion and no
automatic linked-roll cancellation. Incompatible pins or unresolved context
remain in reconciliation without changing the accepted head/allocation state.
Write failures roll back the entire transaction. A valid accepted revision uses the common allocation
executor and current accepted graph; unrelated active allocations are not a
blanket blocker. Direct CNC detail marking remains controlled by
`status_automation.cnc_mark_cut_details`; with it enabled, the executor advances
eligible detail statuses only and does not replay the packet's ordinary rule17
event. With it disabled, direct CNC marking is skipped while the normal pinned
packet event retains the legacy rule path. Eligible bath events and downstream
composition use the job's stored rule pins only. Completed business-order headers
are excluded from ordinary CNC-job automation and are never reopened; detail
effects do not directly change business order status. Informational production
summary recalculation follows its existing enablement behavior.

The executor is prepared in this increment but not activated. The existing
worker service remains behind its existing gates. Generic `/cnc-telegram/ingest`
continues to fail closed with 503 (`CNC_TELEGRAM_BACKGROUND_INGEST_DISABLED` or
`CNC_TELEGRAM_BACKGROUND_INGEST_APPROVAL_REQUIRED`); it is not enabled by the
observation API.

Future manual-SVG sends additionally preserve claim-time file/source identity and
explicit sent-message bindings. A separate registrar checks those facts before
creating an observation target; sending alone is never physical cut evidence.
See [manual-send registration and settlement](cnc-telegram-bounded-observations.md#future-manual-sends).

This bounded CNC continuity path does not deliver complete allocation-pin reconciliation across
all active producers, historical source backfill, UI workflow, or
full engine cutover. Keep engine mode and worker/API feature flags unchanged
unless a separately approved rollout covers those remaining gates.

Still required before a broader cutover: validation of the whole live source
chain, complete allocation-pin reconciliation across active producers,
historical source handling if brought into scope, and the
UI workflow. The bounded observation API and CNC-priority executor do not by
themselves complete those separate rollout steps. Keep
`BACKEND_MDF_JOB_WORKER=false`, `BACKEND_MDF_PUBLISHED_READS=false`, and
`CNC_TELEGRAM_MDF_OBSERVATIONS_ENABLED=false`; engine mode remains `legacy` until
a separately reviewed rollout explicitly changes each gate.

Physical production, whole-position declarations, derived card states and
visibility are separate. Rework is included in raw statistics, excluded from
normal readiness. Declarations provide a coverage floor, not additive shipments.
The caller must supply only accepted, material-resolved source revisions; the
pure calculator does not match material/positions or choose accepted versions.

The allocation planner consumes normalized normal physical cut supply. It keeps
existing reservations/consumption (including absent hidden baths), chooses oldest
fully satisfiable baths and never partially reserves an unsatisfiable new bath.
It cannot persist its own output: the command executor must lock and revalidate
the complete affected set. Manual bath readiness is not synthetic physical supply.

## BASIS name changes

The active `bazis.rename` command changes metadata, not production evidence.
For a tracked source it requires verified unchanged membership/demand, a settled
current source job and a matching clean published card. It copies the exact
evidence into a new metadata revision with no pinned status rules. A pending
production job cannot be replaced by a rename and silently lose its effects.
The normal queued accounting pass preserves reserved/consumed bath quantities
and may allocate already verified eligible stock; a name change never proves
additional cut or lamination. Set update, receipt, audit, outbox and replay result
commit together. Replays recheck owner access.

Resolved non-MDF/HDF-only or empty sets without an MDF source need no MDF receipt.
Historical MDF without accepted evidence and unresolved sources require separate
reconciliation; renaming cannot establish a baseline. Other BASIS composition
mutations remain outside this connected path. Legacy/shadow behavior and all
activation flags stay unchanged.

## BASIS assignment changes and performed work

Assignment quantity, order demand and performed quantity are separate. Editing
a BASIS assignment from 10 to 8 must retain the confirmed cut of 10 and its bath
reservations/consumption. Increasing an assignment to 12 does not prove the extra
two were cut. Removing an assigned position does not erase its physical history.
Only an explicit production return may retract an erroneous physical fact and
its attributable dependent lamination.

`planMdfBazisComposition` is a pure transition helper, not a connected command.
It replaces current membership, copies accepted cut facts unchanged and plans
one-for-one allocation reference replacements. It does not change order demand,
cancel bath work, write detail statuses or authenticate historical evidence.
Its input must come from an authoritative, complete, locked accepted snapshot.
Immediate predecessor references are not proof of verified historical origin.

Some lineage consumption is now connected for immutable, accepted source
revisions: execution and correction snapshots validate the sealed v2 manifest
against the exact physical rows, and allocation quarantine/correction planning
can preserve authenticated packet/BASIS physical facts beyond current
membership. Only exact source/revision/evidence identities count; v1 evidence
keeps its original membership cap, pending revisions receive no lineage credit,
and baths remain strict (no physical overhang). Current membership must still
be nonempty. Current-member events continue to be derived from current
membership, not from retained proof at a removed position.

Assignment edits are connected through the BASIS composition command
(`POST /api/v1/bazis-cut-sets/{setId}/composition/preview|confirm`, active engine
only). `GET /api/v1/bazis-cut-sets/{setId}` reports `mdfComposition`
(availability, concurrency token, eligible row ids) only in the active or
read-only engine, so the legacy editor is unchanged in legacy/shadow mode. In
the active engine the legacy detail edit/delete/add endpoints answer 409
(`MDF_COMPOSITION_REQUIRED`, `MDF_SET_REFILL_NOT_CONNECTED`) and a set with
production history cannot be deleted (`MDF_SET_HAS_PRODUCTION_HISTORY`).

An intentionally-empty assignment is supported only with its authentic sealed
marker: the card keeps retained physical proof, can be moved and renamed
carry-only (no rules, one `mdf_board.card_placed` event for a move), may advance
with its bath reservations, and stays valid after an explicit return removes the
retained proof. Unmarked emptiness is still rejected.

Refill (new rows) is limited to ordinary MDF details of the set's current owner
orders and is gated by `BACKEND_MDF_BAZIS_REFILL` (default off; requests with
`newDetailId` answer 409 `MDF_BAZIS_REFILL_DISABLED`). Rows are built
server-side; migration 187 records every raw row INSERT in a trigger-only
creation log and each added row's provenance for its intent, and the worker
accepts a membership row without a predecessor only when that provenance, the
same-transaction creation record and the unchanged raw content all match.

Refill rollout and rollback: deploy the compatible backend and migration 187
with the flag off, then enable the flag. Before any backend downgrade below this
version, turn the flag off and make sure no refill job is unresolved — pending,
retry and `needs_attention` all block the downgrade:

```sql
SELECT j.job_id, j.status, i.source_id
FROM mdf_bazis_composition_intents i
JOIN mdf_recalculation_jobs j ON j.job_id = i.job_id
WHERE EXISTS (SELECT 1 FROM mdf_bazis_composition_new_rows n WHERE n.intent_id = i.intent_id)
  AND j.status NOT IN ('done', 'superseded');
```

Resolve every returned job on the compatible backend first (retry to done, or
an explicit correction/return), then verify the source's accepted head equals
its received head and its publication has no issues. Existing v1 physical
evidence is never promoted, and the engine mode and runtime flags are unchanged
by these commands.

## Order edits and accounted production

Order update/import, HDF recalculation, delete, restore and detail transfer enter the MDF command
boundary with capability `order-demand` (writers `orders.update`, `orders.recalculate_hdf`,
`orders.delete`, `orders.restore`, `orders.transfer_details`). In `legacy`/`shadow` nothing else
happens. In `active`, the command's own orders are compared before and after its writes: when their
MDF demand did not change, nothing else happens (no discovery, lock or card state can block it). Otherwise
every source whose received revision has frozen demand or evidence on the touched orders, and whose own
positions or statuses this command changed, is classified:

- pending acceptance or a pending job → 409 `MDF_ORDER_SOURCE_PENDING`;
- failed job, missing publication, an own issue other than `MDF_DEMAND_CHANGED` /
  `MEMBER_OUTSIDE_LIVE_MDF_DEMAND`, or any published issue besides those and their quarantine
  consequences (`LINEAGE_INVALID`, `ACCEPTANCE_PENDING`) → 409 `MDF_ORDER_SOURCE_ATTENTION`;
- a position with membership/evidence (MDF-present) disappears or loses quantity → 409
  `MDF_ORDER_PHYSICAL_CONFLICT` (cut/lamination/reservations) or `MDF_ORDER_ASSIGNMENT_CONFLICT`;
  no remaining demand → `MDF_ORDER_DEMAND_EMPTY`;
- only demand-only positions changed, or MDF-present positions grew → a cascade receipt carries the
  predecessor lines verbatim with the new frozen demand. It is received but never accepted by the
  command; migration 188 `mdf_order_cascade_intents` authenticates it and only the MDF worker accepts it
  (`mdf_board.order_cascade_accepted`), replacing bath allocations one-for-one. Added quantity inherits
  no completion; rules are never pinned;
- a completed demand quarantine healed by this change (same demand as frozen again) → a refresh
  receipt (identical lines and demand) republishes the card.

The new board has no order cards: in `active` a manual move or clear of an `order` card answers 409
`MDF_ORDER_CARD_NOT_SUPPORTED` (packets, BASIS sets and baths are moved as before).

Detail status changes alone never touch MDF sources here: card placement follows the members' live
production ranks (read-time placement, see the published board reader).

Every 409 rolls back the whole order command and lists the affected cards filtered by the actor's
`orders.view` permission and scope (hidden owners give no ids, names or quantities). Owners of affected sources that
sort below the command's own orders are locked with `NOWAIT`; contention answers retryable 409
`MDF_ORDER_LOCK_CONTENTION`. In `read_only`, edits without MDF impact pass and any receipt-requiring
change answers `MDF_ENGINE_READ_ONLY`. A confirmed correction of MDF-present positions from an order is
not connected yet; creating an order never touches MDF sources.

## Read-time card placement

A published card stores its rank-independent placement inputs (`mdf_published_sources.placement_inputs`,
migration 189: kind, verified, intentional-empty, manual placement, full cut/rolled, bath readiness,
balance blocking, prior column) bound to the row's `published_revision` and `schemaVersion: 1`. The board
reader computes the column with `mdfPlacement` from these inputs and the members' **live** production ranks
(one set-based read; no writes, no automation). Detail status changes by any writer therefore move cards
immediately without a receipt or job. Manual moves and production returns decide on the same effective
column, locking the member detail rows and the production status catalogue `FOR SHARE` to commit; a return
preview binds the effective column and member ranks, so a status change before confirm makes it stale.

Inputs are usable only when `mdf_placement_inputs_valid(inputs, published_revision)` holds (the same rule
in SQL and in the TypeScript parser). Otherwise the stored column is shown with issue
`MDF_PLACEMENT_INPUTS_MISSING` and the card is not movable. Activation gate: `SELECT count(*) FROM
mdf_published_sources WHERE NOT mdf_placement_inputs_valid(placement_inputs, published_revision)` must be 0
before switching to `active`; an older worker that republishes without inputs invalidates them by bumping
the revision. The legacy CNC auto-cut backfill is `legacy-only` (503 in `active`); the CNC authority job owns
automatic cut statuses there.

## Storage and bounded lineage consumers

### Physical origin contract

The internal lineage receipt path separates fresh production from carrying an
existing physical fact into a new assignment revision. A carry preserves the
same detail, stage, rework class, quantity and canonical origin. Partial and full
removal require an explicit correction manifest; a missing line is not a return.
New production is bounded per position/rework class by the current assignment
minus retained work. Retaining 10 against assignment 8 must not prevent fresh
production for a different position, or create a second copy of the same fact.

The contract and transitions are immutable and sealed with the receipt. Parent
links refer only to the immediate accepted predecessor. Once a source receives
a lineage revision, legacy writers cannot overwrite it; pending acceptance must
settle before the next revision. Old physical history without verified origins
is not automatically promoted. Legacy receipt digest/replay remains compatible.

The bounded snapshot, allocation-quarantine, active correction, ordinary manual
production, BASIS rename, same-membership compatible-advance, and bounded CNC
observation paths consume this contract for accepted v2 revisions. A fresh CNC
receipt carries exact accepted v2 physical identities and roots only the
remaining quantity under the existing membership cap; zero-delta receipts still
record CNC authority without duplicating proof. V1 receipts remain unchanged.
CNC physical overhang, changed-membership assignment edits, historical
backfill, and other unreviewed physical producers remain fenced; no activation
follows from this integration.

### Existing receipt and allocation boundaries

- Revisions and lines are append-only; a seal permanently closes membership.
  Source heads and jobs can refer only to sealed revisions.
- Received and accepted versions are separate. Historical source/order/user IDs
  intentionally do not cascade with deletions in operational tables.
- Allocation lines refer to the exact accepted physical cut evidence and detail.
  Database guards reject overbooking, rework/derived/declaration supply, silent
  reassignments and removal of allocation history. Release then replace records.
- Changing an accepted revision with outstanding allocations requires releasing
  and explicitly replacing those allocations in the correction transaction.
- MDF jobs are separate from notification outbox and notification feature flags.
  Pinned rule versions are stored separately from queue metadata.

Writers use READ COMMITTED and consistent lock order: domain owning orders first,
then source heads and evidence. Cross-source operations lock complete sorted
sets before writing. No frontend or Hasura direct writes are supported.

## Transactional job execution

The runner is inactive in `legacy`, `shadow` and `read_only`. In `active`, it
holds a transaction-level shared `mdf-engine-cutover` advisory lock and claims
one due job with `FOR UPDATE SKIP LOCKED`. Mode switching must obtain the
exclusive form of the same advisory lock before changing state.

The injected handler owns authorization, source/correction fence validation,
current rule-version checks, ordered domain locks, audit and notification outbox.
It must write through the supplied transaction and must not perform external I/O.

SQL failure rolls partial effects back to a savepoint while retaining the receipt
and retry metadata. Backoff is 5/15/60/300 seconds, capped at 300. Deterministic
`MdfNeedsAttention` errors stop automatic retry. Raw database errors are not stored.
Connection failure rolls back the claim, leaving the original pending receipt.

## Tests

Pure/unit tests run in the standard backend suite. The real PostgreSQL suite is
opt-in via `MDF_ENGINE_INTEGRATION=1` and standard `PG_*` connection variables.
It creates one uniquely named `e2e_mdf_engine_*` schema, applies the actual
migration, tests constraints/rollback/concurrency, drops that exact schema and
asserts zero residue. No production data is needed.

On the shared ERP host, invoke test/build/typecheck through the required resource
guard with one worker. Do not print connection variables or source secrets into
test output.
