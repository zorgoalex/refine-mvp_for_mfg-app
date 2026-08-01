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
IGNORED_ANALYSIS_WARNINGS = {
    "RapidOCR found text, but no detail rows with order and size",
}
VECTOR_ORDER_MAJORITY_RATIO = 0.5
OCR_VECTOR_SIZE_TOLERANCE_MM = 3


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


@dataclass(frozen=True)
class VectorValidation:
    items: list[dict[str, Any]]
    warnings: list[str]


def build_structured_packet(
    *,
    image: ImageMeta,
    workday: date,
    comments: list[str],
    ocr: OcrResult,
    gcode: GcodeMeta | None,
    cutting_sequence_no: int | None = None,
    vector_items: list[dict[str, Any]] | None = None,
    cut_layout: dict[str, Any] | None = None,
    sheet_image: dict[str, Any] | None = None,
    default_machine: str,
    default_material: str,
    ocr_engine: str,
    parser_version: str,
) -> dict[str, Any]:
    source_updated_at = image.edited_at or image.message_date
    gcode_analysis = gcode.analysis if gcode else None
    vector_items = vector_items or []
    raw_comments = normalize_comments([image.text, *comments, *ocr.comments])
    ocr_items = normalize_ocr_items(ocr.items)
    vector_validation = validate_vector_items(vector_items, ocr, ocr_items, gcode_analysis)
    accepted_vector_items = vector_validation.items
    structured_order_names = collect_structured_order_names(accepted_vector_items, ocr.items, gcode_analysis)
    order_names = collect_order_names(raw_comments, accepted_vector_items, ocr.items, gcode_analysis)
    last_order_names = detect_last_order_names(raw_comments)
    material_name = ocr.material_name or infer_material(raw_comments, gcode.filename if gcode else "", default_material)
    tools = [
        {"toolNumber": tool.toolNumber, "spindleRpm": tool.spindleRpm}
        for tool in (gcode_analysis.tools if gcode_analysis else [])
    ]
    items = reconcile_ocr_items_with_vector(ocr_items, accepted_vector_items)
    warnings = [
        warning
        for warning in normalize_comments(
            [
                *ocr.analysis_warnings,
                *vector_validation.warnings,
                *cut_layout_warnings(cut_layout),
                *(gcode_analysis.warnings if gcode_analysis else []),
                *gcode_warnings(gcode_analysis, order_names, has_items=bool(items)),
            ],
            limit=100,
        )
        if warning not in IGNORED_ANALYSIS_WARNINGS
    ]
    if not accepted_vector_items:
        items = reconcile_item_quantities_with_gcode(items, order_names, gcode_analysis)
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

    display_comments = [
        comment
        for comment in normalize_display_comments(raw_comments)
        if comment not in order_names
    ]
    for order_name in last_order_names:
        display_comments.append(f"Весь заказ: {order_name}")
    display_comments = dedupe(display_comments)

    machine = ocr.machine or (gcode_analysis.machine if gcode_analysis else None) or default_machine or None
    doweling_links = normalize_doweling_links(
        correct_doweling_order_names([*detect_doweling_links(raw_comments), *ocr.doweling_links], structured_order_names)
    )

    packet: dict[str, Any] = {
        "externalPacketKey": external_packet_key(image.chat_id, image.message_id),
        "source": {
            "chatId": image.chat_id,
            "messageId": image.message_id,
            "threadId": image.thread_id,
            "version": 1,
            "createdAt": isoformat_utc(image.message_date),
            "updatedAt": isoformat_utc(source_updated_at),
        },
        "workday": workday.isoformat(),
        "cuttingSequenceNo": cutting_sequence_no if cutting_sequence_no is not None and cutting_sequence_no > 0 else None,
        "machine": machine,
        "programName": gcode.filename if gcode else None,
        "materialName": material_name,
        "parseStatus": "needs_review" if warnings or any(item.get("matchStatus") == "needs_review" for item in items) else "parsed",
        "completionStatus": "completed" if image.thumbs_up else "pending",
        "thumbsUp": image.thumbs_up,
        "completedAt": isoformat_utc(source_updated_at) if image.thumbs_up else None,
        "rework": has_rework(raw_comments),
        "comments": display_comments[:50],
        "tools": tools[:50],
        "dowelingLinks": doweling_links,
        "analysisWarnings": dedupe(warnings)[:100],
        "ocrEngine": ocr_engine,
        "parserVersion": parser_version,
        "sheetImage": sheet_image,
        "items": items[:2000],
    }
    if cut_layout is not None:
        packet["cutLayout"] = cut_layout
    return packet


