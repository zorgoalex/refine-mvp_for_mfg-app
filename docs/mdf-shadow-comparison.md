# MDF shadow comparison

The optional backend observer compares the existing server return-preview source
model with an independent candidate calculation. It does **not** change the
board, orders, details, manual moves, accepted evidence, allocations, or jobs.

Enable `BACKEND_MDF_SHADOW_INTAKE=true` and
`BACKEND_MDF_SHADOW_COMPARE=true` after migrations 165–167 and 169. Both default
to false. The engine must remain `legacy` or `shadow`. Disable the comparison
flag to stop polling; an already-running bounded diagnostic transaction may
finish. This does not disable existing business logic.

One committed intake observation is examined per 60-second tick. The observer
uses a global nonblocking lock and a repeatable-read transaction. Limits:
100 connected owners, 250 sources, 5,000 composition rows, 15 seconds of snapshot
work, 5 seconds per SQL statement. Hidden and older connected sources participate;
the legacy readiness window is two calendar months. Exceeded limits produce a
blocked report, not truncated success. Transient failures retry with backoff;
after three attempts they produce a blocked report. Other observations can proceed.

## Reading results

Authorized operators can inspect diagnostic tables with SQL; no new public API
or Hasura write access is provided:

```sql
SELECT c.created_at, c.source_kind, c.source_id, c.status, c.duration_ms,
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

`columns` contains old/candidate placement and reasons preventing comparison.
`positions` and `orders` contain position-local cut-not-rolled, rolled, credited
quantities and remaining demand for known live MDF positions. The independent
legacy arithmetic is checked against the frontend formula. Candidate physical
quantities currently use strictly linked raw CNC completion; manual/BASIS facts
without immutable provenance and unfrozen whole-order declarations are reported
as gaps, not accepted manufacturing evidence. Candidate raw rework remains in
statistics but grants no normal-demand credit.

Old/hidden bath consumption and accepted allocations without verified baseline
mapping block allocation comparison. A manual ready column does not create
physical cut supply. Allocation output, when possible, is a proposal only.

`differences` means at least one provisional value differs; inspect its issues
before treating it as a defect. `blocked` means no differences established or a
limit/missing-input prevented comparison. There is deliberately no `match`
status, and `cutoverReady` is always false: baseline and producer migration are
not complete. These reports cannot authorize active cutover.

Tests: backend `src/modules/mdf-board`, real PostgreSQL tests opt in through
`MDF_ENGINE_INTEGRATION=1`; frontend parity in
`src/pages/orderStatusBoard/model.test.ts`. Run heavy checks through the project
resource guard and with one Vitest worker.
