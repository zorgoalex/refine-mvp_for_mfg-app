from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


ORDER_RE = re.compile(r"(?<!\d)(\d{4})(?!\d)")
DETAIL_HASH_RE = re.compile(r"[#№]\s*-?\s*(\d{1,4})")
DETAIL_HASH_WITH_ORDER_RE = re.compile(r"[#№]\s*-?\s*(\d{1,3})(\d{4})(?!\d)")
SIZE_RE = re.compile(r"(?<!\d)(\d{2,4})\s*[*xX×хХ'’°+\-]\s*(\d{2,5})(?!\d)")
DOWELING_RE = re.compile(
    r"(?<!\d)(?P<order>\d{4})(?!\d).{0,24}?(?:присадк[аи]|прис\.?|сверл[её]н\w*)\s*[:#№-]?\s*(?P<number>[\wА-Яа-я-]{1,32})",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class OcrLine:
    text: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) / 2

    @property
    def width(self) -> float:
        return max(1.0, self.x2 - self.x1)


@dataclass(frozen=True)
class Label:
    value: str | int
    line: OcrLine
    score: float


@dataclass(frozen=True)
class SizeLabel:
    width_mm: int
    height_mm: int
    line: OcrLine
    score: float


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--url", default=os.environ.get("CNC_RAPID_OCR_URL", "http://ocr-service:8000/ocr"))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("CNC_RAPID_OCR_TIMEOUT_SECONDS", "120")))
    args = parser.parse_args()

    try:
        data = Path(args.image).read_bytes()
        with httpx.Client(timeout=args.timeout) as client:
            response = client.post(args.url, content=data, headers={"Content-Type": "application/octet-stream"})
        response.raise_for_status()
        result = parse_rapidocr_response(response.json())
    except Exception as exc:
        result = empty_result([f"RapidOCR failed: {exc}"])

    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


def parse_rapidocr_response(data: dict[str, Any]) -> dict[str, Any]:
    lines = [line for line in (line_from_raw(raw) for raw in data.get("lines", [])) if line is not None]
    orders = expand_order_labels(lines)
    details = extract_detail_labels(lines)
    sizes = extract_size_labels(lines)
    items: list[dict[str, Any]] = []
    warnings: list[str] = []

    for index, size in enumerate(sizes):
        order = nearest_order(size, orders)
        if order is None:
            continue
        detail = nearest_detail(size, details, order)
        items.append({
            "sourceItemKey": f"rapid:{order.value}:{detail.value if detail else 'na'}:{size.width_mm}x{size.height_mm}:{index}",
            "orderName": str(order.value),
            "detailNumber": int(detail.value) if detail is not None else None,
            "widthMm": size.width_mm,
            "heightMm": size.height_mm,
            "quantity": 1,
            "confidence": round(min(order.score, detail.score if detail else size.score, size.score), 4),
        })

    if lines and not items:
        warnings.append("RapidOCR found text, but no detail rows with order and size")

    return {
        "items": items,
        "comments": extract_comments(lines),
        "analysisWarnings": warnings,
        "materialName": extract_material(lines),
        "machine": None,
        "dowelingLinks": extract_doweling_links(lines),
    }


def line_from_raw(raw: Any) -> OcrLine | None:
    if not isinstance(raw, dict):
        return None
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    bounds = box_bounds(raw.get("box"))
    if bounds is None:
        return None
    try:
        score = float(raw.get("score") or 0)
    except (TypeError, ValueError):
        score = 0
    x1, y1, x2, y2 = bounds
    return OcrLine(
        text=" ".join(text.strip().split()),
        score=max(0, min(1, score)),
        x1=x1,
        y1=y1,
        x2=x2,
        y2=y2,
    )


