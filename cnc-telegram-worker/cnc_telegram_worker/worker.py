from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import re
import shutil
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from telethon import TelegramClient

from .cleanup import cleanup_temp_dir
from .config import WorkerConfig
from .erp_client import BackendAuth, ErpClient
from .gcode import extract_order_names, parse_gcode_text
from .ocr import OcrResult, run_ocr_command
from .packet import (
    GcodeMeta,
    ImageMeta,
    apply_source_version,
    build_structured_packet,
    canonical_payload_hash,
    external_packet_key,
    idempotency_key,
)
from .state import StateStore
from .telegram_source import (
    collect_day_messages,
    has_thumbs_up,
    is_gcode_message,
    is_image_message,
    is_vector_message,
    message_datetime,
    message_edited_datetime,
    message_filename,
    message_reply_to_id,
    message_text,
    message_thread_id,
    peer_id,
)
from .vector import layout_to_dict, parse_svg_cut_layout


IMAGE_STORAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True)
class ImageGroup:
    image_message: Any
    comments: list[str]
    gcode_message: Any | None
    vector_message: Any | None


class CncTelegramWorker:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config
        self.state = StateStore(config.state_path)
        self.erp = ErpClient(
            config.erp_api_url,
            BackendAuth(
                bearer_token=config.erp_bearer_token,
                username=config.erp_worker_login,
                password=config.erp_worker_password,
            ),
        )

    async def run_once(self, workday: date | None = None, days: int | None = None) -> None:
        self.config.require_telegram()
        self.config.require_backend_auth()
        days_to_scan = days or self.config.history_days
        anchor = workday or datetime.now(self.config.business_timezone).date()
        workdays = [anchor - timedelta(days=offset) for offset in range(days_to_scan)]

        client = TelegramClient(
            str(self.config.telegram_session_path),
            self.config.telegram_api_id,
            self.config.telegram_api_hash,
        )
        await client.connect()
        try:
            if not await client.is_user_authorized():
                raise RuntimeError("Telethon session is not authorized; run `cnc-telegram-worker login` first")
            entity = await client.get_entity(parse_chat_ref(self.config.telegram_chat))
            chat_id = peer_id(entity)
            assert_allowed_chat(chat_id, self.config.telegram_allowed_chat_ids)
            for day in workdays:
                await self.scan_workday(client, entity, chat_id, day)
        finally:
            await client.disconnect()
            cleanup_temp_dir(
                self.config.temp_dir,
                min(self.config.temp_ttl_hours, self.config.attachment_ttl_hours),
            )
            cleanup_temp_dir(self.config.media_dir, self.config.attachment_ttl_hours)

    async def run_daemon(self, days: int | None = None) -> None:
        first = True
        while True:
            scan_days = days or (self.config.history_days if first and self.config.backfill_on_start else 1)
            try:
                await self.run_once(days=scan_days)
            except Exception as exc:
                print(f"scan failed: {exc}", flush=True)
            first = False
            await asyncio.sleep(self.config.poll_interval_seconds)

    async def scan_workday(self, client: Any, entity: Any, chat_id: str, workday: date) -> None:
        messages = await collect_day_messages(
            client,
            entity,
            workday,
            self.config.business_timezone,
            self.config.max_messages_per_scan,
        )
        groups = group_image_messages(messages)
        for group in groups:
            await self.process_group(group, chat_id, workday)

    async def process_group(self, group: ImageGroup, chat_id: str, workday: date) -> None:
        external_key = external_packet_key(chat_id, int(group.image_message.id))
        source_fingerprint = group_source_fingerprint(
            group,
            chat_id,
            workday,
            self.config.parser_version,
            self.config.ocr_engine,
        )
        if not self.config.resend_unchanged and self.state.source_unchanged(external_key, source_fingerprint):
            print(f"skip source unchanged {external_key}", flush=True)
            return

        run_dir = self.config.temp_dir / f"{chat_id.strip('-')}-{group.image_message.id}"
        run_dir.mkdir(parents=True, exist_ok=True)
        image_path: Path | None = None
        gcode_meta: GcodeMeta | None = None
        vector_items: list[dict[str, Any]] = []
        cut_layout: dict[str, Any] | None = None
        try:
            image_path = await download_media(group.image_message, run_dir, "sheet")
            if image_path is None:
                print(f"skip message {group.image_message.id}: image download returned no path", flush=True)
                return
            thumbs_up = group_has_thumbs_up(group)
            sheet_image = persist_sheet_image(self.config.media_dir, chat_id, int(group.image_message.id), image_path)
            if group.gcode_message is not None:
                gcode_path = await download_media(group.gcode_message, run_dir, "program")
                if gcode_path is not None:
                    gcode_text = gcode_path.read_text(encoding="utf-8", errors="replace")
                    filename = message_filename(group.gcode_message) or gcode_path.name
                    gcode_meta = GcodeMeta(
                        filename=filename,
                        text=gcode_text,
                        analysis=parse_gcode_text(gcode_text, filename),
                    )
            if group.vector_message is not None:
                vector_path = await download_media(group.vector_message, run_dir, "vector")
                if vector_path is not None:
                    parsed_layout = parse_svg_cut_layout(vector_path)
                    cut_layout = layout_to_dict(parsed_layout)
                    vector_items = cut_layout["items"] if cut_layout["status"] == "valid" else []

            ocr = OcrResult() if vector_items else await run_ocr_command(self.config.ocr_command, image_path)
            image = ImageMeta(
                chat_id=chat_id,
                message_id=int(group.image_message.id),
                thread_id=message_thread_id(group.image_message),
                message_date=message_datetime(group.image_message),
                edited_at=message_edited_datetime(group.image_message),
                text=message_text(group.image_message),
                thumbs_up=thumbs_up,
            )
            packet = build_structured_packet(
                image=image,
                workday=workday,
                comments=group.comments,
                ocr=ocr,
                gcode=gcode_meta,
                vector_items=vector_items,
                cut_layout=cut_layout,
                sheet_image=sheet_image,
                default_machine=self.config.default_machine,
                default_material=self.config.default_material,
                ocr_engine=self.config.ocr_engine,
                parser_version=self.config.parser_version,
            )
            payload_hash = canonical_payload_hash(packet)
            version = self.state.next_version(packet["externalPacketKey"], payload_hash)
            if not version.changed and not self.config.resend_unchanged:
                self.state.mark_posted(
                    packet["externalPacketKey"],
                    payload_hash,
                    version.source_version,
                    source_fingerprint,
                )
                print(f"skip unchanged {packet['externalPacketKey']} v{version.source_version}", flush=True)
                return
            packet = apply_source_version(packet, version.source_version)
            idem = idempotency_key(packet["externalPacketKey"], version.source_version)
            response = await self.erp.ingest_packet(packet, idem)
            self.state.mark_posted(
                packet["externalPacketKey"],
                payload_hash,
                version.source_version,
                source_fingerprint,
            )
            applied = response.get("applied")
            print(f"posted {packet['externalPacketKey']} v{version.source_version} applied={applied}", flush=True)
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)


