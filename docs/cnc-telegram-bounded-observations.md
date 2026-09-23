# Bounded CNC Telegram observations

This API records a fresh, bounded observation of an explicitly imported CNC
Telegram source. It does not enable generic ingest, history scans, or automatic
polling. The Python worker option `CNC_TELEGRAM_MDF_OBSERVATIONS_ENABLED` is
disabled by default.

Only sources registered by a successful queued-mode explicit import are
eligible. Manual-send sources and older imports are not backfilled by this
slice. The worker must hold the existing CNC Telegram worker session and use the
configured worker identity, `cut.manage` permission, and allowed chat policy.

Apply migrations through `180_mdf_cnc_observations.sql` before deploying this
backend version, even while this lane remains disabled. Keep the worker flag
off until separately approved. The routes also
require `BACKEND_ENABLE_CNC_TELEGRAM=true`. In `legacy`/`shadow`, claim returns
no task and complete/fail return 503 `MDF_CNC_OBSERVATION_MODE_DISABLED`; in
`read_only`, observations may be recorded as facts but the accepted-job runner
does not publish status changes. Actual queue work is eligible only in `active`
mode. No eligible registered source also returns no task.

## Claim, refetch, report

1. `POST /api/v1/cnc-telegram/observation-worker/claim` accepts no source or
   version selector. It returns `{ "claim": null }` when no registered source
   is due, otherwise `{ "claim": ... }` with a server-issued claim token,
   generation, expiry, accepted MDF head/epoch, raw packet version, and up to
   three exact message IDs with roles and stored SHA-256 hashes.
2. After receiving the claim, fetch every listed Telegram message by its exact
   ID from the returned chat. Do not use a date/history scan, cached payload,
   previous worker spool, or composition parser. Verify chat, ID, role, media,
   and bytes against the claim. If any fetch or check fails, call the `fail`
   endpoint; never submit a partial group as pending.
3. `POST /api/v1/cnc-telegram/observation-worker/claims/{claimId}/complete`
   reports only the claim ID/token/generation and exact fetched message facts.
   Packet targets, completion classifications, timestamps, and source versions
   are not client inputs. A 👍 on any registered SVG, G-code, or image message
   means completed; absence on all registered messages means pending.
4. `POST /api/v1/cnc-telegram/observation-worker/claims/{claimId}/fail` records
   bounded fetch or validation failures and releases/backoffs the claim.

All three endpoints require bearer authentication and the standard worker lease
headers: `X-CNC-Telegram-Session-Token`,
`X-CNC-Telegram-Session-Generation`, and
`X-CNC-Telegram-Worker-Instance`. The chat header may be omitted only when the
server has exactly one allowed chat configured. The worker lease is revalidated
inside the observation transaction.

## Freshness behavior

Observation versions are allocated by the server and are independent of the
packet's content `source_version`. Observations therefore do not invalidate
label-map or item-evidence projections keyed to the unchanged packet content.
Claims bind the accepted MDF head, correction epoch, packet content version,
observation version, and persisted message group. If any binding changes, the
worker must claim and refetch again.

After a return correction, one fresh no-👍 observation records pending; only a
distinct later claim and current 👍 observation can satisfy the return fence.
Repeated/no-op observations are durable but do not churn packet content
versions. Exact terminal replays return their stored result and do not create a
second receipt or job. CNC-origin jobs remain quarantined from the general MDF
executor until the dedicated CNC physical-priority executor is shipped; a
durable observation is not a claim that production status was automatically
advanced.

The generic `/cnc-telegram/ingest` route remains fail-closed even if its legacy
environment switch is enabled: it returns 503
`CNC_TELEGRAM_BACKGROUND_INGEST_DISABLED` or
`CNC_TELEGRAM_BACKGROUND_INGEST_APPROVAL_REQUIRED`. It is not used by this
protocol. Manual-send and historical sources are not registered/backfilled by
this increment. A dedicated CNC physical-priority executor, complete allocation
pin reconciliation, UI workflow, and full engine cutover remain outstanding.
