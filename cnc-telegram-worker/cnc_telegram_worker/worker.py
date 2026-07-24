from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from telethon import TelegramClient

from .cleanup import cleanup_temp_dir
from .config import WorkerConfig
from .erp_client import BackendAuth, ErpClient
from .gcode import extract_order_names, parse_gcode_text
from .ocr import run_ocr_command
from .packet import (
    GcodeMeta,
    ImageMeta,
    apply_source_version,
    build_structured_packet,
    canonical_payload_hash,
    idempotency_key,
)
from .state import StateStore
from .telegram_source import (
    collect_day_messages,
    has_thumbs_up,
    is_gcode_message,
    is_image_message,
    message_datetime,
    message_edited_datetime,
    message_filename,
    message_reply_to_id,
    message_text,
    message_thread_id,
    peer_id,
)


@dataclass(frozen=True)
class ImageGroup:
    image_message: Any
    comments: list[str]
    gcode_message: Any | None


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
            cleanup_temp_dir(self.config.temp_dir, self.config.temp_ttl_hours)

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
        run_dir = self.config.temp_dir / f"{chat_id.strip('-')}-{group.image_message.id}"
        run_dir.mkdir(parents=True, exist_ok=True)
        image_path: Path | None = None
        gcode_meta: GcodeMeta | None = None
        try:
            image_path = await download_media(group.image_message, run_dir, "sheet")
            if image_path is None:
                print(f"skip message {group.image_message.id}: image download returned no path", flush=True)
                return
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

            ocr = await run_ocr_command(self.config.ocr_command, image_path)
            image = ImageMeta(
                chat_id=chat_id,
                message_id=int(group.image_message.id),
                thread_id=message_thread_id(group.image_message),
                message_date=message_datetime(group.image_message),
                edited_at=message_edited_datetime(group.image_message),
                text=message_text(group.image_message),
                thumbs_up=has_thumbs_up(group.image_message),
            )
            packet = build_structured_packet(
                image=image,
                workday=workday,
                comments=group.comments,
                ocr=ocr,
                gcode=gcode_meta,
                default_machine=self.config.default_machine,
                default_material=self.config.default_material,
                ocr_engine=self.config.ocr_engine,
                parser_version=self.config.parser_version,
            )
            payload_hash = canonical_payload_hash(packet)
            version = self.state.next_version(packet["externalPacketKey"], payload_hash)
            if not version.changed and not self.config.resend_unchanged:
                print(f"skip unchanged {packet['externalPacketKey']} v{version.source_version}", flush=True)
                return
            packet = apply_source_version(packet, version.source_version)
            idem = idempotency_key(packet["externalPacketKey"], version.source_version)
            response = await self.erp.ingest_packet(packet, idem)
            self.state.mark_posted(packet["externalPacketKey"], payload_hash, version.source_version)
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
    groups: list[ImageGroup] = []
    for index, image_message in enumerate(image_messages):
        next_image_id = image_messages[index + 1].id if index + 1 < len(image_messages) else None
        comments = nearby_comments(messages, image_message, next_image_id)
        gcode_message = select_gcode_message(gcode_messages, image_message, comments)
        groups.append(ImageGroup(image_message=image_message, comments=comments, gcode_message=gcode_message))
    return groups


def nearby_comments(messages: list[Any], image_message: Any, next_image_id: int | None) -> list[str]:
    comments: list[str] = []
    image_id = int(image_message.id)
    image_date = message_datetime(image_message)
    for message in messages:
        if message is image_message or is_image_message(message) or is_gcode_message(message):
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


def select_gcode_message(gcode_messages: list[Any], image_message: Any, comments: list[str]) -> Any | None:
    if not gcode_messages:
        return None
    image_orders = set(extract_order_names(" ".join([message_text(image_message), *comments])))
    candidates: list[tuple[int, Any]] = []
    for gcode_message in gcode_messages:
        filename = message_filename(gcode_message) or ""
        gcode_orders = set(extract_order_names(filename))
        if image_orders and gcode_orders and image_orders.isdisjoint(gcode_orders):
            continue
        distance = abs(int(gcode_message.id) - int(image_message.id))
        candidates.append((distance, gcode_message))
    if not candidates:
        return min(gcode_messages, key=lambda message: abs(int(message.id) - int(image_message.id)))
    return min(candidates, key=lambda pair: pair[0])[1]


async def download_media(message: Any, run_dir: Path, prefix: str) -> Path | None:
    filename = message_filename(message)
    suffix = Path(filename).suffix if filename else ""
    target = run_dir / f"{prefix}-{int(message.id)}{suffix}"
    result = await message.download_media(file=str(target))
    return Path(result) if result else None


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
