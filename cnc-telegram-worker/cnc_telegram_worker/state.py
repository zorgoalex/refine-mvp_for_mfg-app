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
        if (
            isinstance(packet, dict)
            and packet.get("payloadHash") == payload_hash
            and self._has_terminal_svg_cut_import_status(packet)
        ):
            return VersionDecision(source_version=int(packet.get("sourceVersion", 1)), changed=False)
        previous = 0
        if isinstance(packet, dict):
            previous = max(
                coerce_positive_int(packet.get("sourceVersion")),
                coerce_positive_int(packet.get("lastSkippedSourceVersion")),
            )
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
            and self._has_terminal_svg_cut_import_status(packet)
        )

    def posted_packet_matches(
        self,
        external_packet_key: str,
        payload_hash: str,
        source_version: int,
    ) -> bool:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        if not isinstance(packet, dict):
            return False
        return (
            packet.get("payloadHash") == payload_hash
            and packet.get("sourceVersion") == source_version
            and self._has_terminal_svg_cut_import_status(packet)
        )

    def mark_posted(
        self,
        external_packet_key: str,
        payload_hash: str,
        source_version: int,
        source_fingerprint: str | None = None,
        svg_cut_import_status: str | None = None,
        cut_job_id: int | None = None,
        source_file_sha: str | None = None,
    ) -> None:
        existing = self._state.setdefault("packets", {}).get(external_packet_key)
        packet = dict(existing) if isinstance(existing, dict) else {}
        posted_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if svg_cut_import_status == "skipped":
            packet.pop("payloadHash", None)
            packet.pop("sourceVersion", None)
            packet["sourceFingerprint"] = source_fingerprint
            packet["lastSkippedPayloadHash"] = payload_hash
            packet["lastSkippedSourceVersion"] = source_version
            packet["postedAt"] = posted_at
        else:
            packet.update({
                "payloadHash": payload_hash,
                "sourceFingerprint": source_fingerprint,
                "sourceVersion": source_version,
                "postedAt": posted_at,
            })
        if svg_cut_import_status in {"imported", "skipped", "needs_review", "none"}:
            packet["svgCutImportStatus"] = svg_cut_import_status
            if svg_cut_import_status == "skipped":
                packet.pop("cuttingSequenceNumber", None)
                packet.pop("cuttingSequenceReplied", None)
        if cut_job_id is not None and cut_job_id > 0:
            packet["cutJobId"] = cut_job_id
        if isinstance(source_file_sha, str) and source_file_sha:
            packet["sourceFileSha256"] = source_file_sha
        self._state["packets"][external_packet_key] = packet
        self._write()

    @staticmethod
    def _has_terminal_svg_cut_import_status(packet: dict[str, Any]) -> bool:
        return packet.get("svgCutImportStatus") == "imported"

    def imported_svg_cut_job_confirmed(self, external_packet_key: str) -> bool:
        packet = self._state.setdefault("packets", {}).get(external_packet_key)
        return isinstance(packet, dict) and self._has_terminal_svg_cut_import_status(packet)

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


def coerce_positive_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0
