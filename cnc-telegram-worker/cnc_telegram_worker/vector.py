from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any


DETAIL_HEADER_RE = re.compile(r"(?P<order>\d{4,})#(?P<detail>\d{1,5})#")
DETAIL_SIZE_RE = re.compile(r"@(?P<width>\d+(?:[.,]\d+)?)\*(?P<height>\d+(?:[.,]\d+)?)@")
VISUAL_SIZE_RE = re.compile(r"(?P<width>\d+(?:[.,]\d+)?)\s*[xхХX*×]\s*(?P<height>\d+(?:[.,]\d+)?)")
VISUAL_ORDER_RE = re.compile(r"\b(?P<order>\d{4,})\b")
VISUAL_DETAIL_RE = re.compile(r"(?:поз\.?|позиция|дет\.?|деталь|#)?\s*(?P<detail>\d{1,5})", re.IGNORECASE)
NUMBER_RE = re.compile(r"-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?")
PATH_TOKEN_RE = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?")
MATRIX_RE = re.compile(r"matrix\(([^)]+)\)", re.IGNORECASE)
TRANSFORM_RE = re.compile(r"([a-zA-Z]+)\(([^)]*)\)")
GEOMETRY_TAGS = {"rect", "polygon", "polyline", "path"}
SOURCE_SVG_FRAGMENT_TAGS = {"rect", "polygon", "polyline", "path", "line", "circle", "ellipse"}
LAYOUT_BOUNDS_TOLERANCE_MM = 2
DETAIL_SIZE_TOLERANCE_MM = 8
SHEET_OUTLINE_TOLERANCE_MM = 3
SOURCE_SVG_FRAGMENT_INTERSECTION_TOLERANCE_MM = 2
SOURCE_SVG_FRAGMENT_MAX_BODY_LENGTH = 60_000

Matrix = tuple[float, float, float, float, float, float]
Bbox = tuple[float, float, float, float]


@dataclass(frozen=True)
class SourceSvgFragment:
    view_box: dict[str, float]
    body: str


@dataclass(frozen=True)
class VisualTextLine:
    text: str
    x_mm: float
    y_mm: float


@dataclass(frozen=True)
class VisualDetailLabel:
    key: str
    order_name: str
    detail_number: int
    width_mm: float | None
    height_mm: float | None
    has_explicit_size: bool
    cx_mm: float
    cy_mm: float
    line_points_mm: list[tuple[float, float]]
    raw_lines: list[str]


@dataclass(frozen=True)
class ContourGeometry:
    element: ET.Element
    element_id: str
    group_key: str | None
    x_mm: float
    y_mm: float
    placed_width_mm: float
    placed_height_mm: float
    source_svg: SourceSvgFragment | None = None


@dataclass(frozen=True)
class VectorItem:
    order_name: str
    detail_number: int
    width_mm: float | None
    height_mm: float | None
    source_element_id: str
    x_mm: float | None = None
    y_mm: float | None = None
    placed_width_mm: float | None = None
    placed_height_mm: float | None = None
    rotated: bool = False
    source_svg: SourceSvgFragment | None = None
    visual_label: dict[str, Any] | None = None


@dataclass(frozen=True)
class SvgCutLayout:
    status: str
    reasons: list[str]
    sheet_width_mm: float | None
    sheet_height_mm: float | None
    items: list[VectorItem]
    raw_comment_count: int = 0
    part_contour_count: int = 0


