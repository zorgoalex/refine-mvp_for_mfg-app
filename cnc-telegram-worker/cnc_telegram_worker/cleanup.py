from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path


def cleanup_temp_dir(temp_dir: Path, ttl_hours: int) -> int:
    root = temp_dir.resolve()
    if root in {Path("/"), Path("/tmp").resolve()}:
        raise ValueError(f"refuse unsafe temp cleanup root: {root}")
    root.mkdir(parents=True, exist_ok=True)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=ttl_hours)
    removed = 0
    for path in root.rglob("*"):
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        if modified >= cutoff:
            continue
        if path.is_dir():
            try:
                shutil.rmtree(path)
                removed += 1
            except FileNotFoundError:
                pass
        else:
            try:
                path.unlink()
                removed += 1
            except FileNotFoundError:
                pass
    return removed
