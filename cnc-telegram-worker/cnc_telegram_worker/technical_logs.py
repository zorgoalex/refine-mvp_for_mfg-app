from __future__ import annotations

import asyncio
import io
import json
import queue
import re
import sqlite3
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .erp_client import SessionLeaseLost


REDACTION_VERSION = "cnc-technical-redaction-v1"
MAX_LINE_CHARS = 8192
MAX_SPOOL_ROWS = 50_000
MAX_BATCH_ROWS = 200
_PATTERNS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("authorization", re.compile(r"\bAuthorization\s*:\s*[^\r\n]+", re.I), "Authorization: [REDACTED]"),
    ("authorization", re.compile(r"\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]+", re.I), "Authorization: Bearer [REDACTED]"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"), "[JWT_REDACTED]"),
    ("bot_token", re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{20,}\b"), "[BOT_TOKEN_REDACTED]"),
    ("credential", re.compile(r"\b(password|secret|api[_-]?hash|token|cookie)\b[\"']?\s*[:=]\s*[\"']?[^\s\"',;}]+", re.I), r"\1=[REDACTED]"),
    ("url_userinfo", re.compile(r"(https?://)[^\s/@:]+:[^\s/@]+@", re.I), r"\1[CREDENTIALS_REDACTED]@"),
    ("session_path", re.compile(r"/data/session/[A-Za-z0-9._/-]+", re.I), "/data/session/[REDACTED]"),
    ("phone", re.compile(r"(?<!\d)\+?\d[\d ()-]{8,17}\d(?!\d)"), "[PHONE_REDACTED]"),
)
_FORBIDDEN = re.compile(r"\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{12,}|\d{6,12}:[A-Za-z0-9_-]{20,})\b", re.I)


@dataclass(frozen=True)
class TechnicalLogLine:
    workerInstanceId: str
    sequence: int
    observedAt: str
    stream: str
    message: str
    redactionVersion: str
    redacted: bool
    truncated: bool
    redactionCategories: list[str]
    droppedBefore: int


def sanitize_line(value: str) -> tuple[str, bool, bool, list[str]]:
    text = value.rstrip("\r\n")
    categories: list[str] = []
    for category, pattern, replacement in _PATTERNS:
        text, count = pattern.subn(replacement, text)
        if count:
            categories.append(category)
    if _FORBIDDEN.search(text):
        text = "[QUARANTINED: possible credential remained after redaction]"
        categories.append("quarantined")
    truncated = len(text) > MAX_LINE_CHARS
    return text[:MAX_LINE_CHARS] or "[empty line]", bool(categories), truncated, categories[:16]


class TechnicalLogSpool:
    def __init__(self, path: Path, queue_size: int = 10_000, worker_instance_id: str | None = None) -> None:
        self.path = path
        self.worker_instance_id = worker_instance_id or str(uuid.uuid4())
        try:
            uuid.UUID(self.worker_instance_id)
        except ValueError as exc:
            raise ValueError("technical log worker_instance_id must be a UUID") from exc
        self._sequence = 0
        self._dropped = 0
        self._capture_lock = threading.Lock()
        self._queue: queue.Queue[TechnicalLogLine | None] = queue.Queue(maxsize=queue_size)
        self._original_stderr = sys.stderr
        self._closed = False
        self._last_internal_error_at = 0.0
        path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._thread = threading.Thread(target=self._writer_loop, name="technical-log-spool", daemon=True)
        self._thread.start()

    def capture(self, stream: str, value: str) -> None:
        for raw_line in value.splitlines():
            with self._capture_lock:
                self._enqueue_loss_record_nowait(stream)
                self._sequence += 1
                message, redacted, truncated, categories = sanitize_line(raw_line)
                line = TechnicalLogLine(
                    workerInstanceId=self.worker_instance_id,
                    sequence=self._sequence,
                    observedAt=datetime.now(timezone.utc).isoformat(),
                    stream=stream,
                    message=message,
                    redactionVersion=REDACTION_VERSION,
                    redacted=redacted,
                    truncated=truncated,
                    redactionCategories=categories,
                    droppedBefore=self._dropped,
                )
                try:
                    self._queue.put_nowait(line)
                    self._dropped = 0
                except queue.Full:
                    self._dropped += 1

    def pending_batch(self, limit: int = MAX_BATCH_ROWS) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload FROM technical_logs ORDER BY row_id LIMIT ?", (min(limit, MAX_BATCH_ROWS),),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def mark_delivered(self, lines: list[dict[str, Any]]) -> None:
        identities = [(line["workerInstanceId"], line["sequence"]) for line in lines]
        with self._connect() as connection:
            connection.executemany(
                "DELETE FROM technical_logs WHERE worker_instance_id=? AND sequence=?", identities,
            )

    def internal_error(self, message: str) -> None:
        now = time.monotonic()
        if now - self._last_internal_error_at < 30:
            return
        self._last_internal_error_at = now
        self._original_stderr.write(f"technical-log internal error: {sanitize_line(message)[0]}\n")
        self._original_stderr.flush()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with self._capture_lock:
            if self._dropped:
                loss = self._loss_record("stderr")
                try:
                    self._queue.put(loss, timeout=5)
                    self._dropped = 0
                except queue.Full:
                    self.internal_error("durable loss record could not be queued during shutdown")
        try:
            self._queue.put(None, timeout=5)
        except queue.Full:
            self.internal_error("spool writer did not drain during shutdown")
        self._thread.join(timeout=5)

    def _enqueue_loss_record_nowait(self, stream: str) -> None:
        if not self._dropped:
            return
        loss = self._loss_record(stream)
        try:
            self._queue.put_nowait(loss)
            self._dropped = 0
        except queue.Full:
            return

    def _loss_record(self, stream: str) -> TechnicalLogLine:
        dropped = self._dropped
        self._sequence += 1
        return TechnicalLogLine(
            workerInstanceId=self.worker_instance_id,
            sequence=self._sequence,
            observedAt=datetime.now(timezone.utc).isoformat(),
            stream=stream,
            message=f"technical log loss: {dropped} line(s) dropped before persistence",
            redactionVersion=REDACTION_VERSION,
            redacted=False,
            truncated=False,
            redactionCategories=["loss_accounting"],
            droppedBefore=dropped,
        )

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA busy_timeout=5000")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS technical_logs ("
                "row_id INTEGER PRIMARY KEY AUTOINCREMENT, worker_instance_id TEXT NOT NULL, "
                "sequence INTEGER NOT NULL, payload TEXT NOT NULL, "
                "UNIQUE(worker_instance_id, sequence))",
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _writer_loop(self) -> None:
        pending: TechnicalLogLine | None = None
        connection: sqlite3.Connection | None = None
        while True:
            if pending is None:
                pending = self._queue.get()
                if pending is None:
                    break
            try:
                if connection is None:
                    connection = self._connect()
                    connection.execute("PRAGMA journal_mode=WAL")
                pending = self._write_line(connection, pending)
                connection.commit()
                pending = None
            except sqlite3.Error as exc:
                if connection is not None:
                    try:
                        connection.close()
                    except sqlite3.Error:
                        pass
                    connection = None
                self.internal_error(str(exc))
                time.sleep(0.25)
            except Exception as exc:
                self.internal_error(str(exc))
                time.sleep(0.25)
        if connection is not None:
            connection.close()

    def _write_line(self, connection: sqlite3.Connection, line: TechnicalLogLine) -> TechnicalLogLine:
        row_count = int(connection.execute("SELECT count(*) FROM technical_logs").fetchone()[0])
        excess = max(row_count - MAX_SPOOL_ROWS + 1, 0)
        if excess:
            connection.execute(
                "DELETE FROM technical_logs WHERE row_id IN (SELECT row_id FROM technical_logs ORDER BY row_id LIMIT ?)",
                (excess,),
            )
            line = replace(
                line,
                droppedBefore=line.droppedBefore + excess,
                redactionCategories=[*line.redactionCategories, "spool_eviction"][:16],
            )
        connection.execute(
            "INSERT OR IGNORE INTO technical_logs(worker_instance_id, sequence, payload) VALUES (?, ?, ?)",
            (line.workerInstanceId, line.sequence, json.dumps(asdict(line), ensure_ascii=False)),
        )
        return line


class TeeStream(io.TextIOBase):
    def __init__(self, original: Any, stream: str, spool: TechnicalLogSpool) -> None:
        self.original = original
        self.stream = stream
        self.spool = spool
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, value: str) -> int:
        result = self.original.write(value)
        with self._lock:
            self._buffer += value
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                self.spool.capture(self.stream, line)
        return result

    def flush(self) -> None:
        self.original.flush()

    def isatty(self) -> bool:
        return bool(getattr(self.original, "isatty", lambda: False)())

    def finish(self) -> None:
        with self._lock:
            if self._buffer:
                self.spool.capture(self.stream, self._buffer)
                self._buffer = ""


