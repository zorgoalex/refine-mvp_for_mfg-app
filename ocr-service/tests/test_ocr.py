import io
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
FIXTURES = Path(__file__).parent / "fixtures"


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_ocr_reads_real_bazis_label():
    img = (FIXTURES / "label1.png").read_bytes()
    r = client.post("/ocr", content=img, headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 200
    body = r.json()
    texts = " ".join(l["text"] for l in body["lines"])
    # Ключевые фрагменты бирки label1 (эталон из прототипа 41/41)
    assert "2590" in texts
    assert "548-16" in texts  # имя заказа
    assert "902" in texts and "596" in texts  # размеры
    assert body["durationMs"] > 0


def test_ocr_second_label_order_2586():
    img = (FIXTURES / "label17.png").read_bytes()
    r = client.post("/ocr", content=img, headers={"Content-Type": "application/octet-stream"})
    texts = " ".join(l["text"] for l in r.json()["lines"])
    assert "2586" in texts or "548-16" in texts


def test_rejects_garbage():
    r = client.post("/ocr", content=b"not an image", headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 400


def test_rejects_oversize_body():
    r = client.post("/ocr", content=b"0" * (10 * 1024 * 1024 + 1), headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 413


def test_rejects_oversize_by_content_length_before_reading():
    # Ранний отказ по заголовку — тело не читается (генератор упадёт, если тронут)
    def gen():
        raise AssertionError("body must not be read when Content-Length is oversize")
        yield b""
    r = client.post("/ocr", content=gen(), headers={"Content-Length": str(20 * 1024 * 1024), "Content-Type": "application/octet-stream"})
    assert r.status_code == 413


def test_busy_returns_429(monkeypatch):
    # Переполнение очереди семафора → 429 (правило backpressure)
    from app import main as m
    monkeypatch.setattr(m, "queue_slots_available", lambda: False)
    r = client.post("/ocr", content=b"x", headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 429
