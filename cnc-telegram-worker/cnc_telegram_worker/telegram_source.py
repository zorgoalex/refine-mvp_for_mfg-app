from __future__ import annotations

from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from telethon import utils

from .gcode import is_gcode_filename


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
VECTOR_EXTENSIONS = {".svg", ".dxf"}


async def collect_day_messages(
    client: Any,
    entity: Any,
    workday: date,
    tz: ZoneInfo,
    max_messages: int,
    observer: Callable[[Any, int], Awaitable[None]] | None = None,
) -> list[Any]:
    start_local = datetime.combine(workday, time.min, tzinfo=tz)
    end_local = datetime.combine(workday, time.max, tzinfo=tz)
    end_utc = end_local.astimezone(timezone.utc)
    messages: list[Any] = []
    ordinal = 0
    async for message in client.iter_messages(entity, offset_date=end_utc, limit=max_messages):
        ordinal += 1
        if observer is not None:
            await observer(message, ordinal)
        message_date = message_datetime(message).astimezone(tz)
        if message_date.date() < workday:
            break
        if start_local <= message_date <= end_local:
            messages.append(message)
    return list(reversed(messages))


def peer_id(entity: Any) -> str:
    return str(utils.get_peer_id(entity))


def message_datetime(message: Any) -> datetime:
    value = getattr(message, "date", None) or datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def message_edited_datetime(message: Any) -> datetime | None:
    value = getattr(message, "edit_date", None)
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def message_text(message: Any) -> str:
    value = getattr(message, "raw_text", None) or getattr(message, "message", None) or ""
    return value.strip() if isinstance(value, str) else ""


def message_thread_id(message: Any) -> int | None:
    reply = getattr(message, "reply_to", None)
    thread_id = getattr(reply, "reply_to_top_id", None) or getattr(reply, "forum_topic", None)
    return int(thread_id) if isinstance(thread_id, int) and not isinstance(thread_id, bool) and thread_id > 0 else None


def message_reply_to_id(message: Any) -> int | None:
    reply = getattr(message, "reply_to", None)
    reply_to = getattr(reply, "reply_to_msg_id", None)
    return int(reply_to) if isinstance(reply_to, int) and not isinstance(reply_to, bool) and reply_to > 0 else None


def message_filename(message: Any) -> str | None:
    file = getattr(message, "file", None)
    name = getattr(file, "name", None)
    return name if isinstance(name, str) and name.strip() else None


def is_image_message(message: Any) -> bool:
    filename = message_filename(message)
    suffix = Path(filename).suffix.lower() if filename else ""
    if suffix in VECTOR_EXTENSIONS:
        return False
    if getattr(message, "photo", None) is not None:
        return True
    file = getattr(message, "file", None)
    mime_type = getattr(file, "mime_type", None)
    if isinstance(mime_type, str) and mime_type.startswith("image/"):
        return True
    return suffix in IMAGE_EXTENSIONS


def is_gcode_message(message: Any) -> bool:
    return is_gcode_filename(message_filename(message))


def is_vector_message(message: Any) -> bool:
    filename = message_filename(message)
    return filename is not None and Path(filename).suffix.lower() in VECTOR_EXTENSIONS


def has_thumbs_up(message: Any) -> bool:
    reactions = getattr(message, "reactions", None)
    results = getattr(reactions, "results", None)
    if not results:
        return False
    for result in results:
        reaction = getattr(result, "reaction", None)
        emoticon = getattr(reaction, "emoticon", None)
        if emoticon == "\U0001F44D":
            count = getattr(result, "count", 0)
            return not isinstance(count, int) or count > 0
    return False
