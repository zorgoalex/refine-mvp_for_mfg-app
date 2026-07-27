from __future__ import annotations

import asyncio
import json
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class OcrResult:
    items: list[dict[str, Any]] = field(default_factory=list)
    comments: list[str] = field(default_factory=list)
    analysis_warnings: list[str] = field(default_factory=list)
    material_name: str | None = None
    machine: str | None = None
    doweling_links: list[dict[str, Any]] = field(default_factory=list)


async def run_ocr_command(command_template: str, image_path: Path, timeout_seconds: float = 180.0) -> OcrResult:
    if not command_template:
        return OcrResult(analysis_warnings=["OCR command is not configured; packet needs review"])

    command = shlex.split(command_template.replace("{image}", shlex.quote(str(image_path))))
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        return OcrResult(analysis_warnings=[f"OCR command timed out after {int(timeout_seconds)}s"])

    if process.returncode != 0:
        note = stderr.decode("utf-8", errors="replace").strip().splitlines()
        suffix = f": {note[-1][:180]}" if note else ""
        return OcrResult(analysis_warnings=[f"OCR command failed with exit code {process.returncode}{suffix}"])

    try:
        data = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        return OcrResult(analysis_warnings=[f"OCR command returned invalid JSON: {exc.msg}"])

    if not isinstance(data, dict):
        return OcrResult(analysis_warnings=["OCR command JSON root must be an object"])

    return OcrResult(
        items=list_value(data.get("items")),
        comments=string_list(data.get("comments")),
        analysis_warnings=string_list(data.get("analysisWarnings")),
        material_name=optional_string(data.get("materialName")),
        machine=optional_string(data.get("machine")),
        doweling_links=list_value(data.get("dowelingLinks")),
    )


def list_value(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def optional_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
