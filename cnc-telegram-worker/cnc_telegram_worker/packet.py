from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

from .gcode import GcodeAnalysis, SizeCandidate, extract_order_names
from .ocr import OcrResult


ORDER_RE = re.compile(r"(?<!\d)(\d{4,})(?!\d)")
DETAIL_RE = re.compile(r"(?<!\d)(?:деталь|дет\.?|д)\s*#?\s*(\d{1,5})(?!\d)", re.IGNORECASE)
DOWELING_RE = re.compile(
    r"(?<!\d)(?P<order>\d{4,})(?!\d).{0,20}?(?:присадк[аи]|прис\.?|сверл[её]н\w*)\s*[:#№-]?\s*(?P<number>[\wА-Яа-я-]{1,32})",
    re.IGNORECASE,
)
MATERIAL_RE = re.compile(
    r"\b(?P<name>ХДФ|HDF|ЛДСП|LДСП|МДФ|MDF|фанера|plywood)(?:\s*(?P<thickness>\d{1,2}(?:[.,]\d+)?)\s*мм?)?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ImageMeta:
    chat_id: str
    message_id: int
    thread_id: int | None
    message_date: datetime
    edited_at: datetime | None
    text: str
    thumbs_up: bool


@dataclass(frozen=True)
class GcodeMeta:
    filename: str
    text: str
    analysis: GcodeAnalysis


def build_structured_packet(
    *,
    image: ImageMeta,
    workday: date,
    comments: list[str],
    ocr: OcrResult,
    gcode: GcodeMeta | None,
    default_machine: str,
    default_material: str,
    ocr_engine: str,
    parser_version: str,
) -> dict[str, Any]:
    source_updated_at = image.edited_at or image.message_date
    gcode_analysis = gcode.analysis if gcode else None
    comments = normalize_comments([image.text, *comments, *ocr.comments])
    order_names = collect_order_names(comments, ocr.items, gcode_analysis)
    last_order_names = detect_last_order_names(comments)
    material_name = ocr.material_name or infer_material(comments, gcode.filename if gcode else "", default_material)
    tools = [
        {"toolNumber": tool.toolNumber, "spindleRpm": tool.spindleRpm}
        for tool in (gcode_analysis.tools if gcode_analysis else [])
    ]
    warnings = normalize_comments([
        *ocr.analysis_warnings,
        *(gcode_analysis.warnings if gcode_analysis else []),
        *gcode_warnings(gcode_analysis, order_names),
    ], limit=100)
    items = normalize_ocr_items(ocr.items)
    if not items:
        items = fallback_items(order_names, gcode_analysis)
    if not items:
        items = [{
            "sourceItemKey": "unknown:needs-review",
            "orderName": "unknown",
            "detailNumber": None,
            "widthMm": None,
            "heightMm": None,
            "quantity": 1,
            "source": "manual",
            "confidence": 0,
            "matchStatus": "needs_review",
            "reviewNote": "No order number found in Telegram OCR, comments or G-code filename",
        }]
        warnings.append("No order number found; packet needs manual review")

    for order_name in last_order_names:
        comments.append(f"Весь заказ: {order_name}")

    if gcode_analysis and gcode_analysis.size_candidates and len(order_names) != 1:
        warnings.append(
            f"G-code has {sum(candidate.quantity for candidate in gcode_analysis.size_candidates)} size candidate(s), but order mapping requires OCR review"
        )

    machine = ocr.machine or (gcode_analysis.machine if gcode_analysis else None) or default_machine or None

    packet: dict[str, Any] = {
        "externalPacketKey": external_packet_key(image.chat_id, image.message_id),
        "source": {
            "chatId": image.chat_id,
            "messageId": image.message_id,
            "threadId": image.thread_id,
            "version": 1,
            "updatedAt": isoformat_utc(source_updated_at),
        },
        "workday": workday.isoformat(),
        "machine": machine,
        "programName": gcode.filename if gcode else None,
        "materialName": material_name,
        "parseStatus": "needs_review" if warnings or any(item.get("matchStatus") == "needs_review" for item in items) else "parsed",
        "completionStatus": "completed" if image.thumbs_up else "pending",
        "thumbsUp": image.thumbs_up,
        "completedAt": isoformat_utc(source_updated_at) if image.thumbs_up else None,
        "rework": has_rework(comments),
        "comments": comments[:50],
        "tools": tools[:50],
        "dowelingLinks": normalize_doweling_links([*detect_doweling_links(comments), *ocr.doweling_links]),
        "analysisWarnings": dedupe(warnings)[:100],
        "ocrEngine": ocr_engine,
        "parserVersion": parser_version,
        "items": items[:2000],
    }
    return packet


def external_packet_key(chat_id: str, message_id: int) -> str:
    return f"telegram:{chat_id}:{message_id}"


def canonical_payload_hash(packet: dict[str, Any]) -> str:
    payload = json.loads(json.dumps(packet, ensure_ascii=False))
    payload.pop("idempotencyKey", None)
    payload.get("source", {}).pop("version", None)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def apply_source_version(packet: dict[str, Any], source_version: int) -> dict[str, Any]:
    result = json.loads(json.dumps(packet, ensure_ascii=False))
    result["source"]["version"] = source_version
    return result


def idempotency_key(external_key: str, source_version: int) -> str:
    digest = hashlib.sha256(f"{external_key}:v{source_version}".encode("utf-8")).hexdigest()[:24]
    return f"cnc-tg-{digest}-v{source_version}"


def collect_order_names(
    comments: list[str],
    ocr_items: list[dict[str, Any]],
    gcode_analysis: GcodeAnalysis | None,
) -> list[str]:
    values: list[str] = []
    for comment in comments:
        values.extend(extract_order_names(comment))
    for item in ocr_items:
        order_name = item.get("orderName")
        if isinstance(order_name, str):
            values.extend(extract_order_names(order_name))
    if gcode_analysis:
        values.extend(gcode_analysis.order_names)
    return dedupe(values)


def detect_last_order_names(comments: list[str]) -> list[str]:
    result: list[str] = []
    for comment in comments:
        if "весь" in comment.casefold():
            result.extend(extract_order_names(comment))
    return dedupe(result)


def infer_material(comments: list[str], program_name: str, default_material: str) -> str:
    haystack = "\n".join([*comments, program_name])
    match = MATERIAL_RE.search(haystack)
    if not match:
        return default_material
    name = match.group("name").upper().replace("HDF", "ХДФ").replace("MDF", "МДФ")
    if name == "PLYWOOD":
        name = "фанера"
    thickness = match.group("thickness")
    if thickness:
        return f"{name} {thickness.replace(',', '.')}мм"
    if name == "ХДФ":
        return "ХДФ"
    return name


def has_rework(comments: list[str]) -> bool:
    return any("передел" in comment.casefold() for comment in comments)


def detect_doweling_links(comments: list[str]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for comment in comments:
        for match in DOWELING_RE.finditer(comment):
            result.append({
                "orderName": match.group("order"),
                "dowelingNumber": match.group("number"),
            })
    return result


def normalize_doweling_links(links: list[dict[str, Any]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for link in links:
        order_name = clean_string(link.get("orderName"), 64)
        number = clean_string(link.get("dowelingNumber"), 64)
        if not order_name or not number:
            continue
        key = (order_name, number)
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"orderName": order_name, "dowelingNumber": number})
    return normalized[:50]


def normalize_ocr_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        order_name = clean_string(item.get("orderName"), 64)
        if not order_name:
            continue
        width = positive_float(item.get("widthMm"))
        height = positive_float(item.get("heightMm"))
        detail_number = positive_int(item.get("detailNumber"))
        quantity = positive_int(item.get("quantity")) or 1
        match_order_id = positive_int(item.get("matchOrderId"))
        match_detail_id = positive_int(item.get("matchDetailId"))
        match_status = normalize_match_status(item.get("matchStatus"), match_order_id, match_detail_id)
        source_key = clean_string(item.get("sourceItemKey"), 120) or source_item_key(
            "ocr", order_name, detail_number, width, height, index
        )
        normalized.append({
            "sourceItemKey": source_key,
            "orderName": order_name,
            "detailNumber": detail_number,
            "widthMm": width,
            "heightMm": height,
            "quantity": quantity,
            "source": "ocr",
            "confidence": confidence(item.get("confidence"), default=0.5),
            "matchOrderId": match_order_id,
            "matchDetailId": match_detail_id if match_order_id is not None else None,
            "matchStatus": match_status,
            "reviewNote": clean_string(item.get("reviewNote"), 500),
        })
    return normalized


def fallback_items(order_names: list[str], gcode_analysis: GcodeAnalysis | None) -> list[dict[str, Any]]:
    if len(order_names) == 1 and gcode_analysis and gcode_analysis.size_candidates:
        return [
            gcode_item(order_names[0], candidate, index)
            for index, candidate in enumerate(gcode_analysis.size_candidates)
        ]
    return [
        {
            "sourceItemKey": f"placeholder:{order_name}",
            "orderName": order_name,
            "detailNumber": None,
            "widthMm": None,
            "heightMm": None,
            "quantity": 1,
            "source": "manual",
            "confidence": 0,
            "matchStatus": "needs_review",
            "reviewNote": "OCR did not return detail rows; placeholder from Telegram comments or G-code filename",
        }
        for order_name in order_names
    ]


def gcode_item(order_name: str, candidate: SizeCandidate, index: int) -> dict[str, Any]:
    return {
        "sourceItemKey": source_item_key("gcode", order_name, None, candidate.widthMm, candidate.heightMm, index),
        "orderName": order_name,
        "detailNumber": None,
        "widthMm": candidate.widthMm,
        "heightMm": candidate.heightMm,
        "quantity": candidate.quantity,
        "source": "gcode",
        "confidence": 0.35,
        "matchStatus": "needs_review",
        "reviewNote": "Size parsed from G-code; order/detail mapping requires OCR or manual review",
    }


def gcode_warnings(gcode_analysis: GcodeAnalysis | None, order_names: list[str]) -> list[str]:
    if not gcode_analysis:
        return ["No matching G-code file found near Telegram screenshot"]
    warnings: list[str] = []
    if not gcode_analysis.tools:
        warnings.append("G-code tool number not found")
    if not order_names:
        warnings.append("Order number not found in screenshot comments or G-code filename")
    return warnings


def normalize_comments(values: list[str], limit: int = 50) -> list[str]:
    result: list[str] = []
    for value in values:
        text = clean_string(value, 500)
        if text:
            result.append(text)
    return dedupe(result)[:limit]


def source_item_key(prefix: str, order_name: str, detail: int | None, width: float | None, height: float | None, index: int) -> str:
    parts = [prefix, order_name, str(detail or "na"), f"{width or 0:g}x{height or 0:g}", str(index)]
    return ":".join(parts)[:120]


def clean_string(value: Any, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.strip().split())
    return cleaned[:max_length] if cleaned else None


def positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def positive_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return round(parsed, 2) if parsed > 0 else None


def confidence(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(0, min(1, parsed))


def normalize_match_status(value: Any, match_order_id: int | None, match_detail_id: int | None) -> str:
    if value in {"unmatched", "matched", "conflict", "needs_review"}:
        status = value
    else:
        status = "unmatched"
    if status == "matched" and (match_order_id is None or match_detail_id is None):
        return "conflict"
    if status == "unmatched" and match_order_id is not None and match_detail_id is not None:
        return "matched"
    if status == "unmatched" and (match_order_id is not None or match_detail_id is not None):
        return "conflict"
    return status


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def isoformat_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
