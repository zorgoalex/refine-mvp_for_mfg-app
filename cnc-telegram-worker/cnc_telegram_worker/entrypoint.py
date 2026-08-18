from __future__ import annotations

import os
import pwd
import runpy
import sys
from pathlib import Path


WRITABLE_DIRS = (
    Path("/data/tmp"),
    Path("/data/session"),
    Path("/data/cnc-telegram-media"),
    Path("/data/technical-logs"),
)


def main() -> None:
    worker = pwd.getpwnam("worker")
    for path in WRITABLE_DIRS:
        path.mkdir(parents=True, exist_ok=True)
        chown_tree(path, worker.pw_uid, worker.pw_gid)

    os.setgid(worker.pw_gid)
    os.setuid(worker.pw_uid)
    sys.argv = ["python -m cnc_telegram_worker", *sys.argv[1:]]
    runpy.run_module("cnc_telegram_worker", run_name="__main__", alter_sys=True)


def chown_tree(path: Path, uid: int, gid: int) -> None:
    os.chown(path, uid, gid)
    for root, dirs, files in os.walk(path):
        for name in dirs:
            os.chown(Path(root, name), uid, gid)
        for name in files:
            os.chown(Path(root, name), uid, gid)


if __name__ == "__main__":
    main()
