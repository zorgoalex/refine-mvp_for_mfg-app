from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


TOOL_RE = re.compile(r"(?<![A-Z])T(\d{1,3})(?!\d)", re.IGNORECASE)
SPINDLE_RE = re.compile(r"(?<![A-Z])S(\d{3,6})(?!\d)", re.IGNORECASE)
AXIS_RE = re.compile(r"\b([XYZ])\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE)
ORDER_RE = re.compile(r"(?<!\d)(\d{4,})(?!\d)")
MACHINE_RE = re.compile(r"\bCNC\s*#?\s*(\d+)", re.IGNORECASE)
GCODE_EXTENSIONS = {".txt", ".nc", ".cnc", ".tap", ".gcode"}


@dataclass(frozen=True)
class Tool:
    toolNumber: int
    spindleRpm: int | None = None


@dataclass(frozen=True)
class SizeCandidate:
    widthMm: float
    heightMm: float
    quantity: int


@dataclass(frozen=True)
class GcodeAnalysis:
    tools: list[Tool]
    order_names: list[str]
    machine: str | None
    bounds_width_mm: float | None
    bounds_height_mm: float | None
    size_candidates: list[SizeCandidate]
    warnings: list[str]


def is_gcode_filename(filename: str | None) -> bool:
    if not filename:
        return False
    return Path(filename).suffix.lower() in GCODE_EXTENSIONS


def parse_gcode_text(text: str, program_name: str | None = None) -> GcodeAnalysis:
    tools = parse_tools(text)
    points, contour_boxes = parse_motion_boxes(text)
    bounds = axis_bounds(points)
    return GcodeAnalysis(
        tools=tools,
        order_names=extract_order_names(program_name or ""),
        machine=infer_machine(program_name or ""),
        bounds_width_mm=bounds[0],
        bounds_height_mm=bounds[1],
        size_candidates=size_candidates(contour_boxes),
        warnings=[],
    )


def parse_tools(text: str) -> list[Tool]:
    rpm_by_tool: dict[int, int | None] = {}
    current_tool: int | None = None
    for line in text.splitlines():
        tool_match = TOOL_RE.search(line)
        if tool_match:
            current_tool = int(tool_match.group(1))
            rpm_by_tool.setdefault(current_tool, None)
        spindle_match = SPINDLE_RE.search(line)
        if spindle_match and current_tool is not None:
            rpm_by_tool[current_tool] = int(spindle_match.group(1))
    return [Tool(toolNumber=tool, spindleRpm=rpm_by_tool[tool]) for tool in sorted(rpm_by_tool)]


def extract_order_names(text: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for match in ORDER_RE.finditer(text):
        value = match.group(1)
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def infer_machine(text: str) -> str | None:
    match = MACHINE_RE.search(text)
    return f"CNC#{int(match.group(1))}" if match else None


def parse_motion_boxes(text: str) -> tuple[list[tuple[float, float]], list[tuple[float, float, float, float]]]:
    points: list[tuple[float, float]] = []
    contour_points: list[tuple[float, float]] = []
    contour_boxes: list[tuple[float, float, float, float]] = []
    x: float | None = None
    y: float | None = None
    z: float | None = None
    active = False

    for line in text.splitlines():
        axes = {axis.upper(): float(value) for axis, value in AXIS_RE.findall(line)}
        previous_active = active
        if "X" in axes:
            x = axes["X"]
        if "Y" in axes:
            y = axes["Y"]
        if "Z" in axes:
            z = axes["Z"]
            active = z < 0

        if previous_active and not active:
            append_contour_box(contour_points, contour_boxes)
            contour_points = []

        if x is not None and y is not None and ("X" in axes or "Y" in axes):
            points.append((x, y))
            if active:
                contour_points.append((x, y))

    if active:
        append_contour_box(contour_points, contour_boxes)

    return points, contour_boxes


def append_contour_box(
    contour_points: list[tuple[float, float]],
    contour_boxes: list[tuple[float, float, float, float]],
) -> None:
    if len(contour_points) < 2:
        return
    xs = [point[0] for point in contour_points]
    ys = [point[1] for point in contour_points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    if max_x - min_x >= 10 and max_y - min_y >= 10:
        contour_boxes.append((min_x, min_y, max_x, max_y))


def axis_bounds(points: list[tuple[float, float]]) -> tuple[float | None, float | None]:
    if not points:
        return None, None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2)


def size_candidates(boxes: list[tuple[float, float, float, float]]) -> list[SizeCandidate]:
    unique_boxes: set[tuple[int, int, int, int]] = set()
    counts: dict[tuple[float, float], int] = {}
    for min_x, min_y, max_x, max_y in boxes:
        box_key = (round(min_x), round(min_y), round(max_x), round(max_y))
        if box_key in unique_boxes:
            continue
        unique_boxes.add(box_key)
        width = round(max_x - min_x, 2)
        height = round(max_y - min_y, 2)
        size_key = normalize_size(width, height)
        counts[size_key] = counts.get(size_key, 0) + 1
    return [
        SizeCandidate(widthMm=width, heightMm=height, quantity=quantity)
        for (width, height), quantity in sorted(counts.items())
    ]


def normalize_size(width: float, height: float) -> tuple[float, float]:
    return round(width, 2), round(height, 2)
