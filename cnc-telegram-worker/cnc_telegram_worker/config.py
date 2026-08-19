from __future__ import annotations

import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo


WORKER_ROLES = {"disabled", "reader", "writer"}
SVG_VALIDATION_MODES = {"strict", "lenient"}


@dataclass(frozen=True)
class WorkerConfig:
    stack_env: str
    worker_role: str
    allow_non_prod_writer: bool
    manual_svg_send_enabled: bool
    telegram_api_id: int | None
    telegram_api_hash: str
    telegram_session_path: Path
    telegram_chat: str
    telegram_allowed_chat_ids: tuple[str, ...]
    erp_api_url: str
    erp_bearer_token: str
    erp_worker_login: str
    erp_worker_password: str
    enable_glm_ocr: bool
    ocr_command: str
    ocr_command_timeout_seconds: int
    glm_ocr_client_timeout_seconds: int
    ocr_engine: str
    parser_version: str
    svg_validation_mode: str
    default_machine: str
    default_material: str
    business_timezone_name: str
    history_days: int
    poll_interval_seconds: int
    manual_svg_send_poll_interval_seconds: int
    temp_ttl_hours: int
    attachment_ttl_hours: int
    max_messages_per_scan: int
    temp_dir: Path
    media_dir: Path
    state_path: Path
    audit_spool_path: Path
    audit_allow_unsafe_path: bool
    technical_log_spool_path: Path
    technical_log_flush_interval_seconds: int
    technical_log_heartbeat_seconds: int
    resend_unchanged: bool
    backfill_on_start: bool
    worker_instance_id: str
    worker_image_revision: str
    session_lease_ttl_seconds: int
    session_lease_heartbeat_seconds: int
    media_restore_poll_interval_seconds: int
    manual_import_enabled: bool = False

    @property
    def business_timezone(self) -> ZoneInfo:
        return ZoneInfo(self.business_timezone_name)

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        api_id_raw = env("TELEGRAM_API_ID")
        worker_role = normalized_env("CNC_TELEGRAM_WORKER_ROLE", "disabled")
        if worker_role not in WORKER_ROLES:
            raise RuntimeError(
                f"CNC_TELEGRAM_WORKER_ROLE must be one of: {', '.join(sorted(WORKER_ROLES))}",
            )
        return cls(
            stack_env=normalized_env("ERP_STACK_ENV", "test"),
            worker_role=worker_role,
            allow_non_prod_writer=bool_env("CNC_TELEGRAM_ALLOW_NON_PROD_WRITER", False),
            manual_svg_send_enabled=bool_env("CNC_TELEGRAM_ENABLE_MANUAL_UPLOAD_SENDS", False),
            telegram_api_id=int(api_id_raw) if api_id_raw else None,
            telegram_api_hash=env("TELEGRAM_API_HASH"),
            telegram_session_path=Path(env("TELEGRAM_SESSION_PATH", "/data/session/cnc_telegram")),
            telegram_chat=env("TELEGRAM_CHAT") or env("TELEGRAM_ALLOWED_CHAT_ID"),
            telegram_allowed_chat_ids=csv_env("TELEGRAM_ALLOWED_CHAT_ID"),
            erp_api_url=env("ERP_API_URL", "http://backend:3000/api/v1").rstrip("/"),
            erp_bearer_token=env("ERP_BEARER_TOKEN"),
            erp_worker_login=env("ERP_WORKER_LOGIN"),
            erp_worker_password=env("ERP_WORKER_PASSWORD"),
            enable_glm_ocr=bool_env("CNC_ENABLE_GLM_OCR", False),
            ocr_command=env("CNC_OCR_COMMAND"),
            ocr_command_timeout_seconds=positive_int_env("CNC_OCR_COMMAND_TIMEOUT_SECONDS", 180),
            glm_ocr_client_timeout_seconds=positive_int_env("GLM_OCR_CLIENT_TIMEOUT_SECONDS", 660),
            ocr_engine=env("CNC_OCR_ENGINE", "rapidocr-ppocrv5-eslav"),
            parser_version=env("CNC_PARSER_VERSION", "cnc-telegram-worker-v15-lenient-svg"),
            svg_validation_mode=validated_env("CNC_SVG_VALIDATION_MODE", "lenient", SVG_VALIDATION_MODES),
            default_machine=env("CNC_MACHINE_DEFAULT"),
            default_material=env("CNC_DEFAULT_MATERIAL", "МДФ 16мм"),
            business_timezone_name=env("CNC_BUSINESS_TIMEZONE", "Asia/Almaty"),
            history_days=positive_int_env("CNC_HISTORY_DAYS", 7),
            poll_interval_seconds=positive_int_env("CNC_POLL_INTERVAL_SECONDS", 60),
            manual_svg_send_poll_interval_seconds=positive_int_env("CNC_MANUAL_SVG_SEND_POLL_INTERVAL_SECONDS", 5),
            temp_ttl_hours=positive_int_env("CNC_TEMP_TTL_HOURS", 24),
            attachment_ttl_hours=positive_int_env("CNC_ATTACHMENT_TTL_HOURS", 24 * 30),
            max_messages_per_scan=positive_int_env("CNC_MAX_MESSAGES_PER_SCAN", 1000),
            temp_dir=Path(env("CNC_TEMP_DIR", "/data/tmp")),
            media_dir=Path(env("CNC_MEDIA_DIR", "/data/cnc-telegram-media")),
            state_path=Path(env("CNC_STATE_PATH", "/data/state.json")),
            audit_spool_path=Path(env("CNC_AUDIT_SPOOL_PATH", "/data/cnc-telegram-audit.sqlite3")),
            audit_allow_unsafe_path=bool_env("CNC_AUDIT_ALLOW_UNSAFE_PATH", False),
            technical_log_spool_path=Path(env("CNC_TECHNICAL_LOG_SPOOL_PATH", "/data/technical-logs/spool.sqlite3")),
            technical_log_flush_interval_seconds=positive_int_env("CNC_TECHNICAL_LOG_FLUSH_INTERVAL_SECONDS", 5),
            technical_log_heartbeat_seconds=positive_int_env("CNC_TECHNICAL_LOG_HEARTBEAT_SECONDS", 30),
            resend_unchanged=bool_env("CNC_RESEND_UNCHANGED", False),
            backfill_on_start=bool_env("CNC_BACKFILL_ON_START", True),
            worker_instance_id=worker_instance_id_env(),
            worker_image_revision=env("CNC_TELEGRAM_WORKER_IMAGE_REVISION", ""),
            session_lease_ttl_seconds=positive_int_env("CNC_TELEGRAM_SESSION_LEASE_TTL_SECONDS", 90),
            session_lease_heartbeat_seconds=positive_int_env("CNC_TELEGRAM_SESSION_HEARTBEAT_SECONDS", 10),
            media_restore_poll_interval_seconds=positive_int_env("CNC_MEDIA_RESTORE_POLL_INTERVAL_SECONDS", 15),
            manual_import_enabled=bool_env("CNC_TELEGRAM_MANUAL_IMPORT_ENABLED", False),
        )

    @property
    def enabled(self) -> bool:
        return self.worker_role in {"reader", "writer"}

    @property
    def can_write_chat(self) -> bool:
        return self.worker_role == "writer"

    @property
    def can_send_manual_svg_uploads(self) -> bool:
        return self.can_write_chat or self.manual_svg_send_enabled

    def require_worker_enabled(self) -> None:
        if not self.enabled:
            raise RuntimeError(
                f"CNC Telegram worker is disabled (ERP_STACK_ENV={self.stack_env}, "
                f"CNC_TELEGRAM_WORKER_ROLE={self.worker_role})",
            )
        if self.can_write_chat and self.stack_env != "prod" and not self.allow_non_prod_writer:
            raise RuntimeError(
                "CNC Telegram writer is allowed only with ERP_STACK_ENV=prod; "
                "set CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=true only for a deliberate one-off run",
            )
        if re.fullmatch(r"[0-9a-f]{7,64}", self.worker_image_revision) is None:
            raise RuntimeError(
                "CNC_TELEGRAM_WORKER_IMAGE_REVISION must be an immutable git revision",
            )
        if self.enable_glm_ocr:
            if "cnc_telegram_worker.glm_ocr_client" not in self.ocr_command:
                raise RuntimeError(
                    "CNC_ENABLE_GLM_OCR=true requires CNC_OCR_COMMAND to use "
                    "cnc_telegram_worker.glm_ocr_client",
                )
            if not self.ocr_engine.startswith("glm-ocr"):
                raise RuntimeError("CNC_ENABLE_GLM_OCR=true requires CNC_OCR_ENGINE=glm-ocr*")
            if self.ocr_command_timeout_seconds <= self.glm_ocr_client_timeout_seconds:
                raise RuntimeError(
                    "CNC_OCR_COMMAND_TIMEOUT_SECONDS must exceed GLM_OCR_CLIENT_TIMEOUT_SECONDS",
                )

    def require_telegram(self) -> None:
        missing = []
        if self.telegram_api_id is None:
            missing.append("TELEGRAM_API_ID")
        if not self.telegram_api_hash:
            missing.append("TELEGRAM_API_HASH")
        if not self.telegram_chat:
            missing.append("TELEGRAM_CHAT or TELEGRAM_ALLOWED_CHAT_ID")
        if not self.telegram_allowed_chat_ids:
            missing.append("TELEGRAM_ALLOWED_CHAT_ID")
        if missing:
            raise RuntimeError(f"missing required Telegram config: {', '.join(missing)}")

    def require_backend_auth(self) -> None:
        if self.erp_bearer_token:
            return
        if self.erp_worker_login and self.erp_worker_password:
            return
        raise RuntimeError("missing backend auth: set ERP_BEARER_TOKEN or ERP_WORKER_LOGIN/ERP_WORKER_PASSWORD")

    def require_session_lease_timing(self) -> None:
        if self.session_lease_heartbeat_seconds >= self.session_lease_ttl_seconds:
            raise RuntimeError(
                "CNC_TELEGRAM_SESSION_HEARTBEAT_SECONDS must be less than "
                "CNC_TELEGRAM_SESSION_LEASE_TTL_SECONDS",
            )


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def normalized_env(name: str, default: str = "") -> str:
    return env(name, default).lower()


