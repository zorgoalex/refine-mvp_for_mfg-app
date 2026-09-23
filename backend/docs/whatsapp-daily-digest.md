# WhatsApp daily order digest

The daily digest prepares a WhatsApp group message from production orders whose
planned completion date is today in `Asia/Almaty`. It includes all matching
orders regardless of production status, including issued orders. Each image
contains one or two calendar-style order cards, as selected by the saved
`cardsPerMessage` setting (default `2`). The first image has the weekday,
date, and combined area for all orders in the digest. A day with no matching
orders is recorded as empty and does not send an empty message.

The feature is opt-in at two separate levels. The stored automation setting is
created `enabled = false`; the existing backend WhatsApp runtime flag also
remains authoritative. Preview and manual-send controls can be used while the
stored automation setting is off. Sending still requires the existing
`BACKEND_ENABLE_WHATSAPP=true` runtime and an available configured relay owner.
Do not enable or replace an existing relay/cleanup owner as part of this feature
without following the WhatsApp deployment runbook and preserving the current
runtime flags.

## Access and configuration

The configuration page has a separate **Рассылка заказов** tab. Every daily
digest API operation requires all of these permissions:

- `whatsapp.manage`
- `calendar.view`
- `orders.view`
- `orders.view_financials`

Configure one WhatsApp group JID ending in `@g.us`; direct/private chats are
not accepted. The stored defaults are:

| Setting | Default | Meaning |
| --- | --- | --- |
| Automatic sending | Off | Preview and manual actions remain available while off. |
| Send time | 08:45 | Local time in the fixed `Asia/Almaty` timezone. |
| Cards per message | 2 | Choose `1` or `2`; `1` creates one order card per WhatsApp image. |
| Missed-run policy | Until deadline | Catch up after 08:45 only until 10:00. |
| Catch-up deadline | 10:00 | Applies when the policy is `until_deadline`; must not precede send time. |
| Partial delivery | Remaining pages | Retry only pages not confirmed sent. |

The other catch-up choices are `skip` (do not catch up after the scheduled
time) and `end_of_day` (allow catch-up until the Almaty business day ends).
Partial-delivery policy `manual` waits for an operator to retry. `repeat_all`
resends every page and can produce duplicate messages, so saving it requires
explicit confirmation.

Preview is rendered from current order data and is not a frozen promise of what
a later send will contain. Before a manual send, review the destination, date,
order count, and preview; the send action confirms those details may have
changed and then captures the current order state. Manual sends are available
with automation off, but not when the WhatsApp runtime/relay is unavailable.

## Missed sends, partial runs, and uncertainty

The scheduler evaluates the Almaty business date and can catch up according to
the saved policy. It never sends a second automatic run for the same business
date. Empty and intentionally skipped days remain visible in run history.

Run and per-page states distinguish queued/sending, sent, partial, failed,
unknown, cancelled, expired, empty, and skipped outcomes. An `unknown` result
means the provider may have accepted a message even though the backend could
not confirm it. Retrying an unknown page requires duplicate-risk confirmation.
The `remaining` retry mode retries eligible unsent/failed/unknown pages;
`all` retries every page and always requires duplicate-risk confirmation.
Retries are bounded and are rejected while another retry is active.

If an image has expired, the history entry remains and the UI shows that the
image was removed. The expired image cannot be downloaded or retried, and a
retry never extends image lifetime or rebuilds the old snapshot. To send again,
start a new manual run; it will capture today's current orders. A stale or dirty
configuration form must be saved before preview/send so the operator can see
which settings version is being used.

## Image storage and retention

Rendered PNGs are stored only in the backend's private filesystem directory
`/data/whatsapp-daily-digest`, mounted by the tracked VPS Compose template as
the named volume `whatsapp-daily-digest`. They are not stored as database blobs
and must not be included in database dumps or backups. Keep this named volume
mounted only into the backend service; do not expose it through a web server or
public object-storage URL. Authenticated image responses use `private,
no-store` and the API never returns a public file URL.

With 500 matching orders, `cardsPerMessage: 1` can produce up to 500 pages; the
backend enforces that page bound before writing files. Each stored page has a
maximum 24-hour lifetime (the service starts the TTL at
render time and leaves cleanup margin below that limit). Cleanup runs at backend
startup and once per minute, independently of the WhatsApp runtime and
automatic-send setting. If the backend is down across expiry, physical removal
may wait until the next startup cleanup; the API enforces expiry from database
metadata in the meantime. The order snapshot used for retries is purged from
the database after 30 days. Terminal run/page history becomes eligible for
bounded, leaf-first deletion after 90 days; a parent can remain until its child
has also been removed by a later sweep. Active send intents are never pruned.
Database backups may therefore contain temporary snapshot metadata/content
during the 30-day window, but never PNG image bytes.

## Deployment notes

Apply migration `183_whatsapp_daily_digest.sql` before using the settings or
history API. The backend Compose service needs the explicit named-volume mount
at `/data/whatsapp-daily-digest`; the checked-in VPS template declares both the
mount and volume. Verify deployment configuration preserves all existing
WhatsApp runtime, relay-owner, and cleanup-owner flags. Keep the stored daily
setting disabled until the destination, order cards, permissions, relay, and
retention behavior have been reviewed in the intended environment.

These notes document the deployment prerequisites only. They do not authorize
or record any production migration, configuration change, restart, or send.

## API reference

The full request/response schemas and route permissions are in
[`../contracts/04-api-contract.openapi.yaml`](../contracts/04-api-contract.openapi.yaml).
The endpoints are under `/api/v1/whatsapp/daily-digest`: settings, preview,
run history/detail, protected page images, and explicit retries.
