from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request


MAX_BYTES = int(os.environ.get("GLM_OCR_MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))
MAX_WAITING = int(os.environ.get("GLM_OCR_MAX_WAITING", "2"))
LLAMA_SERVER_URL = os.environ.get("LLAMA_SERVER_URL", "http://glm-ocr-llama:8080").rstrip("/")
LLAMA_MODEL = os.environ.get("GLM_OCR_MODEL_ALIAS", "glm-ocr")
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("GLM_OCR_TIMEOUT_SECONDS", "600"))
MAX_TOKENS = int(os.environ.get("GLM_OCR_MAX_TOKENS", "4096"))
USE_RESPONSE_FORMAT = os.environ.get("GLM_OCR_RESPONSE_FORMAT", "false").lower() in {"1", "true", "yes"}


app = FastAPI(title="erp-glm-ocr-runner")
_semaphore = asyncio.Semaphore(1)
_waiting = 0


@app.get("/health")
async def health() -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{LLAMA_SERVER_URL}/health")
        llama_ok = response.status_code < 500
    except Exception:
        llama_ok = False
    if not llama_ok:
        raise HTTPException(status_code=503, detail={"status": "degraded", "llama": False})
    return {"status": "ok" if llama_ok else "degraded", "llama": llama_ok, "model": "GLM-OCR Q8_0"}


@app.post("/ocr")
async def ocr(request: Request) -> dict[str, Any]:
    if not queue_slots_available():
        raise HTTPException(status_code=429, detail="glm ocr runner busy")
    data = await read_capped(request)
    if not data:
        raise HTTPException(status_code=400, detail="empty body")
    return await run_queued(data)


def queue_slots_available() -> bool:
    return _waiting < MAX_WAITING


async def read_capped(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="image too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BYTES:
            raise HTTPException(status_code=413, detail="image too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def run_queued(image: bytes) -> dict[str, Any]:
    global _waiting
    if not queue_slots_available():
        raise HTTPException(status_code=429, detail="glm ocr runner busy")
    _waiting += 1
    try:
        await _semaphore.acquire()
    except BaseException:
        _waiting -= 1
        raise
    _waiting -= 1
    try:
        return await run_glm_ocr(image)
    finally:
        _semaphore.release()


async def run_glm_ocr(image: bytes) -> dict[str, Any]:
    payload = build_chat_payload(image, use_response_format=USE_RESPONSE_FORMAT)
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        try:
            response = await client.post(f"{LLAMA_SERVER_URL}/v1/chat/completions", json=payload)
            if USE_RESPONSE_FORMAT and response.status_code in {400, 404, 422}:
                response = await client.post(
                    f"{LLAMA_SERVER_URL}/v1/chat/completions",
                    json=build_chat_payload(image, use_response_format=False),
                )
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail="glm ocr timed out") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail="llama server unavailable") from exc
        if response.status_code >= 500:
            raise HTTPException(status_code=503, detail="llama server unavailable")
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="llama server rejected request")
        data = response.json()
    content = extract_content(data)
    parsed = parse_json_object(content)
    if parsed is None:
        return empty_result(["GLM-OCR returned non-JSON output; packet needs review"])
    return normalize_result(parsed)


def build_chat_payload(image: bytes, use_response_format: bool) -> dict[str, Any]:
    image_url = "data:image/png;base64," + base64.b64encode(image).decode("ascii")
    payload: dict[str, Any] = {
        "model": LLAMA_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt()},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "repeat_penalty": 1.15,
    }
    if use_response_format:
        payload["response_format"] = {"type": "json_object"}
    return payload


def prompt() -> str:
    return (
        "You are an OCR parser for CNC sheet cutting screenshots. "
        "Return compact valid JSON only. No markdown, no prose, no raw OCR transcript. "
        "Extract one item per visible part/detail row. "
        "Use Russian order numbers as orderName. "
        "If a detail number is visible, put it into detailNumber. "
        "If width/height are visible, put millimeters into widthMm and heightMm. "
        "If quantity is visible, put quantity, otherwise 1. "
        "If a row is unclear, omit it and add a short warning. "
        "Detect materialName, machine, comments, dowelingLinks, and warnings. "
        "Stop immediately after the closing JSON object. "
        "Schema: {"
        "\"items\":[{\"sourceItemKey\":\"string\",\"orderName\":\"string\",\"detailNumber\":null,"
        "\"widthMm\":null,\"heightMm\":null,\"quantity\":1,\"confidence\":0.0}],"
        "\"comments\":[\"string\"],\"analysisWarnings\":[\"string\"],"
        "\"materialName\":null,\"machine\":null,"
        "\"dowelingLinks\":[{\"orderName\":\"string\",\"dowelingNumber\":\"string\"}]"
        "}."
    )


def extract_content(data: dict[str, Any]) -> str:
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict)).strip()
    return ""


def parse_json_object(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            value = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return None
    return value if isinstance(value, dict) else None


def normalize_result(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "items": normalize_items(value.get("items")),
        "comments": string_list(value.get("comments")),
        "analysisWarnings": string_list(value.get("analysisWarnings")),
        "materialName": optional_string(value.get("materialName")),
        "machine": optional_string(value.get("machine")),
        "dowelingLinks": normalize_doweling_links(value.get("dowelingLinks")),
    }


def empty_result(warnings: list[str]) -> dict[str, Any]:
    return {
        "items": [],
        "comments": [],
        "analysisWarnings": warnings,
        "materialName": None,
        "machine": None,
        "dowelingLinks": [],
    }


def normalize_items(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        order_name = optional_string(item.get("orderName"))
        raw_source_key = optional_string(item.get("sourceItemKey"))
        if not order_name:
            continue
        width = positive_float(item.get("widthMm"))
        height = positive_float(item.get("heightMm"))
        detail = positive_int(item.get("detailNumber"))
        source_as_order = likely_order_number(raw_source_key)
        order_as_detail = hash_detail_number(order_name)
        if source_as_order and order_as_detail and detail is None:
            order_name = source_as_order
            detail = order_as_detail
        quantity = positive_int(item.get("quantity")) or 1
        source_key = raw_source_key
        if source_key == order_name and detail is not None:
            source_key = None
        source_key = source_key or (
            f"ocr:{order_name}:{detail or 'na'}:{width or 0:g}x{height or 0:g}:{index}"
        )
        result.append({
            "sourceItemKey": source_key[:120],
            "orderName": order_name[:64],
            "detailNumber": detail,
            "widthMm": width,
            "heightMm": height,
            "quantity": quantity,
            "confidence": confidence(item.get("confidence")),
        })
    return result[:2000]


def normalize_doweling_links(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        order_name = optional_string(item.get("orderName"))
        number = optional_string(item.get("dowelingNumber"))
        if not order_name or not number:
            continue
        key = (order_name, number)
        if key in seen:
            continue
        seen.add(key)
        result.append({"orderName": order_name[:64], "dowelingNumber": number[:64]})
    return result[:50]


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip()[:500] for item in value if isinstance(item, str) and item.strip()][:100]


def optional_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def likely_order_number(value: str | None) -> str | None:
    if value is None:
        return None
    candidate = value.strip()
    return candidate if candidate.isdigit() and 3 <= len(candidate) <= 8 else None


def hash_detail_number(value: str | None) -> int | None:
    if value is None:
        return None
    candidate = value.strip().lstrip("#№").strip()
    return positive_int(candidate)


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


def confidence(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, parsed))
