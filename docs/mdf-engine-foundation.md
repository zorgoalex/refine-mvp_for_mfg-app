# MDF engine foundation

Status: **optional shadow intake**, not the active board calculation.
Applying migration `165_mdf_engine_foundation.sql` does not enable automation,
modify existing production statuses, or change current board APIs.

## Boundaries

`backend/src/modules/mdf-board` contains pure per-position quantity arithmetic,
a deterministic bath allocation planner and a transactional job runner primitive.
No scheduler, HTTP command or replacement board reader is registered yet.
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

Still required before active cutover: producers that bypass dispatch, frozen
whole-order declarations, demand preflight, correction adapters, common resolver,
allocation executor/worker, baseline and full-board shadow comparison. Legacy CNC
processing is still inside its owning transaction: this increment does not yet
make intake survive failure of that legacy processing.

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