def box_bounds(box: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(box, list) or not box:
        return None
    points: list[tuple[float, float]] = []
    for point in box:
        if not isinstance(point, list) or len(point) < 2:
            continue
        try:
            points.append((float(point[0]), float(point[1])))
        except (TypeError, ValueError):
            continue
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def expand_order_labels(lines: list[OcrLine]) -> list[Label]:
    labels: list[Label] = []
    for line in lines:
        if is_ui_line(line.text):
            continue
        if looks_like_size_text(line.text):
            continue
        values = order_values(line.text)
        if not values:
            continue
        if len(values) == 1:
            labels.append(Label(values[0], line, line.score))
            continue
        part_width = line.width / len(values)
        for index, value in enumerate(values):
            part_line = OcrLine(
                text=str(value),
                score=line.score,
                x1=line.x1 + part_width * index,
                y1=line.y1,
                x2=line.x1 + part_width * (index + 1),
                y2=line.y2,
            )
            labels.append(Label(value, part_line, line.score))
    return labels


def order_values(text: str) -> list[str]:
    compact_digits = re.sub(r"\D", "", text)
    compact_text = re.sub(r"\s+", "", text)
    if compact_text.isdigit() and len(compact_digits) >= 8 and len(compact_digits) % 4 == 0:
        return [compact_digits[index:index + 4] for index in range(0, len(compact_digits), 4)]
    return [match.group(1) for match in ORDER_RE.finditer(text)]


def extract_detail_labels(lines: list[OcrLine]) -> list[Label]:
    labels: list[Label] = []
    for line in lines:
        if is_ui_line(line.text):
            continue
        text = normalize_ocr_symbols(line.text)
        combined_match = DETAIL_HASH_WITH_ORDER_RE.search(text)
        if combined_match:
            value = int(combined_match.group(1))
            if 1 <= value <= 999:
                labels.append(Label(value, line, line.score * 0.82))
            continue
        match = DETAIL_HASH_RE.search(text)
        if match:
            value = int(match.group(1))
            if 1 <= value <= 999:
                labels.append(Label(value, line, line.score))
            continue
        digits = re.sub(r"\D", "", text)
        if text.strip().isdigit() and 1 <= len(digits) <= 3:
            value = coerce_standalone_detail_number(digits, line.score)
            if 1 <= value <= 999:
                labels.append(Label(value, line, line.score * 0.8))
    return labels


def coerce_standalone_detail_number(digits: str, score: float) -> int:
    if len(digits) >= 2 and digits[0] in {"8", "9"} and score < 0.9:
        tail = int(digits[1:])
        if 1 <= tail <= 99:
            return tail
    return int(digits)


def extract_size_labels(lines: list[OcrLine]) -> list[SizeLabel]:
    labels: list[SizeLabel] = []
    for line in lines:
        if is_ui_line(line.text) or "#" in line.text or "№" in line.text:
            continue
        text = normalize_ocr_symbols(line.text)
        match = SIZE_RE.search(text)
        if match:
            width = clean_dimension(match.group(1))
            height = clean_dimension(match.group(2))
            if valid_dimension(width) and valid_dimension(height):
                labels.append(SizeLabel(width, height, line, line.score))
            continue
        compact = re.sub(r"\D", "", text)
        if len(compact) not in {6, 7}:
            continue
        size = split_compact_size(compact)
        if size is not None:
            labels.append(SizeLabel(size[0], size[1], line, line.score * 0.86))
    return labels


def looks_like_size_text(text: str) -> bool:
    normalized = normalize_ocr_symbols(text)
    if SIZE_RE.search(normalized):
        return True
    compact = re.sub(r"\D", "", normalized)
    return len(compact) in {6, 7} and split_compact_size(compact) is not None


def normalize_ocr_symbols(text: str) -> str:
    return (
        text.replace("Х", "x")
        .replace("х", "x")
        .replace("×", "x")
        .replace("'", "*")
        .replace("’", "*")
        .replace("°", "*")
        .replace("+", "*")
    )


def clean_dimension(raw: str) -> int:
    value = int(re.sub(r"\D", "", raw) or "0")
    if value > 3000 and len(raw) >= 4:
        trimmed = int(re.sub(r"\D", "", raw[:-1]) or "0")
        if valid_dimension(trimmed):
            return trimmed
    return value


def split_compact_size(value: str) -> tuple[int, int] | None:
    candidates: list[tuple[int, int, int]] = []
    for split_at in range(2, min(4, len(value) - 2) + 1):
        width = int(value[:split_at])
        height = int(value[split_at:])
        if valid_dimension(width) and valid_dimension(height):
            score = 0
            if len(value[split_at:]) == 3:
                score += 2
            if len(value[:split_at]) in {3, 4}:
                score += 1
            candidates.append((score, width, height))
    if not candidates:
        return None
    _, width, height = max(candidates, key=lambda item: item[0])
    return width, height


def valid_dimension(value: int) -> bool:
    return 120 <= value <= 3000


def nearest_order(size: SizeLabel, orders: list[Label]) -> Label | None:
    candidates = [
        order
        for order in orders
        if order.line.cy <= size.line.cy + 8
        and abs(order.line.cx - size.line.cx) <= max(58.0, size.line.width * 1.4)
        and size.line.cy - order.line.cy <= 95
    ]
    if not candidates:
        candidates = [
            order
            for order in orders
            if order.line.cy <= size.line.cy + 16
            and abs(order.line.cx - size.line.cx) <= 85
            and size.line.cy - order.line.cy <= 140
        ]
    if not candidates:
        return None
    return min(candidates, key=lambda order: (abs(order.line.cx - size.line.cx), size.line.cy - order.line.cy))


def nearest_detail(size: SizeLabel, details: list[Label], order: Label) -> Label | None:
    top = min(order.line.cy, size.line.cy) - 18
    bottom = size.line.cy + 12
    candidates = [
        detail
        for detail in details
        if top <= detail.line.cy <= bottom
        and abs(detail.line.cx - size.line.cx) <= max(45.0, size.line.width * 1.15)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda detail: (abs(detail.line.cx - size.line.cx), abs(detail.line.cy - size.line.cy)))


def extract_comments(lines: list[OcrLine]) -> list[str]:
    comments: list[str] = []
    for line in lines:
        folded = line.text.casefold()
        if any(marker in folded for marker in ("весь", "присад", "сверл", "передел", "хдф", "мдф", "лдсп")):
            comments.append(line.text)
    return dedupe(comments)[:30]


def extract_material(lines: list[OcrLine]) -> str | None:
    haystack = " ".join(line.text for line in lines).casefold()
    if "хдф" in haystack or "hdf" in haystack:
        return "ХДФ"
    if "лдсп" in haystack:
        return "ЛДСП"
    if "мдф" in haystack or "mdf" in haystack:
        return "МДФ"
    return None


def extract_doweling_links(lines: list[OcrLine]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for line in lines:
        for match in DOWELING_RE.finditer(line.text):
            result.append({"orderName": match.group("order"), "dowelingNumber": match.group("number")})
    seen: set[tuple[str, str]] = set()
    unique: list[dict[str, str]] = []
    for link in result:
        key = (link["orderName"], link["dowelingNumber"])
        if key not in seen:
            seen.add(key)
            unique.append(link)
    return unique[:30]


def is_ui_line(text: str) -> bool:
    folded = text.casefold()
    stripped = text.strip()
    return (
        "cnc#" in folded
        or ".txt" in folded
        or "kb" in folded
        or bool(re.fullmatch(r"\d{1,2}:\d{2}", stripped))
    )


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def empty_result(warnings: list[str]) -> dict[str, Any]:
    return {
        "items": [],
        "comments": [],
        "analysisWarnings": warnings,
        "materialName": None,
        "machine": None,
        "dowelingLinks": [],
    }


if __name__ == "__main__":
    main()
