from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DETAIL_HEADER_RE = re.compile(r"(?P<order>\d{4,})#(?P<detail>\d{1,5})#")
DETAIL_SIZE_RE = re.compile(r"@(?P<width>\d+(?:[.,]\d+)?)\*(?P<height>\d+(?:[.,]\d+)?)@")
NUMBER_RE = re.compile(r"-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?")
PATH_TOKEN_RE = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?")
MATRIX_RE = re.compile(r"matrix\(([^)]+)\)", re.IGNORECASE)
GEOMETRY_TAGS = {"rect", "polygon", "polyline", "path"}
LAYOUT_BOUNDS_TOLERANCE_MM = 2
DETAIL_SIZE_TOLERANCE_MM = 8

Matrix = tuple[float, float, float, float, float, float]


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
    layout = parse_svg_cut_layout(path)
    return layout.items if layout.status == "valid" else []


def parse_svg_cut_layout(path: Path) -> SvgCutLayout:
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
    seen_geometry: set[tuple[str, str, float | None, float | None, str]] = set()
    raw_comment_count = 0
    part_contour_count = 0
    rejected_detail_contour_reasons: set[str] = set()

    for element, matrix in traversed(root):
        if local_name(element.tag) not in GEOMETRY_TAGS:
            continue
        element_id = element.attrib.get("id", "")
        comments = detail_comments(element)
        raw_comment_count += len(comments)
        if "PartContour" not in element_id:
            continue
        part_contour_count += 1
        if not comments:
            continue
        raw_points = element_points(element)
        transformed = [apply_matrix(point, matrix) for point in raw_points]
        bbox = points_bbox(transformed)
        if bbox is None:
            if any(parse_detail_comment(comment, None) is not None for comment in comments):
                rejected_detail_contour_reasons.add("PartContour detail outlines have no geometry")
            continue
        x_mm = (bbox[0] - vb_min_x) / scale_x
        y_mm = (bbox[1] - vb_min_y) / scale_y
        placed_width_mm = abs(bbox[2] - bbox[0]) / scale_x
        placed_height_mm = abs(bbox[3] - bbox[1]) / scale_y
        parsed_comments = [
            parsed
            for comment in comments
            if (parsed := parse_detail_comment(comment, (placed_width_mm, placed_height_mm))) is not None
        ]
        if not parsed_comments:
            rejected_detail_contour_reasons.add("PartContour detail outlines have unreadable detail comments")
            continue
        inside_sheet = (
            x_mm >= -LAYOUT_BOUNDS_TOLERANCE_MM
            and y_mm >= -LAYOUT_BOUNDS_TOLERANCE_MM
            and x_mm + placed_width_mm <= sheet_width + LAYOUT_BOUNDS_TOLERANCE_MM
            and y_mm + placed_height_mm <= sheet_height + LAYOUT_BOUNDS_TOLERANCE_MM
        )
        if not inside_sheet:
            rejected_detail_contour_reasons.add("PartContour detail outlines outside sheet")
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

    reasons: list[str] = []
    if raw_comment_count == 0:
        reasons.append("no detail comments")
    if part_contour_count == 0:
        reasons.append("no PartContour detail outlines")
    reasons.extend(sorted(rejected_detail_contour_reasons))
    if part_contour_count > 0 and not parts:
        reasons.append("PartContour outlines exist but no placed detail passed geometry checks")

    return SvgCutLayout(
        status="valid" if parts and not reasons else "invalid",
        reasons=reasons,
        sheet_width_mm=round(sheet_width, 2),
        sheet_height_mm=round(sheet_height, 2),
        items=parts,
        raw_comment_count=raw_comment_count,
        part_contour_count=part_contour_count,
    )


def item_to_dict(item: VectorItem) -> dict[str, Any]:
    return {
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


def element_points(element: ET.Element) -> list[tuple[float, float]]:
    if local_name(element.tag) == "rect":
        x = float_attr(element, "x") or 0
        y = float_attr(element, "y") or 0
        width = float_attr(element, "width")
        height = float_attr(element, "height")
        if width is None or height is None or width <= 0 or height <= 0:
            return []
        return [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
    if local_name(element.tag) in {"polygon", "polyline"}:
        return parse_points(element.attrib.get("points", ""))
    if local_name(element.tag) == "path":
        return parse_path_points(element.attrib.get("d", ""))
    return []


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
    match = MATRIX_RE.search(value)
    if not match:
        return None
    numbers = [parse_float(part) for part in re.split(r"[,\s]+", match.group(1).strip()) if part]
    finite = [number for number in numbers if number is not None and math.isfinite(number)]
    if len(finite) != 6:
        return None
    return tuple(finite)  # type: ignore[return-value]


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