def validated_env(name: str, default: str, allowed: set[str]) -> str:
    value = normalized_env(name, default)
    if value not in allowed:
        raise RuntimeError(f"{name} must be one of: {', '.join(sorted(allowed))}")
    return value


def csv_env(name: str) -> tuple[str, ...]:
    value = env(name)
    return tuple(part.strip() for part in value.split(",") if part.strip())


def positive_int_env(name: str, default: int) -> int:
    value = env(name)
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise RuntimeError(f"{name} must be positive")
    return parsed


def bool_env(name: str, default: bool) -> bool:
    value = env(name)
    if not value:
        return default
    return value.lower() in {"1", "true", "yes", "y", "on"}


def worker_instance_id_env() -> str:
    value = env("CNC_TELEGRAM_WORKER_INSTANCE_ID") or str(uuid.uuid4())
    try:
        uuid.UUID(value)
    except ValueError as exc:
        raise RuntimeError("CNC_TELEGRAM_WORKER_INSTANCE_ID must be a UUID") from exc
    return value


def ensure_worker_instance_id() -> str:
    """Establish one process-wide identity before logs and worker config start."""
    value = os.environ.get("CNC_TELEGRAM_WORKER_INSTANCE_ID", "").strip()
    if not value:
        value = str(uuid.uuid4())
        os.environ["CNC_TELEGRAM_WORKER_INSTANCE_ID"] = value
    try:
        uuid.UUID(value)
    except ValueError as exc:
        raise RuntimeError("CNC_TELEGRAM_WORKER_INSTANCE_ID must be a UUID") from exc
    return value
