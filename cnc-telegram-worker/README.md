# CNC Telegram Worker

Telethon worker for CNC cutting sheets. Each valid SVG message becomes one ERP
cut job/sheet. Screenshots and G-code files are optional context and never create
a job without a valid SVG.

Raw screenshots, G-code text and OCR raw text are never sent to the ERP backend.

Every Telegram iterator result, SVG decision, backend ingest and bot reply is
written first to a durable SQLite WAL outbox (`CNC_AUDIT_SPOOL_PATH`, default
`/data/cnc-telegram-audit.sqlite3`). ERP exposes the evidence on the
`Аудит → Telegram-бот` tab. A corrupt/unwritable spool or missing backend
`cnc_telegram_worker_audit_v1` capability stops the worker before Telegram is read.

## Commands

```bash
python -m cnc_telegram_worker login
python -m cnc_telegram_worker once --days 7
python -m cnc_telegram_worker daemon
python -m cnc_telegram_worker cleanup
```

`login` creates the Telethon `.session` file. Run it once before daemon mode.
`once --days 10` scans oldest to newest, checks existing Telegram replies like
`Раскрой №7` before storing a number, and only writes a new reply after ERP
accepts the packet and returns a cutting sequence number.

## Required Environment

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=...
TELEGRAM_CHAT=-1001234567890
TELEGRAM_ALLOWED_CHAT_ID=-1001234567890
ERP_API_URL=http://backend:3000/api/v1
ERP_WORKER_LOGIN=cnc-worker
ERP_WORKER_PASSWORD=...
CNC_AUDIT_SPOOL_PATH=/data/cnc-telegram-audit.sqlite3
```

`ERP_BEARER_TOKEN` can replace `ERP_WORKER_LOGIN/PASSWORD`.

Backend must also set `CNC_TELEGRAM_WORKER_USERNAME` to the exact ERP login and
`CNC_TELEGRAM_ALLOWED_CHAT_IDS` to the comma-separated allowed chat ids. Audit
payloads contain only sanitized bounded text and identifiers; raw SVG, image and
G-code bodies are never stored.

Telegram access mode is explicit:

```env
# Test: read/download/parse and write ERP data, but never send chat messages.
ERP_STACK_ENV=test
CNC_TELEGRAM_WORKER_ROLE=reader
CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=false

# Production: read plus cutting sequence replies.
# ERP_STACK_ENV=prod
# CNC_TELEGRAM_WORKER_ROLE=writer
```

Roles: `disabled`, `reader`, `writer`. Non-production `writer` remains blocked
unless `CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=true` is deliberately set.

The normal worker parses valid SVG layouts and does not run an OCR subprocess or
call an OCR service. The legacy/default OCR command remains available for
configuration compatibility, while the engine identifier preserves existing
source fingerprints; the command is dormant while `CNC_ENABLE_GLM_OCR=false`.

```env
CNC_OCR_COMMAND="python -m cnc_telegram_worker.rapid_ocr_client --image {image}"
CNC_RAPID_OCR_URL=http://ocr-service:8000/ocr
```

GLM-OCR is retained as an explicit screenshot cross-check fallback and is not
started or called by the normal `cnc-telegram` profile. The stack wrapper
enables the OCR gate, switches the command and engine, and activates the
separate `cnc-telegram-glm` profile for one run:

```bash
repo_erp/ops/cnc-telegram-worker.sh up-glm
```

The wrapper waits up to 30 minutes for the runner healthcheck (which also checks
llama) before starting the worker. A failed GLM startup therefore cannot be
recorded as a completed fallback pass.

Run `repo_erp/ops/cnc-telegram-worker.sh up` to return to SVG-only processing
and remove the GLM containers. The downloaded model volume is kept for future
fallback. For a persisted fallback, set all five values:

```env
COMPOSE_PROFILES=cnc-telegram,cnc-telegram-glm
CNC_ENABLE_GLM_OCR=true
CNC_OCR_COMMAND="python -m cnc_telegram_worker.glm_ocr_client --image {image}"
CNC_OCR_COMMAND_TIMEOUT_SECONDS=720
CNC_OCR_ENGINE=glm-ocr-0.9b-q8
```

The outer command timeout must exceed `GLM_OCR_CLIENT_TIMEOUT_SECONDS` (660 by
default). The engine identifier is part of the source fingerprint and must
match the selected OCR.

When the explicit fallback gate is enabled, its OCR command must print JSON to
stdout. Minimal supported shape:

```json
{
  "items": [
    {
      "sourceItemKey": "2689:31:497x477",
      "orderName": "2689",
      "detailNumber": 31,
      "widthMm": 497,
      "heightMm": 477,
      "quantity": 4,
      "confidence": 0.94
    }
  ],
  "comments": ["optional structured note"],
  "analysisWarnings": []
}
```