def external_packet_key(chat_id: str, message_id: int) -> str:
    return f"telegram:{chat_id}:{message_id}"


def canonical_payload_hash(packet: dict[str, Any]) -> str:
    payload = json.loads(json.dumps(packet, ensure_ascii=False))
    payload.pop("idempotencyKey", None)
    payload.pop("cuttingSequenceNo", None)
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
    vector_items: list[dict[str, Any]],
    ocr_items: list[dict[str, Any]],
    gcode_analysis: GcodeAnalysis | None,
) -> list[str]:
    values: list[str] = []
    for comment in comments:
        values.extend(extract_order_names_without_doweling_numbers(comment))
    for item in vector_items:
        order_name = item.get("orderName")
        if isinstance(order_name, str):
            values.extend(extract_order_names(order_name))
    for item in ocr_items:
        order_name = item.get("orderName")
        if isinstance(order_name, str):
            values.extend(extract_order_names(order_name))
    if gcode_analysis:
        values.extend(gcode_analysis.order_names)
    return dedupe(values)


def collect_structured_order_names(
    vector_items: list[dict[str, Any]],
    ocr_items: list[dict[str, Any]],
    gcode_analysis: GcodeAnalysis | None,
) -> list[str]:
    values: list[str] = []
    for item in vector_items:
        order_name = item.get("orderName")
        if isinstance(order_name, str):
            values.extend(extract_order_names(order_name))
    for item in ocr_items:
        order_name = item.get("orderName")
        if isinstance(order_name, str):
            values.extend(extract_order_names(order_name))
    if gcode_analysis:
        values.extend(gcode_analysis.order_names)
    return dedupe(values)


def validate_vector_items(
    vector_items: list[dict[str, Any]],
    ocr: OcrResult,
    ocr_items: list[dict[str, Any]],
    gcode_analysis: GcodeAnalysis | None,
) -> VectorValidation:
    normalized_vector_items = normalize_vector_items(vector_items)
    if not normalized_vector_items:
        return VectorValidation(items=[], warnings=[])

    vector_order_names = item_order_names(normalized_vector_items)
    reference_order_names = collect_ocr_order_names(ocr, ocr_items)
    reference_source = "OCR"
    if not reference_order_names and gcode_analysis and gcode_analysis.order_names:
        reference_order_names = dedupe(gcode_analysis.order_names)
        reference_source = "G-code filename"

    if not reference_order_names:
        return VectorValidation(
            items=normalized_vector_items,
            warnings=["SVG accepted without OCR or G-code order-number validation"],
        )

    if not order_majority_matches(reference_order_names, vector_order_names):
        return VectorValidation(
            items=[],
            warnings=[(
                "SVG ignored: order numbers do not match "
                f"{reference_source} majority "
                f"(reference={', '.join(reference_order_names)}; "
                f"svg={', '.join(vector_order_names)}; "
                f"overlap={', '.join(order_overlap(reference_order_names, vector_order_names)) or 'none'})"
            )],
        )

    reference_orders = set(reference_order_names)
    accepted_items = [
        item
        for item in normalized_vector_items
        if item.get("orderName") in reference_orders
    ]
    dropped_orders = [
        order_name
        for order_name in vector_order_names
        if order_name not in reference_orders
    ]
    warnings = [
        f"SVG rows ignored for orders outside {reference_source}: {', '.join(dropped_orders)}"
    ] if dropped_orders else []
    return VectorValidation(items=accepted_items, warnings=warnings)


