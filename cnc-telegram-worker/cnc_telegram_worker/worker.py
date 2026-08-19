from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import mimetypes
import re
import shutil
import os
import time
import traceback
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable

from telethon import TelegramClient
from PIL import Image, ImageOps

from .cleanup import cleanup_temp_dir
from .audit import (
    AuditSpool,
    ScanAudit,
    reconcile_pending_processing_attempts,
    reconcile_pending_replies,
    sanitize_text,
    utc_now,
)
from .config import WorkerConfig
from .erp_client import BackendAuth, ErpClient, ErpResponseError, SessionLeaseLost, WorkerItemLease, parse_item_lease
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
    classify_import_message,
    collect_day_messages,
    has_thumbs_up,
    is_gcode_message,
    is_image_message,
    is_vector_message,
    message_datetime,
    message_edited_datetime,
    message_filename,
    message_mime_type,
    message_outgoing,
    message_reply_to_id,
    message_sender_id,
    message_text,
    message_thread_id,
    peer_id,
)
from .vector import layout_to_dict, parse_svg_cut_layout


IMAGE_STORAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
SHEET_PREVIEW_DIRECTORY = "previews"
SHEET_PREVIEW_SIZE = (360, 240)
SHEET_PREVIEW_MAX_SOURCE_PIXELS = 40_000_000
SHEET_ORIGINAL_MAX_BYTES = 12 * 1024 * 1024
CUTTING_SEQUENCE_REPLY_RE = re.compile(
    r"(?<!\w)раскро[ий]\s*(?:файла\s*станка\s*)?[№#]?\s*(\d{1,6})(?!\d)",
    re.IGNORECASE,
)
CUTTING_SEQUENCE_REPLY_TEXT = "Раскрой №{number}"
IMPORT_MAX_FILE_BYTES = 15 * 1024 * 1024
IMPORT_MAX_TOTAL_BYTES = 36 * 1024 * 1024
TELEGRAM_MEDIA_TIMEOUT_SECONDS = 30.0
DISCOVERY_PAGE_MESSAGES = 50
DISCOVERY_PAGE_SECONDS = 2.0


@dataclass(frozen=True)
class SvgGroup:
    vector_message: Any
    image_message: Any | None
    comments: list[str]
    cutting_sequence_no: int | None
    gcode_message: Any | None

    @property
    def source_message(self) -> Any:
        return self.vector_message


@dataclass(frozen=True)
class ManualSvgSendFile:
    kind: str
    path: Path


@dataclass(frozen=True)
class ManualSvgSentItem:
    kind: str
    file_name: str | None
    message: Any


class WeightedQueueScheduler:
    """Small deterministic weighted round-robin dispatcher for queue fairness."""

    weights = {"manual": 4, "import": 2, "restore": 1, "discovery": 1}

    def __init__(self, *, aging_seconds: float = 60.0) -> None:
        self.aging_seconds = aging_seconds
        self._slots = [name for name, weight in self.weights.items() for _ in range(weight)]
        self._cursor = 0

    def choose(self, ready: dict[str, bool], ready_since: dict[str, float], now: float | None = None) -> str | None:
        now = time.monotonic() if now is None else now
        aged = [
            name for name, is_ready in ready.items()
            if is_ready and name in self.weights and now - ready_since.get(name, now) >= self.aging_seconds
        ]
        if aged:
            # An aged queue gets the next slot, with stable order for tests.
            name = min(aged, key=lambda name: (ready_since.get(name, now), self._slots.index(name)))
            # Aging is a wait-time bonus, not a permanent priority. Reset it
            # after service so one continuously ready queue cannot starve the
            # other queues forever.
            ready_since[name] = now
            index = self._slots.index(name)
            self._cursor = (index + 1) % len(self._slots)
            return name
        for offset in range(len(self._slots)):
            index = (self._cursor + offset) % len(self._slots)
            name = self._slots[index]
            if ready.get(name, False):
                self._cursor = (index + 1) % len(self._slots)
                return name
        return None


