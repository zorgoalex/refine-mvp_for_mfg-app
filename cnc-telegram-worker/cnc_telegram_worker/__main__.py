from __future__ import annotations

import argparse
import asyncio
from datetime import date, datetime

from .cleanup import cleanup_temp_dir
from .config import WorkerConfig
from .worker import CncTelegramWorker, login_telegram_session


def main() -> None:
    parser = argparse.ArgumentParser(prog="cnc-telegram-worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("login", help="Create or refresh Telethon session")

    once = subparsers.add_parser("once", help="Scan history once")
    once.add_argument("--date", dest="workday", help="Workday YYYY-MM-DD")
    once.add_argument("--days", type=int, help="Backfill days ending at --date or today")

    svg_refresh = subparsers.add_parser("svg-refresh-backfill", help="Reparse Telegram SVGs with lenient mode")
    svg_refresh.add_argument("--date", dest="workday", help="Workday YYYY-MM-DD")
    svg_refresh.add_argument("--days", type=int, help="Backfill days ending at --date or today")
    svg_refresh.add_argument("--write", action="store_true", help="Send refreshed SVG layouts to ERP")

    daemon = subparsers.add_parser("daemon", help="Scan history forever")
    daemon.add_argument("--days", type=int, help="Backfill days per polling pass")

    subparsers.add_parser("cleanup", help="Delete stale temp files")

    args = parser.parse_args()
    config = WorkerConfig.from_env()

    if args.command == "login":
        asyncio.run(login_telegram_session(config))
        return

    if args.command == "cleanup":
        removed = cleanup_temp_dir(config.temp_dir, config.temp_ttl_hours)
        print(f"cleanup removed {removed} file(s)")
        return

    worker = CncTelegramWorker(config)
    if args.command == "once":
        workday = parse_workday(args.workday) if args.workday else None
        asyncio.run(worker.run_once(workday=workday, days=args.days))
        return

    if args.command == "svg-refresh-backfill":
        workday = parse_workday(args.workday) if args.workday else None
        asyncio.run(worker.run_svg_refresh_backfill(workday=workday, days=args.days, write=args.write))
        return

    if args.command == "daemon":
        asyncio.run(worker.run_daemon(days=args.days))


def parse_workday(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise SystemExit(f"invalid --date {value!r}; expected YYYY-MM-DD") from exc


if __name__ == "__main__":
    main()
