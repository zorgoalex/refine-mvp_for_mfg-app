# Bounded CNC Telegram observations

Status: **prepared, not activated**. This describes explicit-import and future
manual-send observation registration and CNC-priority execution. It does not enable polling, the MDF
job scheduler, the published board, or a general CNC ingest path.

## Scope and trust boundary

An observation target comes from an eligible explicit Telegram import or a
verified new ERP manual-SVG send. It stores the real Telegram chat, a message
anchor, and a bounded set of exact SVG/G-code/image message IDs and content
hashes. Neither path backfills older imports, old manual sends or Telegram
history. Import, upload and successful send establish no physical completion.

## Future manual sends

Send-task claim freezes its exact file IDs, kinds, source hashes and MDF source
revision/version/epoch. Upload file rows may later be overwritten; registration
must never infer old sent content from their current values. An incomplete or
unaccepted source does not become eligible merely because sending succeeded.

Capable tasks advertise `observationBindingVersion: 1`. The updated worker
reports `sentFiles` with explicit `fileId`, `messageId`, `sourceSha256` and
`mediaSha256`. Do not zip files and message IDs: the worker's send order differs
from backend storage order, and `sentMessageIds` also includes any comment.
File roles are derived from the frozen server snapshot, not supplied as authority
by the worker. A full group includes SVG and every sent file, with at most three
unique file/message bindings; comment messages are not observation targets.

The worker refetches exact sent messages under count/size/time bounds. SVG and
G-code media must retain their source hash. Screenshot remains a photo: its
Telegram representation may differ, so the original source hash and actual
fetched-media hash remain separate. Subsequent observation verifies the latter;
image 👍 remains supported. Verification failure reports
`observationBindingError: "MEDIA_VERIFICATION_FAILED"` instead of a partial group.
Old workers may settle a send without bindings, but those data cannot authorize
an observation target.

Transport completion stores the sent result and immutable binding receipt before
registration. A pending registrar runs in a separate transaction before ordinary
observation claim, locks owners before sources, and revalidates the claim-time
source fences and complete accepted composition. Registration creates no cut
proof and changes no production status. Stale/ineligible facts are retained with
a blocking reason; transient registration failure leaves work retryable. Exact
replay is effect-free; a conflicting completion is rejected. Existing packet
targets are never rebound to another send; such a registration requires review.
Transient database failures defer this registration with a 2–300 second backoff
and let ordinary observation claiming continue. After ten failed attempts the
work requires reconciliation. Session and cutover errors are not bypassed.
For manual origin the message anchor is the SVG message ID.
An already committed send receipt survives a worker restart: the registrar uses
the currently authorized session for the same chat, not the original sender's
expired session. This does not relax authentication of the original completion.

Once a remote send has started, later errors must not call send-failure or cause
an automatic resend: even a timeout can conceal successful remote delivery.
When all sends returned known IDs, media-verification failure still settles
`sent`, but blocks registration. Completion retries use the exact same payload.
Partial or unresolved delivery remains unknown. For newly snapshotted claims,
late completion is allowed only for the same token, item generation, worker and
still-current session generation; a newer identity, failed request or unrelated
unknown request cannot be overwritten. Older unsnapshotted tasks retain their
existing lease checks.

## Observation protocol

The worker claims at most one due target through the worker-session API, fetches
the exact bound messages after the claim, and reports each message's presence,
identity, hash, and thumbs-up state. Missing, partial, mismatched, or failed
fetches are not pending/completion observations. The server derives the aggregate
signal; the worker cannot select a packet, target detail, source version, or
desired production status. No history scan, local spool replay, file parsing, or
generic `/cnc-telegram/ingest` is used.

The `POST /api/v1/cnc-telegram/observation-worker/claim` endpoint accepts no
source or version selector. It returns `{ "claim": null }` when no registered
source is due, otherwise `{ "claim": ... }` with a server-issued claim token,
generation, expiry, accepted MDF head/epoch, raw packet version, observation
version, and up to three exact message IDs with roles and stored SHA-256 hashes.

After receiving a claim, fetch every listed Telegram message by its exact ID
from the returned chat. Verify chat, ID, role, media, and bytes against the
claim. If any fetch or check fails, call
`POST /api/v1/cnc-telegram/observation-worker/claims/{claimId}/fail`; never
submit a partial group as pending. The completion endpoint is
`POST /api/v1/cnc-telegram/observation-worker/claims/{claimId}/complete` and
reports only the claim ID/token/generation and exact fetched message facts. A 👍 on any registered SVG,
G-code, or image message means completed; absence on all registered messages
means pending. Packet targets, completion classifications, timestamps, and
source versions are not client inputs.