def cut_layout_warnings(cut_layout: dict[str, Any] | None) -> list[str]:
    if not cut_layout:
        return []
    status = clean_string(cut_layout.get("status"), 32)
    if status == "valid":
        return []
    raw_reasons = cut_layout.get("reasons")
    reasons = raw_reasons if isinstance(raw_reasons, list) else []
    clean_reasons = [
        reason
        for reason in (clean_string(item, 200) for item in reasons)
        if reason
    ]
    if clean_reasons:
        return [f"SVG layout ignored: {'; '.join(clean_reasons[:3])}"]
    if status:
        return [f"SVG layout ignored: {status}"]
    return ["SVG layout ignored"]


def collect_ocr_order_names(ocr: OcrResult, ocr_items: list[dict[str, Any]]) -> list[str]:
    values = item_order_names(ocr_items)
    for comment in ocr.comments:
        values.extend(extract_order_names_without_doweling_numbers(comment))
    return dedupe(values)


def item_order_names(items: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for item in items:
        order_name = item.get("orderName")
        if isinstance(order_name, str):
            values.extend(extract_order_names(order_name))
    return dedupe(values)


def order_majority_matches(reference_order_names: list[str], vector_order_names: list[str]) -> bool:
    if not reference_order_names or not vector_order_names:
        return False
    overlap_count = len(order_overlap(reference_order_names, vector_order_names))
    return (
        overlap_count / len(reference_order_names) > VECTOR_ORDER_MAJORITY_RATIO
        and overlap_count / len(vector_order_names) > VECTOR_ORDER_MAJORITY_RATIO
    )


def order_overlap(left: list[str], right: list[str]) -> list[str]:
    right_set = set(right)
    return [order_name for order_name in left if order_name in right_set]


def extract_order_names_without_doweling_numbers(comment: str) -> list[str]:
    doweling_numbers = {
        link["dowelingNumber"]
        for link in detect_doweling_links([comment])
    }
    return [
        order_name
        for order_name in extract_order_names(comment)
        if order_name not in doweling_numbers
    ]


def detect_last_order_names(comments: list[str]) -> list[str]:
    result: list[str] = []
    for comment in comments:
        for segment in re.split(r"[.;\n]+", comment):
            if "весь" in segment.casefold():
                result.extend(extract_order_names(segment))
    return dedupe(result)


def normalize_display_comments(comments: list[str]) -> list[str]:
    result: list[str] = []
    for comment in comments:
        folded = comment.casefold()
        if (
            "весь" in folded
            or "присад" in folded
            or "сверл" in folded
        ):
            continue
        result.append(comment)
    return result


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
    normalized_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
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
        aggregate_detail_key = detail_number if detail_number is not None else f"unlabeled:{index}"
        aggregate_key = (
            order_name,
            aggregate_detail_key,
            width,
            height,
            match_order_id,
            match_detail_id if match_order_id is not None else None,
            match_status,
        )
        existing = normalized_by_key.get(aggregate_key)
        if existing is not None:
            existing["quantity"] = int(existing["quantity"]) + quantity
            existing["confidence"] = max(float(existing["confidence"]), confidence(item.get("confidence"), default=0.5))
            continue
        source_key = source_item_key("ocr", order_name, detail_number, width, height, len(normalized_by_key))
        normalized_by_key[aggregate_key] = {
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
        }
    return list(normalized_by_key.values())


def normalize_vector_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
    for index, item in enumerate(items):
        order_name = clean_string(item.get("orderName"), 64)
        if not order_name:
            continue
        width = positive_float(item.get("widthMm"))
        height = positive_float(item.get("heightMm"))
        detail_number = positive_int(item.get("detailNumber"))
        if detail_number is None:
            continue
        quantity = positive_int(item.get("quantity")) or 1
        aggregate_key = (order_name, detail_number, width, height)
        existing = normalized_by_key.get(aggregate_key)
        if existing is not None:
            existing["quantity"] = int(existing["quantity"]) + quantity
            existing["confidence"] = max(float(existing["confidence"]), confidence(item.get("confidence"), default=0.99))
            continue
        source_key = source_item_key("vector", order_name, detail_number, width, height, len(normalized_by_key))
        normalized_by_key[aggregate_key] = {
            "sourceItemKey": source_key,
            "orderName": order_name,
            "detailNumber": detail_number,
            "widthMm": width,
            "heightMm": height,
            "quantity": quantity,
            "source": "vector",
            "confidence": confidence(item.get("confidence"), default=0.99),
            "matchOrderId": positive_int(item.get("matchOrderId")),
            "matchDetailId": positive_int(item.get("matchDetailId")),
            "matchStatus": normalize_match_status(item.get("matchStatus"), None, None),
            "reviewNote": None,
        }
    return list(normalized_by_key.values())


def reconcile_ocr_items_with_vector(
    ocr_items: list[dict[str, Any]],
    vector_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not ocr_items:
        return vector_items
    if not vector_items:
        return ocr_items

    result: list[dict[str, Any]] = []
    used_vector_indexes: set[int] = set()
    for item in ocr_items:
        vector_match = unique_vector_match(item, vector_items, used_vector_indexes)
        if vector_match is None:
            result.append(item)
            continue
        vector_index, vector_item = vector_match
        used_vector_indexes.add(vector_index)
        result.append(correct_ocr_item_from_vector(item, vector_item))

    ocr_orders = set(item_order_names(ocr_items))
    for index, vector_item in enumerate(vector_items):
        if index in used_vector_indexes or vector_item.get("orderName") not in ocr_orders:
            continue
        added_item = dict(vector_item)
        added_item["reviewNote"] = "Added from SVG after OCR order validation"
        result.append(added_item)
    return result


def unique_vector_match(
    ocr_item: dict[str, Any],
    vector_items: list[dict[str, Any]],
    used_vector_indexes: set[int],
) -> tuple[int, dict[str, Any]] | None:
    matches = [
        (index, vector_item)
        for index, vector_item in enumerate(vector_items)
        if index not in used_vector_indexes and vector_item_matches_ocr(ocr_item, vector_item)
    ]
    return matches[0] if len(matches) == 1 else None


def vector_item_matches_ocr(ocr_item: dict[str, Any], vector_item: dict[str, Any]) -> bool:
    if ocr_item.get("orderName") != vector_item.get("orderName"):
        return False
    ocr_detail = positive_int(ocr_item.get("detailNumber"))
    vector_detail = positive_int(vector_item.get("detailNumber"))
    if ocr_detail is not None and vector_detail != ocr_detail:
        return False
    if ocr_detail is None and vector_detail is None:
        return False

    ocr_width = positive_float(ocr_item.get("widthMm"))
    ocr_height = positive_float(ocr_item.get("heightMm"))
    vector_width = positive_float(vector_item.get("widthMm"))
    vector_height = positive_float(vector_item.get("heightMm"))
    if ocr_width is None or ocr_height is None or vector_width is None or vector_height is None:
        return ocr_detail is not None and vector_detail == ocr_detail
    return same_size_with_tolerance(ocr_width, ocr_height, vector_width, vector_height, OCR_VECTOR_SIZE_TOLERANCE_MM)


def correct_ocr_item_from_vector(ocr_item: dict[str, Any], vector_item: dict[str, Any]) -> dict[str, Any]:
    result = dict(ocr_item)
    vector_detail = positive_int(vector_item.get("detailNumber"))
    vector_width = positive_float(vector_item.get("widthMm"))
    vector_height = positive_float(vector_item.get("heightMm"))
    if positive_int(result.get("detailNumber")) is None and vector_detail is not None:
        result["detailNumber"] = vector_detail
    if vector_width is not None:
        result["widthMm"] = vector_width
    if vector_height is not None:
        result["heightMm"] = vector_height
    result["quantity"] = positive_int(vector_item.get("quantity")) or positive_int(ocr_item.get("quantity")) or 1
    result["confidence"] = max(
        confidence(ocr_item.get("confidence"), default=0.5),
        confidence(vector_item.get("confidence"), default=0.99),
    )
    result["reviewNote"] = clean_string(ocr_item.get("reviewNote"), 500)
    return result


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


def reconcile_item_quantities_with_gcode(
    items: list[dict[str, Any]],
    order_names: list[str],
    gcode_analysis: GcodeAnalysis | None,
) -> list[dict[str, Any]]:
    if not items or not gcode_analysis or len(order_names) != 1:
        return items
    if any(item.get("orderName") != order_names[0] for item in items):
        return items
    candidates = gcode_analysis.size_candidates
    if not candidates:
        return items
    result = [dict(item) for item in items]
    item_indexes_by_candidate: dict[int, list[int]] = {}
    for index, item in enumerate(result):
        width = positive_float(item.get("widthMm"))
        height = positive_float(item.get("heightMm"))
        match_index = matching_size_candidate_index(width, height, candidates)
        if match_index is not None:
            item_indexes_by_candidate.setdefault(match_index, []).append(index)

    for candidate_index, item_indexes in item_indexes_by_candidate.items():
        if len(item_indexes) != 1:
            continue
        index = item_indexes[0]
        candidate = candidates[candidate_index]
        if candidate.quantity > int(result[index].get("quantity") or 0):
            result[index] = {**result[index], "quantity": candidate.quantity}
    return result


def matching_size_candidate_index(
    width: float | None,
    height: float | None,
    candidates: list[SizeCandidate],
) -> int | None:
    if width is None or height is None:
        return None
    matches = [
        index
        for index, candidate in enumerate(candidates)
        if same_size(width, height, candidate.widthMm, candidate.heightMm)
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def matching_size_candidate(
    width: float | None,
    height: float | None,
    candidates: list[SizeCandidate],
) -> SizeCandidate | None:
    match_index = matching_size_candidate_index(width, height, candidates)
    return candidates[match_index] if match_index is not None else None


def correct_doweling_order_names(
    links: list[dict[str, Any]],
    order_names: list[str],
) -> list[dict[str, Any]]:
    known_orders = [order for order in order_names if isinstance(order, str) and order.isdigit()]
    result: list[dict[str, Any]] = []
    for link in links:
        order_name = link.get("orderName")
        if not isinstance(order_name, str) or order_name in known_orders:
            result.append(link)
            continue
        replacement = nearest_known_order_name(order_name, known_orders)
        result.append({**link, "orderName": replacement or order_name})
    return result


def nearest_known_order_name(value: str, known_orders: list[str]) -> str | None:
    candidates = [
        order_name
        for order_name in known_orders
        if len(order_name) == len(value) and sum(left != right for left, right in zip(order_name, value)) == 1
    ]
    return candidates[0] if len(candidates) == 1 else None


def same_size(left_width: float, left_height: float, right_width: float, right_height: float) -> bool:
    return same_size_with_tolerance(left_width, left_height, right_width, right_height, 3)


def same_size_with_tolerance(
    left_width: float,
    left_height: float,
    right_width: float,
    right_height: float,
    tolerance_mm: float,
) -> bool:
    return abs(left_width - right_width) <= tolerance_mm and abs(left_height - right_height) <= tolerance_mm


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
        "matchStatus": "unmatched",
        "reviewNote": None,
    }


def gcode_warnings(gcode_analysis: GcodeAnalysis | None, order_names: list[str], *, has_items: bool) -> list[str]:
    warnings: list[str] = []
    if not gcode_analysis and not has_items:
        warnings.append("No matching G-code file found near Telegram screenshot")
    if not order_names:
        warnings.append("Order number not found in screenshot comments or G-code filename")
    return warnings


def normalize_comments(values: list[str], limit: int = 50) -> list[str]:
    result: list[str] = []
    for value in values:
        text = clean_string(value, 500)
        if text and text.casefold() in {"string", "null", "none"}:
            continue
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
