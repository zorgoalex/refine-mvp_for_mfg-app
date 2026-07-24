# GLM OCR Runner

Internal HTTP wrapper around `llama.cpp` server with local
`GLM-OCR-Q8_0.gguf` + `mmproj-GLM-OCR-Q8_0.gguf` files.

Endpoints:

- `GET /health` returns 200 only after the backing `llama-server` is reachable.
- `POST /ocr` with raw image bytes, returns structured JSON:

```json
{
  "items": [],
  "comments": [],
  "analysisWarnings": [],
  "materialName": null,
  "machine": null,
  "dowelingLinks": []
}
```

The service does not store images or raw model output. It is intended for the
internal Docker `back` network only.
