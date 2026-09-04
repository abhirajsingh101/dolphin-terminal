"""Trusted server-side workspace and origin configuration."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Iterable


_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class ConfigurationError(ValueError):
    """Raised when the trusted workspace allowlist is malformed."""


def environment_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off", ""}:
        return False
    raise ConfigurationError(
        f"{name} must be one of: 1, 0, true, false, yes, no, on, off."
    )


@dataclass(frozen=True)
class Workspace:
    id: str
    name: str
    path: Path
    emoji: str = "⌁"

    def descriptor(self) -> dict[str, str]:
        return {
            "id": self.id,
            "name": self.name,
            "emoji": self.emoji,
            "path": str(self.path),
        }


def _slug(value: str) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-.").lower()
    if candidate and _SAFE_ID.fullmatch(candidate):
        return candidate[:128]
    return f"workspace-{hashlib.sha256(value.encode()).hexdigest()[:12]}"


def _workspace_from_path(
    raw_path: str, *, workspace_id: str | None = None
) -> Workspace:
    path = Path(raw_path).expanduser().resolve()
    name = path.name or str(path)
    return Workspace(id=workspace_id or _slug(name), name=name, path=path)


def _workspace_from_mapping(raw: dict[str, Any]) -> Workspace:
    raw_path = raw.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ConfigurationError("Every workspace object needs a non-empty path.")
    path = Path(raw_path).expanduser().resolve()
    workspace_id = str(raw.get("id") or _slug(path.name or str(path)))
    if not _SAFE_ID.fullmatch(workspace_id):
        raise ConfigurationError(f"Invalid workspace id: {workspace_id!r}")
    name = str(raw.get("name") or path.name or path)
    emoji = str(raw.get("emoji") or "⌁")
    return Workspace(id=workspace_id, name=name, path=path, emoji=emoji)


def parse_workspaces(raw: str) -> tuple[Workspace, ...]:
    if not raw.strip():
        return ()
    entries: Iterable[Any]
    if raw.lstrip().startswith("["):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ConfigurationError(
                "DOLPHIN_TERMINAL_WORKSPACES is invalid JSON."
            ) from error
        if not isinstance(parsed, list):
            raise ConfigurationError("DOLPHIN_TERMINAL_WORKSPACES JSON must be a list.")
        entries = parsed
    else:
        entries = raw.split(os.pathsep)

    workspaces: list[Workspace] = []
    for entry in entries:
        if isinstance(entry, dict):
            workspace = _workspace_from_mapping(entry)
        elif isinstance(entry, str) and entry.strip():
            value = entry.strip()
            prefix, separator, suffix = value.partition("=")
            if separator and suffix.startswith(("/", "~")):
                if not _SAFE_ID.fullmatch(prefix):
                    raise ConfigurationError(f"Invalid workspace id: {prefix!r}")
                workspace = _workspace_from_path(suffix, workspace_id=prefix)
            else:
                workspace = _workspace_from_path(value)
        else:
            raise ConfigurationError("Workspace entries must be paths or objects.")
        workspaces.append(workspace)

    ids = [workspace.id for workspace in workspaces]
    if len(ids) != len(set(ids)):
        raise ConfigurationError("Workspace ids must be unique.")
    return tuple(workspaces)


@dataclass(frozen=True)
class Settings:
    workspaces: tuple[Workspace, ...]
    allowed_origins: tuple[str, ...]
    host: str = "127.0.0.1"
    port: int = 8733
    session_backend: str = "native"
    dictation_enabled: bool = False
    static_dir: Path | None = None

    @classmethod
    def from_environment(cls) -> "Settings":
        workspaces = parse_workspaces(os.getenv("DOLPHIN_TERMINAL_WORKSPACES", ""))
        host = os.getenv("DOLPHIN_TERMINAL_HOST", "127.0.0.1")
        port = int(os.getenv("DOLPHIN_TERMINAL_PORT", "8733"))
        raw_origins = os.getenv(
            "DOLPHIN_TERMINAL_ALLOWED_ORIGINS",
            (
                f"http://127.0.0.1:{port},http://localhost:{port},"
                "http://127.0.0.1:8734,http://localhost:8734"
            ),
        )
        origins = tuple(
            item.strip().rstrip("/") for item in raw_origins.split(",") if item.strip()
        )
        static_dir = cls.discover_static_dir()
        settings = cls(
            workspaces=workspaces,
            allowed_origins=origins,
            host=host,
            port=port,
            session_backend=os.getenv("DOLPHIN_TERMINAL_SESSION_BACKEND", "native"),
            dictation_enabled=environment_flag("DOLPHIN_TERMINAL_ENABLE_DICTATION"),
            static_dir=static_dir,
        )
        settings.apply_workspace_roots()
        return settings

    @staticmethod
    def discover_static_dir() -> Path | None:
        configured = os.getenv("DOLPHIN_TERMINAL_STATIC_DIR")
        candidates = []
        if configured:
            candidates.append(Path(configured).expanduser())
        package_dir = Path(__file__).resolve().parent
        candidates.extend(
            (
                package_dir / "static",
                package_dir.parents[1] / "apps" / "standalone" / "dist",
            )
        )
        for candidate in candidates:
            resolved = candidate.resolve()
            if (resolved / "index.html").is_file():
                return resolved
        if configured:
            raise ConfigurationError(
                "DOLPHIN_TERMINAL_STATIC_DIR does not contain index.html."
            )
        return None

    def apply_workspace_roots(self) -> None:
        os.environ["DOLPHIN_TERMINAL_WORKSPACE_ROOTS"] = os.pathsep.join(
            str(workspace.path) for workspace in self.workspaces
        )

    def workspace(self, workspace_id: str) -> Workspace:
        for workspace in self.workspaces:
            if workspace.id == workspace_id:
                return workspace
        raise KeyError(workspace_id)