async def login_telegram_session(config: WorkerConfig) -> None:
    config.require_telegram()
    config.telegram_session_path.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(config.telegram_session_path), config.telegram_api_id, config.telegram_api_hash)
    await client.start()
    await client.disconnect()
    print(f"Telethon session ready: {config.telegram_session_path}")


def group_image_messages(messages: list[Any]) -> list[ImageGroup]:
    image_messages = [message for message in messages if is_image_message(message)]
    gcode_messages = [message for message in messages if is_gcode_message(message)]
    vector_messages = [message for message in messages if is_vector_message(message)]
    groups: list[ImageGroup] = []
    for index, image_message in enumerate(image_messages):
        previous_image_id = image_messages[index - 1].id if index > 0 else None
        next_image_id = image_messages[index + 1].id if index + 1 < len(image_messages) else None
        comments = nearby_comments(messages, image_message, next_image_id)
        gcode_message = select_gcode_message(
            gcode_messages,
            image_message,
            comments,
            previous_image_id,
            next_image_id,
        )
        vector_message = select_vector_message(
            vector_messages,
            image_message,
            comments,
            previous_image_id,
            next_image_id,
        )
        groups.append(ImageGroup(
            image_message=image_message,
            comments=comments,
            gcode_message=gcode_message,
            vector_message=vector_message,
        ))
    return groups


def nearby_comments(messages: list[Any], image_message: Any, next_image_id: int | None) -> list[str]:
    comments: list[str] = []
    image_id = int(image_message.id)
    image_date = message_datetime(image_message)
    for message in messages:
        if message is image_message or is_image_message(message) or is_gcode_message(message) or is_vector_message(message):
            continue
        text = message_text(message)
        if not text:
            continue
        reply_to = message_reply_to_id(message)
        if reply_to == image_id:
            comments.append(text)
            continue
        message_id = int(message.id)
        if message_id <= image_id:
            continue
        if next_image_id is not None and message_id >= next_image_id:
            continue
        if abs((message_datetime(message) - image_date).total_seconds()) <= 20 * 60:
            comments.append(text)
    return comments


def select_gcode_message(
    gcode_messages: list[Any],
    image_message: Any,
    comments: list[str],
    previous_image_id: int | None = None,
    next_image_id: int | None = None,
) -> Any | None:
    if not gcode_messages:
        return None
    return select_attachment_message(
        gcode_messages,
        image_message,
        comments,
        previous_image_id,
        next_image_id,
        key_builder=lambda image_id: lambda message: abs(int(message.id) - image_id),
    )


def select_vector_message(
    vector_messages: list[Any],
    image_message: Any,
    comments: list[str],
    previous_image_id: int | None = None,
    next_image_id: int | None = None,
) -> Any | None:
    if not vector_messages:
        return None
    return select_attachment_message(
        vector_messages,
        image_message,
        comments,
        previous_image_id,
        next_image_id,
        key_builder=lambda image_id: lambda message: (
            0 if Path(message_filename(message) or "").suffix.lower() == ".svg" else 1,
            abs(int(message.id) - image_id),
        ),
    )


