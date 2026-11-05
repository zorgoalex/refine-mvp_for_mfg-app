from __future__ import annotations

import asyncio
from typing import Any

from .observation import MAX_OBSERVATION_MEDIA_BYTES, _HashBoundedSink, _message_batch, _message_chat_id, _matches_role


MANUAL_SEND_OBSERVATION_TIMEOUT_SECONDS = 60.0
MANUAL_SEND_OBSERVATION_MAX_TOTAL_BYTES = 36 * 1024 * 1024
MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647


class ManualSendBindingError(RuntimeError):
    """Exact post-send media could not be safely bound to its send request."""


class ManualSendDeliveryAmbiguous(RuntimeError):
    """A dispatched send did not return an unambiguous bounded message ID set."""


def validated_transport_message_ids(sent_items: list[Any]) -> list[str]:
    """Return every actual send ID in dispatch order; never silently drop one."""
    result: list[str] = []
    seen: set[int] = set()
    for item in sent_items:
        message = getattr(item, "message", None)
        message_id = getattr(message, "id", None)
        if isinstance(message_id, bool) or not isinstance(message_id, int) or not 1 <= message_id <= MAX_TELEGRAM_MESSAGE_ID:
            raise ManualSendDeliveryAmbiguous("Telegram send returned a missing or invalid message ID")
        if message_id in seen:
            raise ManualSendDeliveryAmbiguous("Telegram send returned a duplicate message ID")
        seen.add(message_id)
        result.append(str(message_id))
    if not result:
        raise ManualSendDeliveryAmbiguous("Telegram send returned no message IDs")
    return result


async def bind_manual_svg_sent_files(
    client: Any,
    entity: Any,
    chat_id: str,
    requested_files: list[dict[str, Any]],
    sent_items: list[Any],
) -> list[dict[str, str]]:
    """Refetch exact outbound file messages and bind their real media bytes.

    The server maps roles from its immutable claim snapshot. This worker only
    reports the claimed file ID/source hash, its exact returned Telegram message
    ID, and the hash of bytes now present in that exact Telegram message.
    """
    if not isinstance(requested_files, list) or not 1 <= len(requested_files) <= 3:
        raise ManualSendBindingError("manual SVG task has an invalid observation file count")

    files_by_id: dict[str, dict[str, Any]] = {}
    for row in requested_files:
        if not isinstance(row, dict):
            raise ManualSendBindingError("manual SVG task file identity is invalid")
        file_id = row.get("fileId")
        kind = row.get("kind")
        source_sha = row.get("sha256")
        if (not isinstance(file_id, str) or not file_id.strip()
            or file_id in files_by_id
            or kind not in {"svg", "gcode", "screenshot"}
            or not isinstance(source_sha, str) or len(source_sha) != 64
            or any(char not in "0123456789abcdefABCDEF" for char in source_sha)):
            raise ManualSendBindingError("manual SVG task file identity is invalid")
        files_by_id[file_id] = row

    file_items: dict[str, Any] = {}
    for item in sent_items:
        file_id = getattr(item, "file_id", None)
        if file_id is None:
            continue  # The optional caption/comment is transport-only.
        if file_id not in files_by_id or file_id in file_items:
            raise ManualSendBindingError("manual SVG send returned an ambiguous file mapping")
        file_items[file_id] = item
    if file_items.keys() != files_by_id.keys():
        raise ManualSendBindingError("manual SVG send did not return one message per requested file")

    message_ids: dict[int, tuple[str, Any]] = {}
    for file_id, item in file_items.items():
        message = getattr(item, "message", None)
        message_id = getattr(message, "id", None)
        if isinstance(message_id, bool) or not isinstance(message_id, int) or not 1 <= message_id <= MAX_TELEGRAM_MESSAGE_ID:
            raise ManualSendBindingError("manual SVG file send returned an invalid message ID")
        if message_id in message_ids:
            raise ManualSendBindingError("manual SVG file sends returned duplicate message IDs")
        message_ids[message_id] = (file_id, message)

    expected_ids = set(message_ids)
    deadline = asyncio.get_running_loop().time() + MANUAL_SEND_OBSERVATION_TIMEOUT_SECONDS
    try:
        async with asyncio.timeout_at(deadline):
            fetched_value = await client.get_messages(entity, ids=sorted(expected_ids))
    except TimeoutError as exc:
        raise ManualSendBindingError("post-send Telegram media refetch timed out") from exc
    except Exception as exc:
        raise ManualSendBindingError("post-send Telegram media refetch failed") from exc

    try:
        fetched = _message_batch(fetched_value, expected_ids)
    except Exception as exc:
        raise ManualSendBindingError("post-send Telegram message set is malformed") from exc
    if fetched.keys() != expected_ids:
        raise ManualSendBindingError("post-send Telegram message set is incomplete")

    total_bytes = 0
    bindings: list[dict[str, str]] = []
    for message_id in sorted(expected_ids):
        file_id, sent_message = message_ids[message_id]
        expected = files_by_id[file_id]
        kind = expected["kind"]
        source_sha = expected["sha256"].lower()
        returned = fetched[message_id]
        if returned is None or getattr(sent_message, "id", None) != getattr(returned, "id", None):
            raise ManualSendBindingError("post-send Telegram message identity changed")
        if _message_chat_id(returned) != chat_id:
            raise ManualSendBindingError("post-send Telegram message belongs to a different chat")
        role = "image" if kind == "screenshot" else kind
        if not _matches_role(returned, role):
            raise ManualSendBindingError("post-send Telegram media role does not match the sent file")
        media = getattr(returned, "file", None)
        declared_size = getattr(media, "size", None)
        if isinstance(declared_size, int) and (declared_size <= 0 or declared_size > MAX_OBSERVATION_MEDIA_BYTES):
            raise ManualSendBindingError("post-send Telegram media exceeds the observation bound")

        sink = _HashBoundedSink(message_id)
        try:
            async with asyncio.timeout_at(deadline):
                await returned.download_media(file=sink)
        except TimeoutError as exc:
            raise ManualSendBindingError("post-send Telegram media refetch timed out") from exc
        except Exception as exc:
            raise ManualSendBindingError("post-send Telegram media refetch failed") from exc
        finally:
            sink.close()
        if sink.size <= 0:
            raise ManualSendBindingError("post-send Telegram media is empty")
        total_bytes += sink.size
        if total_bytes > MANUAL_SEND_OBSERVATION_MAX_TOTAL_BYTES:
            raise ManualSendBindingError("post-send Telegram group exceeds the byte bound")
        media_sha = sink.hexdigest()
        if kind in {"svg", "gcode"} and media_sha != source_sha:
            raise ManualSendBindingError("post-send SVG/G-code bytes differ from the claimed source")
        bindings.append({
            "fileId": file_id,
            "messageId": str(message_id),
            "sourceSha256": source_sha,
            "mediaSha256": media_sha,
        })
    return bindings
