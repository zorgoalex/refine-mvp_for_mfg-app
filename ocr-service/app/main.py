"""Тупой OCR HTTP-сервис: изображение -> строки текста. Никакой бизнес-логики
(извлечение полей заказа/детали живёт в backend). Без auth, без состояния —
рассчитан на внутреннюю сеть."""
import asyncio

from fastapi import FastAPI, Request, HTTPException

from .ocr import run_ocr, get_engine

MAX_BYTES = 10 * 1024 * 1024
MAX_WAITING = 3

app = FastAPI(title="erp-ocr-service")

# Backpressure: одновременно обрабатывается 1 запрос (модель не потокобезопасна
# для параллельного инференса), в очереди ожидания разрешено не более
# MAX_WAITING — сверх этого клиент получает 429 сразу, не встаёт в очередь.
_semaphore = asyncio.Semaphore(1)
_waiting = 0


def queue_slots_available() -> bool:
    """Тестовый/backpressure-хук: True, если есть место в очереди ожидания.
    Монкипатчится в тестах для детерминированной проверки 429."""
    return _waiting < MAX_WAITING


@app.get("/health")
def health():
    return {"status": "ok", "model": "PP-OCRv5-eslav"}


async def read_capped(request: Request) -> bytes:
    # Ранний 413: сначала Content-Length, затем чанковое чтение с cap —
    # тело НЕ буферизуется целиком до проверки размера.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="image too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BYTES:
            raise HTTPException(status_code=413, detail="image too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def run_ocr_queued(data: bytes) -> dict:
    """Семафор(1) + очередь ожидания <= MAX_WAITING. Синхронный run_ocr
    выполняется в отдельном потоке (asyncio.to_thread), чтобы не блокировать
    event loop на время инференса."""
    global _waiting
    # Прямой вызов имени модуля (не локальная ссылка) — так monkeypatch в
    # тестах (setattr(app.main, "queue_slots_available", ...)) реально
    # подменяет то, что читает эта функция (global lookup при каждом вызове).
    if not queue_slots_available():
        raise HTTPException(status_code=429, detail="ocr service busy, try again later")
    _waiting += 1
    try:
        await _semaphore.acquire()
    except BaseException:
        _waiting -= 1
        raise
    _waiting -= 1
    try:
        return await asyncio.to_thread(run_ocr, data)
    finally:
        _semaphore.release()


@app.post("/ocr")
async def ocr(request: Request):
    # Fast-fail BEFORE reading any body bytes: if the queue is already at
    # capacity, an over-capacity request must not pay for buffering up to
    # MAX_BYTES of memory just to be rejected afterwards. This is a coarse
    # pre-check (race between check and enqueue is fine — run_ocr_queued
    # still re-checks queue_slots_available() itself right before enqueueing).
    if not queue_slots_available():
        raise HTTPException(status_code=429, detail="ocr service busy, try again later")
    data = await read_capped(request)
    if not data:
        raise HTTPException(status_code=400, detail="empty body")
    try:
        return await run_ocr_queued(data)
    except ValueError as exc:
        # 'unreadable image' | 'image dimensions too large' (image-bomb guard)
        raise HTTPException(status_code=400, detail=str(exc) or "unreadable image")


@app.on_event("startup")
def warmup():
    get_engine()  # инициализация модели на старте, не на первом запросе
