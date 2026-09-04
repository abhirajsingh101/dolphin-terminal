"""Provider-neutral trusted workspace validation."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


class WorkspaceServiceError(Exception):
    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class WorkspacePathStatus:
    path: str | None
    path_exists: bool
    is_directory: bool
    is_allowed: bool
    message: str


def workspace_roots() -> list[Path]:
    raw_roots = os.getenv(
        "DOLPHIN_TERMINAL_WORKSPACE_ROOTS",
        os.getenv("DOLPHIN_WORKSPACE_ROOTS", ""),
    )
    return [
        Path(raw_root).expanduser().resolve()
        for raw_root in raw_roots.split(os.pathsep)
        if raw_root.strip()
    ]


def workspace_path_status(raw_path: str | None) -> WorkspacePathStatus:
    if not raw_path:
        return WorkspacePathStatus(
            path=None,
            path_exists=False,
            is_directory=False,
            is_allowed=False,
            message="No directory is linked to this project.",
        )

    resolved = Path(raw_path).expanduser().resolve()
    exists = resolved.exists()
    is_directory = resolved.is_dir()
    allowed = any(
        resolved == root or root in resolved.parents for root in workspace_roots()
    )

    if not exists:
        message = "The linked directory does not exist on this machine."
    elif not is_directory:
        message = "The linked path exists, but it is not a directory."
    elif not allowed:
        message = "The linked directory is outside the allowed workspace roots."
    else:
        message = "Workspace is ready."

    return WorkspacePathStatus(
        path=str(resolved),
        path_exists=exists,
        is_directory=is_directory,
        is_allowed=allowed,
        message=message,
    )


def require_workspace_path(raw_path: str | None) -> Path:
    status = workspace_path_status(raw_path)
    if not status.path:
        raise WorkspaceServiceError(status.message)
    if not status.path_exists or not status.is_directory:
        raise WorkspaceServiceError(status.message, 404)
    if not status.is_allowed:
        raise WorkspaceServiceError(status.message, 403)
    return Path(status.path)
