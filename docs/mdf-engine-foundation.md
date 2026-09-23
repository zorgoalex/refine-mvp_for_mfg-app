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

This bounded CNC continuity path does not deliver complete allocation-pin reconciliation across
all active producers, historical or manual-send source backfill, UI workflow, or
full engine cutover. Keep engine mode and worker/API feature flags unchanged
unless a separately approved rollout covers those remaining gates.

Still required before a broader cutover: validation of the whole live source
chain, complete allocation-pin reconciliation across active producers,
historical/manual-send source handling if those are brought into scope, and the
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

## Storage

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
