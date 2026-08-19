from __future__ import annotations

import argparse
import asyncio
import os
from datetime import date, datetime
from pathlib import Path
from typing import Awaitable, Callable

from .cleanup import cleanup_temp_dir
from .config import WorkerConfig, ensure_worker_instance_id
from .erp_client import SessionLeaseLost
from .technical_logs import TechnicalLogCapture, deliver_technical_logs, flush_technical_logs_once
from .worker import CncTelegramWorker, login_telegram_session


def main() -> None:
    worker_instance_id = ensure_worker_instance_id()
    capture = TechnicalLogCapture(
        Path(os.environ.get("CNC_TECHNICAL_LOG_SPOOL_PATH", "/data/technical-logs/spool.sqlite3")),
        worker_instance_id=worker_instance_id,
    )
    capture.install()
    try:
        _main(capture)
    finally:
        capture.close()


def _main(capture: TechnicalLogCapture) -> None:
    parser = argparse.ArgumentParser(prog="cnc-telegram-worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("login", help="Create or refresh Telethon session")

    once = subparsers.add_parser("once", help="Disabled until Phase B persisted approval is available")
    once.add_argument("--date", dest="workday", help="Workday YYYY-MM-DD")
    once.add_argument("--days", type=int, required=True, help="Bounded scan days (1..31) ending at --date or today")
    once.add_argument("--scan-request-id", required=True, help="Persisted approved scan request id")

    subparsers.add_parser("serve", help="Run queues without unsolicited Telegram history scans")

    svg_refresh = subparsers.add_parser("svg-refresh-backfill", help="Disabled Phase-A history reader")
    svg_refresh.add_argument("--date", dest="workday", help="Workday YYYY-MM-DD")
    svg_refresh.add_argument("--days", type=int, help="Backfill days ending at --date or today")
    svg_refresh.add_argument("--write", action="store_true", help="Send refreshed SVG layouts to ERP")

    daemon = subparsers.add_parser("daemon", help="Scan history forever")
    daemon.add_argument("--days", type=int, help="Backfill days per polling pass")

    subparsers.add_parser("cleanup", help="Delete stale temp files")

    args = parser.parse_args()
    if args.command == "once":
        raise SystemExit(
            "once is disabled after Phase A; persisted approved scan/import worker flow is required",
        )
    if args.command == "svg-refresh-backfill":
        raise SystemExit(
            "svg-refresh-backfill is disabled after Phase A; history reads require the Phase B persisted scan flow",
        )
    config = WorkerConfig.from_env()
    if capture.spool.worker_instance_id != config.worker_instance_id:
        raise RuntimeError("technical-log and session worker identities do not match")

    if args.command == "login":
        asyncio.run(login_telegram_session(config))
        return

    if args.command == "cleanup":
        removed = cleanup_temp_dir(config.temp_dir, config.temp_ttl_hours)
        print(f"cleanup removed {removed} file(s)")
        return

    worker = CncTelegramWorker(config)
    if args.command == "serve":
        asyncio.run(run_with_technical_delivery(
            worker,
            capture,
            lambda fatal_event: worker.run_serve(technical_lease_lost_event=fatal_event),
        ))
        return

    if args.command == "daemon":
        raise SystemExit("daemon is deprecated and fail-closed; use `serve`")


async def run_with_technical_delivery(
    worker: CncTelegramWorker,
    capture: TechnicalLogCapture,
    operation: Callable[[asyncio.Event], Awaitable[None]],
) -> None:
    stop_event = asyncio.Event()
    fatal_event = asyncio.Event()
    delivery = asyncio.create_task(deliver_technical_logs(
        capture.spool,
        worker.erp.technical_log_batch,
        stop_event,
        interval_seconds=worker.config.technical_log_flush_interval_seconds,
        heartbeat_seconds=worker.config.technical_log_heartbeat_seconds,
        fatal_event=fatal_event,
    ))
    operation_task = asyncio.create_task(operation(fatal_event))
    try:
        done, _ = await asyncio.wait(
            {delivery, operation_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if delivery in done:
            # A stale session lease from technical delivery must reach the
            # serve operation so it disconnects Telethon before we exit.
            delivery_error = delivery.exception()
            if isinstance(delivery_error, SessionLeaseLost):
                fatal_event.set()
                await operation_task
            if delivery_error is not None:
                raise delivery_error
        else:
            await operation_task
    finally:
        try:
            for _ in range(3):
                if await flush_technical_logs_once(capture.spool, worker.erp.technical_log_batch) == 0:
                    break
        except SessionLeaseLost:
            fatal_event.set()
            raise
        except Exception as exc:
            capture.spool.internal_error(str(exc))
        stop_event.set()
        if not operation_task.done():
            operation_task.cancel()
        results = await asyncio.gather(delivery, operation_task, return_exceptions=True)
        for result in results:
            if isinstance(result, SessionLeaseLost):
                raise result


def parse_workday(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise SystemExit(f"invalid --date {value!r}; expected YYYY-MM-DD") from exc


if __name__ == "__main__":
    main()
