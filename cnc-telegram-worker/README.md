# CNC Telegram Worker

Telethon worker for CNC cutting sheets. It reads Telegram history/live polling,
downloads screenshots and G-code files into local temp storage, runs optional
OCR, posts only structured JSON to ERP, then removes local media files.

Raw screenshots, G-code text and OCR raw text are never sent to the ERP backend.

## Commands

```bash
python -m cnc_telegram_worker login
python -m cnc_telegram_worker once --days 7
python -m cnc_telegram_worker daemon
python -m cnc_telegram_worker cleanup
```

`login` creates the Telethon `.session` file. Run it once before daemon mode.

## Required Environment

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=...
TELEGRAM_CHAT=-1001234567890
TELEGRAM_ALLOWED_CHAT_ID=-1001234567890
ERP_API_URL=http://backend:3000/api/v1
ERP_WORKER_LOGIN=cnc-worker
ERP_WORKER_PASSWORD=...
```

`ERP_BEARER_TOKEN` can replace `ERP_WORKER_LOGIN/PASSWORD`.

`CNC_OCR_COMMAND` defaults to the internal RapidOCR service command:

```env
CNC_OCR_COMMAND=python -m cnc_telegram_worker.rapid_ocr_client --image {image}
CNC_RAPID_OCR_URL=http://ocr-service:8000/ocr
```

Custom OCR commands must print JSON to stdout. Minimal supported shape:

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

Custom example:

```env
CNC_OCR_ENGINE=rapidocr-ppocrv5-eslav
CNC_OCR_COMMAND=python -m cnc_telegram_worker.rapid_ocr_client --image {image}
```
