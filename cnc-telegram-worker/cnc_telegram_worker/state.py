from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class VersionDecision:
    source_version: int
    changed: bool


class StateStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._state = self._load()

    def next_version(self, external_packet_key: str, payload_hash: str) -> VersionDecision:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        if isinstance(packet, dict) and packet.get("payloadHash") == payload_hash:
            return VersionDecision(source_version=int(packet.get("sourceVersion", 1)), changed=False)
        previous = int(packet.get("sourceVersion", 0)) if isinstance(packet, dict) else 0
        return VersionDecision(source_version=previous + 1, changed=True)

    def mark_posted(self, external_packet_key: str, payload_hash: str, source_version: int) -> None:
        self._state.setdefault("packets", {})[external_packet_key] = {
            "payloadHash": payload_hash,
            "sourceVersion": source_version,
            "postedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        self._write()

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"packets": {}}
        except json.JSONDecodeError:
            corrupt = self.path.with_suffix(self.path.suffix + ".corrupt")
            self.path.replace(corrupt)
            return {"packets": {}}
        return data if isinstance(data, dict) else {"packets": {}}

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(self._state, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp_path, self.path)
