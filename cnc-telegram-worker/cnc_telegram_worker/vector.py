from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DETAIL_HEADER_RE = re.compile(r"(?P<order>\d{4,})#(?P<detail>\d{1,5})#")
DETAIL_SIZE_RE = re.compile(r"@(?P<width>\d+(?:[.,]\d+)?)\*(?P<height>\d+(?:[.,]\d+)?)@")
NUMBER_RE = re.compile(r"-?\d+(?:[.,]\d+)?")
MATRIX_RE = re.compile(r"matrix\(([^)]+)\)", re.IGNORECASE)
GEOMETRY_TAGS = {"rect", "polygon", "polyline"}
COREL_UNIT_PER_MM = 100


@dataclass(frozen=True)
class VectorItem:
    order_name: str
    detail_number: int
    width_mm: float | None
    height_mm: float | None
    source_element_id: str
    x_mm: float | None = None
    y_mm: float | None = None


def parse_vector_file(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() != ".svg":
        return []
    return [item_to_dict(item) for item in parse_svg_parts(path)]


def parse_svg_parts(path: Path) -> list[VectorItem]:
    root = ET.parse(path).getroot()
    parts: list[VectorItem] = []
    seen_geometry: set[tuple[str, str, float | None, float | None, str]] = set()

    for element in root.iter():
        if local_name(element.tag) not in GEOMETRY_TAGS:
            continue
        element_id = element.attrib.get("id", "")
        if "PartContour" not in element_id:
            continue
        comments = detail_comments(element)
        if not comments:
            continue
        bbox = element_bbox(element)
        for comment in comments:
            parsed = parse_detail_comment(comment, bbox)
            if parsed is None:
                continue
            item = VectorItem(
                order_name=parsed["orderName"],
                detail_number=parsed["detailNumber"],
                width_mm=parsed["widthMm"],
                height_mm=parsed["heightMm"],
                source_element_id=element_id,
                x_mm=round(bbox[0] / COREL_UNIT_PER_MM, 2) if bbox else None,
                y_mm=round(bbox[1] / COREL_UNIT_PER_MM, 2) if bbox else None,
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

    return parts


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


def parse_detail_comment(comment: str, bbox: tuple[float, float, float, float] | None) -> dict[str, Any] | None:
    match = DETAIL_HEADER_RE.search(comment)
    if not match:
        return None
    size_match = DETAIL_SIZE_RE.search(comment)
    width = positive_float(size_match.group("width")) if size_match else None
    height = positive_float(size_match.group("height")) if size_match else None
    if (width is None or height is None) and bbox is not None:
        bbox_width = abs(bbox[2] - bbox[0]) / COREL_UNIT_PER_MM
        bbox_height = abs(bbox[3] - bbox[1]) / COREL_UNIT_PER_MM
        width = round(max(bbox_width, bbox_height), 2)
        height = round(min(bbox_width, bbox_height), 2)
    return {
        "orderName": match.group("order"),
        "detailNumber": int(match.group("detail")),
        "widthMm": width,
        "heightMm": height,
    }


def element_bbox(element: ET.Element) -> tuple[float, float, float, float] | None:
    if local_name(element.tag) == "rect":
        x = float_attr(element, "x")
        y = float_attr(element, "y")
        width = float_attr(element, "width")
        height = float_attr(element, "height")
        if x is None or y is None or width is None or height is None:
            return None
        points = [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
    else:
        points = parse_points(element.attrib.get("points", ""))
        if not points:
            return None

    transform = parse_matrix(element.attrib.get("transform"))
    if transform is not None:
        points = [apply_matrix(point, transform) for point in points]

    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def parse_points(value: str) -> list[tuple[float, float]]:
    numbers = [parse_float(match.group(0)) for match in NUMBER_RE.finditer(value)]
    finite = [number for number in numbers if number is not None and math.isfinite(number)]
    return list(zip(finite[0::2], finite[1::2]))


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


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]