All three endpoints require bearer authentication and the standard worker lease
headers: `X-CNC-Telegram-Session-Token`,
`X-CNC-Telegram-Session-Generation`, and
`X-CNC-Telegram-Worker-Instance`. They additionally require the configured CNC
worker identity, the `cut.manage` permission, and a chat allowed by worker
policy. The chat header may be omitted only when the server has exactly one
allowed chat configured. The worker lease is revalidated inside the observation
transaction. The routes also require
`BACKEND_ENABLE_CNC_TELEGRAM=true`. In `legacy`/`shadow`, claim returns no task
and complete/fail return 503 `MDF_CNC_OBSERVATION_MODE_DISABLED`; in `read_only`,
observations may be recorded as facts but the accepted-job runner does not
publish status changes. Queue execution is eligible only in `active` mode.

Raw packet `source_version` is content identity used by labels and evidence, so
observation polling does not change it. A separate monotonic observation version
records meaningful signal transitions. Claims also bind the accepted MDF head
and correction epoch. After a confirmed return, only a fresh post-claim no-like
observation followed by a later fresh post-claim like can satisfy the fence. A
claim that predates a correction is stale and must fetch again. This is an
ordered observation guarantee, not proof of when a person changed a Telegram
reaction; Telegram supplies no reliable total reaction revision.
Unchanged polls are recorded without churning the raw packet, its source head,
or the observation sequence. Exact terminal replays return their stored result
and do not create a second receipt or job. Failed fetches use bounded backoff;
accepted completion stops polling until a later correction creates a new epoch.

## CNC physical authority

An eligible fresh completion creates an immutable physical receipt and a job
carrying a distinct `cnc_autocut` authority marker. Incompatible allocation pins
on the prior packet revision or unresolved context can instead record
`needs_reconciliation` without accepting replacement evidence. The marker is
checked against its exact claim, completed observation receipt, result
job/revision, current accepted head, epoch, and freshness state before the
CNC-specific effect runs.
An observation-origin job with a missing or mismatched marker cannot fall through
to ordinary rule17. Legitimate superseded jobs have no effects; corrupt authority
is quarantined for attention.

The executor uses the packet's verified sealed normal membership as its detail
scope and requires complete physical cut proof for that packet. A detail advances
to the active cut status only when verified accepted packet and BASIS evidence
for that same detail covers its full live quantity. Physical contributions add;
declarations retain their existing maximum-floor meaning. No quantity crosses
detail boundaries, and rework-only membership does not advance a normal detail.
At receipt intake, exact normal physical-cut allocations may follow an unchanged
proof line into the new packet revision. The transaction locks the complete
bounded source/owner component, verifies the affected baths and their debits,
releases old allocation rows, accepts the receipt once, and appends replacement
rows preserving quantity, reserved/consumed state, bath ID and bath revision.
Old rows remain as history. A declaration cannot become physical allocation
evidence merely because its position or quantity matches.

Incompatible pins or unresolved membership/context put the observation into
`needs_reconciliation` without changing the accepted head, allocations, raw
completion or return-fence credit. A write failure rolls back the whole receipt
transaction. A fresh completion is not a cancellation command: linked lamination
is cancelled only through the separately confirmed return workflow. Source/owner
scope limits and races fail closed before unsafe writes.
After a valid receipt is accepted, its job uses the common allocation executor
and current accepted graph rather than rejecting unrelated allocations broadly.

`status_automation.cnc_mark_cut_details` continues to control the direct CNC
detail-status effect. If enabled, CNC advances eligible details independently
of rule17 and omits the duplicate ordinary packet event. If disabled, the direct
effect is skipped but the packet follows the existing pinned ordinary rule path,
including rule17 when its stored pin permits it. This keeps the existing setting
semantics. Direct effects advance only: same-or-higher stages are retained, null
status may advance, and unknown non-null status rank fails closed. Informational
order production summaries keep their existing recalculation behavior; the
executor never writes the business order status.

Eligible bath events and downstream detail-composition automation for open
orders continue only under the job's stored rule pins. Completed business-order
headers are excluded from ordinary CNC-job events/composition, while eligible
CNC-owned detail effects remain allowed. Missing actors do not become synthetic
admin authority. The physical receipt is committed independently of a later
automation failure.

## Activation remains gated

Applying MDF migrations, deploying endpoints, or registering an
observation target does not enable production behavior. Keep the database MDF
engine in `legacy`; do not enable the accepted-job scheduler or published MDF
reads; keep `CNC_TELEGRAM_MDF_OBSERVATIONS_ENABLED=false`. Do not start or restart
the currently stopped CNC worker without a separate approved rollout. The
generic background ingest remains fail-closed. This increment does not connect
the UI, historical registration, every CNC producer, or the full MDF
cutover chain.

The generic `/cnc-telegram/ingest` route remains fail-closed even if its legacy
environment switch is enabled: it returns 503
`CNC_TELEGRAM_BACKGROUND_INGEST_DISABLED` or
`CNC_TELEGRAM_BACKGROUND_INGEST_APPROVAL_REQUIRED`. It is not used by this
protocol.

Before any broader activation, verify the current runtime configuration and
database mode, exact worker image and reader role, claim/session boundaries,
freshness after return, active allocation-pin reconciliation, pinned downstream
rules, completed-order protection, and rollback/audit/outbox behavior. A passed
bounded test suite is not permission to change runtime flags or worker state.
