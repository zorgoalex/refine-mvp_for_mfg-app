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

    def cutting_sequence_number(self, external_packet_key: str) -> int | None:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        if not isinstance(packet, dict):
            return None
        value = packet.get("cuttingSequenceNumber")
        return int(value) if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None

    def cutting_sequence_replied(self, external_packet_key: str) -> bool:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        return isinstance(packet, dict) and packet.get("cuttingSequenceReplied") is True

    def assign_cutting_sequence_number(
        self,
        external_packet_key: str,
        existing_number: int | None = None,
    ) -> tuple[int, bool]:
        packet = self._state.setdefault("packets", {}).setdefault(external_packet_key, {})
        if not isinstance(packet, dict):
            packet = {}
            self._state["packets"][external_packet_key] = packet
        current = packet.get("cuttingSequenceNumber")
        if isinstance(current, int) and not isinstance(current, bool) and current > 0:
            if existing_number is not None and existing_number > 0 and current != existing_number:
                packet["cuttingSequenceNumber"] = existing_number
                self._advance_cutting_sequence(existing_number + 1)
                self._write()
                return existing_number, False
            return current, False
        if existing_number is not None and existing_number > 0:
            number = existing_number
            new_assignment = False
        else:
            number = self._next_cutting_sequence_number()
            new_assignment = True
        packet["cuttingSequenceNumber"] = number
        self._advance_cutting_sequence(number + 1)
        self._write()
        return number, new_assignment

    def mark_cutting_sequence_replied(self, external_packet_key: str) -> None:
        packet = self._state.setdefault("packets", {}).setdefault(external_packet_key, {})
        if not isinstance(packet, dict):
            packet = {}
            self._state["packets"][external_packet_key] = packet
        packet["cuttingSequenceReplied"] = True
        self._write()

    def source_unchanged(self, external_packet_key: str, source_fingerprint: str) -> bool:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        return (
            isinstance(packet, dict)
            and packet.get("sourceFingerprint") == source_fingerprint
            and isinstance(packet.get("payloadHash"), str)
        )

    def posted_packet_matches(
        self,
        external_packet_key: str,
        payload_hash: str,
        source_version: int,
        source_fingerprint: str | None,
    ) -> bool:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        if not isinstance(packet, dict):
            return False
        return (
            packet.get("payloadHash") == payload_hash
            and packet.get("sourceVersion") == source_version
            and packet.get("sourceFingerprint") == source_fingerprint
        )

    def mark_posted(
        self,
        external_packet_key: str,
        payload_hash: str,
        source_version: int,
        source_fingerprint: str | None = None,
    ) -> None:
        existing = self._state.setdefault("packets", {}).get(external_packet_key)
        packet = dict(existing) if isinstance(existing, dict) else {}
        packet.update({
            "payloadHash": payload_hash,
            "sourceFingerprint": source_fingerprint,
            "sourceVersion": source_version,
            "postedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        })
        self._state["packets"][external_packet_key] = packet
        self._write()

    def _next_cutting_sequence_number(self) -> int:
        sequence = self._state.setdefault("cuttingSequence", {})
        if not isinstance(sequence, dict):
            sequence = {}
            self._state["cuttingSequence"] = sequence
        value = sequence.get("nextNumber", 1)
        return int(value) if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 1

    def _advance_cutting_sequence(self, next_number: int) -> None:
        sequence = self._state.setdefault("cuttingSequence", {})
        if not isinstance(sequence, dict):
            sequence = {}
            self._state["cuttingSequence"] = sequence
        current = self._next_cutting_sequence_number()
        sequence["nextNumber"] = max(current, next_number)

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