def parse_vector_file(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() != ".svg":
        return []
    return [item_to_dict(item) for item in parse_svg_parts(path)]


def parse_svg_parts(path: Path) -> list[VectorItem]:
    layout = parse_svg_cut_layout(path, mode="strict")
    return layout.items if layout.status == "valid" else []


def parse_svg_cut_layout(path: Path, mode: str = "strict") -> SvgCutLayout:
    lenient = mode == "lenient"
    if path.suffix.lower() != ".svg":
        return SvgCutLayout(
            status="skipped",
            reasons=["not an SVG file"],
            sheet_width_mm=None,
            sheet_height_mm=None,
            items=[],
        )
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        return SvgCutLayout(
            status="invalid",
            reasons=[f"XML parse error: {exc}"],
            sheet_width_mm=None,
            sheet_height_mm=None,
            items=[],
        )

    sheet_width = parse_mm(root.attrib.get("width"))
    sheet_height = parse_mm(root.attrib.get("height"))
    view_box = parse_view_box(root.attrib.get("viewBox"))
    if sheet_width is None or sheet_height is None or view_box is None:
        return SvgCutLayout(
            status="invalid",
            reasons=["missing root width/height mm or viewBox"],
            sheet_width_mm=sheet_width,
            sheet_height_mm=sheet_height,
            items=[],
        )

    vb_min_x, vb_min_y, vb_width, vb_height = view_box
    if sheet_width <= 0 or sheet_height <= 0 or vb_width <= 0 or vb_height <= 0:
        return SvgCutLayout(
            status="invalid",
            reasons=["invalid root width/height or viewBox"],
            sheet_width_mm=sheet_width,
            sheet_height_mm=sheet_height,
            items=[],
        )
    scale_x = vb_width / sheet_width
    scale_y = vb_height / sheet_height

    parts: list[VectorItem] = []
    part_contours: list[ContourGeometry] = []
    generic_contours: list[ContourGeometry] = []
    seen_geometry: set[tuple[str, str, float | None, float | None, str]] = set()
    raw_comment_count = 0
    part_contour_count = 0
    rejected_detail_contour_reasons: set[str] = set()
    parent_map = build_parent_map(root)
    visual_labels = extract_visual_detail_labels(root, vb_min_x, vb_min_y, scale_x, scale_y) if lenient else []

    for element, matrix in traversed(root):
        if local_name(element.tag) not in GEOMETRY_TAGS:
            continue
        if has_ignored_geometry_ancestor(element, parent_map):
            continue
        element_id = element.attrib.get("id", "")
        is_part_contour = "PartContour" in element_id
        comments = detail_comments(element)
        raw_comment_count += len(comments)
        if not is_part_contour and not lenient:
            continue
        if is_part_contour:
            part_contour_count += 1
        raw_points = element_points(element)
        transformed = [apply_matrix(point, matrix) for point in raw_points]
        bbox = points_bbox(transformed)
        if bbox is None:
            if is_part_contour and any(parse_detail_comment(comment, None) is not None for comment in comments):
                rejected_detail_contour_reasons.add("PartContour detail outlines have no geometry")
            continue
        x_mm = (bbox[0] - vb_min_x) / scale_x
        y_mm = (bbox[1] - vb_min_y) / scale_y
        placed_width_mm = abs(bbox[2] - bbox[0]) / scale_x
        placed_height_mm = abs(bbox[3] - bbox[1]) / scale_y
        contour = ContourGeometry(
            element=element,
            element_id=element_id or f"{local_name(element.tag)}-{len(part_contours) + len(generic_contours) + 1}",
            group_key=part_contour_group_key(element, parent_map) if is_part_contour else None,
            x_mm=x_mm,
            y_mm=y_mm,
            placed_width_mm=placed_width_mm,
            placed_height_mm=placed_height_mm,
        )
        if not is_part_contour and not svg_geometry_is_detail_contour(contour, sheet_width, sheet_height, element_id, element.attrib.get("class", "")):
            continue
        parsed_comments = [
            parsed
            for comment in comments
            if (parsed := parse_detail_comment(comment, (placed_width_mm, placed_height_mm))) is not None
        ]
        if is_part_contour and not parsed_comments:
            rejected_detail_contour_reasons.add("PartContour detail outlines have unreadable detail comments")
        inside_sheet = (
            x_mm >= -LAYOUT_BOUNDS_TOLERANCE_MM
            and y_mm >= -LAYOUT_BOUNDS_TOLERANCE_MM
            and x_mm + placed_width_mm <= sheet_width + LAYOUT_BOUNDS_TOLERANCE_MM
            and y_mm + placed_height_mm <= sheet_height + LAYOUT_BOUNDS_TOLERANCE_MM
        )
        if not inside_sheet:
            if is_part_contour:
                rejected_detail_contour_reasons.add("PartContour detail outlines outside sheet")
            continue
        contour = replace(
            contour,
            source_svg=build_source_svg_fragment_for_contour(
                element,
                contour,
                root,
                parent_map,
                vb_min_x,
                vb_min_y,
                scale_x,
                scale_y,
            ),
        )
        if is_part_contour:
            part_contours.append(contour)
        elif lenient:
            generic_contours.append(contour)
        if not is_part_contour or not parsed_comments:
            continue
        matched_comment = False
        for parsed in parsed_comments:
            if not size_matches(parsed["widthMm"], parsed["heightMm"], placed_width_mm, placed_height_mm):
                continue
            matched_comment = True
            item = VectorItem(
                order_name=parsed["orderName"],
                detail_number=parsed["detailNumber"],
                width_mm=parsed["widthMm"],
                height_mm=parsed["heightMm"],
                source_element_id=element_id,
                x_mm=round(x_mm, 2),
                y_mm=round(y_mm, 2),
                placed_width_mm=round(placed_width_mm, 2),
                placed_height_mm=round(placed_height_mm, 2),
                rotated=round(placed_width_mm) == round(parsed["heightMm"])
                and round(placed_height_mm) == round(parsed["widthMm"]),
                source_svg=contour.source_svg,
            )
            key = (
                item.order_name,
                str(item.detail_number),
                item.width_mm,
                item.height_mm,
                item.source_element_id,
            )
            if key in seen_geometry:
                continue
            seen_geometry.add(key)
            parts.append(item)
        if not matched_comment:
            rejected_detail_contour_reasons.add("PartContour detail outline size does not match detail comment")

    if lenient and not parts:
        selected_contours = part_contours if part_contours else generic_contours
        parts, visual_reasons = build_items_from_visual_contours(selected_contours, visual_labels)
        rejected_detail_contour_reasons.update(visual_reasons)
        raw_comment_count = max(raw_comment_count, len(visual_labels))
        if part_contour_count == 0:
            part_contour_count = len(selected_contours)

    reasons: list[str] = []
    if raw_comment_count == 0 and not lenient:
        reasons.append("no detail comments")
    if part_contour_count == 0 and not lenient:
        reasons.append("no PartContour detail outlines")
    if lenient:
        if not visual_labels and not parts:
            reasons.append("no readable visual detail labels")
        if not part_contours and not generic_contours:
            reasons.append("no detail outlines")
        if (part_contours or generic_contours) and not parts:
            reasons.append("detail outlines exist but no detail passed lenient checks")
    else:
        reasons.extend(sorted(rejected_detail_contour_reasons))
    if not lenient and part_contour_count > 0 and not parts:
        reasons.append("PartContour outlines exist but no placed detail passed geometry checks")

    return SvgCutLayout(
        status="valid" if parts and (lenient or not reasons) else "invalid",
        reasons=reasons,
        sheet_width_mm=round(sheet_width, 2),
        sheet_height_mm=round(sheet_height, 2),
        items=parts,
        raw_comment_count=raw_comment_count,
        part_contour_count=part_contour_count,
    )


def item_to_dict(item: VectorItem) -> dict[str, Any]:
    result: dict[str, Any] = {
        "orderName": item.order_name,
        "detailNumber": item.detail_number,
        "widthMm": item.width_mm,
        "heightMm": item.height_mm,
        "quantity": 1,
        "confidence": 0.99,
        "sourceElementId": item.source_element_id,
        "xMm": item.x_mm,
        "yMm": item.y_mm,
        "placedWidthMm": item.placed_width_mm,
        "placedHeightMm": item.placed_height_mm,
        "rotated": item.rotated,
    }
    if item.source_svg is not None:
        result["sourceSvg"] = {
            "viewBox": item.source_svg.view_box,
            "body": item.source_svg.body,
        }
    if item.visual_label is not None:
        result["visualLabel"] = item.visual_label
    return result


def layout_to_dict(layout: SvgCutLayout) -> dict[str, Any]:
    return {
        "status": layout.status,
        "reasons": layout.reasons,
        "sheet": {
            "widthMm": layout.sheet_width_mm,
            "heightMm": layout.sheet_height_mm,
        } if layout.sheet_width_mm is not None and layout.sheet_height_mm is not None else None,
        "rawCommentCount": layout.raw_comment_count,
        "partContourCount": layout.part_contour_count,
        "acceptedItemCount": len(layout.items) if layout.status == "valid" else 0,
        "items": [item_to_dict(item) for item in layout.items] if layout.status == "valid" else [],
    }


def detail_comments(element: ET.Element) -> list[str]:
    comments: list[str] = []
    for child in element.iter():
        if local_name(child.tag) != "odm":
            continue
        if child.attrib.get("name") != "Comments":
            continue
        value = child.attrib.get("value")
        if value:
            comments.append(value)
    return comments


def parse_detail_comment(comment: str, bbox_size: tuple[float, float] | None) -> dict[str, Any] | None:
    match = DETAIL_HEADER_RE.search(comment)
    if not match:
        return None
    size_match = DETAIL_SIZE_RE.search(comment)
    width = positive_float(size_match.group("width")) if size_match else None
    height = positive_float(size_match.group("height")) if size_match else None
    if (width is None or height is None) and bbox_size is not None:
        width = round(max(bbox_size), 2)
        height = round(min(bbox_size), 2)
    return {
        "orderName": match.group("order"),
        "detailNumber": int(match.group("detail")),
        "widthMm": width,
        "heightMm": height,
    }


def build_items_from_visual_contours(
    contours: list[ContourGeometry],
    labels: list[VisualDetailLabel],
) -> tuple[list[VectorItem], set[str]]:
    items: list[VectorItem] = []
    rejected: set[str] = set()
    seen: set[str] = set()
    matches = match_visual_labels_to_contours(contours, labels) if labels else {}
    for index, contour in enumerate(contours):
        label = matches.get(id(contour))
        if label is None:
            if labels:
                rejected.add("detail contour has no readable visual label")
                continue
            fallback = VectorItem(
                order_name="SVG",
                detail_number=index + 1,
                width_mm=round(contour.placed_width_mm, 2),
                height_mm=round(contour.placed_height_mm, 2),
                source_element_id=contour.element_id,
                x_mm=round(contour.x_mm, 2),
                y_mm=round(contour.y_mm, 2),
                placed_width_mm=round(contour.placed_width_mm, 2),
                placed_height_mm=round(contour.placed_height_mm, 2),
                rotated=False,
                source_svg=contour.source_svg,
            )
            key = f"{fallback.order_name}:{fallback.detail_number}:{fallback.width_mm}:{fallback.height_mm}:{fallback.source_element_id}"
            if key in seen:
                continue
            seen.add(key)
            items.append(fallback)
            rejected.add("detail contour has no readable visual label; created informational SVG item")
            continue
        width_mm, height_mm = resolve_visual_label_size(label, contour)
        item = VectorItem(
            order_name=label.order_name,
            detail_number=label.detail_number,
            width_mm=width_mm,
            height_mm=height_mm,
            source_element_id=contour.element_id,
            x_mm=round(contour.x_mm, 2),
            y_mm=round(contour.y_mm, 2),
            placed_width_mm=round(contour.placed_width_mm, 2),
            placed_height_mm=round(contour.placed_height_mm, 2),
            rotated=round(contour.placed_width_mm) == round(height_mm)
            and round(contour.placed_height_mm) == round(width_mm),
            source_svg=contour.source_svg,
            visual_label={"rawLines": [line for line in label.raw_lines if line][:4]},
        )
        key = f"{item.order_name}:{item.detail_number}:{item.width_mm}:{item.height_mm}:{item.source_element_id}"
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    return items, rejected


def extract_visual_detail_labels(
    root: ET.Element,
    vb_min_x: float,
    vb_min_y: float,
    scale_x: float,
    scale_y: float,
) -> list[VisualDetailLabel]:
    return group_visual_detail_labels(collect_visual_text_lines(root, vb_min_x, vb_min_y, scale_x, scale_y))


def collect_visual_text_lines(
    root: ET.Element,
    vb_min_x: float,
    vb_min_y: float,
    scale_x: float,
    scale_y: float,
) -> list[VisualTextLine]:
    lines: list[VisualTextLine] = []
    for element, matrix in traversed(root):
        if local_name(element.tag) != "text":
            continue
        for text, x, y in split_text_element_lines(element):
            normalized = normalize_visual_text(text)
            if not normalized:
                continue
            point = apply_matrix((x, y), matrix)
            lines.append(VisualTextLine(
                text=normalized,
                x_mm=round((point[0] - vb_min_x) / scale_x, 2),
                y_mm=round((point[1] - vb_min_y) / scale_y, 2),
            ))
    return lines


def split_text_element_lines(element: ET.Element) -> list[tuple[str, float, float]]:
    tspans = [child for child in list(element) if local_name(child.tag) == "tspan"]
    parent_x = coordinate_attr(element, "x") or 0
    parent_y = coordinate_attr(element, "y") or 0
    if not tspans:
        return [("".join(element.itertext()), parent_x, parent_y)]

    lines: list[tuple[str, float, float]] = []
    x = parent_x
    y = parent_y
    current_text: str | None = None
    current_x = x
    current_y = y
    for tspan in tspans:
        text = "".join(tspan.itertext())
        explicit_x = coordinate_attr(tspan, "x")
        explicit_y = coordinate_attr(tspan, "y")
        dx = coordinate_attr(tspan, "dx")
        dy = coordinate_attr(tspan, "dy")
        starts_new_line = (
            current_text is None
            or explicit_x is not None
            or explicit_y is not None
            or (dy is not None and abs(dy) > 0.001)
        )
        if explicit_x is not None:
            x = explicit_x
        elif dx is not None:
            x += dx
        if explicit_y is not None:
            y = explicit_y
        elif dy is not None:
            y += dy
        if starts_new_line:
            if current_text is not None:
                lines.append((current_text, current_x, current_y))
            current_text = text
            current_x = x
            current_y = y
        else:
            current_text = (current_text or "") + text
    if current_text is not None:
        lines.append((current_text, current_x, current_y))
    return lines


def group_visual_detail_labels(lines: list[VisualTextLine]) -> list[VisualDetailLabel]:
    sorted_lines = sorted(lines, key=lambda line: (line.y_mm, line.x_mm))
    labels: list[VisualDetailLabel] = []
    for size_line in sorted_lines:
        size = parse_visual_size_line(size_line.text)
        if size is None:
            continue
        width_mm, height_mm = size
        max_x_delta = max(35, min(180, max(width_mm, height_mm) * 0.35))
        max_y_delta = max(20, min(220, max(width_mm, height_mm) * 0.35))
        upper = sorted(
            [
                line
                for line in sorted_lines
                if line.y_mm < size_line.y_mm
                and size_line.y_mm - line.y_mm <= max_y_delta
                and abs(line.x_mm - size_line.x_mm) <= max_x_delta
            ],
            key=lambda line: -line.y_mm,
        )
        detail_line = next((line for line in upper if parse_visual_detail_line(line.text) is not None), None)
        if detail_line is None:
            continue
        order_line = next(
            (line for line in upper if line.y_mm < detail_line.y_mm and parse_visual_order_line(line.text) is not None),
            None,
        )
        if order_line is None:
            continue
        order_name = parse_visual_order_line(order_line.text)
        detail_number = parse_visual_detail_line(detail_line.text)
        if order_name is None or detail_number is None:
            continue
        labels.append(VisualDetailLabel(
            key=f"{order_name}:{detail_number}:{width_mm}:{height_mm}:{round(size_line.x_mm, 2)}:{round(size_line.y_mm, 2)}",
            order_name=order_name,
            detail_number=detail_number,
            width_mm=width_mm,
            height_mm=height_mm,
            has_explicit_size=True,
            cx_mm=round((order_line.x_mm + detail_line.x_mm + size_line.x_mm) / 3, 2),
            cy_mm=round((order_line.y_mm + detail_line.y_mm + size_line.y_mm) / 3, 2),
            line_points_mm=[
                (order_line.x_mm, order_line.y_mm),
                (detail_line.x_mm, detail_line.y_mm),
                (size_line.x_mm, size_line.y_mm),
            ],
            raw_lines=[order_line.text, detail_line.text, size_line.text],
        ))

    for detail_line in sorted_lines:
        detail_number = parse_visual_detail_line(detail_line.text)
        if detail_number is None:
            continue
        order_line = find_visual_order_line_for_detail(sorted_lines, detail_line)
        if order_line is None:
            continue
        order_name = parse_visual_order_line(order_line.text)
        if order_name is None:
            continue
        cx = (order_line.x_mm + detail_line.x_mm) / 2
        cy = (order_line.y_mm + detail_line.y_mm) / 2
        if any(
            label.has_explicit_size
            and label.order_name == order_name
            and label.detail_number == detail_number
            and abs(label.cx_mm - cx) <= 260
            and abs(label.cy_mm - cy) <= 180
            for label in labels
        ):
            continue
        labels.append(VisualDetailLabel(
            key=f"{order_name}:{detail_number}:no-size:{round(detail_line.x_mm, 2)}:{round(detail_line.y_mm, 2)}",
            order_name=order_name,
            detail_number=detail_number,
            width_mm=None,
            height_mm=None,
            has_explicit_size=False,
            cx_mm=round(cx, 2),
            cy_mm=round(cy, 2),
            line_points_mm=[(order_line.x_mm, order_line.y_mm), (detail_line.x_mm, detail_line.y_mm)],
            raw_lines=[order_line.text, detail_line.text],
        ))
    return dedupe_visual_labels(labels)


def find_visual_order_line_for_detail(lines: list[VisualTextLine], detail_line: VisualTextLine) -> VisualTextLine | None:
    candidates = [
        line
        for line in lines
        if line.y_mm < detail_line.y_mm
        and detail_line.y_mm - line.y_mm <= 160
        and abs(line.x_mm - detail_line.x_mm) <= 260
        and parse_visual_order_line(line.text) is not None
    ]
    return sorted(candidates, key=lambda line: (-line.y_mm, abs(line.x_mm - detail_line.x_mm)))[0] if candidates else None


def parse_visual_order_line(text: str) -> str | None:
    match = VISUAL_ORDER_RE.search(text)
    return match.group("order") if match else None


def parse_visual_detail_line(text: str) -> int | None:
    if parse_visual_size_line(text) is not None or parse_visual_order_line(text) is not None:
        return None
    match = VISUAL_DETAIL_RE.search(text)
    parsed = positive_float(match.group("detail")) if match else None
    return int(parsed) if parsed is not None and parsed.is_integer() else None


def parse_visual_size_line(text: str) -> tuple[float, float] | None:
    match = VISUAL_SIZE_RE.search(re.sub(r"\s+", "", text))
    if not match:
        return None
    width = positive_float(match.group("width"))
    height = positive_float(match.group("height"))
    return (width, height) if width is not None and height is not None else None


def dedupe_visual_labels(labels: list[VisualDetailLabel]) -> list[VisualDetailLabel]:
    seen: set[str] = set()
    out: list[VisualDetailLabel] = []
    for label in labels:
        if label.key in seen:
            continue
        seen.add(label.key)
        out.append(label)
    return out


def match_visual_labels_to_contours(
    contours: list[ContourGeometry],
    labels: list[VisualDetailLabel],
) -> dict[int, VisualDetailLabel]:
    matches: dict[int, VisualDetailLabel] = {}
    used: set[int] = set()
    for contour in sorted(contours, key=lambda item: item.placed_width_mm * item.placed_height_mm):
        candidates: list[tuple[float, VisualDetailLabel]] = []
        for label in labels:
            if id(label) in used:
                continue
            score = visual_label_contour_score(label, contour)
            if score is not None:
                candidates.append((score, label))
        if not candidates:
            continue
        _, label = sorted(candidates, key=lambda item: item[0])[0]
        matches[id(contour)] = label
        used.add(id(label))
    propagate_group_visual_matches(contours, matches)
    return matches


def propagate_group_visual_matches(
    contours: list[ContourGeometry],
    matches: dict[int, VisualDetailLabel],
) -> None:
    by_group: dict[str, list[ContourGeometry]] = {}
    for contour in contours:
        if contour.group_key:
            by_group.setdefault(contour.group_key, []).append(contour)
    for group in by_group.values():
        matched = [contour for contour in group if id(contour) in matches]
        if not matched:
            continue
        for contour in group:
            if id(contour) in matches:
                continue
            sibling = next((candidate for candidate in matched if same_contour_size(candidate, contour)), None)
            if sibling is None:
                continue
            label = matches.get(id(sibling))
            if label and label_fits_contour_size(label, contour):
                matches[id(contour)] = label


def visual_label_contour_score(label: VisualDetailLabel, contour: ContourGeometry) -> float | None:
    center_x = contour.x_mm + contour.placed_width_mm / 2
    center_y = contour.y_mm + contour.placed_height_mm / 2
    distance = math.hypot(label.cx_mm - center_x, label.cy_mm - center_y)
    points = label.line_points_mm or [(label.cx_mm, label.cy_mm)]
    inside_tolerance = max(10, min(contour.placed_width_mm, contour.placed_height_mm) * 0.2)
    near_tolerance = max(35, min(220, min(contour.placed_width_mm, contour.placed_height_mm) * 0.45))
    min_contour_distance = min(point_distance_to_contour(x, y, contour) for x, y in points)
    inside = any(point_inside_contour(x, y, contour, inside_tolerance) for x, y in points) or point_inside_contour(
        label.cx_mm,
        label.cy_mm,
        contour,
        inside_tolerance,
    )
    max_center_distance = max(80, math.hypot(contour.placed_width_mm, contour.placed_height_mm) * 0.85)
    size_delta = visual_label_contour_size_delta(label, contour)
    if not (inside or min_contour_distance <= near_tolerance or distance <= max_center_distance):
        return None
    if (
        label.has_explicit_size
        and size_delta > max(120, min(contour.placed_width_mm, contour.placed_height_mm) * 0.5)
        and not inside
        and min_contour_distance > near_tolerance * 0.5
    ):
        return None
    size_penalty = min(size_delta, 200) * 3 if label.has_explicit_size and size_delta > DETAIL_SIZE_TOLERANCE_MM else 0
    return min_contour_distance * 3 + distance * 0.2 + size_penalty + (0 if inside else 25) + (0 if label.has_explicit_size else 40)


def same_contour_size(left: ContourGeometry, right: ContourGeometry) -> bool:
    return (
        abs(left.placed_width_mm - right.placed_width_mm) <= DETAIL_SIZE_TOLERANCE_MM
        and abs(left.placed_height_mm - right.placed_height_mm) <= DETAIL_SIZE_TOLERANCE_MM
    )


def label_fits_contour_size(label: VisualDetailLabel, contour: ContourGeometry) -> bool:
    if not label.has_explicit_size:
        return True
    return visual_label_contour_size_delta(label, contour) <= max(120, min(contour.placed_width_mm, contour.placed_height_mm) * 0.5)


def visual_label_contour_size_delta(label: VisualDetailLabel, contour: ContourGeometry) -> float:
    if not label.has_explicit_size or label.width_mm is None or label.height_mm is None:
        return 0
    expected = sorted([label.width_mm, label.height_mm])
    actual = sorted([contour.placed_width_mm, contour.placed_height_mm])
    return max(abs(expected[0] - actual[0]), abs(expected[1] - actual[1]))


def resolve_visual_label_size(label: VisualDetailLabel, contour: ContourGeometry) -> tuple[float, float]:
    if label.has_explicit_size and label.width_mm is not None and label.height_mm is not None:
        return label.width_mm, label.height_mm
    return round(max(contour.placed_width_mm, contour.placed_height_mm), 2), round(min(contour.placed_width_mm, contour.placed_height_mm), 2)


def point_inside_contour(x: float, y: float, contour: ContourGeometry, tolerance: float) -> bool:
    return (
        x >= contour.x_mm - tolerance
        and y >= contour.y_mm - tolerance
        and x <= contour.x_mm + contour.placed_width_mm + tolerance
        and y <= contour.y_mm + contour.placed_height_mm + tolerance
    )


def point_distance_to_contour(x: float, y: float, contour: ContourGeometry) -> float:
    dx = max(contour.x_mm - x, 0, x - (contour.x_mm + contour.placed_width_mm))
    dy = max(contour.y_mm - y, 0, y - (contour.y_mm + contour.placed_height_mm))
    return math.hypot(dx, dy)


def normalize_visual_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u00a0", " ")).strip()


def coordinate_attr(element: ET.Element, name: str) -> float | None:
    numbers = [parse_float(match.group(0)) for match in NUMBER_RE.finditer(element.attrib.get(name, ""))]
    return next((number for number in numbers if number is not None and math.isfinite(number)), None)


def element_points(element: ET.Element) -> list[tuple[float, float]]:
    tag = local_name(element.tag)
    if tag == "rect":
        x = float_attr(element, "x") or 0
        y = float_attr(element, "y") or 0
        width = float_attr(element, "width")
        height = float_attr(element, "height")
        if width is None or height is None or width <= 0 or height <= 0:
            return []
        return [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
    if tag in {"polygon", "polyline"}:
        return parse_points(element.attrib.get("points", ""))
    if tag == "path":
        return parse_path_points(element.attrib.get("d", ""))
    if tag == "line":
        x1 = float_attr(element, "x1")
        y1 = float_attr(element, "y1")
        x2 = float_attr(element, "x2")
        y2 = float_attr(element, "y2")
        return [] if x1 is None or y1 is None or x2 is None or y2 is None else [(x1, y1), (x2, y2)]
    if tag == "circle":
        cx = float_attr(element, "cx")
        cy = float_attr(element, "cy")
        r = float_attr(element, "r")
        if cx is None or cy is None or r is None or r <= 0:
            return []
        return [(cx - r, cy - r), (cx + r, cy + r)]
    if tag == "ellipse":
        cx = float_attr(element, "cx")
        cy = float_attr(element, "cy")
        rx = float_attr(element, "rx")
        ry = float_attr(element, "ry")
        if cx is None or cy is None or rx is None or ry is None or rx <= 0 or ry <= 0:
            return []
        return [(cx - rx, cy - ry), (cx + rx, cy + ry)]
    return []


def build_parent_map(root: ET.Element) -> dict[int, ET.Element]:
    return {id(child): parent for parent in root.iter() for child in list(parent)}


def has_ignored_geometry_ancestor(element: ET.Element, parent_map: dict[int, ET.Element]) -> bool:
    node = parent_map.get(id(element))
    while node is not None:
        marker = f"{node.attrib.get('id', '')} {node.attrib.get('class', '')}".lower()
        if any(token in marker for token in ("legend", "frame", "stamp", "titleblock", "размер", "razmer")):
            return True
        node = parent_map.get(id(node))
    return False


def svg_geometry_is_detail_contour(
    contour: ContourGeometry,
    sheet_width: float,
    sheet_height: float,
    element_id: str,
    class_name: str,
) -> bool:
    if (
        contour.placed_width_mm <= 0
        or contour.placed_height_mm <= 0
        or not math.isfinite(contour.x_mm)
        or not math.isfinite(contour.y_mm)
        or not math.isfinite(contour.placed_width_mm)
        or not math.isfinite(contour.placed_height_mm)
    ):
        return False
    covers_sheet = (
        abs(contour.x_mm) <= SHEET_OUTLINE_TOLERANCE_MM
        and abs(contour.y_mm) <= SHEET_OUTLINE_TOLERANCE_MM
        and abs(contour.placed_width_mm - sheet_width) <= SHEET_OUTLINE_TOLERANCE_MM * 2
        and abs(contour.placed_height_mm - sheet_height) <= SHEET_OUTLINE_TOLERANCE_MM * 2
    )
    if not covers_sheet:
        return True
    marker = f"{element_id} {class_name}".lower()
    return bool(element_id.strip()) and re.search(r"sheet|border|ramka|лист|str0", marker, re.IGNORECASE) is None


def part_contour_group_key(element: ET.Element, parent_map: dict[int, ET.Element]) -> str | None:
    node = parent_map.get(id(element))
    while node is not None and local_name(node.tag) != "svg":
        node_id = node.attrib.get("id", "").strip()
        if local_name(node.tag) == "g" and node_id and re.search(r"(?:^|[_-])(?:part|x007e).*part", node_id, re.IGNORECASE):
            return node_id
        node = parent_map.get(id(node))
    return None


def part_contour_source_group(element: ET.Element, parent_map: dict[int, ET.Element]) -> ET.Element:
    group_key = part_contour_group_key(element, parent_map)
    if not group_key:
        return parent_map.get(id(element), element)
    node = parent_map.get(id(element))
    while node is not None and local_name(node.tag) != "svg":
        if local_name(node.tag) == "g" and node.attrib.get("id", "").strip() == group_key:
            return node
        node = parent_map.get(id(node))
    return element


def build_source_svg_fragment_for_contour(
    element: ET.Element,
    contour: ContourGeometry,
    root: ET.Element,
    parent_map: dict[int, ET.Element],
    vb_min_x: float,
    vb_min_y: float,
    scale_x: float,
    scale_y: float,
) -> SourceSvgFragment | None:
    group = part_contour_source_group(element, parent_map)
    base_matrix = ancestor_matrix(group, root, parent_map)
    fragments: list[str] = []
    for child, matrix in traversed(group, base_matrix):
        if local_name(child.tag) not in SOURCE_SVG_FRAGMENT_TAGS:
            continue
        child_bbox = points_bbox([apply_matrix(point, matrix) for point in element_points(child)])
        if child_bbox is None:
            continue
        child_mm = bbox_to_mm(child_bbox, vb_min_x, vb_min_y, scale_x, scale_y)
        if not bboxes_intersect_mm(child_mm, contour, SOURCE_SVG_FRAGMENT_INTERSECTION_TOLERANCE_MM):
            continue
        sanitized = sanitize_source_svg_geometry_element(child)
        if not sanitized:
            continue
        transform = source_svg_element_matrix(matrix, vb_min_x, vb_min_y, scale_x, scale_y, contour)
        fragments.append(f'<g transform="{transform}">{sanitized}</g>')
        if len("".join(fragments)) > SOURCE_SVG_FRAGMENT_MAX_BODY_LENGTH:
            break
    body = "".join(fragments)
    if not body or len(body) > SOURCE_SVG_FRAGMENT_MAX_BODY_LENGTH:
        return None
    return SourceSvgFragment(
        view_box={
            "xMm": round(contour.x_mm, 2),
            "yMm": round(contour.y_mm, 2),
            "widthMm": round(contour.placed_width_mm, 2),
            "heightMm": round(contour.placed_height_mm, 2),
        },
        body=body,
    )


def ancestor_matrix(element: ET.Element, root: ET.Element, parent_map: dict[int, ET.Element]) -> Matrix:
    ancestors: list[ET.Element] = []
    node = parent_map.get(id(element))
    while node is not None and node is not root:
        ancestors.insert(0, node)
        node = parent_map.get(id(node))
    matrix = identity_matrix()
    for ancestor in ancestors:
        own = parse_matrix(ancestor.attrib.get("transform"))
        if own is not None:
            matrix = compose_matrix(matrix, own)
    return matrix


def bbox_to_mm(bbox: Bbox, vb_min_x: float, vb_min_y: float, scale_x: float, scale_y: float) -> Bbox:
    return (
        (bbox[0] - vb_min_x) / scale_x,
        (bbox[1] - vb_min_y) / scale_y,
        (bbox[2] - vb_min_x) / scale_x,
        (bbox[3] - vb_min_y) / scale_y,
    )


def bboxes_intersect_mm(bbox: Bbox, contour: ContourGeometry, tolerance: float) -> bool:
    left, top, right, bottom = bbox
    return (
        right >= contour.x_mm - tolerance
        and bottom >= contour.y_mm - tolerance
        and left <= contour.x_mm + contour.placed_width_mm + tolerance
        and top <= contour.y_mm + contour.placed_height_mm + tolerance
    )


def source_svg_element_matrix(
    matrix: Matrix,
    vb_min_x: float,
    vb_min_y: float,
    scale_x: float,
    scale_y: float,
    contour: ContourGeometry,
) -> str:
    a, b, c, d, e, f = matrix
    values = [
        a / scale_x,
        b / scale_y,
        c / scale_x,
        d / scale_y,
        (e - vb_min_x) / scale_x - contour.x_mm,
        (f - vb_min_y) / scale_y - contour.y_mm,
    ]
    return f"matrix({' '.join(svg_number(value) for value in values)})"


def sanitize_source_svg_geometry_element(element: ET.Element) -> str | None:
    tag = local_name(element.tag)
    if tag not in SOURCE_SVG_FRAGMENT_TAGS:
        return None
    attrs = source_svg_geometry_attrs(element, tag)
    if not attrs:
        return None
    return (
        f"<{tag} {' '.join(attrs)} fill=\"none\" stroke=\"#111827\" "
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'
    )


def source_svg_geometry_attrs(element: ET.Element, tag: str) -> list[str]:
    names_by_tag = {
        "rect": ["x", "y", "width", "height", "rx", "ry"],
        "polygon": ["points"],
        "polyline": ["points"],
        "path": ["d", "fill-rule", "clip-rule"],
        "line": ["x1", "y1", "x2", "y2"],
        "circle": ["cx", "cy", "r"],
        "ellipse": ["cx", "cy", "rx", "ry"],
    }
    attrs: list[str] = []
    for name in names_by_tag.get(tag, []):
        value = element.attrib.get(name)
        if value is None or not source_svg_attr_value_safe(value):
            continue
        attrs.append(f'{name}="{escape_svg_attr(value)}"')
    return attrs


def source_svg_attr_value_safe(value: str) -> bool:
    return re.search(r"[<>\"'`]|(?:javascript:|data:|https?:|file:)", value, re.IGNORECASE) is None


def escape_svg_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;")


def svg_number(value: float) -> str:
    rounded = round(value, 6)
    return str(int(rounded)) if float(rounded).is_integer() else str(rounded)


def points_bbox(points: list[tuple[float, float]]) -> tuple[float, float, float, float] | None:
    if not points:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def parse_view_box(value: str | None) -> tuple[float, float, float, float] | None:
    numbers = [parse_float(match.group(0)) for match in NUMBER_RE.finditer(value or "")]
    finite = [number for number in numbers if number is not None and math.isfinite(number)]
    return tuple(finite[:4]) if len(finite) >= 4 else None  # type: ignore[return-value]


def identity_matrix() -> Matrix:
    return (1, 0, 0, 1, 0, 0)


def compose_matrix(parent: Matrix, child: Matrix) -> Matrix:
    pa, pb, pc, pd, pe, pf = parent
    ca, cb, cc, cd, ce, cf = child
    return (
        pa * ca + pc * cb,
        pb * ca + pd * cb,
        pa * cc + pc * cd,
        pb * cc + pd * cd,
        pa * ce + pc * cf + pe,
        pb * ce + pd * cf + pf,
    )


def traversed(element: ET.Element, matrix: Matrix | None = None):
    base = matrix or identity_matrix()
    own_matrix = parse_matrix(element.attrib.get("transform"))
    current = compose_matrix(base, own_matrix) if own_matrix else base
    yield element, current
    for child in list(element):
        yield from traversed(child, current)


def parse_points(value: str) -> list[tuple[float, float]]:
    numbers = [parse_float(match.group(0)) for match in NUMBER_RE.finditer(value.replace(",", " "))]
    finite = [number for number in numbers if number is not None and math.isfinite(number)]
    return list(zip(finite[0::2], finite[1::2]))


def parse_path_points(value: str | None) -> list[tuple[float, float]]:
    tokens = PATH_TOKEN_RE.findall((value or "").replace(",", " "))
    if not tokens:
        return []
    points: list[tuple[float, float]] = []
    index = 0
    command: str | None = None
    x = 0.0
    y = 0.0
    start_x = 0.0
    start_y = 0.0

    def is_command(token: str) -> bool:
        return len(token) == 1 and token.isalpha()

    def read_number() -> float | None:
        nonlocal index
        if index >= len(tokens) or is_command(tokens[index]):
            return None
        number = parse_float(tokens[index])
        index += 1
        return number

    def read_pair(relative: bool) -> tuple[float, float] | None:
        left = read_number()
        right = read_number()
        if left is None or right is None:
            return None
        return (x + left, y + right) if relative else (left, right)

    while index < len(tokens):
        if is_command(tokens[index]):
            command = tokens[index]
            index += 1
        if command is None:
            return []

        relative = command.islower()
        op = command.upper()
        if op == "Z":
            x, y = start_x, start_y
            points.append((x, y))
            command = None
            continue

        consumed = False
        if op == "M":
            first = True
            while index < len(tokens) and not is_command(tokens[index]):
                pair = read_pair(relative)
                if pair is None:
                    return []
                x, y = pair
                if first:
                    start_x, start_y = x, y
                    first = False
                points.append((x, y))
                consumed = True
            command = "l" if relative else "L"
        elif op == "L":
            while index < len(tokens) and not is_command(tokens[index]):
                pair = read_pair(relative)
                if pair is None:
                    return []
                x, y = pair
                points.append((x, y))
                consumed = True
        elif op == "H":
            while index < len(tokens) and not is_command(tokens[index]):
                value = read_number()
                if value is None:
                    return []
                x = x + value if relative else value
                points.append((x, y))
                consumed = True
        elif op == "V":
            while index < len(tokens) and not is_command(tokens[index]):
                value = read_number()
                if value is None:
                    return []
                y = y + value if relative else value
                points.append((x, y))
                consumed = True
        elif op == "C":
            while index < len(tokens) and not is_command(tokens[index]):
                controls = [read_pair(relative), read_pair(relative), read_pair(relative)]
                if any(point is None for point in controls):
                    return []
                for point in controls:
                    assert point is not None
                    points.append(point)
                x, y = controls[-1]  # type: ignore[misc]
                consumed = True
        elif op in {"S", "Q"}:
            while index < len(tokens) and not is_command(tokens[index]):
                controls = [read_pair(relative), read_pair(relative)]
                if any(point is None for point in controls):
                    return []
                for point in controls:
                    assert point is not None
                    points.append(point)
                x, y = controls[-1]  # type: ignore[misc]
                consumed = True
        elif op == "T":
            while index < len(tokens) and not is_command(tokens[index]):
                pair = read_pair(relative)
                if pair is None:
                    return []
                x, y = pair
                points.append((x, y))
                consumed = True
        elif op == "A":
            while index < len(tokens) and not is_command(tokens[index]):
                values = [read_number() for _ in range(7)]
                if any(number is None for number in values):
                    return []
                end_x = values[5]
                end_y = values[6]
                assert end_x is not None and end_y is not None
                x = x + end_x if relative else end_x
                y = y + end_y if relative else end_y
                points.append((x, y))
                consumed = True
        else:
            return []

        if not consumed and index < len(tokens) and not is_command(tokens[index]):
            return []

    return points


def parse_matrix(value: str | None) -> tuple[float, float, float, float, float, float] | None:
    if not value:
        return None
    matrix = identity_matrix()
    matched = False
    for match in TRANSFORM_RE.finditer(value):
        name = match.group(1).lower()
        numbers = [parse_float(part) for part in re.split(r"[,\s]+", match.group(2).strip()) if part]
        finite = [number for number in numbers if number is not None and math.isfinite(number)]
        own = transform_matrix(name, finite)
        if own is None:
            continue
        matrix = compose_matrix(matrix, own)
        matched = True
    if matched:
        return matrix
    legacy = MATRIX_RE.search(value)
    if not legacy:
        return None
    numbers = [parse_float(part) for part in re.split(r"[,\s]+", legacy.group(1).strip()) if part]
    finite = [number for number in numbers if number is not None and math.isfinite(number)]
    return tuple(finite) if len(finite) == 6 else None  # type: ignore[return-value]


def transform_matrix(name: str, values: list[float]) -> Matrix | None:
    if name == "matrix" and len(values) == 6:
        return tuple(values)  # type: ignore[return-value]
    if name == "translate" and len(values) in {1, 2}:
        return (1, 0, 0, 1, values[0], values[1] if len(values) > 1 else 0)
    if name == "scale" and len(values) in {1, 2}:
        return (values[0], 0, 0, values[1] if len(values) > 1 else values[0], 0, 0)
    if name == "rotate" and len(values) in {1, 3}:
        angle = math.radians(values[0])
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        rotation: Matrix = (cos_a, sin_a, -sin_a, cos_a, 0, 0)
        if len(values) == 1:
            return rotation
        cx, cy = values[1], values[2]
        return compose_matrix(compose_matrix((1, 0, 0, 1, cx, cy), rotation), (1, 0, 0, 1, -cx, -cy))
    return None


def apply_matrix(
    point: tuple[float, float],
    matrix: tuple[float, float, float, float, float, float],
) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    x, y = point
    return (a * x + c * y + e, b * x + d * y + f)


def float_attr(element: ET.Element, name: str) -> float | None:
    return parse_float(element.attrib.get(name))


def positive_float(value: str | None) -> float | None:
    parsed = parse_float(value)
    if parsed is None or parsed <= 0:
        return None
    return round(parsed, 2)


def parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value.replace(",", "."))
    except ValueError:
        return None


def parse_mm(value: str | None) -> float | None:
    if not value:
        return None
    match = NUMBER_RE.search(value)
    if not match:
        return None
    parsed = parse_float(match.group(0))
    return round(parsed, 3) if parsed is not None else None


def size_matches(
    declared_width: float | None,
    declared_height: float | None,
    placed_width: float,
    placed_height: float,
) -> bool:
    if declared_width is None or declared_height is None:
        return True
    expected = sorted([declared_width, declared_height])
    actual = sorted([placed_width, placed_height])
    return max(abs(expected[0] - actual[0]), abs(expected[1] - actual[1])) <= DETAIL_SIZE_TOLERANCE_MM


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]
