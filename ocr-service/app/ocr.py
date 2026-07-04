"""Тупой OCR: изображение -> строки. Никакого извлечения полей (business
logic живёт в backend). Модель PP-OCRv5-eslav запекается в образ на build."""
import time
import numpy as np
import cv2
from rapidocr import RapidOCR, OCRVersion, LangRec, ModelType

_engine: RapidOCR | None = None


def get_engine() -> RapidOCR:
    global _engine
    if _engine is None:
        _engine = RapidOCR(params={
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.lang_type": LangRec('eslav'),   # форма, проверенная прогоном 41 файла
            "Rec.model_type": ModelType.MOBILE,
        })
    return _engine


def run_ocr(image_bytes: bytes) -> dict:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("unreadable image")
    # Даунскейл больших фото: длинная сторона > 2000px -> в 2000 (латентность).
    h, w = img.shape[:2]
    scale = 2000 / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
    t0 = time.time()
    result = get_engine()(img)
    duration_ms = int((time.time() - t0) * 1000)
    lines = []
    if result is not None and result.txts is not None:
        boxes = result.boxes if result.boxes is not None else [None] * len(result.txts)
        scores = result.scores if result.scores is not None else [0.0] * len(result.txts)
        for text, box, score in zip(result.txts, boxes, scores):
            lines.append({
                "text": str(text),
                "score": float(score) if score is not None else 0.0,
                "box": box.tolist() if hasattr(box, "tolist") else (box or []),
            })
    return {"lines": lines, "durationMs": duration_ms}
