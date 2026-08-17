from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import uuid
from copy import deepcopy
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterator

from .telegram_source import (
    is_gcode_message,
    is_image_message,
    is_vector_message,
    message_datetime,
    message_edited_datetime,
    message_filename,
    message_reply_to_id,
    message_text,
    message_thread_id,
)

SANITIZER_VERSION = "cnc-tg-sanitize-v1"
WORKER_AUDIT_VERSION = "cnc-telegram-worker-audit-v1"
_SECRET_PATTERNS = (
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.I), "Bearer [REDACTED]"),
    (re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{20,}\b"), "[BOT_TOKEN_REDACTED]"),
    (re.compile(r"\b(password|secret|api[_-]?hash)\s*[:=]\s*[^\s,;]+", re.I), r"\1=[REDACTED]"),
    (re.compile(r"https?://[^\s/@:]+:[^\s/@]+@", re.I), "https://[CREDENTIALS_REDACTED]@"),
    (re.compile(r"/data/session/[A-Za-z0-9._/-]+", re.I), "/data/session/[REDACTED]"),
    (re.compile(r"(?<!\d)\+?\d[\d ()-]{8,17}\d(?!\d)"), "[PHONE_REDACTED]"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_text(value: str, limit: int) -> str:
    result = value
    for pattern, replacement in _SECRET_PATTERNS:
        result = pattern.sub(replacement, result)
    return result[:limit]


class AuditSpool:
    def __init__(self, path: Path, *, allow_unsafe_path: bool = False) -> None:
        resolved = path.expanduser().resolve()
        if not resolved.is_absolute():
            raise RuntimeError("CNC_AUDIT_SPOOL_PATH must be absolute")
        if not allow_unsafe_path and resolved != Path("/data/cnc-telegram-audit.sqlite3") and Path("/data") not in resolved.parents:
            raise RuntimeError("CNC_AUDIT_SPOOL_PATH must be under /data")
        resolved.parent.mkdir(parents=True, exist_ok=True)
        if not os.access(resolved.parent, os.W_OK):
            raise RuntimeError("CNC audit spool parent is not writable")
        self.path = resolved
        self.connection = sqlite3.connect(str(resolved), isolation_level=None)
        self.connection.execute("PRAGMA busy_timeout=5000")
        mode = self.connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        self.connection.execute("PRAGMA synchronous=FULL")
        synchronous = self.connection.execute("PRAGMA synchronous").fetchone()[0]
        integrity = self.connection.execute("PRAGMA integrity_check").fetchone()[0]
        if str(mode).lower() != "wal" or int(synchronous) != 2 or integrity != "ok":
            self.connection.close()
            raise RuntimeError("CNC audit spool failed WAL/FULL/integrity verification")
        self.connection.executescript("""
          CREATE TABLE IF NOT EXISTS audit_outbox (
            outbox_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
          );
          CREATE TABLE IF NOT EXISTS audit_scans (
            scan_id TEXT PRIMARY KEY,
            scan_json TEXT NOT NULL,
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS operation_ordinals (
            ordinal_key TEXT PRIMARY KEY,
            last_ordinal INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS reply_attempts (
            operation_key TEXT PRIMARY KEY,
            source_chat_id TEXT NOT NULL,
            reply_to_message_id TEXT NOT NULL,
            scan_json TEXT NOT NULL,
            message_json TEXT NOT NULL,
            operation_json TEXT NOT NULL,
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS processing_attempts (
            operation_key TEXT PRIMARY KEY,
            external_packet_key TEXT NOT NULL,
            scan_json TEXT NOT NULL,
            message_json TEXT NOT NULL,
            operation_json TEXT NOT NULL,
            packet_json TEXT,
            idempotency_key TEXT,
            payload_hash TEXT,
            source_fingerprint TEXT,
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS audit_selftest (
            selftest_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
          );
        """)
        test_id = f"selftest:{uuid.uuid4()}"
        try:
            with self.transaction():
                self.connection.execute(
                    "INSERT INTO audit_selftest(selftest_id,created_at) VALUES(?,?)",
                    (test_id, utc_now()),
                )
                row = self.connection.execute(
                    "SELECT selftest_id FROM audit_selftest WHERE selftest_id=?",
                    (test_id,),
                ).fetchone()
                if row is None:
                    raise RuntimeError("CNC audit spool self-test read failed")
                self.connection.execute("DELETE FROM audit_selftest WHERE selftest_id=?", (test_id,))
        except (sqlite3.Error, OSError) as exc:
            self.connection.close()
            raise RuntimeError(f"CNC audit spool self-test failed: {exc}") from exc

    @contextmanager
    def transaction(self) -> Iterator[None]:
        owns_transaction = not self.connection.in_transaction
        try:
            if owns_transaction:
                self.connection.execute("BEGIN IMMEDIATE")
            yield
            if owns_transaction:
                self.connection.execute("COMMIT")
        except BaseException:
            if owns_transaction and self.connection.in_transaction:
                try:
                    self.connection.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            raise

    def enqueue(self, payload: dict[str, Any], *, outbox_id: str | None = None) -> str:
        key = outbox_id or str(uuid.uuid4())
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        try:
            with self.transaction():
                self.connection.execute(
                    "INSERT OR IGNORE INTO audit_outbox(outbox_id,payload_json,created_at) VALUES(?,?,?)",
                    (key, encoded, utc_now()),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"CNC audit spool commit failed: {exc}") from exc
        return key

    def save_scan(self, scan: dict[str, Any]) -> None:
        encoded = json.dumps(scan, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        try:
            with self.transaction():
                self.connection.execute(
                    "INSERT INTO audit_scans(scan_id,scan_json,status,updated_at) VALUES(?,?,?,?) "
                    "ON CONFLICT(scan_id) DO UPDATE SET scan_json=excluded.scan_json,status=excluded.status,updated_at=excluded.updated_at",
                    (scan["scanId"], encoded, scan["status"], utc_now()),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"CNC audit scan commit failed: {exc}") from exc

    def abandon_running_scans(self) -> int:
        rows = self.connection.execute("SELECT scan_id,scan_json FROM audit_scans WHERE status='running'").fetchall()
        for scan_id, scan_json in rows:
            scan = json.loads(scan_json)
            scan.update({
                "status": "abandoned",
                "finishedAt": utc_now(),
                "errorCode": "worker_restarted_before_scan_completion",
                "errorMessage": "Worker restarted before scan completion",
            })
            with self.transaction():
                self.save_scan(scan)
                self.enqueue(empty_batch(scan), outbox_id=f"scan-abandoned:{scan_id}")
        return len(rows)

    def next_operation_key(self, scan_id: str, log_key: str, operation_type: str) -> str:
        digest = log_key.rsplit(":", 1)[-1]
        ordinal_key = f"{scan_id}:{digest}:{operation_type}"
        try:
            with self.transaction():
                row = self.connection.execute(
                    "SELECT last_ordinal FROM operation_ordinals WHERE ordinal_key=?",
                    (ordinal_key,),
                ).fetchone()
                ordinal = int(row[0]) + 1 if row else 1
                self.connection.execute(
                    "INSERT INTO operation_ordinals(ordinal_key,last_ordinal) VALUES(?,?) "
                    "ON CONFLICT(ordinal_key) DO UPDATE SET last_ordinal=excluded.last_ordinal",
                    (ordinal_key, ordinal),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"CNC audit operation allocation failed: {exc}") from exc
        return f"tgop:v1:{scan_id}:{digest}:{operation_type}:{ordinal}"

    def save_reply_attempt(self, scan: dict[str, Any], message: dict[str, Any], operation: dict[str, Any]) -> None:
        if operation["operationType"] != "telegram_reply" or not operation.get("replyToMessageId"):
            return
        try:
            with self.transaction():
                self.connection.execute(
                    "INSERT INTO reply_attempts(operation_key,source_chat_id,reply_to_message_id,scan_json,message_json,operation_json,status,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET "
                    "scan_json=excluded.scan_json,message_json=excluded.message_json,operation_json=excluded.operation_json,status=excluded.status,updated_at=excluded.updated_at",
                    (
                        operation["operationKey"], scan["sourceChatId"], operation["replyToMessageId"],
                        json.dumps(scan, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                        json.dumps(message, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                        json.dumps(operation, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                        operation["status"], utc_now(),
                    ),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"CNC audit reply-attempt commit failed: {exc}") from exc

    def pending_reply_attempts(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT scan_json,message_json,operation_json FROM reply_attempts WHERE status='planned' ORDER BY updated_at,operation_key"
        ).fetchall()
        return [{"scan": json.loads(row[0]), "message": json.loads(row[1]), "operation": json.loads(row[2])} for row in rows]

    def save_processing_attempt(
        self,
        scan: dict[str, Any],
        message: dict[str, Any],
        operation: dict[str, Any],
        *,
        packet: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        payload_hash: str | None = None,
        source_fingerprint: str | None = None,
    ) -> None:
        if operation["operationType"] != "message_processing":
            return
        external_packet_key = operation.get("externalPacketKey")
        if not isinstance(external_packet_key, str) or not external_packet_key:
            raise RuntimeError("CNC processing attempt requires externalPacketKey")
        try:
            with self.transaction():
                self.connection.execute(
                    "INSERT INTO processing_attempts(operation_key,external_packet_key,scan_json,message_json,operation_json,packet_json,idempotency_key,payload_hash,source_fingerprint,status,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET "
                    "scan_json=excluded.scan_json,message_json=excluded.message_json,operation_json=excluded.operation_json,"
                    "packet_json=COALESCE(excluded.packet_json,processing_attempts.packet_json),"
                    "idempotency_key=COALESCE(excluded.idempotency_key,processing_attempts.idempotency_key),"
                    "payload_hash=COALESCE(excluded.payload_hash,processing_attempts.payload_hash),"
                    "source_fingerprint=COALESCE(excluded.source_fingerprint,processing_attempts.source_fingerprint),"
                    "status=excluded.status,updated_at=excluded.updated_at",
                    (
                        operation["operationKey"], external_packet_key,
                        json.dumps(scan, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                        json.dumps(message, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                        json.dumps(operation, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                        json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":")) if packet is not None else None,
                        idempotency_key, payload_hash, source_fingerprint, operation["status"], utc_now(),
                    ),
                )
        except sqlite3.Error as exc:
            raise RuntimeError(f"CNC audit processing-attempt commit failed: {exc}") from exc

    def pending_processing_attempts(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT scan_json,message_json,operation_json,packet_json,idempotency_key,payload_hash,source_fingerprint "
            "FROM processing_attempts WHERE status='planned' ORDER BY updated_at,operation_key"
        ).fetchall()
        return [{
            "scan": json.loads(row[0]),
            "message": json.loads(row[1]),
            "operation": json.loads(row[2]),
            "packet": json.loads(row[3]) if row[3] is not None else None,
            "idempotencyKey": row[4],
            "payloadHash": row[5],
            "sourceFingerprint": row[6],
        } for row in rows]

    def has_unresolved_reply(self, source_chat_id: str, reply_to_message_id: str) -> bool:
        row = self.connection.execute(
            "SELECT 1 FROM reply_attempts WHERE source_chat_id=? AND reply_to_message_id=? AND status IN ('planned','incomplete','ambiguous') LIMIT 1",
            (source_chat_id, reply_to_message_id),
        ).fetchone()
        return row is not None

    async def flush(self, sender: Callable[[dict[str, Any]], Awaitable[Any]]) -> int:
        delivered = 0
        while True:
            row = self.connection.execute(
                "SELECT outbox_id,payload_json FROM audit_outbox ORDER BY created_at,outbox_id LIMIT 1"
            ).fetchone()
            if row is None:
                return delivered
            outbox_id, payload_json = row
            try:
                await sender(json.loads(payload_json))
            except Exception as exc:
                with self.transaction():
                    self.connection.execute(
                        "UPDATE audit_outbox SET attempts=attempts+1,last_error=? WHERE outbox_id=?",
                        (sanitize_text(str(exc), 1000), outbox_id),
                    )
                raise
            with self.transaction():
                self.connection.execute("DELETE FROM audit_outbox WHERE outbox_id=?", (outbox_id,))
            delivered += 1

    def close(self) -> None:
        self.connection.close()


@dataclass
class ScanAudit:
    spool: AuditSpool
    scan: dict[str, Any]
    business_timezone: Any = timezone.utc
    messages: dict[str, dict[str, Any]] = field(default_factory=dict)
    operations: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def start(
        cls,
        spool: AuditSpool,
        chat_id: str,
        workday: date,
        session_user_id: str | None,
        parser_version: str,
        can_write_chat: bool,
        business_timezone: Any = timezone.utc,
    ) -> "ScanAudit":
        scan = {
            "scanId": str(uuid.uuid4()), "sourceChatId": str(chat_id), "workday": workday.isoformat(),
            "status": "running", "startedAt": utc_now(), "finishedAt": None,
            "sessionUserId": session_user_id, "dayYieldedCount": 0, "dayExhausted": False,
            "dayTruncated": False, "dayErrorCode": None, "replySearchYieldedCount": 0,
            "replySearchExhausted": False, "replySearchTruncated": False,
            "replySearchErrorCode": None, "svgCount": 0, "processedCount": 0,
            "ingestedCount": 0, "skippedCount": 0, "failedCount": 0,
            "parserVersion": parser_version, "workerVersion": WORKER_AUDIT_VERSION,
            "canWriteChat": can_write_chat, "errorCode": None, "errorMessage": None,
        }
        with spool.transaction():
            spool.save_scan(scan)
            spool.enqueue(empty_batch(scan), outbox_id=f"scan-running:{scan['scanId']}")
        return cls(spool=spool, scan=scan, business_timezone=business_timezone)

    async def observe(self, message: Any, read_source: str, ordinal: int, *, decision_code: str | None = None) -> None:
        record = self.record_for(message)
        if decision_code is not None:
            self._transition_message_status(
                record,
                "used" if decision_code == "reply_selected" else "skipped",
            )
            record.update({
                "reasonCode": decision_code,
                "reasonMessage": reply_search_reason_message(decision_code),
                "decisionAt": utc_now(),
            })
        if read_source == "day_history":
            self.scan["dayYieldedCount"] = max(self.scan["dayYieldedCount"], ordinal)
        elif read_source == "reply_search":
            self.scan["replySearchYieldedCount"] = max(self.scan["replySearchYieldedCount"], ordinal)
        observation = {
            "scanId": self.scan["scanId"], "logKey": record["logKey"], "operationKey": None,
            "sourceChatId": record["sourceChatId"], "sourceMessageId": record["sourceMessageId"],
            "observedAt": utc_now(), "readSource": read_source, "readOrdinal": ordinal,
            "classificationCode": f"message_{record['messageType']}", "decisionCode": decision_code,
            "relatedSourceMessageId": record.get("replyToMessageId"),
        }
        with self.spool.transaction():
            self.spool.save_scan(self.scan)
            self.spool.enqueue({"scan": self.scan, "messages": [record], "observations": [observation], "operations": []})

    def begin_operation(self, message: Any, operation_type: str, **values: Any) -> str:
        record = self.record_for(message)
        with self.spool.transaction():
            key = self.spool.next_operation_key(self.scan["scanId"], record["logKey"], operation_type)
            operation = {
                "operationKey": key, "scanId": self.scan["scanId"], "logKey": record["logKey"],
                "operationType": operation_type, "status": "planned", "plannedAt": utc_now(),
                "finishedAt": None, "reasonCode": None, "reasonMessage": None, "errorCode": None,
                "errorMessage": None, "externalPacketKey": None, "sourceVersion": None,
                "packetId": None, "cutJobId": None, "cutResultNo": None, "cuttingSequenceNo": None,
                "backendApplied": None, "backendStale": None, "replyText": None,
                "replyToMessageId": None, "sessionSenderUserId": None, "sentTelegramMessageId": None,
                "reconciliationYieldedCount": 0, "reconciliationExhausted": False,
                "reconciliationTruncated": False, "reconciliationErrorCode": None,
                "reconciliationWindowFrom": None, "reconciliationWindowTo": None,
                "steps": [{"stepId": f"start:{operation_type}", "code": "reply_send" if operation_type == "telegram_reply" else "classified", "status": "started", "at": utc_now(), "message": "Обработка начата"}],
                "responses": [], **values,
            }
            self.operations[key] = operation
            self.spool.save_reply_attempt(self.scan, record, operation)
            self.spool.save_processing_attempt(self.scan, record, operation)
            self.spool.enqueue({"scan": self.scan, "messages": [record], "observations": [], "operations": [operation]})
        return key

    def prepare_processing_attempt(
        self,
        key: str,
        message: Any,
        packet: dict[str, Any],
        idempotency_key: str,
        payload_hash: str,
        source_fingerprint: str,
    ) -> None:
        record = self.record_for(message)
        operation = self.operations[key]
        source_version = packet.get("source", {}).get("version")
        if source_version is not None:
            operation["sourceVersion"] = str(source_version)
        with self.spool.transaction():
            self.spool.save_processing_attempt(
                self.scan, record, operation, packet=packet, idempotency_key=idempotency_key,
                payload_hash=payload_hash, source_fingerprint=source_fingerprint,
            )

    def add_operation_step(
        self,
        key: str,
        message: Any,
        code: str,
        status: str,
        step_message: str,
    ) -> None:
        record = self.record_for(message)
        operation = self.operations[key]
        operation["steps"] = [*operation["steps"], {
            "stepId": f"step:{uuid.uuid4()}",
            "code": code,
            "status": status,
            "at": utc_now(),
            "message": sanitize_text(step_message, 500),
        }]
        with self.spool.transaction():
            self.spool.save_processing_attempt(self.scan, record, operation)
            self.spool.enqueue({
                "scan": self.scan,
                "messages": [record],
                "observations": [],
                "operations": [operation],
            })

    def defer_processing_reconciliation(self, key: str, message: Any, error_message: str) -> None:
        record = self.record_for(message)
        self.defer_saved_processing_reconciliation(key, record, error_message)

    def defer_saved_processing_reconciliation(self, key: str, record: dict[str, Any], error_message: str) -> None:
        operation = self.operations[key]
        operation.update({
            "errorCode": "backend_ingest_failed",
            "errorMessage": sanitize_text(error_message, 1000),
        })
        with self.spool.transaction():
            self.spool.save_processing_attempt(self.scan, record, operation)

    def defer_reply_reconciliation(self, key: str, message: Any, error_message: str) -> None:
        record = self.record_for(message)
        operation = self.operations[key]
        operation["_plannedReference"] = deepcopy(operation)
        operation.update({
            "errorCode": "reply_send_failed",
            "errorMessage": sanitize_text(error_message, 1000),
            "responses": [*operation.get("responses", []), {
                "responseId": f"telegram-uncertain:{uuid.uuid4()}",
                "kind": "telegram_reply", "status": "incomplete", "at": utc_now(),
                "text": operation.get("replyText"),
                "replyToMessageId": operation.get("replyToMessageId"),
                "errorCode": "reply_send_failed",
                "errorMessage": sanitize_text(error_message, 500),
            }],
        })
        with self.spool.transaction():
            self.spool.save_reply_attempt(self.scan, record, operation)

    def finish_operation(self, key: str, message: Any, status: str, reason_code: str, reason_message: str, **values: Any) -> None:
        record = self.record_for(message)
        self.finish_saved_operation(key, record, status, reason_code, reason_message, **values)

    def finish_saved_operation(self, key: str, record: dict[str, Any], status: str, reason_code: str, reason_message: str, **values: Any) -> None:
        message_status = "ingested" if reason_code == "backend_ingest_succeeded" else (
            "failed" if status == "failed" else "skipped" if status == "skipped" else (
                record["status"] if record["status"] == "ingested" else "used"
            )
        )
        self._transition_message_status(record, message_status)
        record.update({
            "reasonCode": reason_code, "reasonMessage": sanitize_text(reason_message, 1000),
            "decisionAt": utc_now(),
        })
        for field_name in ("externalPacketKey", "sourceVersion", "packetId", "cutJobId", "cutResultNo", "cuttingSequenceNo", "backendApplied", "backendStale"):
            if field_name in values:
                record[field_name] = values[field_name]
        operation = self.operations[key]
        operation.update({
            "status": status, "finishedAt": utc_now(), "reasonCode": reason_code,
            "reasonMessage": sanitize_text(reason_message, 1000), **values,
        })
        operation["steps"] = [*operation["steps"], {
            "stepId": f"finish:{operation['operationType']}",
            "code": "reply_send" if operation["operationType"] == "telegram_reply" else "backend_ingest",
            "status": "failed" if status == "failed" else "skipped" if status == "skipped" else "succeeded",
            "at": utc_now(), "message": sanitize_text(reason_message, 500),
        }]
        self.scan["processedCount"] += 1 if operation["operationType"] == "message_processing" else 0
        self.scan["ingestedCount"] += 1 if reason_code == "backend_ingest_succeeded" else 0
        with self.spool.transaction():
            self.spool.save_reply_attempt(self.scan, record, operation)
            self.spool.save_processing_attempt(self.scan, record, operation)
            self.spool.save_scan(self.scan)
            self.spool.enqueue({"scan": self.scan, "messages": [record], "observations": [], "operations": [operation]})

    def mark_message(
        self,
        message: Any,
        status: str,
        reason_code: str,
        reason_message: str,
        related_message: Any | None = None,
    ) -> None:
        record = self.record_for(message)
        self._transition_message_status(record, status)
        record.update({
            "reasonCode": reason_code,
            "reasonMessage": sanitize_text(reason_message, 1000), "decisionAt": utc_now(),
            "relatedSourceMessageId": str(int(related_message.id)) if related_message is not None else None,
        })
        with self.spool.transaction():
            self.spool.save_scan(self.scan)
            self.spool.enqueue({"scan": self.scan, "messages": [record], "observations": [], "operations": []})

    def _transition_message_status(self, record: dict[str, Any], status: str) -> None:
        previous = record.get("status")
        if previous == status:
            return
        if previous == "skipped":
            self.scan["skippedCount"] = max(0, self.scan["skippedCount"] - 1)
        elif previous == "failed":
            self.scan["failedCount"] = max(0, self.scan["failedCount"] - 1)
        if status == "skipped":
            self.scan["skippedCount"] += 1
        elif status == "failed":
            self.scan["failedCount"] += 1
        record["status"] = status

    def record_for(self, message: Any) -> dict[str, Any]:
        message_workday = message_datetime(message).astimezone(self.business_timezone).date().isoformat()
        record = telegram_message_record(message, self.scan["sourceChatId"], message_workday)
        existing = self.messages.get(record["logKey"])
        if existing is not None:
            return existing
        self.messages[record["logKey"]] = record
        return record

    def complete(self, status: str = "completed", error: Exception | None = None) -> None:
        self.scan.update({
            "status": status, "finishedAt": utc_now(),
            "dayExhausted": not self.scan["dayTruncated"] and self.scan["dayErrorCode"] is None,
            "replySearchExhausted": not self.scan["replySearchTruncated"] and self.scan["replySearchErrorCode"] is None,
            "errorCode": "unexpected_worker_error" if error else None,
            "errorMessage": sanitize_text(str(error), 1000) if error else None,
        })
        with self.spool.transaction():
            self.spool.save_scan(self.scan)
            self.spool.enqueue(empty_batch(self.scan), outbox_id=f"scan-terminal:{self.scan['scanId']}:{status}")


def empty_batch(scan: dict[str, Any]) -> dict[str, Any]:
    return {"scan": scan, "messages": [], "observations": [], "operations": []}


def telegram_message_record(message: Any, chat_id: str, workday: str) -> dict[str, Any]:
    filename = message_filename(message)
    file = getattr(message, "file", None)
    mime_type = getattr(file, "mime_type", None)
    sender_id = getattr(message, "sender_id", None)
    outgoing = bool(getattr(message, "out", False))
    raw = {
        "chatId": str(chat_id), "messageId": str(int(message.id)),
        "createdAt": message_datetime(message).isoformat(),
        "editedAt": message_edited_datetime(message).isoformat() if message_edited_datetime(message) else None,
        "filename": filename, "mimeType": mime_type, "text": message_text(message),
        "replyToMessageId": str(message_reply_to_id(message)) if message_reply_to_id(message) else None,
        "threadId": str(message_thread_id(message)) if message_thread_id(message) else None,
        "senderUserId": str(sender_id) if isinstance(sender_id, int) else None,
        "outgoing": outgoing, "reactions": reaction_summary(message),
    }
    encoded = json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    message_type = classify_message(message)
    return {
        "logKey": f"tglog:raw-v1:{digest}", "rawSourceDigest": f"sha256:{digest}",
        "sanitizerVersion": SANITIZER_VERSION, "sourceChatId": str(chat_id),
        "sourceMessageId": str(int(message.id)),
        "sourceThreadId": str(message_thread_id(message)) if message_thread_id(message) else None,
        "replyToMessageId": str(message_reply_to_id(message)) if message_reply_to_id(message) else None,
        "senderUserId": str(sender_id) if isinstance(sender_id, int) else None,
        "sourceCreatedAt": message_datetime(message).isoformat(),
        "sourceEditedAt": message_edited_datetime(message).isoformat() if message_edited_datetime(message) else None,
        "workday": workday, "messageType": message_type,
        "filename": sanitize_text(filename or "", 255) or None,
        "mimeType": sanitize_text(mime_type or "", 120) or None,
        "messageText": sanitize_text(message_text(message), 2000) or None,
        "outgoing": outgoing, "status": "observed",
        "reasonCode": "message_observed", "reasonMessage": "Сообщение прочитано",
        "errorCode": None, "errorMessage": None, "relatedSourceMessageId": None,
        "externalPacketKey": None, "sourceVersion": None, "packetId": None, "cutJobId": None,
        "cutResultNo": None, "cuttingSequenceNo": None, "backendApplied": None,
        "backendStale": None, "observedAt": utc_now(), "decisionAt": None,
    }


async def reconcile_pending_processing_attempts(
    spool: AuditSpool,
    erp: Any,
    state: Any,
) -> list[dict[str, Any]]:
    reconciled: list[dict[str, Any]] = []
    for attempt in spool.pending_processing_attempts():
        scan = attempt["scan"]
        message = attempt["message"]
        operation = attempt["operation"]
        audit = ScanAudit(
            spool=spool,
            scan=scan,
            messages={message["logKey"]: message},
            operations={operation["operationKey"]: operation},
        )
        packet = attempt["packet"]
        idem = attempt["idempotencyKey"]
        payload_hash = attempt["payloadHash"]
        source_fingerprint = attempt["sourceFingerprint"]
        if not isinstance(packet, dict) or not all(
            isinstance(value, str) and value for value in (idem, payload_hash, source_fingerprint)
        ):
            audit.finish_saved_operation(
                operation["operationKey"], message, "failed",
                "worker_restarted_before_scan_completion",
                "Worker restarted before the ERP request was durably prepared",
                errorCode="worker_restarted_before_scan_completion",
                errorMessage="Worker restarted before the ERP request was durably prepared",
            )
            reconciled.append(audit.operations[operation["operationKey"]])
            continue
        packet_source = packet.get("source") if isinstance(packet.get("source"), dict) else {}
        packet_source_version = packet_source.get("version") if isinstance(packet_source, dict) else None
        if isinstance(packet_source_version, int) and not isinstance(packet_source_version, bool):
            source_version = packet_source_version
        else:
            try:
                source_version = int(packet_source_version)
            except (TypeError, ValueError):
                audit.finish_saved_operation(
                    operation["operationKey"], message, "failed",
                    "worker_restarted_before_scan_completion",
                    "Worker restarted before the ERP request source version was durably prepared",
                    errorCode="worker_restarted_before_scan_completion",
                    errorMessage="Worker restarted before the ERP request source version was durably prepared",
                )
                reconciled.append(audit.operations[operation["operationKey"]])
                continue
        if state.posted_packet_matches(
            packet["externalPacketKey"],
            payload_hash,
            source_version,
        ):
            sequence_no = state.cutting_sequence_number(packet["externalPacketKey"])
            audit.finish_saved_operation(
                operation["operationKey"], message, "succeeded", "backend_ingest_succeeded",
                "ERP ingest was already confirmed before worker restart",
                externalPacketKey=packet["externalPacketKey"],
                sourceVersion=str(source_version),
                cuttingSequenceNo=sequence_no,
                backendApplied=None,
                backendStale=None,
                responses=[*operation.get("responses", []), {
                    "responseId": f"backend-recovered-from-state:{uuid.uuid4()}",
                    "kind": "backend_ingest", "status": "reconciled", "at": utc_now(),
                }],
            )
            reconciled.append(audit.operations[operation["operationKey"]])
            continue
        try:
            response = await erp.ingest_packet(packet, idem)
        except Exception as exc:
            error_message = sanitize_text(str(exc), 1000)
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if isinstance(status_code, int) and 400 <= status_code < 500:
                audit.finish_saved_operation(
                    operation["operationKey"], message, "failed", "backend_ingest_failed",
                    error_message,
                    errorCode="backend_ingest_failed",
                    errorMessage=error_message,
                    externalPacketKey=packet["externalPacketKey"],
                    sourceVersion=str(packet["source"]["version"]),
                    responses=[*operation.get("responses", []), {
                        "responseId": f"backend-recovery-failed:{uuid.uuid4()}",
                        "kind": "backend_ingest", "status": "failed", "at": utc_now(),
                        "errorCode": "backend_ingest_failed", "errorMessage": error_message,
                    }],
                )
                reconciled.append(audit.operations[operation["operationKey"]])
                continue
            audit.defer_saved_processing_reconciliation(operation["operationKey"], message, error_message)
            print(
                "Deferred CNC Telegram processing recovery after transient ERP ingest error "
                f"externalPacketKey={packet.get('externalPacketKey')} "
                f"sourceVersion={packet.get('source', {}).get('version')} "
                f"error={error_message}",
                flush=True,
            )
            continue
        response_packet = response.get("packet") if isinstance(response, dict) else None
        skipped_duplicate = response_skipped_duplicate_source_file(response)
        response_import_status = response_svg_cut_import_status(response, response_packet)
        response_cut_job_id = response_svg_cut_job_id(response_packet, skipped_duplicate)
        reason_code = "backend_duplicate_source_file" if skipped_duplicate else "backend_ingest_succeeded"
        reason_message = (
            sanitize_text(str(skipped_duplicate.get("note") or ""), 1000)
            if skipped_duplicate else "ERP idempotently confirmed the assignment after worker restart"
        )
        audit.finish_saved_operation(
            operation["operationKey"], message, "succeeded", reason_code, reason_message,
            externalPacketKey=packet["externalPacketKey"],
            sourceVersion=str(packet["source"]["version"]),
            packetId=response_packet.get("packetId") if isinstance(response_packet, dict) else None,
            cutJobId=str(response_cut_job_id) if response_cut_job_id is not None else None,
            cutResultNo=response_packet.get("cutResultNo") if isinstance(response_packet, dict) else None,
            cuttingSequenceNo=response_packet.get("cuttingSequenceNo") if isinstance(response_packet, dict) else None,
            backendApplied=bool(response.get("applied")) if isinstance(response, dict) else None,
            backendStale=bool(response.get("stale")) if isinstance(response, dict) and response.get("stale") is not None else None,
            responses=[*operation.get("responses", []), {
                "responseId": f"backend-reconciled:{uuid.uuid4()}",
                "kind": "backend_ingest", "status": "reconciled", "at": utc_now(),
            }],
        )
        sequence_no = response_packet.get("cuttingSequenceNo") if isinstance(response_packet, dict) else None
        if (
            response_allows_cutting_sequence_reply(response, response_packet)
            and isinstance(sequence_no, int)
            and not isinstance(sequence_no, bool)
            and sequence_no > 0
        ):
            state.assign_cutting_sequence_number(packet["externalPacketKey"], existing_number=sequence_no)
        state.mark_posted(
            packet["externalPacketKey"], payload_hash, source_version, source_fingerprint,
            svg_cut_import_status=response_import_status,
            cut_job_id=response_cut_job_id,
            source_file_sha=packet_svg_source_sha(packet),
        )
        reconciled.append(audit.operations[operation["operationKey"]])
    return reconciled


def response_skipped_duplicate_source_file(response: Any) -> dict[str, Any] | None:
    if not isinstance(response, dict):
        return None
    skipped = response.get("skippedDuplicateSourceFile")
    if isinstance(skipped, dict) and skipped.get("status") == "skipped":
        return skipped
    return None


def response_allows_cutting_sequence_reply(response: Any, response_packet: Any) -> bool:
    return response_skipped_duplicate_source_file(response) is None and response_svg_cut_imported(response_packet)


def response_svg_cut_imported(response_packet: Any) -> bool:
    return isinstance(response_packet, dict) and response_packet.get("svgCutImportStatus") == "imported"


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


def packet_svg_source_sha(packet: dict[str, Any]) -> str | None:
    source_files = packet.get("sourceFiles")
    if not isinstance(source_files, list):
        return None
    for source_file in source_files:
        if (
            isinstance(source_file, dict)
            and source_file.get("kind") == "svg"
            and isinstance(source_file.get("sha256"), str)
            and source_file["sha256"]
        ):
            return source_file["sha256"]
    return None


def classify_message(message: Any) -> str:
    filename = (message_filename(message) or "").lower()
    if filename.endswith(".svg"):
        return "svg"
    if filename.endswith(".dxf"):
        return "dxf"
    if is_image_message(message):
        return "image"
    if is_gcode_message(message):
        return "gcode"
    text = message_text(message)
    if re.search(r"(?i)раскро[ий].*\d", text):
        return "bot_reply"
    if text and not filename:
        return "text"
    if is_vector_message(message):
        return "other"
    return "other"


def reaction_summary(message: Any) -> list[dict[str, Any]]:
    results = getattr(getattr(message, "reactions", None), "results", None) or []
    summary: list[dict[str, Any]] = []
    for result in results:
        reaction = getattr(result, "reaction", None)
        value = getattr(reaction, "emoticon", None) or getattr(reaction, "document_id", None)
        summary.append({"reaction": str(value or "unknown"), "count": int(getattr(result, "count", 0) or 0)})
    return sorted(summary, key=lambda item: item["reaction"])


async def reconcile_pending_replies(
    spool: AuditSpool,
    client: Any,
    entity: Any,
    session_user_id: str | None,
) -> list[dict[str, Any]]:
    reconciled: list[dict[str, Any]] = []
    for attempt in spool.pending_reply_attempts():
        scan = attempt["scan"]
        source = attempt["message"]
        operation = attempt["operation"]
        stored_planned_reference = operation.pop("_plannedReference", None)
        stable_observations = operation.pop("_reconciliationObservations", {})
        if not isinstance(stable_observations, dict):
            stable_observations = {}
        planned_reference = (
            stored_planned_reference
            if isinstance(stored_planned_reference, dict)
            else deepcopy(operation)
        )
        planned_at = datetime.fromisoformat(operation["plannedAt"])
        window_from = planned_at - timedelta(seconds=5)
        window_to = planned_at + timedelta(minutes=5)
        reconciliation_yielded_count = 0
        reconciliation_truncated = False
        reconciliation_error_code: str | None = None
        matches: list[Any] = []
        complete = False
        try:
            ordinal = 0
            async for candidate in client.iter_messages(
                entity,
                search=operation["replyText"],
                offset_date=window_to,
                limit=1000,
            ):
                ordinal += 1
                candidate_at = message_datetime(candidate)
                if candidate_at < window_from:
                    complete = True
                decision = reconciliation_decision(candidate, operation, session_user_id, window_from, window_to)
                candidate_record = telegram_message_record(candidate, scan["sourceChatId"], scan["workday"])
                candidate_record.update({
                    "status": "used" if decision == "reconciliation_match" else "skipped",
                    "reasonCode": decision,
                    "reasonMessage": reconciliation_reason_message(decision),
                    "decisionAt": utc_now(),
                    "relatedSourceMessageId": operation["replyToMessageId"],
                })
                if decision == "reconciliation_match":
                    matches.append(candidate)
                reconciliation_yielded_count = ordinal
                stable_key = str(ordinal)
                stable_payload = stable_observations.get(stable_key)
                if stable_payload is None:
                    observation = {
                        "scanId": scan["scanId"], "logKey": candidate_record["logKey"],
                        "operationKey": operation["operationKey"], "sourceChatId": scan["sourceChatId"],
                        "sourceMessageId": candidate_record["sourceMessageId"], "observedAt": utc_now(),
                        "readSource": "reply_reconciliation", "readOrdinal": ordinal,
                        "classificationCode": "message_bot_reply", "decisionCode": decision,
                        "relatedSourceMessageId": operation["replyToMessageId"],
                    }
                    stable_payload = {"message": candidate_record, "observation": observation}
                    stable_observations[stable_key] = stable_payload
                elif not reconciliation_payload_matches(stable_payload, candidate_record, decision, operation):
                    raise RuntimeError(f"Telegram reconciliation ordinal {ordinal} changed between retries")
                candidate_record = stable_payload["message"]
                observation = stable_payload["observation"]
                operation_progress = deepcopy(operation)
                operation_progress["_plannedReference"] = planned_reference
                operation_progress["_reconciliationObservations"] = stable_observations
                batch_messages = [source]
                if candidate_record["logKey"] != source["logKey"]:
                    batch_messages.append(candidate_record)
                with spool.transaction():
                    spool.save_reply_attempt(scan, source, operation_progress)
                    spool.enqueue({
                        "scan": scan, "messages": batch_messages,
                        "observations": [observation], "operations": [planned_reference],
                    })
                if complete:
                    break
            else:
                complete = True
            if reconciliation_yielded_count >= 1000:
                reconciliation_truncated = True
        except Exception as exc:
            reconciliation_error_code = "telegram_read_failed"
            operation["errorCode"] = "telegram_read_failed"
            operation["errorMessage"] = sanitize_text(str(exc), 1000)

        operation.update({
            "reconciliationWindowFrom": window_from.isoformat(),
            "reconciliationWindowTo": window_to.isoformat(),
            "reconciliationYieldedCount": reconciliation_yielded_count,
            "reconciliationExhausted": complete and not reconciliation_truncated,
            "reconciliationTruncated": reconciliation_truncated,
            "reconciliationErrorCode": reconciliation_error_code,
        })

        if operation["reconciliationExhausted"] and len(matches) == 1:
            match = matches[0]
            operation.update({
                "status": "reconciled", "finishedAt": utc_now(),
                "reasonCode": "reconciliation_match", "reasonMessage": "Ранее отправленный ответ найден",
                "sentTelegramMessageId": str(int(match.id)),
            })
            operation["responses"] = [*operation.get("responses", []), {
                "responseId": f"telegram-reconciled:{uuid.uuid4()}", "kind": "telegram_reply",
                "status": "reconciled", "at": utc_now(), "text": operation["replyText"],
                "telegramMessageId": str(int(match.id)), "replyToMessageId": operation["replyToMessageId"],
            }]
            reconciled.append(operation)
        elif len(matches) > 1:
            operation.update({
                "status": "ambiguous", "finishedAt": utc_now(),
                "reasonCode": "reconciliation_ambiguous", "reasonMessage": "Найдено несколько одинаковых ответов; повторная отправка заблокирована",
            })
        else:
            operation.update({
                "status": "incomplete", "finishedAt": utc_now(),
                "reasonCode": "reconciliation_incomplete",
                "reasonMessage": "Ответ не доказан; повторная отправка заблокирована" if operation["reconciliationExhausted"] else "Поиск ответа завершён не полностью; повторная отправка заблокирована",
            })
        operation["steps"] = [*operation.get("steps", []), {
            "stepId": f"reconcile:{uuid.uuid4()}", "code": "reply_search",
            "status": "succeeded" if operation["status"] == "reconciled" else "failed",
            "at": utc_now(), "message": operation["reasonMessage"],
        }]
        with spool.transaction():
            spool.save_reply_attempt(scan, source, operation)
            spool.enqueue({"scan": scan, "messages": [source], "observations": [], "operations": [operation]})
    return reconciled


def reconciliation_payload_matches(
    stable_payload: Any,
    candidate_record: dict[str, Any],
    decision: str,
    operation: dict[str, Any],
) -> bool:
    if not isinstance(stable_payload, dict):
        return False
    message = stable_payload.get("message")
    observation = stable_payload.get("observation")
    return (
        isinstance(message, dict)
        and isinstance(observation, dict)
        and message.get("logKey") == candidate_record["logKey"]
        and observation.get("logKey") == candidate_record["logKey"]
        and observation.get("sourceMessageId") == candidate_record["sourceMessageId"]
        and observation.get("decisionCode") == decision
        and observation.get("operationKey") == operation["operationKey"]
        and observation.get("relatedSourceMessageId") == operation["replyToMessageId"]
    )


def reconciliation_decision(
    message: Any,
    operation: dict[str, Any],
    session_user_id: str | None,
    window_from: datetime,
    window_to: datetime,
) -> str:
    created_at = message_datetime(message)
    if created_at < window_from or created_at > window_to:
        return "reconciliation_outside_window"
    if not bool(getattr(message, "out", False)):
        return "reconciliation_not_outgoing"
    sender_id = getattr(message, "sender_id", None)
    if session_user_id is not None and str(sender_id) != session_user_id:
        return "reconciliation_foreign_sender"
    if str(message_reply_to_id(message)) != operation["replyToMessageId"]:
        return "reconciliation_wrong_target"
    if message_text(message) != operation["replyText"]:
        return "reconciliation_wrong_text"
    return "reconciliation_match"


def reconciliation_reason_message(code: str) -> str:
    return {
        "reconciliation_match": "Точный ранее отправленный ответ",
        "reconciliation_outside_window": "Ответ вне окна восстановления",
        "reconciliation_not_outgoing": "Сообщение не отправлено текущей сессией",
        "reconciliation_foreign_sender": "Другой отправитель Telegram",
        "reconciliation_wrong_target": "Ответ адресован другому сообщению",
        "reconciliation_wrong_text": "Текст ответа отличается",
    }.get(code, code)


def reply_search_reason_message(code: str) -> str:
    return {
        "reply_selected": "Ответ выбран как номер раскроя",
        "reply_invalid_number": "Текст похож на ответ, но номер раскроя не распознан",
        "reply_wrong_target": "Ответ адресован другому сообщению",
        "reply_foreign_sender": "Ответ оставил другой пользователь; номер отклонён",
        "reply_not_outgoing": "Ответ не отправлен текущей сессией; номер отклонён",
        "reply_older_than_selected": "Для сообщения уже выбран более новый ответ",
        "reply_ambiguous": "Найден другой номер для того же сообщения",
        "reply_outside_business_window": "Ответ старше рабочего дня SVG",
        "reply_unrelated": "Ответ не привязан к сообщению",
    }.get(code, code)