class TechnicalLogCapture:
    def __init__(self, path: Path, worker_instance_id: str | None = None) -> None:
        self.spool = TechnicalLogSpool(path, worker_instance_id=worker_instance_id)
        self._stdout = sys.stdout
        self._stderr = sys.stderr
        self._stdout_tee = TeeStream(self._stdout, "stdout", self.spool)
        self._stderr_tee = TeeStream(self._stderr, "stderr", self.spool)

    def install(self) -> None:
        sys.stdout = self._stdout_tee
        sys.stderr = self._stderr_tee

    def close(self) -> None:
        self._stdout_tee.finish()
        self._stderr_tee.finish()
        sys.stdout = self._stdout
        sys.stderr = self._stderr
        self.spool.close()


async def deliver_technical_logs(
    spool: TechnicalLogSpool,
    sender: Callable[[dict[str, Any]], Any],
    stop_event: asyncio.Event,
    interval_seconds: int = 5,
    heartbeat_seconds: int = 30,
    fatal_event: asyncio.Event | None = None,
) -> None:
    last_heartbeat = 0.0
    loop = asyncio.get_running_loop()
    while not stop_event.is_set():
        now = loop.time()
        if now - last_heartbeat >= heartbeat_seconds:
            print(f"worker heartbeat instance={spool.worker_instance_id} phase=running delivery=active", flush=True)
            last_heartbeat = now
        try:
            await flush_technical_logs_once(spool, sender)
        except SessionLeaseLost:
            if fatal_event is not None:
                fatal_event.set()
            stop_event.set()
            raise
        except Exception as exc:
            spool.internal_error(str(exc))
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass


async def flush_technical_logs_once(
    spool: TechnicalLogSpool,
    sender: Callable[[dict[str, Any]], Any],
) -> int:
    lines = await asyncio.to_thread(spool.pending_batch)
    if not lines:
        return 0
    await sender({"batchId": str(uuid.uuid4()), "lines": lines})
    await asyncio.to_thread(spool.mark_delivered, lines)
    return len(lines)
