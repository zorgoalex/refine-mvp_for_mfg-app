from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path


def cleanup_temp_dir(
    temp_dir: Path,
    ttl_hours: int,
    *,
    excluded_relative_dirs: frozenset[str] = frozenset(),
) -> int:
    root = temp_dir.resolve()
    if root in {Path("/"), Path("/tmp").resolve()}:
        raise ValueError(f"refuse unsafe temp cleanup root: {root}")
    root.mkdir(parents=True, exist_ok=True)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=ttl_hours)
    removed = 0
    for path in root.rglob("*"):
        relative_parts = path.relative_to(root).parts
        if relative_parts and relative_parts[0] in excluded_relative_dirs:
            continue
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
