"""Тупой OCR: изображение -> строки. Никакого извлечения полей (business
logic живёт в backend). Модель PP-OCRv5-eslav запекается в образ на build."""
import time
import numpy as np
import cv2
from rapidocr import RapidOCR, OCRVersion, LangRec, ModelType

_engine: RapidOCR | None = None

# Image-bomb guard: cap на РАЗМЕРНОСТИ изображения, проверяемый по заголовку
# файла ДО cv2.imdecode. 10МБ-лимит тела ограничивает только сжатый размер:
# крошечный PNG 30000x30000 при декоде раздул бы память до downscale-этапа.
MAX_DIMENSION = 12_000
MAX_PIXELS = 40_000_000


def _parse_dimensions(data: bytes) -> tuple[int, int] | None:
    """Извлечь (width, height) из заголовка PNG/BMP/JPEG без декодирования.
    None — формат/заголовок не распознан (решение оставляем cv2.imdecode)."""
    # PNG: 8-байтная сигнатура, затем IHDR: width/height — big-endian uint32
    # на байтах 16..24 от начала файла.
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        return width, height
    # BMP: 'BM', biWidth/biHeight — little-endian int32 на offset 18/22
    # (height может быть отрицательным у top-down BMP — берём модуль).
    if data[:2] == b"BM" and len(data) >= 26:
        width = abs(int.from_bytes(data[18:22], "little", signed=True))
        height = abs(int.from_bytes(data[22:26], "little", signed=True))
        return width, height
    # JPEG: скан сегментов до SOF0/SOF1/SOF2 (0xFFC0/C1/C2):
    # height/width — big-endian uint16 на +5/+7 от начала маркера.
    if data[:2] == b"\xff\xd8":
        i = 2
        n = len(data)
        while i + 9 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                height = int.from_bytes(data[i + 5:i + 7], "big")
                width = int.from_bytes(data[i + 7:i + 9], "big")
                return width, height
            if marker == 0xFF:
                i += 1  # padding-байт 0xFF перед маркером
                continue
            if marker == 0x01 or 0xD0 <= marker <= 0xD9:
                i += 2  # standalone-маркеры без поля длины
                continue
            seg_len = int.from_bytes(data[i + 2:i + 4], "big")
            if seg_len < 2:
                return None
            i += 2 + seg_len
        return None
    return None


def check_dimensions(data: bytes) -> None:
    """ValueError, если заголовок объявляет чрезмерные размеры (image bomb).
    Вызывается ДО cv2.imdecode — пиксели не аллоцируются."""
    dims = _parse_dimensions(data)
    if dims is None:
        return
    width, height = dims
    if max(width, height) > MAX_DIMENSION or width * height > MAX_PIXELS:
        raise ValueError("image dimensions too large")


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
    check_dimensions(image_bytes)  # image-bomb guard: ДО декода пикселей
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