def select_attachment_message(
    messages: list[Any],
    image_message: Any,
    comments: list[str],
    previous_image_id: int | None,
    next_image_id: int | None,
    *,
    key_builder: Callable[[int], Any],
) -> Any | None:
    image_orders = set(extract_order_names(" ".join([message_text(image_message), *comments])))
    compatible_messages: list[Any] = []
    for message in messages:
        filename = message_filename(message) or ""
        attachment_orders = set(extract_order_names(filename))
        if image_orders and attachment_orders and image_orders.isdisjoint(attachment_orders):
            continue
        compatible_messages.append(message)
    candidates = compatible_messages or messages
    image_id = int(image_message.id)
    previous_id = int(previous_image_id) if previous_image_id is not None else None
    next_id = int(next_image_id) if next_image_id is not None else None
    before_image = [
        message for message in candidates
        if (previous_id is None or int(message.id) > previous_id) and int(message.id) < image_id
    ]
    after_image = [
        message for message in candidates
        if int(message.id) > image_id and (next_id is None or int(message.id) < next_id)
    ]
    sort_key = key_builder(image_id)
    for scoped_candidates in (before_image, after_image, candidates):
        if scoped_candidates:
            return min(scoped_candidates, key=sort_key)
    return None


def group_has_thumbs_up(group: ImageGroup) -> bool:
    return any(
        has_thumbs_up(message)
        for message in (group.image_message, group.gcode_message, group.vector_message)
        if message is not None
    )


def group_source_fingerprint(
    group: ImageGroup,
    chat_id: str,
    workday: date,
    parser_version: str,
    ocr_engine: str,
) -> str:
    payload = {
        "version": 2,
        "chatId": chat_id,
        "workday": workday.isoformat(),
        "parserVersion": parser_version,
        "ocrEngine": ocr_engine,
        "image": message_identity(group.image_message, include_reactions=True),
        "comments": group.comments,
        "gcode": (
            message_identity(group.gcode_message, include_reactions=True)
            if group.gcode_message is not None
            else None
        ),
        "vector": (
            message_identity(group.vector_message, include_reactions=True)
            if group.vector_message is not None
            else None
        ),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def message_identity(message: Any, *, include_reactions: bool) -> dict[str, Any]:
    return {
        "id": int(message.id),
        "date": message_datetime(message).isoformat(),
        "editedAt": message_edited_datetime(message).isoformat() if message_edited_datetime(message) else None,
        "filename": message_filename(message),
        "text": message_text(message),
        "thumbsUp": has_thumbs_up(message) if include_reactions else None,
    }


async def download_media(message: Any, run_dir: Path, prefix: str) -> Path | None:
    filename = message_filename(message)
    suffix = Path(filename).suffix if filename else ""
    target = run_dir / f"{prefix}-{int(message.id)}{suffix}"
    result = await message.download_media(file=str(target))
    return Path(result) if result else None


def persist_sheet_image(media_dir: Path, chat_id: str, message_id: int, image_path: Path) -> dict[str, Any]:
    media_dir.mkdir(parents=True, exist_ok=True)
    suffix = normalize_image_suffix(image_path.suffix)
    key = sheet_image_key(chat_id, message_id, suffix)
    target = media_dir / key
    shutil.copy2(image_path, target)
    content_type = mimetypes.guess_type(target.name)[0] or "image/jpeg"
    return {
        "storageKey": key,
        "contentType": content_type,
        "sizeBytes": target.stat().st_size,
    }


def delete_sheet_image(media_dir: Path, chat_id: str, message_id: int) -> None:
    prefix = sheet_image_key_prefix(chat_id, message_id)
    if not media_dir.exists():
        return
    for path in media_dir.glob(f"{prefix}.*"):
        if path.is_file():
            path.unlink(missing_ok=True)


def sheet_image_key(chat_id: str, message_id: int, suffix: str) -> str:
    return f"{sheet_image_key_prefix(chat_id, message_id)}{normalize_image_suffix(suffix)}"


def sheet_image_key_prefix(chat_id: str, message_id: int) -> str:
    safe_chat = re.sub(r"[^A-Za-z0-9]+", "_", chat_id).strip("_") or "chat"
    return f"tg_{safe_chat}_{message_id}"


def normalize_image_suffix(value: str) -> str:
    suffix = value.lower()
    return suffix if suffix in IMAGE_STORAGE_EXTENSIONS else ".jpg"


def parse_chat_ref(value: str) -> int | str:
    stripped = value.strip()
    if stripped.lstrip("-").isdigit():
        return int(stripped)
    return stripped


def assert_allowed_chat(actual_chat_id: str, allowed_chat_ids: tuple[str, ...]) -> None:
    if not allowed_chat_ids:
        return
    allowed = set(allowed_chat_ids)
    aliases = {actual_chat_id}
    if actual_chat_id.startswith("-100"):
        aliases.add(actual_chat_id[4:])
    elif actual_chat_id.startswith("-"):
        aliases.add(actual_chat_id[1:])
    else:
        aliases.add(f"-100{actual_chat_id}")
    if allowed.isdisjoint(aliases):
        raise RuntimeError(f"resolved Telegram chat {actual_chat_id} is not in TELEGRAM_ALLOWED_CHAT_ID")
