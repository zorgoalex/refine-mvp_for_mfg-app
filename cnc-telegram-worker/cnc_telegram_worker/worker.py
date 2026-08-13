from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import mimetypes
import re
import shutil
import os
import uuid
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

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
SHEET_PREVIEW_DIRECTORY = "previews"
SHEET_PREVIEW_SIZE = (360, 240)
SHEET_PREVIEW_MAX_SOURCE_PIXELS = 40_000_000
SHEET_ORIGINAL_MAX_BYTES = 12 * 1024 * 1024
CUTTING_SEQUENCE_REPLY_RE = re.compile(
    r"(?<!\w)раскро[ий]\s*(?:файла\s*станка\s*)?[№#]?\s*(\d{1,6})(?!\d)",
    re.IGNORECASE,
)
CUTTING_SEQUENCE_REPLY_TEXT = "Раскрой №{number}"


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
        days_to_scan = days or self.config.history_days
        anchor = workday or datetime.now(self.config.business_timezone).date()
        workdays = [anchor - timedelta(days=offset) for offset in reversed(range(days_to_scan))]

        client: Any | None = None
        try:
            await self.erp.audit_capabilities()
            await audit_spool.flush(self.erp.audit_batch)
            await reconcile_pending_processing_attempts(audit_spool, self.erp, self.state)
            audit_spool.abandon_running_scans()
            await audit_spool.flush(self.erp.audit_batch)
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
            await self.process_media_restore_requests(client, entity, chat_id)
            if self.config.can_send_manual_svg_uploads:
                await self.process_manual_svg_telegram_send_requests(client, entity, chat_id)
            me = await client.get_me()
            session_user_id = str(me.id) if getattr(me, "id", None) is not None else None
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
                await self.scan_workday(client, entity, chat_id, day, audit_spool, session_user_id)
        finally:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception as exc:
                    print(f"Telegram disconnect failed: {exc}", flush=True)
            try:
                try:
                    await audit_spool.flush(self.erp.audit_batch)
                except Exception as exc:
                    print(f"audit delivery deferred: {exc}", flush=True)
            finally:
                audit_spool.close()
            cleanup_temp_dir(
                self.config.temp_dir,
                min(self.config.temp_ttl_hours, self.config.attachment_ttl_hours),
            )
            cleanup_temp_dir(
                self.config.media_dir,
                self.config.attachment_ttl_hours,
                excluded_relative_dirs=frozenset({SHEET_PREVIEW_DIRECTORY}),
            )

    async def process_media_restore_requests(self, client: Any, entity: Any, chat_id: str) -> None:
        claim = await self.erp.claim_media_restores()
        if claim.get("capability") != "cnc_telegram_media_restore_v1":
            raise RuntimeError("backend does not expose cnc_telegram_media_restore_v1")
        for task in claim.get("tasks") or []:
            request_id = str(task.get("requestId") or "")
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
                await self.erp.complete_media_restore(request_id, media)
            except Exception as exc:
                error_message = sanitize_text(str(exc), 500) or "Telegram screenshot restore failed"
                try:
                    await self.erp.fail_media_restore(request_id, error_message)
                except Exception as report_exc:
                    print(f"restore {request_id} failure delivery deferred: {report_exc}", flush=True)
                print(f"restore {request_id} failed: {error_message}", flush=True)

    async def process_manual_svg_telegram_send_requests(self, client: Any, entity: Any, chat_id: str) -> None:
        claim = await self.erp.claim_manual_svg_telegram_sends()
        if claim.get("capability") != "cnc_manual_svg_telegram_send_v1":
            raise RuntimeError("backend does not expose cnc_manual_svg_telegram_send_v1")
        for task in claim.get("tasks") or []:
            request_id = str(task.get("requestId") or "")
            try:
                files = task.get("files") or []
                if not isinstance(files, list) or not files:
                    raise RuntimeError("manual SVG Telegram send task has no files")
                send_dir = self.config.temp_dir / f"manual-svg-send-{request_id}"
                send_dir.mkdir(parents=True, exist_ok=True)
                paths: list[Path] = []
                for index, file_item in enumerate(files, start=1):
                    path = write_manual_svg_send_file(send_dir, file_item, index)
                    paths.append(path)
                caption = sanitize_text(str(task.get("messageText") or ""), 4096) or None
                sent = await send_manual_svg_upload_files(client, entity, paths, caption)
                await self.erp.complete_manual_svg_telegram_send(request_id, {
                    "sentChatId": chat_id,
                    "sentMessageIds": manual_svg_sent_message_ids(sent),
                })
            except Exception as exc:
                error_message = sanitize_text(str(exc), 500) or "Manual SVG Telegram send failed"
                try:
                    await self.erp.fail_manual_svg_telegram_send(request_id, error_message)
                except Exception as report_exc:
                    print(f"manual SVG send {request_id} failure delivery deferred: {report_exc}", flush=True)
                print(f"manual SVG send {request_id} failed: {error_message}", flush=True)

    async def run_daemon(self, days: int | None = None) -> None:
        if not self.config.enabled:
            print(
                f"CNC Telegram worker disabled: ERP_STACK_ENV={self.config.stack_env} "
                f"CNC_TELEGRAM_WORKER_ROLE={self.config.worker_role}",
                flush=True,
            )
            return
        self.config.require_worker_enabled()
        first = True
        while True:
            scan_days = days or (self.config.history_days if first and self.config.backfill_on_start else 1)
            try:
                await self.run_once(days=scan_days)
            except Exception as exc:
                print(f"scan failed: {exc}", flush=True)
            first = False
            await asyncio.sleep(self.config.poll_interval_seconds)

    async def scan_workday(
        self,
        client: Any,
        entity: Any,
        chat_id: str,
        workday: date,
        audit_spool: AuditSpool,
        session_user_id: str | None,
    ) -> None:
        audit = ScanAudit.start(
            audit_spool, chat_id, workday, session_user_id,
            self.config.parser_version, self.config.can_write_chat,
            business_timezone=self.config.business_timezone,
        )
        await audit_spool.flush(self.erp.audit_batch)
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
                await audit_spool.flush(self.erp.audit_batch)
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
    ) -> None:
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
            if cutting_sequence_no is not None:
                self.state.assign_cutting_sequence_number(external_key, existing_number=cutting_sequence_no)
                self.state.mark_cutting_sequence_replied(external_key)
            pending_sequence_reply = (
                self.config.can_write_chat
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
                and not pending_sequence_reply
                and self.state.source_unchanged(external_key, source_fingerprint)
            ):
                print(f"skip source unchanged {external_key}", flush=True)
                if audit and audit_operation:
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не обрабатывался: источник не изменился")
                        audit.finish_operation(audit_operation, group.vector_message, "skipped", "source_unchanged", "Источник не изменился")
                return

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
                return
            parsed_layout = parse_svg_cut_layout(vector_path)
            cut_layout = layout_to_dict(parsed_layout)
            if cut_layout["status"] != "valid":
                reasons = "; ".join(cut_layout.get("reasons") or ["invalid SVG layout"])
                print(f"skip SVG message {group.vector_message.id}: {reasons}", flush=True)
                if audit and audit_operation:
                    with audit.spool.transaction():
                        mark_ignored_group_attachments(audit, group, "SVG не обработан: некорректный макет")
                        audit.finish_operation(audit_operation, group.vector_message, "skipped", "svg_invalid_layout", reasons)
                return
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
            payload_hash = canonical_payload_hash(packet)
            version = self.state.next_version(packet["externalPacketKey"], payload_hash)
            if (
                not version.changed
                and not self.config.resend_unchanged
                and not sequence_from_telegram
                and not pending_sequence_reply
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
                return
            if audit:
                with audit.spool.transaction():
                    mark_used_group_attachments(audit, group)
            packet = apply_source_version(packet, version.source_version)
            idem = idempotency_key(packet["externalPacketKey"], version.source_version)
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
            if audit and audit_operation:
                audit.finish_operation(
                    audit_operation, group.vector_message, "succeeded", "backend_ingest_succeeded", "Задание принято ERP",
                    externalPacketKey=packet["externalPacketKey"], sourceVersion=str(version.source_version),
                    packetId=response_packet.get("packetId") if isinstance(response_packet, dict) else None,
                    cutJobId=str(response_packet.get("cutJobId")) if isinstance(response_packet, dict) and response_packet.get("cutJobId") is not None else None,
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
            if isinstance(response_sequence_no, int) and not isinstance(response_sequence_no, bool) and response_sequence_no > 0:
                self.state.assign_cutting_sequence_number(external_key, existing_number=response_sequence_no)
                if (
                    self.config.can_write_chat
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
            )
            applied = response.get("applied")
            print(f"posted {packet['externalPacketKey']} v{version.source_version} applied={applied}", flush=True)
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
        number = state.cutting_sequence_number(external_key)
        updated.append(replace(group, cutting_sequence_no=number) if number is not None else group)
    return updated


async def send_cutting_sequence_reply(client: Any, entity: Any, image_message: Any, number: int) -> Any:
    return await client.send_message(
        entity,
        CUTTING_SEQUENCE_REPLY_TEXT.format(number=number),
        reply_to=int(image_message.id),
    )


async def send_manual_svg_upload_files(client: Any, entity: Any, paths: list[Path], caption: str | None) -> Any:
    sent_messages: list[Any] = []
    for index, path in enumerate(paths):
        sent = await client.send_file(
            entity,
            str(path),
            caption=caption if index == 0 else None,
            force_document=True,
        )
        sent_messages.extend(sent if isinstance(sent, list) else [sent])
    return sent_messages


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
        message_id = getattr(item, "id", None)
        if isinstance(message_id, int) and message_id > 0:
            result.append(str(message_id))
    return result


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


def assert_allowed_chat(actual_chat_id: str, allowed_chat_ids: tuple[str, ...]) -> None:
    if not allowed_chat_ids:
        raise RuntimeError("TELEGRAM_ALLOWED_CHAT_ID must contain the exact resolved chat id")
    if actual_chat_id not in set(allowed_chat_ids):
        raise RuntimeError(f"resolved Telegram chat {actual_chat_id} is not in TELEGRAM_ALLOWED_CHAT_ID")