async def flush_audit_spool(
    audit_spool: AuditSpool,
    sender: Any,
    lock: asyncio.Lock | None = None,
) -> int:
    if lock is None:
        return await audit_spool.flush(sender)
    async with lock:
        return await audit_spool.flush(sender)


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
        self.erp.set_worker_identity(config.worker_instance_id)

    async def _claim_session_lease(self) -> None:
        self.config.require_session_lease_timing()
        configured_chat_id = self.config.telegram_chat
        if not re.fullmatch(r"-?\d+", configured_chat_id):
            if len(self.config.telegram_allowed_chat_ids) != 1:
                raise RuntimeError(
                    "Telegram session lease requires numeric TELEGRAM_CHAT when multiple allowed chats are configured",
                )
            configured_chat_id = self.config.telegram_allowed_chat_ids[0]
        max_attempts, retry_delay_seconds = self._session_claim_retry_policy()
        for attempt in range(max_attempts):
            try:
                await self.erp.claim_worker_session(
                    chat_id=configured_chat_id,
                    image_revision=self.config.worker_image_revision,
                    lease_ttl_seconds=self.config.session_lease_ttl_seconds,
                )
                return
            except ErpResponseError as exc:
                if not self._is_busy_session_claim_error(exc) or attempt + 1 >= max_attempts:
                    raise
                print(
                    "CNC Telegram session lease is busy; "
                    f"retry {attempt + 2}/{max_attempts} in {retry_delay_seconds:g}s",
                    flush=True,
                )
                await asyncio.sleep(retry_delay_seconds)

    def _session_claim_retry_policy(self) -> tuple[int, float]:
        lease_ttl_seconds = max(1.0, float(self.config.session_lease_ttl_seconds))
        poll_interval_seconds = max(0.01, float(self.config.poll_interval_seconds))
        # One extra poll beyond the advertised TTL avoids racing a lease that
        # expires between backend/database clock ticks during rolling restart.
        max_attempts = max(2, math.ceil(lease_ttl_seconds / poll_interval_seconds) + 2)
        return max_attempts, min(lease_ttl_seconds, poll_interval_seconds)

    @staticmethod
    def _is_busy_session_claim_error(exc: ErpResponseError) -> bool:
        response = exc.response
        if response.status_code != 409:
            return False
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict):
            return False
        candidates: list[Any] = [payload.get("code"), payload.get("errorCode")]
        nested_error = payload.get("error")
        if isinstance(nested_error, dict):
            candidates.extend([nested_error.get("code"), nested_error.get("errorCode")])
        return any(candidate == "CNC_TELEGRAM_SESSION_LEASE_BUSY" for candidate in candidates)

    async def run_once(
        self,
        workday: date | None = None,
        days: int | None = None,
        *,
        scan_request_id: str | None = None,
    ) -> None:
        if not self.config.enabled:
            print(
                f"CNC Telegram worker disabled: ERP_STACK_ENV={self.config.stack_env} "
                f"CNC_TELEGRAM_WORKER_ROLE={self.config.worker_role}",
                flush=True,
            )
            return
        self.config.require_worker_enabled()
        self.config.require_telegram()
        self.config.require_backend_auth()
        if days is None or days < 1 or days > 31:
            raise RuntimeError("break-glass once requires --days between 1 and 31")
        if not scan_request_id or not scan_request_id.strip():
            raise RuntimeError("break-glass once requires an approved --scan-request-id")
        self.erp.set_approved_scan_request(scan_request_id)
        backfill_sheet_previews(self.config.media_dir)
        audit_spool = AuditSpool(
            self.config.audit_spool_path,
            allow_unsafe_path=self.config.audit_allow_unsafe_path,
        )
        days_to_scan = days or self.config.history_days
        anchor = workday or datetime.now(self.config.business_timezone).date()
        workdays = [anchor - timedelta(days=offset) for offset in reversed(range(days_to_scan))]

        client: Any | None = None
        session_claimed = False
        audit_flush_lock = asyncio.Lock()
        manual_svg_send_stop: asyncio.Event | None = None
        manual_svg_send_task: asyncio.Task[None] | None = None
        try:
            await self._claim_session_lease()
            session_claimed = True
            await self.erp.audit_capabilities()
            await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
            await reconcile_pending_processing_attempts(audit_spool, self.erp, self.state)
            audit_spool.abandon_running_scans()
            await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
            client = TelegramClient(
                str(self.config.telegram_session_path),
                self.config.telegram_api_id,
                self.config.telegram_api_hash,
            )
            await client.connect()
            if not await client.is_user_authorized():
                raise RuntimeError("Telethon session is not authorized; run `cnc-telegram-worker login` first")
            entity = await client.get_entity(parse_chat_ref(self.config.telegram_chat))
            chat_id = peer_id(entity)
            assert_allowed_chat(chat_id, self.config.telegram_allowed_chat_ids)
            me = await client.get_me()
            session_user_id = str(me.id) if getattr(me, "id", None) is not None else None
            await self.process_media_restore_requests(client, entity, chat_id)
            if self.config.can_send_manual_svg_uploads:
                await self.process_manual_svg_telegram_send_requests(
                    client,
                    entity,
                    chat_id,
                    audit_spool=audit_spool,
                    session_user_id=session_user_id,
                    audit_flush_lock=audit_flush_lock,
                )
                manual_svg_send_stop = asyncio.Event()
                manual_svg_send_task = asyncio.create_task(
                    self.poll_manual_svg_telegram_send_requests(
                        client,
                        entity,
                        chat_id,
                        manual_svg_send_stop,
                        audit_spool=audit_spool,
                        session_user_id=session_user_id,
                        audit_flush_lock=audit_flush_lock,
                    ),
                )
            reconciled_replies = await reconcile_pending_replies(
                audit_spool, client, entity, session_user_id,
            )
            for operation in reconciled_replies:
                key = operation.get("externalPacketKey")
                number = operation.get("cuttingSequenceNo")
                if isinstance(key, str) and key and isinstance(number, int) and number > 0:
                    self.state.assign_cutting_sequence_number(key, existing_number=number)
                    self.state.mark_cutting_sequence_replied(key)
            for day in workdays:
                await self.scan_workday(
                    client,
                    entity,
                    chat_id,
                    day,
                    audit_spool,
                    session_user_id,
                    audit_flush_lock=audit_flush_lock,
                )
        finally:
            if manual_svg_send_stop is not None:
                manual_svg_send_stop.set()
            if manual_svg_send_task is not None:
                try:
                    await manual_svg_send_task
                except Exception as exc:
                    print(f"manual SVG send polling stopped with error: {exc}", flush=True)
                    traceback.print_exception(exc)
            if client is not None:
                try:
                    await client.disconnect()
                except Exception as exc:
                    print(f"Telegram disconnect failed: {exc}", flush=True)
            try:
                try:
                    await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
                except Exception as exc:
                    print(f"audit delivery deferred: {exc}", flush=True)
            finally:
                audit_spool.close()
            if session_claimed:
                self.erp.set_session_lease(None)
            self.erp.set_approved_scan_request(None)
            cleanup_temp_dir(
                self.config.temp_dir,
                min(self.config.temp_ttl_hours, self.config.attachment_ttl_hours),
            )
            cleanup_temp_dir(
                self.config.media_dir,
                self.config.attachment_ttl_hours,
                excluded_relative_dirs=frozenset({SHEET_PREVIEW_DIRECTORY}),
            )

    async def run_serve(self, *, technical_lease_lost_event: asyncio.Event | None = None) -> None:
        """Run the long-lived queue worker without unsolicited Telegram scans."""
        if not self.config.enabled:
            print(
                f"CNC Telegram worker disabled: ERP_STACK_ENV={self.config.stack_env} "
                f"CNC_TELEGRAM_WORKER_ROLE={self.config.worker_role}",
                flush=True,
            )
            return
        self.config.require_worker_enabled()
        self.config.require_telegram()
        self.config.require_backend_auth()
        backfill_sheet_previews(self.config.media_dir)
        audit_spool = AuditSpool(
            self.config.audit_spool_path,
            allow_unsafe_path=self.config.audit_allow_unsafe_path,
        )
        audit_flush_lock = asyncio.Lock()
        client: Any | None = None
        stop_event = asyncio.Event()
        lease_lost_event = asyncio.Event()
        queue_tasks: list[asyncio.Task[None]] = []
        heartbeat_task: asyncio.Task[None] | None = None
        technical_lease_wait: asyncio.Task[bool] | None = None
        try:
            # Claim the DB lease before connecting Telethon. This also fences
            # crash-recovery ingest and all queue calls made below.
            await self._claim_session_lease()
            self._raise_if_technical_lease_lost(technical_lease_lost_event)
            await self.erp.audit_capabilities()
            await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
            audit_spool.abandon_running_scans()
            await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
            self._raise_if_technical_lease_lost(technical_lease_lost_event)

            client = TelegramClient(
                str(self.config.telegram_session_path),
                self.config.telegram_api_id,
                self.config.telegram_api_hash,
            )
            await client.connect()
            self._raise_if_technical_lease_lost(technical_lease_lost_event)
            if not await client.is_user_authorized():
                raise RuntimeError("Telethon session is not authorized; run `cnc-telegram-worker login` first")
            entity = await client.get_entity(parse_chat_ref(self.config.telegram_chat))
            chat_id = peer_id(entity)
            assert_allowed_chat(chat_id, self.config.telegram_allowed_chat_ids)
            me = await client.get_me()
            session_user_id = str(me.id) if getattr(me, "id", None) is not None else None

            heartbeat_task = asyncio.create_task(
                self._heartbeat_session(stop_event, lease_lost_event),
                name="cnc-telegram-session-heartbeat",
            )
            import_scheduler_enabled = bool(getattr(self.config, "manual_import_enabled", False))
            await self.process_media_restore_requests(client, entity, chat_id)
            self._raise_if_technical_lease_lost(technical_lease_lost_event)
            if self.config.can_send_manual_svg_uploads:
                await self.process_manual_svg_telegram_send_requests(
                    client,
                    entity,
                    chat_id,
                    audit_spool=audit_spool,
                    session_user_id=session_user_id,
                    audit_flush_lock=audit_flush_lock,
                )
                self._raise_if_technical_lease_lost(technical_lease_lost_event)
            if self.config.can_send_manual_svg_uploads and not import_scheduler_enabled:
                queue_tasks.append(asyncio.create_task(
                    self.poll_manual_svg_telegram_send_requests(
                        client,
                        entity,
                        chat_id,
                        stop_event,
                        audit_spool=audit_spool,
                        session_user_id=session_user_id,
                        audit_flush_lock=audit_flush_lock,
                        fatal_event=lease_lost_event,
                    ),
                    name="cnc-telegram-manual-send-poll",
                ))
            if import_scheduler_enabled:
                queue_tasks.append(asyncio.create_task(
                    self.poll_queue_scheduler(
                        client,
                        entity,
                        chat_id,
                        stop_event,
                        audit_spool=audit_spool,
                        session_user_id=session_user_id,
                        audit_flush_lock=audit_flush_lock,
                        fatal_event=lease_lost_event,
                    ),
                    name="cnc-telegram-import-queue-scheduler",
                ))
            else:
                queue_tasks.append(asyncio.create_task(
                    self.poll_media_restore_requests(
                        client,
                        entity,
                        chat_id,
                        stop_event,
                        fatal_event=lease_lost_event,
                    ),
                    name="cnc-telegram-media-restore-poll",
                ))

            stop_wait = asyncio.create_task(stop_event.wait(), name="cnc-telegram-serve-stop")
            lease_wait = asyncio.create_task(lease_lost_event.wait(), name="cnc-telegram-serve-lease-loss")
            waiter_tasks: list[asyncio.Task[bool]] = [stop_wait, lease_wait]
            if technical_lease_lost_event is not None:
                technical_lease_wait = asyncio.create_task(
                    technical_lease_lost_event.wait(),
                    name="cnc-telegram-serve-technical-lease-loss",
                )
                waiter_tasks.append(technical_lease_wait)
            try:
                await asyncio.wait(set(waiter_tasks), return_when=asyncio.FIRST_COMPLETED)
            finally:
                for waiter in waiter_tasks:
                    waiter.cancel()
                await asyncio.gather(*waiter_tasks, return_exceptions=True)
            if technical_lease_lost_event is not None and technical_lease_lost_event.is_set():
                raise SessionLeaseLost("technical log delivery lost the worker session lease")
            if lease_lost_event.is_set():
                raise SessionLeaseLost("worker session lease was lost")
        finally:
            stop_event.set()
            for task in queue_tasks:
                if not task.done():
                    task.cancel()
            if queue_tasks:
                await asyncio.gather(*queue_tasks, return_exceptions=True)
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                await asyncio.gather(heartbeat_task, return_exceptions=True)
            if client is not None:
                try:
                    await client.disconnect()
                except Exception as exc:
                    print(f"Telegram disconnect failed: {exc}", flush=True)
            try:
                try:
                    await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
                except Exception as exc:
                    print(f"audit delivery deferred: {exc}", flush=True)
            finally:
                audit_spool.close()
                self.erp.set_session_lease(None)
            cleanup_temp_dir(
                self.config.temp_dir,
                min(self.config.temp_ttl_hours, self.config.attachment_ttl_hours),
            )
            cleanup_temp_dir(
                self.config.media_dir,
                self.config.attachment_ttl_hours,
                excluded_relative_dirs=frozenset({SHEET_PREVIEW_DIRECTORY}),
            )

    @staticmethod
    def _raise_if_technical_lease_lost(event: asyncio.Event | None) -> None:
        if event is not None and event.is_set():
            raise SessionLeaseLost("technical log delivery lost the worker session lease")

    async def _heartbeat_session(self, stop_event: asyncio.Event, fatal_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=self.config.session_lease_heartbeat_seconds,
                )
            except asyncio.TimeoutError:
                try:
                    await self.erp.heartbeat_worker_session()
                except SessionLeaseLost as exc:
                    print(f"CNC Telegram session lease lost: {exc}", flush=True)
                    fatal_event.set()
                    stop_event.set()
                    return
                except Exception as exc:
                    print(f"CNC Telegram session heartbeat failed: {exc}", flush=True)
                    fatal_event.set()
                    stop_event.set()
                    return

    async def poll_media_restore_requests(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        stop_event: asyncio.Event,
        *,
        fatal_event: asyncio.Event | None = None,
    ) -> None:
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=self.config.media_restore_poll_interval_seconds,
                )
            except asyncio.TimeoutError:
                pass
            if stop_event.is_set():
                break
            try:
                await self.process_media_restore_requests(client, entity, chat_id)
            except SessionLeaseLost:
                if fatal_event is not None:
                    fatal_event.set()
                stop_event.set()
                return
            except Exception as exc:
                print(f"media restore polling failed: {exc}", flush=True)
                traceback.print_exception(exc)

    async def run_svg_refresh_backfill(
        self,
        workday: date | None = None,
        days: int | None = None,
        *,
        write: bool = False,
    ) -> None:
        raise RuntimeError(
            "svg-refresh-backfill is disabled after Phase A; history reads require the Phase B persisted scan flow",
        )

    async def process_media_restore_requests(self, client: Any, entity: Any, chat_id: str) -> int:
        claim = await self.erp.claim_media_restores()
        if claim.get("capability") != "cnc_telegram_media_restore_v1":
            raise RuntimeError("backend does not expose cnc_telegram_media_restore_v1")
        tasks = (claim.get("tasks") or [])[:1]
        for task in tasks:
            request_id = str(task.get("requestId") or "")
            item_lease = parse_optional_item_lease(task)
            if item_lease is None:
                raise SessionLeaseLost("backend restore task has no fenced item lease")
            try:
                task_chat_id = str(task.get("sourceChatId") or "")
                message_id = int(task.get("sourceMessageId") or 0)
                if task_chat_id != chat_id:
                    raise RuntimeError("restore task targets a different Telegram chat")
                if message_id <= 0:
                    raise RuntimeError("restore task has invalid Telegram message id")
                message = await client.get_messages(entity, ids=message_id)
                if message is None or not is_image_message(message):
                    raise RuntimeError("Telegram screenshot message is unavailable")
                restore_dir = self.config.temp_dir / f"restore-{request_id}"
                restore_dir.mkdir(parents=True, exist_ok=True)
                image_path = await download_media(message, restore_dir, "sheet")
                if image_path is None:
                    raise RuntimeError("Telegram returned no screenshot file")
                media = persist_sheet_image(
                    self.config.media_dir,
                    task_chat_id,
                    message_id,
                    image_path,
                    require_preview=True,
                )
                if storage_key_identity(media["storageKey"]) != storage_key_identity(str(task.get("storageKey") or "")):
                    raise RuntimeError("restored screenshot storage key does not match packet")
                if item_lease is None:
                    await self.erp.complete_media_restore(request_id, media)
                else:
                    await self.erp.complete_media_restore(request_id, media, item_lease)
            except SessionLeaseLost:
                raise
            except Exception as exc:
                error_message = sanitize_text(str(exc), 500) or "Telegram screenshot restore failed"
                try:
                    await self.erp.fail_media_restore(request_id, error_message, item_lease)
                except SessionLeaseLost:
                    raise
                except Exception as report_exc:
                    print(f"restore {request_id} failure delivery deferred: {report_exc}", flush=True)
                print(f"restore {request_id} failed: {error_message}", flush=True)
        return len(tasks)

    async def process_manual_svg_telegram_send_requests(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        *,
        audit_spool: AuditSpool | None = None,
        session_user_id: str | None = None,
        audit_flush_lock: asyncio.Lock | None = None,
    ) -> int:
        claim = await self.erp.claim_manual_svg_telegram_sends()
        if claim.get("capability") != "cnc_manual_svg_telegram_send_v1":
            raise RuntimeError("backend does not expose cnc_manual_svg_telegram_send_v1")
        processed = 0
        for task in (claim.get("tasks") or [])[:1]:
            processed += 1
            request_id = str(task.get("requestId") or "")
            item_lease = parse_optional_item_lease(task)
            if item_lease is None:
                raise SessionLeaseLost("backend manual send task has no fenced item lease")
            try:
                files = task.get("files") or []
                if not isinstance(files, list) or not files:
                    raise RuntimeError("manual SVG Telegram send task has no files")
                send_dir = self.config.temp_dir / f"manual-svg-send-{request_id}"
                send_dir.mkdir(parents=True, exist_ok=True)
                send_files: list[ManualSvgSendFile] = []
                for index, file_item in enumerate(files, start=1):
                    path = write_manual_svg_send_file(send_dir, file_item, index)
                    kind = str(file_item.get("kind") or "").lower() if isinstance(file_item, dict) else ""
                    send_files.append(ManualSvgSendFile(kind=kind, path=path))
                message_text = manual_svg_send_message_text(task)
                sent = await send_manual_svg_upload_files(client, entity, send_files, message_text)
                if audit_spool is not None:
                    try:
                        record_manual_svg_sent_messages(
                            audit_spool,
                            chat_id,
                            session_user_id,
                            self.config.parser_version,
                            getattr(self.config, "can_send_manual_svg_uploads", getattr(self.config, "can_write_chat", False)),
                            self.config.business_timezone,
                            str(task.get("packetId") or "") or None,
                            str(task.get("cutJobId") or "") or None,
                            str(task.get("cutJobDisplayNumber") or "") or None,
                            sent,
                        )
                        await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
                    except Exception as audit_exc:
                        print(f"manual SVG send audit delivery deferred: {audit_exc}", flush=True)
                completion = {
                    "sentChatId": chat_id,
                    "sentMessageIds": manual_svg_sent_message_ids(sent),
                }
                if item_lease is None:
                    await self.erp.complete_manual_svg_telegram_send(request_id, completion)
                else:
                    await self.erp.complete_manual_svg_telegram_send(request_id, completion, item_lease)
                if audit_spool is not None:
                    try:
                        await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
                    except Exception as audit_exc:
                        print(f"manual SVG send audit delivery deferred: {audit_exc}", flush=True)
            except SessionLeaseLost:
                raise
            except Exception as exc:
                error_message = sanitize_text(str(exc), 500) or "Manual SVG Telegram send failed"
                traceback.print_exception(exc)
                try:
                    await self.erp.fail_manual_svg_telegram_send(request_id, error_message, item_lease)
                except SessionLeaseLost:
                    raise
                except Exception as report_exc:
                    print(f"manual SVG send {request_id} failure delivery deferred: {report_exc}", flush=True)
                print(f"manual SVG send {request_id} failed: {error_message}", flush=True)
        return processed

    async def poll_manual_svg_telegram_send_requests(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        stop_event: asyncio.Event,
        *,
        audit_spool: AuditSpool | None = None,
        session_user_id: str | None = None,
        audit_flush_lock: asyncio.Lock | None = None,
        fatal_event: asyncio.Event | None = None,
    ) -> None:
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=self.config.manual_svg_send_poll_interval_seconds,
                )
            except asyncio.TimeoutError:
                pass
            if stop_event.is_set():
                break
            try:
                await self.process_manual_svg_telegram_send_requests(
                    client,
                    entity,
                    chat_id,
                    audit_spool=audit_spool,
                    session_user_id=session_user_id,
                    audit_flush_lock=audit_flush_lock,
                )
            except SessionLeaseLost:
                if fatal_event is not None:
                    fatal_event.set()
                stop_event.set()
                return
            except Exception as exc:
                print(f"manual SVG send polling failed: {exc}", flush=True)
                traceback.print_exception(exc)

    async def poll_queue_scheduler(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        stop_event: asyncio.Event,
        *,
        audit_spool: AuditSpool | None = None,
        session_user_id: str | None = None,
        audit_flush_lock: asyncio.Lock | None = None,
        fatal_event: asyncio.Event | None = None,
    ) -> None:
        scheduler = WeightedQueueScheduler()
        ready_since: dict[str, float] = {}
        next_probe_at: dict[str, float] = {}
        import_poll_interval = getattr(self.config, "import_queue_poll_interval_seconds", 5)
        poll_intervals = {
            "manual": self.config.poll_interval_seconds,
            "import": import_poll_interval,
            "restore": self.config.poll_interval_seconds,
            "discovery": import_poll_interval,
        }
        while not stop_event.is_set():
            now = time.monotonic()
            enabled = {
                "manual": self.config.can_send_manual_svg_uploads,
                "import": True,
                "restore": True,
                "discovery": True,
            }
            ready: dict[str, bool] = {}
            for name, is_enabled in enabled.items():
                if not is_enabled:
                    ready[name] = False
                    ready_since.pop(name, None)
                    next_probe_at.pop(name, None)
                elif now >= next_probe_at.get(name, 0.0):
                    ready[name] = True
                    ready_since.setdefault(name, now)
                else:
                    # A queue that was just found empty is cooling down. It
                    # must not age while it is not being probed.
                    ready[name] = False
                    ready_since.pop(name, None)
            queue_name = scheduler.choose(ready, ready_since, now)
            if queue_name is None:
                cooling = [
                    next_probe_at[name]
                    for name, is_enabled in enabled.items()
                    if is_enabled and name in next_probe_at
                ]
                timeout = min(poll_intervals.values())
                if cooling:
                    timeout = min(timeout, max(min(cooling) - now, 0.0))
                try:
                    await asyncio.wait_for(
                        stop_event.wait(),
                        timeout=timeout,
                    )
                except asyncio.TimeoutError:
                    pass
                continue
            processed = 0
            try:
                if queue_name == "manual":
                    processed = await self.process_manual_svg_telegram_send_requests(
                        client, entity, chat_id,
                        audit_spool=audit_spool,
                        session_user_id=session_user_id,
                        audit_flush_lock=audit_flush_lock,
                    )
                elif queue_name == "restore":
                    processed = await self.process_media_restore_requests(client, entity, chat_id)
                elif queue_name == "discovery":
                    processed = await self.process_import_scan_queue(
                        client,
                        entity,
                        chat_id,
                        between_days=(
                            lambda: self.process_manual_svg_telegram_send_requests(
                                client,
                                entity,
                                chat_id,
                                audit_spool=audit_spool,
                                session_user_id=session_user_id,
                                audit_flush_lock=audit_flush_lock,
                            )
                            if self.config.can_send_manual_svg_uploads
                            else asyncio.sleep(0)
                        ),
                    )
                else:
                    processed = await self.process_import_item_queue(client, entity, chat_id)
            except SessionLeaseLost:
                if fatal_event is not None:
                    fatal_event.set()
                stop_event.set()
                return
            except Exception as exc:
                print(f"CNC Telegram {queue_name} queue failed: {exc}", flush=True)
                traceback.print_exception(exc)
            if processed == 0:
                # Cool down only this empty queue. Other queues remain eligible
                # and are probed immediately, so an empty manual queue cannot
                # delay an available import queue by its weighted slots.
                ready_since.pop(queue_name, None)
                next_probe_at[queue_name] = time.monotonic() + poll_intervals[queue_name]
                await asyncio.sleep(0)
            else:
                next_probe_at.pop(queue_name, None)
                await asyncio.sleep(0)

    async def process_import_scan_queue(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        *,
        between_days: Callable[[], Awaitable[None]] | None = None,
    ) -> int:
        claim = await self.erp.claim_import_scans()
        tasks = claim if isinstance(claim, list) else (claim.get("tasks") or [])
        if not isinstance(tasks, list):
            raise RuntimeError("import scan claim response has invalid tasks")
        for task in tasks[:1]:
            if not isinstance(task, dict):
                raise RuntimeError("import scan task is invalid")
            scan_id = str(task.get("scanId") or "")
            lease = parse_optional_item_lease(task)
            if lease is None:
                raise SessionLeaseLost("backend import scan has no fenced lease")
            if str(task.get("sourceChatId") or chat_id) != chat_id:
                raise RuntimeError("import scan targets a different Telegram chat")
            try:
                start = parse_iso_date(task.get("dateFrom"))
                end = parse_iso_date(task.get("dateTo"))
                if end < start or (end - start).days > 30:
                    raise RuntimeError("import scan date range is outside the 31-day bound")
                day_offset = int(task.get("daysProcessed") or 0)
                total_days = (end - start).days + 1
                if day_offset < 0 or day_offset > total_days:
                    raise RuntimeError("import scan progress is invalid")
                scan_progress = task.get("progress") if isinstance(task.get("progress"), dict) else {}
                messages_seen = max(int(scan_progress.get("messagesProcessed") or 0), int(task.get("messagesScanned") or 0))
                candidates_seen = max(int(scan_progress.get("candidatesTotal") or 0), int(task.get("candidatesFound") or 0))
                truncated = bool(task.get("truncated") or scan_progress.get("truncated"))
                days_scanned = day_offset
                for current_offset in range(day_offset, total_days):
                    remaining_messages = max(5000 - messages_seen, 0)
                    remaining_candidates = max(500 - candidates_seen, 0)
                    # Candidate rows have a separate bound, but reaching it
                    # must not stop the raw-message view: continue reading
                    # remaining days until the 5000-message scan bound.
                    if remaining_messages == 0:
                        truncated = True
                        break
                    day = start + timedelta(days=current_offset)
                    candidates, page = await self.discover_workday(
                        client,
                        entity,
                        chat_id,
                        day,
                        scan_id=scan_id,
                        max_messages=remaining_messages,
                        max_candidates=remaining_candidates,
                    )
                    messages_seen += int(page["messagesProcessed"])
                    candidates_seen += int(page["candidatesFound"])
                    truncated = truncated or bool(page["truncated"])
                    days_scanned = current_offset + 1
                    # One fenced batch is the atomic checkpoint for one day.
                    # Never advance days_scanned before every bounded message
                    # from that day is persisted.
                    await self.erp.submit_import_scan_candidates(
                        scan_id,
                        candidates,
                        lease,
                        messages=page.get("messages", []),
                        days_scanned=current_offset + 1,
                        messages_scanned=messages_seen,
                        truncated=truncated,
                    )
                    if between_days is not None and current_offset + 1 < total_days:
                        await between_days()
                    await asyncio.sleep(0)
                await self.erp.complete_import_scan(
                    scan_id,
                    {
                        "daysScanned": days_scanned,
                        "messagesScanned": messages_seen,
                        "truncated": truncated,
                    },
                    lease,
                )
            except SessionLeaseLost:
                raise
            except Exception as exc:
                await self.erp.fail_import_scan(
                    scan_id,
                    "DISCOVERY_FAILED",
                    sanitize_text(str(exc), 500) or "Telegram discovery failed",
                    lease,
                )
        return len(tasks[:1])

    async def process_import_item_queue(self, client: Any, entity: Any, chat_id: str) -> int:
        claim = await self.erp.claim_import_items()
        tasks = claim if isinstance(claim, list) else (claim.get("tasks") or [])
        if not isinstance(tasks, list):
            raise RuntimeError("import item claim response has invalid tasks")
        for task in tasks[:1]:
            if not isinstance(task, dict):
                raise RuntimeError("import item task is invalid")
            item_id = str(task.get("importItemId") or task.get("itemId") or "")
            lease = parse_optional_item_lease(task)
            if lease is None:
                raise SessionLeaseLost("backend import item has no fenced lease")
            try:
                result = await self.import_candidate(client, entity, chat_id, task)
                await self.erp.complete_import_item(item_id, result, lease)
            except SessionLeaseLost:
                raise
            except SourceChangedError as exc:
                await self.erp.fail_import_item(item_id, "SOURCE_CHANGED_RESCAN_REQUIRED", str(exc), lease)
            except Exception as exc:
                await self.erp.fail_import_item(
                    item_id,
                    "IMPORT_FAILED",
                    sanitize_text(str(exc), 500) or "Telegram import failed",
                    lease,
                )
        return len(tasks[:1])

    async def discover_workday(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        workday: date,
        *,
        scan_id: str = "discovery",
        max_messages: int | None = None,
        max_candidates: int = 500,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Read one bounded history page and return candidates plus all messages.

        This deliberately does not instantiate ``ScanAudit``, ingest a packet,
        enqueue outbound work, or send a Telegram reply.  Bytes exist only in
        the per-page temporary directory and are removed in ``finally``.
        """
        max_messages = min(max(int(max_messages or self.config.max_messages_per_scan), 1), 5000)
        messages = await asyncio.wait_for(
            collect_day_messages(
                client, entity, workday, self.config.business_timezone, max_messages,
            ),
            timeout=TELEGRAM_MEDIA_TIMEOUT_SECONDS,
        )
        truncated = len(messages) >= max_messages
        groups = group_svg_messages(messages)
        candidates: list[dict[str, Any]] = []
        page_dir = self.config.temp_dir / f"import-discovery-{safe_path_component(scan_id)}-{workday.isoformat()}"
        try:
            bounded_candidates = min(len(groups), max(max_candidates, 0))
            page_started = time.monotonic()
            for page_start in range(0, bounded_candidates, 50):
                for group_index, group in enumerate(groups[page_start:page_start + 50]):
                    candidate_dir = page_dir / f"candidate-{page_start + group_index}"
                    try:
                        candidate = await self._discover_group_candidate(
                            client, group, chat_id, workday, candidate_dir, related_messages=messages,
                        )
                        # Current backend strict DTO requires a non-null SVG
                        # SHA-256 even for invalid layout candidates.  Do not
                        # emit a DTO-rejected incomplete row when bytes are gone;
                        # the scan truncation/warning counters remain visible.
                        if candidate.get("svgContentSha256"):
                            candidates.append(candidate)
                    finally:
                        shutil.rmtree(candidate_dir, ignore_errors=True)
                    if (group_index + 1) % DISCOVERY_PAGE_MESSAGES == 0 or time.monotonic() - page_started >= DISCOVERY_PAGE_SECONDS:
                        await asyncio.sleep(0)
                        page_started = time.monotonic()
                # Parsing is explicitly paged so a 31-day/1000-message read
                # yields to outbound work between every bounded page.
                await asyncio.sleep(0)
                page_started = time.monotonic()
        finally:
            shutil.rmtree(page_dir, ignore_errors=True)
        candidate_links: dict[int, tuple[int, str]] = {}
        for candidate in candidates:
            candidate_source_id = int(candidate["sourceMessageId"])
            for link in candidate.get("messageLinks", []):
                try:
                    candidate_links[int(link["sourceMessageId"])] = (candidate_source_id, str(link["candidateRole"]))
                except (KeyError, TypeError, ValueError):
                    continue
        serialized_messages = [
            serialize_import_scan_message(message, chat_id, workday, ordinal, candidate_links)
            for ordinal, message in enumerate(messages, start=1)
        ]
        warnings = sum(len(candidate.get("warnings") or []) for candidate in candidates)
        return candidates, {
            "messagesProcessed": len(messages),
            "candidatesFound": len(candidates),
            "warningsCount": warnings,
            "truncated": truncated or len(groups) > bounded_candidates,
            "messages": serialized_messages,
        }

    async def _discover_group_candidate(
        self,
        client: Any,
        group: SvgGroup,
        chat_id: str,
        workday: date,
        page_dir: Path,
        *,
        related_messages: list[Any] | None = None,
        include_content: bool = False,
    ) -> dict[str, Any]:
        page_dir.mkdir(parents=True, exist_ok=True)
        files: list[dict[str, Any]] = []
        cut_layout: dict[str, Any] | None = None
        warnings: list[str] = []
        gcode_analysis: Any | None = None
        svg_path = await asyncio.wait_for(
            download_media(group.vector_message, page_dir, "svg"),
            timeout=TELEGRAM_MEDIA_TIMEOUT_SECONDS,
        )
        if svg_path is None:
            warnings.append("SVG source is unavailable")
        else:
            files.append(source_file_identity(svg_path, group.vector_message, "svg"))
            try:
                cut_layout = layout_to_dict(
                    parse_svg_cut_layout(
                        svg_path,
                        mode=getattr(self.config, "svg_validation_mode", "lenient"),
                    ),
                )
                if cut_layout.get("status") != "valid":
                    warnings.extend(sanitize_text(str(reason), 200) for reason in cut_layout.get("reasons") or [])
            except Exception as exc:
                warnings.append(sanitize_text(str(exc), 200) or "SVG parse failed")
        if group.gcode_message is not None:
            gcode_path = await asyncio.wait_for(
                download_media(group.gcode_message, page_dir, "gcode"),
                timeout=TELEGRAM_MEDIA_TIMEOUT_SECONDS,
            )
            if gcode_path is None:
                warnings.append("G-code source is unavailable")
            else:
                files.append(source_file_identity(gcode_path, group.gcode_message, "gcode"))
                gcode_text = gcode_path.read_text(encoding="utf-8", errors="replace")
                gcode_analysis = parse_gcode_text(gcode_text, message_filename(group.gcode_message) or gcode_path.name)
        if group.image_message is not None:
            screenshot_path = await asyncio.wait_for(
                download_media(group.image_message, page_dir, "screenshot"),
                timeout=TELEGRAM_MEDIA_TIMEOUT_SECONDS,
            )
            if screenshot_path is not None:
                files.append(source_file_identity(screenshot_path, group.image_message, "screenshot"))
        comment_messages = [
            message for message in (related_messages or [])
            if message not in (group.vector_message, group.image_message, group.gcode_message)
            and message_text(message) in group.comments
            and not is_cutting_sequence_reply_text(message_text(message))
        ]
        source_ids = [
            int(message.id)
            for message in (group.vector_message, group.image_message, group.gcode_message, *comment_messages)
            if message is not None
        ]
        message_links = [
            {"sourceMessageId": int(group.vector_message.id), "candidateRole": "svg"},
            *([{"sourceMessageId": int(group.gcode_message.id), "candidateRole": "gcode"}] if group.gcode_message is not None else []),
            *([{"sourceMessageId": int(group.image_message.id), "candidateRole": "screenshot"}] if group.image_message is not None else []),
            *({"sourceMessageId": int(message.id), "candidateRole": "comment"} for message in comment_messages),
        ]
        if include_content:
            total_size = 0
            for source_file in files:
                path = page_dir / f"{source_file['kind']}-{source_file.get('fileName') or ''}"
                # Resolve the actual downloaded file by its identity hash; do
                # not trust Telegram-provided names for filesystem lookup.
                matches = [candidate for candidate in page_dir.iterdir() if candidate.is_file() and file_sha256(candidate) == source_file["sha256"]]
                if len(matches) != 1:
                    raise RuntimeError("revalidated source file is unavailable")
                raw = matches[0].read_bytes()
                if not raw or len(raw) > IMPORT_MAX_FILE_BYTES:
                    raise RuntimeError("revalidated source file exceeds import size bounds")
                total_size += len(raw)
                source_file.update({
                    "contentType": source_file.get("contentType") or "application/octet-stream",
                    "sizeBytes": len(raw),
                    "base64Content": base64.b64encode(raw).decode("ascii"),
                })
            if total_size > IMPORT_MAX_TOTAL_BYTES or len(files) > 3:
                raise RuntimeError("revalidated source set exceeds import size bounds")
        source_set_fingerprint = import_source_set_fingerprint(
            group, chat_id, workday, files, self.config.parser_version, comment_messages=comment_messages,
        )
        layout_fingerprint = canonical_layout_fingerprint(cut_layout) if cut_layout is not None else None
        snapshot: dict[str, Any] = {
            "externalPacketKey": external_packet_key(chat_id, int(group.source_message.id)),
            "sourceMessageIds": [str(source_id) for source_id in source_ids],
            "comments": [sanitize_text(comment, 500) for comment in group.comments[:50]],
            "items": (cut_layout or {}).get("items", [])[:2000],
            "cutLayout": cut_layout,
            "gcodeAnalysis": asdict(gcode_analysis) if gcode_analysis is not None else None,
            "parserVersion": self.config.parser_version,
        }
        eligible = bool(files and cut_layout and cut_layout.get("status") == "valid")
        if not eligible and not warnings:
            warnings.append("candidate has no valid complete SVG source")
        return {
            "sourceChatId": chat_id,
            "sourceMessageId": str(int(group.source_message.id)),
            "sourceThreadId": str(thread_id) if (thread_id := message_thread_id(group.source_message)) is not None else None,
            "sourceCreatedAt": message_datetime(group.source_message).isoformat(),
            "sourceUpdatedAt": message_edited_datetime(group.source_message).isoformat() if message_edited_datetime(group.source_message) else None,
            "workday": workday.isoformat(),
            "svgMessageId": str(int(group.vector_message.id)),
            "gcodeMessageId": str(int(group.gcode_message.id)) if group.gcode_message is not None else None,
            "screenshotMessageId": str(int(group.image_message.id)) if group.image_message is not None else None,
            "svgFileName": message_filename(group.vector_message) or f"{group.vector_message.id}.svg",
            "gcodeFileName": message_filename(group.gcode_message) if group.gcode_message is not None else None,
            "screenshotFileName": message_filename(group.image_message) if group.image_message is not None else None,
            "svgContentSha256": next((item["sha256"] for item in files if item["kind"] == "svg"), None),
            "gcodeContentSha256": next((item["sha256"] for item in files if item["kind"] == "gcode"), None),
            "screenshotContentSha256": next((item["sha256"] for item in files if item["kind"] == "screenshot"), None),
            "sourceSetFingerprint": source_set_fingerprint,
            "parserVersion": self.config.parser_version,
            "layoutFingerprint": layout_fingerprint,
            "parsedSnapshot": snapshot,
            "cutLayout": cut_layout,
            "sourceFiles": files,
            "messageLinks": message_links,
            "warnings": [warning for warning in warnings if warning],
            "eligibilityStatus": "valid" if eligible else "incomplete",
        }

    async def import_candidate(self, client: Any, entity: Any, chat_id: str, task: dict[str, Any]) -> dict[str, Any]:
        """Re-read and validate the complete source set before backend completion."""
        candidate = task.get("candidate") if isinstance(task.get("candidate"), dict) else task
        snapshot = candidate.get("parsedSnapshot") if isinstance(candidate.get("parsedSnapshot"), dict) else {}
        expected_ids = [int(value) for value in snapshot.get("sourceMessageIds", []) if str(value).isdigit()]
        if not expected_ids:
            expected_ids = [
                int(value) for value in (
                    candidate.get("svgMessageId"), candidate.get("gcodeMessageId"), candidate.get("screenshotMessageId"),
                ) if value is not None and str(value).isdigit()
            ]
        if not expected_ids:
            raise RuntimeError("import candidate has no source message ids")
        fetched = await client.get_messages(entity, ids=expected_ids)
        messages = fetched if isinstance(fetched, list) else [fetched]
        messages = [message for message in messages if message is not None]
        if {int(message.id) for message in messages} != set(expected_ids):
            raise SourceChangedError("one or more Telegram source messages were deleted")
        groups = group_svg_messages(messages)
        source_id = int(candidate.get("sourceMessageId") or candidate.get("svgMessageId") or 0)
        group = next((item for item in groups if int(item.source_message.id) == source_id), None)
        if group is None:
            raise SourceChangedError("Telegram source grouping changed")
        temp_dir = self.config.temp_dir / f"import-selected-{safe_path_component(str(task.get('importItemId') or source_id))}"
        try:
            current = await self._discover_group_candidate(
                client, group, chat_id, parse_iso_date(candidate.get("workday") or candidate.get("sourceCreatedAt")), temp_dir,
                related_messages=messages,
                include_content=True,
            )
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
        expected_fingerprint = str(candidate.get("sourceSetFingerprint") or "")
        if not expected_fingerprint or current["sourceSetFingerprint"] != expected_fingerprint:
            raise SourceChangedError("Telegram source set changed since discovery")
        if current.get("eligibilityStatus") != "valid":
            raise RuntimeError("import candidate is not eligible")
        source = {
            key: current[key]
            for key in (
                "sourceChatId", "sourceMessageId", "svgMessageId", "gcodeMessageId", "screenshotMessageId",
                "svgFileName", "gcodeFileName", "screenshotFileName", "svgContentSha256",
                "gcodeContentSha256", "screenshotContentSha256",
            )
        }
        return {
            "sourceSetFingerprint": current["sourceSetFingerprint"],
            "source": source,
            "sourceFiles": [
                {
                    key: file[key]
                    for key in ("kind", "fileName", "contentType", "sizeBytes", "sha256", "base64Content")
                }
                for file in current.get("sourceFiles", [])
            ],
        }

    async def run_daemon(self, days: int | None = None) -> None:
        raise RuntimeError("daemon is deprecated and fail-closed; use `serve`")

    async def scan_workday(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        workday: date,
        audit_spool: AuditSpool,
        session_user_id: str | None,
        audit_flush_lock: asyncio.Lock | None = None,
    ) -> None:
        audit = ScanAudit.start(
            audit_spool, chat_id, workday, session_user_id,
            self.config.parser_version, self.config.can_write_chat,
            business_timezone=self.config.business_timezone,
        )
        await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
        try:
            try:
                messages = await collect_day_messages(
                    client,
                    entity,
                    workday,
                    self.config.business_timezone,
                    self.config.max_messages_per_scan,
                    observer=lambda message, ordinal: audit.observe(message, "day_history", ordinal),
                )
            except Exception:
                audit.scan["dayErrorCode"] = "telegram_read_failed"
                audit.spool.save_scan(audit.scan)
                raise
            audit.scan["dayTruncated"] = audit.scan["dayYieldedCount"] >= self.config.max_messages_per_scan
            groups = group_svg_messages(messages)
            audit.scan["svgCount"] = len(groups)
            # Every Telegram reply used by a scan must pass the same audited
            # sender/window/ambiguity taxonomy, including replies already in day history.
            groups = [replace(group, cutting_sequence_no=None) for group in groups]
            groups = apply_known_cutting_sequence_state(groups, chat_id, self.state)
            source_message_ids = {int(group.source_message.id) for group in groups}
            known_sequence_index = {
                int(group.source_message.id): group.cutting_sequence_no
                for group in groups
                if group.cutting_sequence_no is not None
            }
            if source_message_ids:
                try:
                    sequence_index = await collect_cutting_sequence_reply_search_index(
                        client,
                        entity,
                        source_message_ids,
                        session_user_id=session_user_id,
                        workday=workday,
                        business_timezone=self.config.business_timezone,
                        known_sequence_index=known_sequence_index,
                        observer=lambda message, ordinal, decision: audit.observe(
                            message, "reply_search", ordinal, decision_code=decision,
                        ),
                    )
                except Exception:
                    audit.scan["replySearchErrorCode"] = "telegram_read_failed"
                    audit.spool.save_scan(audit.scan)
                    raise
                audit.scan["replySearchTruncated"] = audit.scan["replySearchYieldedCount"] >= 1000
                rejected_local_sequences = {
                    source_id: (
                        f"Локальный номер раскроя №{number} отклонён: "
                        + (
                            "поиск Telegram нашёл противоречащий ответ"
                            if source_id in sequence_index
                            else "подтверждающий исходящий ответ Telegram не найден"
                        )
                    )
                    for source_id, number in known_sequence_index.items()
                    if sequence_index.get(source_id) != number
                }
                groups = apply_cutting_sequence_reply_index(groups, sequence_index)
            else:
                rejected_local_sequences = {}
            for group in groups:
                try:
                    await self.process_group(
                        client,
                        entity,
                        group,
                        chat_id,
                        workday,
                        audit=audit,
                        cutting_sequence_rejection=rejected_local_sequences.get(int(group.source_message.id)),
                    )
                except Exception as exc:
                    print(f"SVG message {group.vector_message.id} failed: {exc}", flush=True)
            selected_ids = {
                int(message.id)
                for group in groups
                for message in (group.vector_message, group.image_message, group.gcode_message)
                if message is not None
            }
            source_ids = {int(group.source_message.id) for group in groups}
            comment_relations = {
                int(message.id): group.vector_message
                for group in groups
                for message in messages
                if message_text(message) and message_text(message) in group.comments
            }
            for message in messages:
                if int(message.id) in selected_ids:
                    continue
                filename = (message_filename(message) or "").lower()
                if int(message.id) in comment_relations:
                    audit.mark_message(message, "used", "comment_selected", "Комментарий добавлен к заданию", comment_relations[int(message.id)])
                elif filename.endswith(".dxf"):
                    audit.mark_message(message, "skipped", "unsupported_dxf", "DXF не поддерживается worker-ом")
                elif is_cutting_sequence_reply_text(message_text(message)):
                    existing_reason = audit.record_for(message).get("reasonCode")
                    if isinstance(existing_reason, str) and existing_reason.startswith("reply_"):
                        continue
                    if message_reply_to_id(message) not in source_ids:
                        code, reason = "reply_unrelated", "Ответ не связан с выбранным SVG"
                    elif session_user_id is None or str(getattr(message, "sender_id", None)) != session_user_id:
                        code, reason = "reply_foreign_sender", "Ответ оставил другой пользователь; номер отклонён"
                    elif not bool(getattr(message, "out", False)):
                        code, reason = "reply_not_outgoing", "Ответ не отправлен текущей сессией; номер отклонён"
                    else:
                        code, reason = "reply_unrelated", "Связанный ответ не был выбран поиском Telegram; номер отклонён"
                    audit.mark_message(message, "skipped", code, reason)
                else:
                    audit.mark_message(message, "skipped", "no_svg_association", "Сообщение не связано с выбранным SVG")
            audit.complete()
        except Exception as exc:
            audit.complete("failed", exc)
            raise
        finally:
            try:
                await flush_audit_spool(audit_spool, self.erp.audit_batch, audit_flush_lock)
            except Exception as exc:
                print(f"audit delivery deferred: {exc}", flush=True)

    async def process_group(
        self,
        client: Any,
        entity: Any,
        group: SvgGroup,
        chat_id: str,
        workday: date,
        audit: ScanAudit | None = None,
        cutting_sequence_rejection: str | None = None,
        refresh_imported: bool = False,
        dry_run: bool = False,
    ) -> str:
        source_message = group.source_message
        external_key = external_packet_key(chat_id, int(source_message.id))
        audit_operation = audit.begin_operation(
            group.vector_message,
            "message_processing",
            externalPacketKey=external_key,
        ) if audit else None
        if audit and audit_operation and cutting_sequence_rejection is not None:
            audit.add_operation_step(
                audit_operation,
                group.vector_message,
                "reply_search",
                "skipped",
                cutting_sequence_rejection,
            )
        run_dir = self.config.temp_dir / f"{chat_id.strip('-')}-{source_message.id}"
        gcode_meta: GcodeMeta | None = None
        try:
            cutting_sequence_no = group.cutting_sequence_no
            sequence_from_telegram = cutting_sequence_no is not None
            pending_sequence_reply = (
                self.config.can_write_chat
                and not refresh_imported
                and not sequence_from_telegram
                and self.state.cutting_sequence_number(external_key) is not None
                and not self.state.cutting_sequence_replied(external_key)
            )

            source_fingerprint = group_source_fingerprint(
                group,
                chat_id,
                workday,
                self.config.parser_version,
                self.config.ocr_engine,
                cutting_sequence_no=cutting_sequence_no,
            )
            if (
                not self.config.resend_unchanged
                and not refresh_imported
                and not dry_run
                and not pending_sequence_reply
                and self.state.source_unchanged(external_key, source_fingerprint)
            ):
                print(f"skip source unchanged {external_key}", flush=True)
                if audit and audit_operation:
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не обрабатывался: источник не изменился")
                        audit.finish_operation(audit_operation, group.vector_message, "skipped", "source_unchanged", "Источник не изменился")
                return "skipped"

            run_dir.mkdir(parents=True, exist_ok=True)
            try:
                vector_path = await download_media(group.vector_message, run_dir, "vector")
            except Exception as exc:
                if audit and audit_operation:
                    error_message = sanitize_text(str(exc), 1000)
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не обработан: ошибка скачивания из Telegram")
                        audit.finish_operation(
                            audit_operation, group.vector_message, "failed", "svg_download_failed",
                            error_message, errorCode="svg_download_failed", errorMessage=error_message,
                        )
                raise
            if vector_path is None:
                print(f"skip SVG message {group.vector_message.id}: download returned no path", flush=True)
                if audit and audit_operation:
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не обработан: Telegram не вернул файл")
                        audit.finish_operation(audit_operation, group.vector_message, "failed", "svg_download_failed", "Telegram не вернул файл SVG")
                return "skipped"
            source_files: list[dict[str, Any]] = [
                source_file_identity(vector_path, group.vector_message, "svg"),
            ]
            svg_validation_mode = getattr(self.config, "svg_validation_mode", "lenient")
            parsed_layout = parse_svg_cut_layout(vector_path, mode=svg_validation_mode)
            cut_layout = layout_to_dict(parsed_layout)
            if cut_layout["status"] != "valid":
                reasons = "; ".join(cut_layout.get("reasons") or ["invalid SVG layout"])
                print(f"skip SVG message {group.vector_message.id}: {reasons}", flush=True)
                if audit and audit_operation:
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не обработан: некорректный макет")
                        audit.finish_operation(audit_operation, group.vector_message, "skipped", "svg_invalid_layout", reasons)
                return "skipped"
            vector_items = cut_layout["items"]

            thumbs_up = group_has_thumbs_up(group)
            sheet_image: dict[str, Any] | None = None
            if group.gcode_message is not None:
                try:
                    gcode_path = await download_media(group.gcode_message, run_dir, "program")
                except Exception as exc:
                    if audit and audit_operation:
                        error_message = sanitize_text(str(exc), 1000)
                        with audit.spool.transaction():
                            audit.mark_message(
                                group.gcode_message, "failed", "gcode_download_failed",
                                error_message, group.vector_message,
                            )
                            mark_unfinished_group_attachments(
                                audit, group, "Обработка вложения прервана из-за ошибки скачивания G-code",
                            )
                            audit.finish_operation(
                                audit_operation, group.vector_message, "failed", "gcode_download_failed",
                                error_message, errorCode="gcode_download_failed", errorMessage=error_message,
                            )
                    raise
                if gcode_path is not None:
                    source_files.append(source_file_identity(gcode_path, group.gcode_message, "gcode"))
                    try:
                        gcode_text = gcode_path.read_text(encoding="utf-8", errors="replace")
                        filename = message_filename(group.gcode_message) or gcode_path.name
                        gcode_meta = GcodeMeta(
                            filename=filename,
                            text=gcode_text,
                            analysis=parse_gcode_text(gcode_text, filename),
                        )
                    except Exception as exc:
                        if audit and audit_operation:
                            error_message = sanitize_text(str(exc), 1000)
                            with audit.spool.transaction():
                                audit.mark_message(
                                    group.gcode_message,
                                    "failed",
                                    "gcode_parse_failed",
                                    error_message,
                                    group.vector_message,
                                )
                                mark_unfinished_group_attachments(
                                    audit,
                                    group,
                                    "Вложение не попало в задание из-за ошибки разбора G-code",
                                )
                                audit.finish_operation(
                                    audit_operation,
                                    group.vector_message,
                                    "failed",
                                    "gcode_parse_failed",
                                    error_message,
                                    errorCode="gcode_parse_failed",
                                    errorMessage=error_message,
                                )
                        raise
                elif audit:
                    audit.mark_message(group.gcode_message, "failed", "gcode_download_failed", "Telegram не вернул G-code", group.vector_message)
            comments = list(group.comments)
            if source_message is not group.vector_message:
                vector_caption = message_text(group.vector_message)
                if vector_caption and vector_caption not in comments:
                    comments.insert(0, vector_caption)
            ocr = OcrResult()
            image = ImageMeta(
                chat_id=chat_id,
                message_id=int(source_message.id),
                thread_id=message_thread_id(source_message),
                message_date=message_datetime(source_message),
                edited_at=message_edited_datetime(source_message),
                text=message_text(source_message),
                thumbs_up=thumbs_up,
            )
            packet = build_structured_packet(
                image=image,
                workday=workday,
                comments=comments,
                ocr=ocr,
                gcode=gcode_meta,
                cutting_sequence_no=cutting_sequence_no,
                vector_items=vector_items,
                cut_layout=cut_layout,
                sheet_image=sheet_image,
                default_machine=self.config.default_machine,
                default_material=self.config.default_material,
                ocr_engine=self.config.ocr_engine,
                parser_version=self.config.parser_version,
            )
            packet["svgImportMode"] = {
                "validationMode": svg_validation_mode,
                "refreshImported": refresh_imported,
            }
            packet["sourceFiles"] = source_files
            payload_hash = canonical_payload_hash(packet)
            version = self.state.next_version(packet["externalPacketKey"], payload_hash)
            if dry_run:
                print(
                    f"dry-run SVG {group.vector_message.id}: items={len(vector_items)} "
                    f"sourceSvg={sum(1 for item in vector_items if item.get('sourceSvg'))} "
                    f"sequence={cutting_sequence_no}",
                    flush=True,
                )
                return "parsed"
            if (
                not version.changed
                and not self.config.resend_unchanged
                and not refresh_imported
                and not sequence_from_telegram
                and not pending_sequence_reply
                and self.state.posted_packet_matches(packet["externalPacketKey"], payload_hash, version.source_version)
            ):
                if audit and audit_operation:
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не отправлен: содержимое задания не изменилось")
                        audit.finish_operation(
                            audit_operation, group.vector_message, "skipped", "payload_unchanged", "Содержимое задания не изменилось",
                            externalPacketKey=packet["externalPacketKey"], sourceVersion=str(version.source_version),
                        )
                self.state.mark_posted(
                    packet["externalPacketKey"],
                    payload_hash,
                    version.source_version,
                    source_fingerprint,
                )
                print(f"skip unchanged {packet['externalPacketKey']} v{version.source_version}", flush=True)
                return "skipped"
            if audit:
                with audit.spool.transaction():
                    mark_used_group_attachments(audit, group)
            packet = apply_source_version(packet, version.source_version)
            idem = (
                svg_refresh_idempotency_key(packet["externalPacketKey"], version.source_version, payload_hash)
                if refresh_imported
                else idempotency_key(packet["externalPacketKey"], version.source_version)
            )
            if audit and audit_operation:
                audit.prepare_processing_attempt(
                    audit_operation, group.vector_message, packet, idem, payload_hash, source_fingerprint,
                )
            try:
                response = await self.erp.ingest_packet(packet, idem)
            except Exception as exc:
                if audit and audit_operation:
                    error_message = sanitize_text(str(exc), 1000)
                    status_code = getattr(getattr(exc, "response", None), "status_code", None)
                    if isinstance(status_code, int) and 400 <= status_code < 500:
                        audit.finish_operation(
                            audit_operation,
                            group.vector_message,
                            "failed",
                            "backend_ingest_failed",
                            error_message,
                            errorCode="backend_ingest_failed",
                            errorMessage=error_message,
                            externalPacketKey=packet["externalPacketKey"],
                            sourceVersion=str(version.source_version),
                            responses=[*audit.operations[audit_operation].get("responses", []), {
                                "responseId": f"backend-failed:{uuid.uuid4()}",
                                "kind": "backend_ingest",
                                "status": "failed",
                                "at": utc_now(),
                            }],
                        )
                    else:
                        audit.defer_processing_reconciliation(audit_operation, group.vector_message, error_message)
                raise
            response_packet = response.get("packet") if isinstance(response, dict) else None
            skipped_duplicate = response_skipped_duplicate_source_file(response)
            response_import_status = response_svg_cut_import_status(response, response_packet)
            response_cut_job_id = response_svg_cut_job_id(response_packet, skipped_duplicate)
            if audit and audit_operation:
                reason_code = "backend_duplicate_source_file" if skipped_duplicate else "backend_ingest_succeeded"
                reason_message = (
                    sanitize_text(str(skipped_duplicate.get("note") or ""), 1000)
                    if skipped_duplicate else "Задание принято ERP"
                )
                audit.finish_operation(
                    audit_operation, group.vector_message, "succeeded", reason_code, reason_message,
                    externalPacketKey=packet["externalPacketKey"], sourceVersion=str(version.source_version),
                    packetId=response_packet.get("packetId") if isinstance(response_packet, dict) else None,
                    cutJobId=str(response_cut_job_id) if response_cut_job_id is not None else None,
                    cutResultNo=response_packet.get("cutResultNo") if isinstance(response_packet, dict) else None,
                    cuttingSequenceNo=response_packet.get("cuttingSequenceNo") if isinstance(response_packet, dict) else None,
                    backendApplied=bool(response.get("applied")) if isinstance(response, dict) else None,
                    backendStale=bool(response.get("stale")) if isinstance(response, dict) and response.get("stale") is not None else None,
                    responses=[*audit.operations[audit_operation].get("responses", []), {
                        "responseId": f"backend:{uuid.uuid4()}", "kind": "backend_ingest",
                        "status": "succeeded", "at": utc_now(),
                    }],
                )
            response_sequence_no = (
                response_packet.get("cuttingSequenceNo")
                if isinstance(response_packet, dict)
                else None
            )
            if (
                response_allows_cutting_sequence_reply(response, response_packet)
                and isinstance(response_sequence_no, int)
                and not isinstance(response_sequence_no, bool)
                and response_sequence_no > 0
            ):
                self.state.assign_cutting_sequence_number(external_key, existing_number=response_sequence_no)
                if sequence_from_telegram and cutting_sequence_no == response_sequence_no:
                    self.state.mark_cutting_sequence_replied(external_key)
                if (
                    self.config.can_write_chat
                    and not refresh_imported
                    and cutting_sequence_no is None
                    and not self.state.cutting_sequence_replied(external_key)
                ):
                    blocked = audit is not None and audit.spool.has_unresolved_reply(chat_id, str(int(source_message.id)))
                    if blocked:
                        print(f"reply blocked pending reconciliation {external_key}", flush=True)
                    else:
                        reply_key = audit.begin_operation(
                            source_message, "telegram_reply",
                            externalPacketKey=external_key,
                            replyText=CUTTING_SEQUENCE_REPLY_TEXT.format(number=response_sequence_no),
                            replyToMessageId=str(int(source_message.id)),
                            sessionSenderUserId=audit.scan.get("sessionUserId"),
                            cuttingSequenceNo=response_sequence_no,
                            responses=[{
                                "responseId": f"telegram-plan:{uuid.uuid4()}", "kind": "telegram_reply",
                                "status": "planned", "at": utc_now(),
                                "text": CUTTING_SEQUENCE_REPLY_TEXT.format(number=response_sequence_no),
                                "replyToMessageId": str(int(source_message.id)),
                            }],
                        ) if audit else None
                        try:
                            sent_message = await send_cutting_sequence_reply(client, entity, source_message, response_sequence_no)
                        except Exception as exc:
                            if audit and reply_key:
                                error_message = sanitize_text(str(exc), 1000)
                                audit.defer_reply_reconciliation(reply_key, source_message, error_message)
                            raise
                        if audit and reply_key:
                            sent_id = getattr(sent_message, "id", None)
                            audit.finish_operation(
                                reply_key, source_message, "succeeded", "reply_send_succeeded", "Ответ отправлен в Telegram",
                                replyText=CUTTING_SEQUENCE_REPLY_TEXT.format(number=response_sequence_no),
                                replyToMessageId=str(int(source_message.id)),
                                sessionSenderUserId=audit.scan.get("sessionUserId"),
                                sentTelegramMessageId=str(sent_id) if sent_id is not None else None,
                                cuttingSequenceNo=response_sequence_no,
                                responses=[*audit.operations[reply_key].get("responses", []), {
                                    "responseId": f"telegram:{uuid.uuid4()}", "kind": "telegram_reply", "status": "succeeded",
                                    "at": utc_now(), "text": CUTTING_SEQUENCE_REPLY_TEXT.format(number=response_sequence_no),
                                    "telegramMessageId": str(sent_id) if sent_id is not None else None,
                                    "replyToMessageId": str(int(source_message.id)),
                                }],
                            )
                        self.state.mark_cutting_sequence_replied(external_key)
            self.state.mark_posted(
                packet["externalPacketKey"],
                payload_hash,
                version.source_version,
                source_fingerprint,
                svg_cut_import_status=response_import_status,
                cut_job_id=response_cut_job_id,
                source_file_sha=source_files[0].get("sha256") if source_files else None,
            )
            applied = response.get("applied")
            print(f"posted {packet['externalPacketKey']} v{version.source_version} applied={applied}", flush=True)
            return "posted"
        except Exception as exc:
            if (
                audit and audit_operation
                and audit.operations[audit_operation]["status"] == "planned"
                and audit.operations[audit_operation].get("errorCode") != "backend_ingest_failed"
            ):
                with audit.spool.transaction():
                    mark_unfinished_group_attachments(
                        audit,
                        group,
                        "Обработка вложения прервана до завершения",
                    )
                    audit.finish_operation(
                        audit_operation, group.vector_message, "failed", "unexpected_worker_error",
                        sanitize_text(str(exc), 1000), errorCode="unexpected_worker_error",
                        errorMessage=sanitize_text(str(exc), 1000),
                    )
            raise
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)


async def login_telegram_session(config: WorkerConfig) -> None:
    config.require_telegram()
    config.telegram_session_path.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(config.telegram_session_path), config.telegram_api_id, config.telegram_api_hash)
    await client.start()
    await client.disconnect()
    print(f"Telethon session ready: {config.telegram_session_path}")


def serialize_import_scan_message(
    message: Any,
    chat_id: str,
    workday: date,
    read_ordinal: int,
    candidate_links: dict[int, tuple[int, str]],
) -> dict[str, Any]:
    """Build the bounded, non-media raw message row for an import scan."""
    message_id = int(message.id)
    candidate_link = candidate_links.get(message_id)
    raw_text = message_text(message)
    filename = message_filename(message)
    edited_at = message_edited_datetime(message)
    row: dict[str, Any] = {
        "sourceChatId": chat_id,
        "sourceMessageId": str(message_id),
        "sourceThreadId": str(thread_id) if (thread_id := message_thread_id(message)) is not None else None,
        "replyToMessageId": str(reply_id) if (reply_id := message_reply_to_id(message)) is not None else None,
        "senderUserId": str(sender_id) if (sender_id := message_sender_id(message)) is not None else None,
        "sourceCreatedAt": message_datetime(message).isoformat(),
        "sourceUpdatedAt": edited_at.isoformat() if edited_at is not None else None,
        "workday": workday.isoformat(),
        "messageType": classify_import_message(message),
        "filename": sanitize_text(filename, 255) if filename else None,
        "mimeType": sanitize_text(message_mime_type(message), 120) if message_mime_type(message) else None,
        "messageText": sanitize_text(raw_text, 2000) if raw_text else None,
        "outgoing": message_outgoing(message),
        "readOrdinal": read_ordinal,
    }
    if candidate_link is not None:
        candidate_source_id, candidate_role = candidate_link
        row["candidateSourceMessageId"] = str(candidate_source_id)
        row["candidateRole"] = candidate_role
    return row


def group_svg_messages(messages: list[Any]) -> list[SvgGroup]:
    image_messages = [message for message in messages if is_image_message(message)]
    gcode_messages = [message for message in messages if is_gcode_message(message)]
    svg_messages = [
        message
        for message in messages
        if is_vector_message(message) and Path(message_filename(message) or "").suffix.lower() == ".svg"
    ]

    # Preserve the old image->SVG pairing for one SVG per image. This keeps the
    # existing external packet key stable during backfill. Any additional or
    # standalone SVG has no image anchor and therefore gets its own message id.
    legacy_context_by_svg_id: dict[int, list[tuple[Any, list[str]]]] = {}
    for index, image_message in enumerate(image_messages):
        previous_image_id = image_messages[index - 1].id if index > 0 else None
        next_image_id = image_messages[index + 1].id if index + 1 < len(image_messages) else None
        comments = nearby_comments(messages, image_message, next_image_id)
        vector_message = select_vector_message(
            svg_messages,
            image_message,
            comments,
            previous_image_id,
            next_image_id,
        )
        if vector_message is not None:
            legacy_context_by_svg_id.setdefault(int(vector_message.id), []).append((image_message, comments))

    groups: list[SvgGroup] = []
    for index, vector_message in enumerate(svg_messages):
        previous_svg_id = svg_messages[index - 1].id if index > 0 else None
        next_svg_id = svg_messages[index + 1].id if index + 1 < len(svg_messages) else None
        vector_comments = nearby_comments(messages, vector_message, next_svg_id)
        legacy_context = min(
            legacy_context_by_svg_id.get(int(vector_message.id), []),
            key=lambda item: abs(int(item[0].id) - int(vector_message.id)),
            default=None,
        )
        image_message = legacy_context[0] if legacy_context is not None else None
        comments = list(dict.fromkeys([
            *(legacy_context[1] if legacy_context is not None else []),
            *vector_comments,
        ]))
        gcode_message = select_gcode_message(
            gcode_messages,
            vector_message,
            comments,
            previous_svg_id,
            next_svg_id,
        )
        groups.append(SvgGroup(
            vector_message=vector_message,
            image_message=image_message,
            comments=comments,
            cutting_sequence_no=cutting_sequence_reply_number(messages, vector_message),
            gcode_message=gcode_message,
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
        if is_cutting_sequence_reply_text(text):
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
    vector_message: Any,
    comments: list[str],
    previous_image_id: int | None = None,
    next_image_id: int | None = None,
) -> Any | None:
    if not gcode_messages:
        return None
    vector_base_name = attachment_base_name(vector_message)
    if not vector_base_name:
        return None
    matching_gcode_messages = [
        message
        for message in gcode_messages
        if attachment_base_name(message) == vector_base_name
    ]
    if not matching_gcode_messages:
        return None
    return select_attachment_message(
        matching_gcode_messages,
        vector_message,
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


def attachment_base_name(message: Any) -> str | None:
    filename = message_filename(message)
    if not filename:
        return None
    base_name = Path(filename).stem.strip().lower()
    return base_name or None


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


def group_has_thumbs_up(group: SvgGroup) -> bool:
    return any(
        has_thumbs_up(message)
        for message in (group.image_message, group.gcode_message, group.vector_message)
        if message is not None
    )


def group_source_fingerprint(
    group: SvgGroup,
    chat_id: str,
    workday: date,
    parser_version: str,
    ocr_engine: str,
    cutting_sequence_no: int | None = None,
) -> str:
    payload = {
        "version": 5,
        "chatId": chat_id,
        "workday": workday.isoformat(),
        "parserVersion": parser_version,
        "ocrEngine": ocr_engine,
        "cuttingSequenceNo": cutting_sequence_no if cutting_sequence_no is not None and cutting_sequence_no > 0 else None,
        "source": message_identity(group.source_message, include_reactions=True),
        "comments": group.comments,
        "gcode": (
            message_identity(group.gcode_message, include_reactions=True)
            if group.gcode_message is not None
            else None
        ),
        "vector": message_identity(group.vector_message, include_reactions=True),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


class SourceChangedError(RuntimeError):
    """The selected Telegram source no longer matches discovery provenance."""


def parse_iso_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("date value is missing")
    raw = value.strip().split("T", 1)[0]
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise RuntimeError("date value is invalid") from exc


def safe_path_component(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return cleaned[:100] or "item"


def source_file_payload(source: dict[str, Any]) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for kind, name_key, sha_key in (
        ("svg", "svgFileName", "svgContentSha256"),
        ("gcode", "gcodeFileName", "gcodeContentSha256"),
        ("screenshot", "screenshotFileName", "screenshotContentSha256"),
    ):
        if source.get(sha_key):
            files.append({"kind": kind, "fileName": source.get(name_key), "sha256": source.get(sha_key)})
    return files


def fingerprint_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_layout_fingerprint(layout: dict[str, Any] | None) -> str | None:
    """Return the bare SHA-256 of geometry, excluding semantic labels/IDs."""
    if not isinstance(layout, dict):
        return None

    def rounded(value: Any) -> float | int | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        normalized = round(float(value), 3)
        # Match TypeScript JSON.stringify: integral numbers serialize as 2800,
        # not Python's 2800.0.  This is part of the cross-language hash
        # contract, not merely a display normalization.
        return int(normalized) if normalized.is_integer() else normalized

    sheet = layout.get("sheet") if isinstance(layout.get("sheet"), dict) else {}
    geometry_items: list[dict[str, Any]] = []
    for item in layout.get("items") if isinstance(layout.get("items"), list) else []:
        if not isinstance(item, dict):
            continue
        geometry_items.append({
            "widthMm": rounded(item.get("widthMm")),
            "heightMm": rounded(item.get("heightMm")),
            "xMm": rounded(item.get("xMm")),
            "yMm": rounded(item.get("yMm")),
            "placedWidthMm": rounded(item.get("placedWidthMm")),
            "placedHeightMm": rounded(item.get("placedHeightMm")),
            "rotated": bool(item.get("rotated", False)),
            "quantity": int(item.get("quantity", 1)) if isinstance(item.get("quantity", 1), int) else 1,
        })
    canonical = {
        "version": "cnc-layout-fingerprint-v1",
        # The persisted layout DTO has no material field in this contract.
        "material": None,
        "sheet": {
            "widthMm": rounded(sheet.get("widthMm")),
            "heightMm": rounded(sheet.get("heightMm")),
        },
        "items": sorted(geometry_items, key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":"))),
    }
    return fingerprint_json(canonical)


def import_source_set_fingerprint(
    group: SvgGroup,
    chat_id: str,
    workday: date,
    source_files: list[dict[str, Any]],
    parser_version: str,
    *,
    comment_messages: list[Any] | None = None,
) -> str:
    """Hash every discovery dimension needed to fence a later import."""
    payload = {
        "version": "cnc-telegram-import-source-set-v1",
        "chatId": chat_id,
        "workday": workday.isoformat(),
        "groupingVersion": "group-svg-messages-v1",
        "parserVersion": parser_version,
        "layoutFingerprintVersion": "cnc-layout-fingerprint-v1",
        "vector": message_identity(group.vector_message, include_reactions=True),
        "image": message_identity(group.image_message, include_reactions=True) if group.image_message is not None else None,
        "gcode": message_identity(group.gcode_message, include_reactions=True) if group.gcode_message is not None else None,
        "comments": [sanitize_text(comment, 500) for comment in group.comments[:50]],
        "commentMessages": [message_identity(message, include_reactions=True) for message in (comment_messages or [])],
        "sourceFiles": sorted(
            [
                {
                    key: item.get(key)
                    for key in ("kind", "fileName", "contentType", "sizeBytes", "sha256")
                }
                for item in source_files
            ],
            key=lambda item: str(item.get("kind") or ""),
        ),
    }
    return fingerprint_json(payload)


def svg_refresh_idempotency_key(external_key: str, source_version: int, payload_hash: str) -> str:
    digest = hashlib.sha256(f"{external_key}:v{source_version}:svg-refresh:{payload_hash}".encode("utf-8")).hexdigest()[:24]
    return f"cnc-tg-svg-refresh-{digest}"


def mark_ignored_group_attachments(audit: ScanAudit, group: SvgGroup, reason_message: str) -> None:
    if group.image_message is not None and audit.record_for(group.image_message)["status"] in {"observed", "used"}:
        audit.mark_message(
            group.image_message,
            "skipped",
            "image_ignored",
            reason_message,
            group.vector_message,
        )
    if group.gcode_message is not None and audit.record_for(group.gcode_message)["status"] in {"observed", "used"}:
        audit.mark_message(
            group.gcode_message,
            "skipped",
            "gcode_ignored",
            reason_message,
            group.vector_message,
        )


def mark_unfinished_group_attachments(audit: ScanAudit, group: SvgGroup, reason_message: str) -> None:
    for message, reason_code in (
        (group.image_message, "image_ignored"),
        (group.gcode_message, "gcode_ignored"),
    ):
        if message is None or audit.record_for(message)["status"] != "observed":
            continue
        audit.mark_message(message, "skipped", reason_code, reason_message, group.vector_message)


def mark_used_group_attachments(audit: ScanAudit, group: SvgGroup) -> None:
    if group.image_message is not None and audit.record_for(group.image_message)["status"] in {"observed", "used"}:
        audit.mark_message(
            group.image_message,
            "skipped",
            "image_ignored",
            "Изображение не использовано: SVG распарсен",
            group.vector_message,
        )
    for message, reason_code, reason_message in (
        (group.gcode_message, "gcode_selected", "G-code использован при создании пакета задания"),
    ):
        if message is None or audit.record_for(message)["status"] != "observed":
            continue
        audit.mark_message(message, "used", reason_code, reason_message, group.vector_message)


def is_cutting_sequence_reply_text(text: str) -> bool:
    return CUTTING_SEQUENCE_REPLY_RE.search(text.strip()) is not None


def parse_cutting_sequence_reply(text: str) -> int | None:
    match = CUTTING_SEQUENCE_REPLY_RE.search(text.strip())
    if not match:
        return None
    try:
        value = int(match.group(1))
    except ValueError:
        return None
    return value if value > 0 else None


def cutting_sequence_reply_number(messages: list[Any], image_message: Any) -> int | None:
    image_id = int(image_message.id)
    candidates: list[tuple[datetime, int, int]] = []
    for message in messages:
        if message is image_message or message_reply_to_id(message) != image_id:
            continue
        number = parse_cutting_sequence_reply(message_text(message))
        if number is not None:
            candidates.append((message_datetime(message), int(message.id), number))
    if not candidates:
        return None
    return min(candidates, key=lambda item: (item[0], item[1]))[2]


async def collect_cutting_sequence_reply_search_index(
    client: Any,
    entity: Any,
    source_message_ids: set[int],
    session_user_id: str | None = None,
    workday: date | None = None,
    business_timezone: Any | None = None,
    known_sequence_index: dict[int, int] | None = None,
    observer: Callable[[Any, int, str], Any] | None = None,
) -> dict[int, int | None]:
    if not source_message_ids:
        return {}
    candidates_by_source: dict[int, list[tuple[datetime, int, int]]] = {}
    ambiguous_sources: set[int] = set()
    ordinal = 0
    async for message in client.iter_messages(entity, search="Раскрой", limit=1000):
        ordinal += 1
        reply_to = message_reply_to_id(message)
        if reply_to is None or reply_to not in source_message_ids:
            continue
        number = parse_cutting_sequence_reply(message_text(message))
        if number is None:
            decision = "reply_invalid_number"
        elif workday is not None and business_timezone is not None and message_datetime(message).astimezone(business_timezone).date() < workday:
            decision = "reply_outside_business_window"
        elif session_user_id is not None and str(getattr(message, "sender_id", None)) != session_user_id:
            decision = "reply_foreign_sender"
        elif not bool(getattr(message, "out", False)):
            decision = "reply_not_outgoing"
        else:
            previous = candidates_by_source.get(reply_to, [])
            if previous:
                if previous[0][2] == number:
                    decision = "reply_older_than_selected"
                else:
                    decision = "reply_ambiguous"
                    ambiguous_sources.add(reply_to)
            elif known_sequence_index is not None and reply_to in known_sequence_index and known_sequence_index[reply_to] != number:
                decision = "reply_ambiguous"
                ambiguous_sources.add(reply_to)
            else:
                decision = "reply_selected"
        if observer is not None:
            await observer(message, ordinal, decision)
        if decision == "reply_selected":
            candidates_by_source.setdefault(reply_to, []).append((
                message_datetime(message),
                int(message.id),
                number,
            ))
    selected: dict[int, int | None] = {
        source_id: candidates[0][2]
        for source_id, candidates in candidates_by_source.items()
        if source_id not in ambiguous_sources
    }
    selected.update({source_id: None for source_id in ambiguous_sources})
    return selected


def apply_cutting_sequence_reply_index(
    groups: list[SvgGroup],
    sequence_index: dict[int, int | None],
) -> list[SvgGroup]:
    return [
        replace(group, cutting_sequence_no=sequence_index.get(int(group.source_message.id)))
        for group in groups
    ]


def apply_known_cutting_sequence_state(
    groups: list[SvgGroup],
    chat_id: str,
    state: StateStore,
) -> list[SvgGroup]:
    updated: list[SvgGroup] = []
    for group in groups:
        if group.cutting_sequence_no is not None:
            updated.append(group)
            continue
        external_key = external_packet_key(chat_id, int(group.source_message.id))
        if not state.cutting_sequence_replied(external_key):
            updated.append(group)
            continue
        if not state.imported_svg_cut_job_confirmed(external_key):
            updated.append(group)
            continue
        number = state.cutting_sequence_number(external_key)
        updated.append(replace(group, cutting_sequence_no=number) if number is not None else group)
    return updated


async def send_cutting_sequence_reply(client: Any, entity: Any, image_message: Any, number: int) -> Any:
    return await client.send_message(
        entity,
        CUTTING_SEQUENCE_REPLY_TEXT.format(number=number),
        reply_to=int(image_message.id),
    )


MANUAL_SVG_SEND_KIND_ORDER = {
    "gcode": 0,
    "svg": 1,
    "screenshot": 2,
}


async def send_manual_svg_upload_files(
    client: Any,
    entity: Any,
    files: list[ManualSvgSendFile],
    message_text: str | None,
) -> list[ManualSvgSentItem]:
    sent_messages: list[ManualSvgSentItem] = []
    ordered_files = sorted(
        enumerate(files),
        key=lambda item: (MANUAL_SVG_SEND_KIND_ORDER.get(item[1].kind, 99), item[0]),
    )
    for _index, file_item in ordered_files:
        sent = await client.send_file(
            entity,
            str(file_item.path),
            force_document=file_item.kind != "screenshot",
        )
        for sent_message in sent if isinstance(sent, list) else [sent]:
            sent_messages.append(ManualSvgSentItem(
                kind=file_item.kind,
                file_name=file_item.path.name,
                message=sent_message,
            ))
    if message_text:
        sent_messages.append(ManualSvgSentItem(
            kind="comment",
            file_name=None,
            message=await client.send_message(entity, message_text),
        ))
    return sent_messages


def response_svg_cut_imported(response_packet: Any) -> bool:
    return isinstance(response_packet, dict) and response_packet.get("svgCutImportStatus") == "imported"


def response_skipped_duplicate_source_file(response: Any) -> dict[str, Any] | None:
    if not isinstance(response, dict):
        return None
    skipped = response.get("skippedDuplicateSourceFile")
    if isinstance(skipped, dict) and skipped.get("status") == "skipped":
        return skipped
    return None


def response_allows_cutting_sequence_reply(response: Any, response_packet: Any) -> bool:
    return response_skipped_duplicate_source_file(response) is None and response_svg_cut_imported(response_packet)


def response_svg_cut_import_status(response: Any, response_packet: Any) -> str | None:
    if response_skipped_duplicate_source_file(response) is not None:
        return "skipped"
    if isinstance(response_packet, dict):
        status = response_packet.get("svgCutImportStatus")
        if isinstance(status, str):
            return status
    return None


def response_svg_cut_job_id(response_packet: Any, skipped_duplicate: dict[str, Any] | None) -> int | None:
    if skipped_duplicate is not None:
        return positive_int(skipped_duplicate.get("cutJobId"))
    if not isinstance(response_packet, dict):
        return None
    return positive_int(response_packet.get("svgCutJobId") or response_packet.get("cutJobId"))


def positive_int(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def manual_svg_send_message_text(task: Any) -> str:
    if not isinstance(task, dict):
        raise RuntimeError("manual SVG Telegram send task is invalid")
    display_number = sanitize_text(str(task.get("cutJobDisplayNumber") or ""), 80)
    if not display_number:
        raise RuntimeError("manual SVG Telegram send task has no real cut job display number")
    number_line = f"Задание №{display_number}"
    user_text = sanitize_text(str(task.get("messageText") or ""), 4096)
    if user_text:
        return sanitize_text(f"{number_line}\n{user_text}", 4096)
    return number_line


def record_manual_svg_sent_messages(
    audit_spool: AuditSpool,
    chat_id: str,
    session_user_id: str | None,
    parser_version: str,
    can_write_chat: bool,
    business_timezone: Any,
    packet_id: str | None,
    cut_job_id: str | None,
    cut_job_display_number: str | None,
    sent_items: list[ManualSvgSentItem],
) -> None:
    valid_items = [item for item in sent_items if manual_svg_sent_message_id(item.message) is not None]
    if not valid_items:
        return
    audit = ScanAudit.start(
        audit_spool,
        chat_id,
        datetime.now(business_timezone).date(),
        session_user_id,
        parser_version,
        can_write_chat,
        business_timezone=business_timezone,
    )
    for item in valid_items:
        message_id = manual_svg_sent_message_id(item.message)
        reason_message = manual_svg_send_reason_message(item)
        key = audit.begin_operation(
            item.message,
            "telegram_reply",
            packetId=packet_id,
            cutJobId=cut_job_id,
            cutJobDisplayNumber=cut_job_display_number,
            replyText=message_text(item.message) or None,
            sentTelegramMessageId=message_id,
        )
        audit.finish_operation(
            key,
            item.message,
            "succeeded",
            "reply_send_succeeded",
            reason_message,
            packetId=packet_id,
            cutJobId=cut_job_id,
            cutJobDisplayNumber=cut_job_display_number,
            replyText=message_text(item.message) or None,
            sentTelegramMessageId=message_id,
        )
    audit.complete()


def manual_svg_send_reason_message(item: ManualSvgSentItem) -> str:
    if item.kind == "comment":
        return "Ручная SVG-загрузка: комментарий отправлен в Telegram"
    kind_label = {
        "gcode": "G-code",
        "svg": "SVG-файл",
        "screenshot": "скрин раскроя",
    }.get(item.kind, "файл")
    suffix = f" {item.file_name}" if item.file_name else ""
    return f"Ручная SVG-загрузка: {kind_label}{suffix} отправлен в Telegram"


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
    declared_size = getattr(getattr(message, "file", None), "size", None)
    if isinstance(declared_size, int) and declared_size > IMPORT_MAX_FILE_BYTES:
        raise ValueError(f"Telegram media exceeds {IMPORT_MAX_FILE_BYTES} byte limit")
    run_dir.mkdir(parents=True, exist_ok=True)
    sink = BoundedMediaWriter(target, IMPORT_MAX_FILE_BYTES)
    try:
        result = await message.download_media(file=sink)
        sink.close()
        if not target.exists() or target.stat().st_size <= 0:
            return None
        if target.stat().st_size > IMPORT_MAX_FILE_BYTES:
            raise ValueError(f"Telegram media exceeds {IMPORT_MAX_FILE_BYTES} byte limit")
        return Path(result) if result else target
    except Exception:
        sink.close()
        target.unlink(missing_ok=True)
        raise


class BoundedMediaWriter:
    """File-like Telethon sink that rejects oversized media while writing."""

    def __init__(self, path: Path, limit: int) -> None:
        self.path = path
        self.name = str(path)
        self.limit = limit
        self.size = 0
        self._file = path.open("wb")

    def write(self, data: bytes) -> int:
        if self.size + len(data) > self.limit:
            raise ValueError(f"Telegram media exceeds {self.limit} byte limit")
        written = self._file.write(data)
        self.size += written
        return written

    def flush(self) -> None:
        self._file.flush()

    def close(self) -> None:
        if not self._file.closed:
            self._file.close()

    def __fspath__(self) -> str:
        # Keeps lightweight test doubles and Telethon path handling compatible.
        return str(self.path)


def source_file_identity(path: Path, message: Any, kind: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "fileName": message_filename(message) or path.name,
        "contentType": message_content_type(message, path),
        "sizeBytes": path.stat().st_size,
        "sha256": file_sha256(path),
    }


def message_content_type(message: Any, path: Path) -> str | None:
    file = getattr(message, "file", None)
    mime_type = getattr(file, "mime_type", None)
    if isinstance(mime_type, str) and mime_type.strip():
        return mime_type.strip()
    guessed, _encoding = mimetypes.guess_type(path.name)
    return guessed


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manual_svg_send_file(send_dir: Path, file_item: Any, index: int) -> Path:
    if not isinstance(file_item, dict):
        raise RuntimeError("manual SVG Telegram send file payload is invalid")
    file_name = safe_manual_svg_send_file_name(str(file_item.get("fileName") or f"file-{index}"))
    target = unique_child_path(send_dir, file_name)
    content = str(file_item.get("base64Content") or "")
    normalized_content = re.sub(r"\s+", "", content)
    try:
        raw = base64.b64decode(normalized_content.encode("ascii"), validate=True)
    except Exception as exc:
        raise RuntimeError(f"{file_name}: invalid base64 content") from exc
    size_bytes = int(file_item.get("sizeBytes") or -1)
    if len(raw) != size_bytes:
        raise RuntimeError(f"{file_name}: size mismatch")
    expected_sha = str(file_item.get("sha256") or "").lower()
    actual_sha = hashlib.sha256(raw).hexdigest()
    if expected_sha != actual_sha:
        raise RuntimeError(f"{file_name}: SHA-256 mismatch")
    target.write_bytes(raw)
    return target


def safe_manual_svg_send_file_name(value: str) -> str:
    name = Path(value.replace("\x00", "_")).name.strip()
    name = re.sub(r"[\r\n\t/\\]+", "_", name)
    return name[:180] or "manual-svg-file"


def unique_child_path(directory: Path, file_name: str) -> Path:
    target = directory / file_name
    if not target.exists():
        return target
    stem = target.stem or "file"
    suffix = target.suffix
    for index in range(2, 100):
        candidate = directory / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"cannot allocate unique filename for {file_name}")


def manual_svg_sent_message_ids(sent: Any) -> list[str]:
    values = sent if isinstance(sent, list) else [sent]
    result: list[str] = []
    for item in values:
        message = item.message if isinstance(item, ManualSvgSentItem) else item
        message_id = manual_svg_sent_message_id(message)
        if message_id is not None:
            result.append(message_id)
    return result


def manual_svg_sent_message_id(message: Any) -> str | None:
    message_id = getattr(message, "id", None)
    return str(message_id) if isinstance(message_id, int) and message_id > 0 else None


def persist_sheet_image(
    media_dir: Path,
    chat_id: str,
    message_id: int,
    image_path: Path,
    *,
    require_preview: bool = False,
) -> dict[str, Any]:
    media_dir.mkdir(parents=True, exist_ok=True)
    suffix = normalize_image_suffix(image_path.suffix)
    if require_preview:
        validate_restored_sheet_image(image_path, suffix)
    key = sheet_image_key(chat_id, message_id, suffix)
    target = media_dir / key
    temporary = media_dir / f".{key}.{uuid.uuid4().hex}.tmp"
    try:
        shutil.copy2(image_path, temporary)
        try:
            persist_sheet_preview(media_dir, key, temporary)
        except Exception as exc:
            if require_preview:
                raise
            # Preview creation must not turn an otherwise valid packet ingest into a
            # failure. The next worker run backfills missing previews.
            print(f"preview creation deferred for {key}: {sanitize_text(str(exc), 300)}", flush=True)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
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


def validate_restored_sheet_image(image_path: Path, suffix: str) -> None:
    size = image_path.stat().st_size
    if size <= 0 or size > SHEET_ORIGINAL_MAX_BYTES:
        raise ValueError("Telegram screenshot exceeds the original size limit")
    with image_path.open("rb") as source:
        header = source.read(12)
    normalized_suffix = suffix.lower()
    is_jpeg = header.startswith(b"\xff\xd8\xff") and normalized_suffix in {".jpg", ".jpeg"}
    is_png = header.startswith(b"\x89PNG\r\n\x1a\n") and normalized_suffix == ".png"
    is_webp = header.startswith(b"RIFF") and header[8:12] == b"WEBP" and normalized_suffix == ".webp"
    if not (is_jpeg or is_png or is_webp):
        raise ValueError("Telegram screenshot content does not match its file extension")


def persist_sheet_preview(media_dir: Path, storage_key: str, image_path: Path) -> Path:
    preview_dir = media_dir / SHEET_PREVIEW_DIRECTORY
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = preview_dir / sheet_preview_key(storage_key)
    temporary = preview_dir / f".{preview_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with Image.open(image_path) as source:
            width, height = source.size
            if width <= 0 or height <= 0 or width > 16_384 or height > 16_384 or width * height > SHEET_PREVIEW_MAX_SOURCE_PIXELS:
                raise ValueError("Telegram screenshot dimensions exceed preview limits")
            normalized = ImageOps.exif_transpose(source).convert("RGB")
            normalized.thumbnail(SHEET_PREVIEW_SIZE, Image.Resampling.LANCZOS)
            normalized.save(temporary, format="JPEG", quality=72, optimize=True, progressive=True)
        os.replace(temporary, preview_path)
    finally:
        temporary.unlink(missing_ok=True)
    return preview_path


def backfill_sheet_previews(media_dir: Path) -> int:
    media_dir.mkdir(parents=True, exist_ok=True)
    created = 0
    for path in media_dir.iterdir():
        if not path.is_file() or path.suffix.lower() not in IMAGE_STORAGE_EXTENSIONS:
            continue
        preview = media_dir / SHEET_PREVIEW_DIRECTORY / sheet_preview_key(path.name)
        if preview.is_file():
            continue
        try:
            persist_sheet_preview(media_dir, path.name, path)
            created += 1
        except Exception as exc:
            print(f"skip preview backfill {path.name}: {sanitize_text(str(exc), 300)}", flush=True)
    return created


def sheet_preview_key(storage_key: str) -> str:
    path = Path(storage_key)
    if path.name != storage_key or path.suffix.lower() not in IMAGE_STORAGE_EXTENSIONS:
        raise ValueError("invalid screenshot storage key")
    return f"{path.stem}.preview.jpg"


def storage_key_identity(storage_key: str) -> str:
    path = Path(storage_key)
    return path.stem if path.name == storage_key and path.suffix.lower() in IMAGE_STORAGE_EXTENSIONS else ""


def parse_chat_ref(value: str) -> int | str:
    stripped = value.strip()
    if stripped.lstrip("-").isdigit():
        return int(stripped)
    return stripped


def parse_optional_item_lease(task: Any) -> WorkerItemLease | None:
    """Read the additive item-lease contract when the backend exposes it.

    Phase-A compatible backends may still return legacy queue tasks.  New
    responses are carried through unchanged to complete/fail, where the
    backend strictly fences token, generation and owner.
    """
    if not isinstance(task, dict):
        raise RuntimeError("backend queue task is invalid")
    lease_keys = {
        "itemLease",
        "itemLeaseToken",
        "itemLeaseGeneration",
        "itemLeaseOwner",
        "leaseToken",
        "leaseGeneration",
        "leaseOwner",
    }
    if not lease_keys.intersection(task):
        return None
    return parse_item_lease(task)


def assert_allowed_chat(actual_chat_id: str, allowed_chat_ids: tuple[str, ...]) -> None:
    if not allowed_chat_ids:
        raise RuntimeError("TELEGRAM_ALLOWED_CHAT_ID must contain the exact resolved chat id")
    if actual_chat_id not in set(allowed_chat_ids):
        raise RuntimeError(f"resolved Telegram chat {actual_chat_id} is not in TELEGRAM_ALLOWED_CHAT_ID")
