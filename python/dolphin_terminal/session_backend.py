"""Replaceable persistent-session backend contract.

The public gateway speaks in workspaces and sessions. The built-in native PTY
daemon is the standalone default; tmux remains a compatibility backend for
existing Dolphin sessions. Neither the HTTP API nor React knows which provider
owns process lifetime.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import sys
from typing import Protocol, runtime_checkable

from . import native_runtime
from . import tmux_service


class SessionBackendError(Exception):
    """Provider-neutral error that can be mapped to the public HTTP API."""

    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class SessionInfo:
    name: str
    path: str
    created_at: datetime
    windows: int
    attached: bool
    current_command: str | None
    is_codex_running: bool
    is_claude_code_running: bool = False
    has_recent_activity: bool = False


@dataclass(frozen=True)
class SessionSnapshot:
    session_name: str
    content: str
    captured_at: datetime


@dataclass(frozen=True)
class SessionBackendHealth:
    id: str
    available: bool
    detail: str
    executable: str | None = None


@runtime_checkable
class SessionBackend(Protocol):
    """Operations required by the provider-neutral terminal gateway."""

    id: str

    def health(self) -> SessionBackendHealth: ...

    def attach_command(self, session_name: str) -> tuple[str, ...]: ...

    async def list_workspace_sessions(
        self, workspace_path: Path
    ) -> list[SessionInfo]: ...

    async def create_session(
        self,
        workspace_path: Path,
        workspace_name: str,
        *,
        requested_name: str | None,
        mode: str,
    ) -> SessionInfo: ...

    async def rename_session(
        self,
        workspace_path: Path,
        workspace_name: str,
        session_name: str,
        requested_name: str,
    ) -> SessionInfo: ...

    async def kill_session(self, workspace_path: Path, session_name: str) -> None: ...

    async def capture_session(
        self, workspace_path: Path, session_name: str, lines: int
    ) -> SessionSnapshot: ...

    async def require_workspace_session(
        self, workspace_path: Path, session_name: str
    ) -> SessionInfo: ...

    async def pane_current_paths(self, session_name: str) -> list[Path]: ...


class TmuxSessionBackend:
    """Compatibility backend for durable, detachable tmux sessions."""

    id = "tmux"

    def health(self) -> SessionBackendHealth:
        try:
            executable = tmux_service.tmux_binary()
        except tmux_service.TmuxServiceError as error:
            return SessionBackendHealth(
                id=self.id,
                available=False,
                detail=error.detail,
            )
        return SessionBackendHealth(
            id=self.id,
            available=True,
            detail="Persistent session backend is ready.",
            executable=executable,
        )

    def attach_command(self, session_name: str) -> tuple[str, ...]:
        return (
            tmux_service.tmux_binary(),
            "attach-session",
            "-t",
            session_name,
        )

    async def list_workspace_sessions(self, workspace_path: Path) -> list[SessionInfo]:
        try:
            sessions = await tmux_service.list_workspace_sessions(workspace_path)
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error
        return [_session_info(session) for session in sessions]

    async def create_session(
        self,
        workspace_path: Path,
        workspace_name: str,
        *,
        requested_name: str | None,
        mode: str,
    ) -> SessionInfo:
        try:
            session = await tmux_service.create_session(
                workspace_path,
                workspace_name,
                requested_name=requested_name,
                mode=mode,
            )
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error
        return _session_info(session)

    async def rename_session(
        self,
        workspace_path: Path,
        workspace_name: str,
        session_name: str,
        requested_name: str,
    ) -> SessionInfo:
        try:
            session = await tmux_service.rename_session(
                workspace_path,
                workspace_name,
                session_name,
                requested_name,
            )
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error
        return _session_info(session)

    async def kill_session(self, workspace_path: Path, session_name: str) -> None:
        try:
            await tmux_service.kill_session(workspace_path, session_name)
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error

    async def capture_session(
        self, workspace_path: Path, session_name: str, lines: int
    ) -> SessionSnapshot:
        try:
            snapshot = await tmux_service.capture_session(
                workspace_path, session_name, lines
            )
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error
        return SessionSnapshot(
            session_name=snapshot.session_name,
            content=snapshot.content,
            captured_at=snapshot.captured_at,
        )

    async def require_workspace_session(
        self, workspace_path: Path, session_name: str
    ) -> SessionInfo:
        try:
            session = await tmux_service.require_workspace_session(
                workspace_path, session_name
            )
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error
        return _session_info(session)

    async def pane_current_paths(self, session_name: str) -> list[Path]:
        try:
            return await tmux_service.pane_current_paths(session_name)
        except tmux_service.TmuxServiceError as error:
            raise _tmux_error(error) from error


class NativeSessionBackend:
    """Built-in persistent PTY backend with no tmux or LLM dependency."""

    id = "native"

    def __init__(
        self,
        *,
        socket_path: Path | None = None,
        state_dir: Path | None = None,
    ):
        self._socket_path = socket_path
        self._state_dir = state_dir

    def _ready_socket(self) -> Path:
        try:
            resolved = native_runtime.ensure_daemon(
                socket_path=self._socket_path,
                state_dir=self._state_dir,
            )
        except native_runtime.NativeRuntimeError as error:
            raise SessionBackendError(error.detail, error.status_code) from error
        self._socket_path = resolved
        return resolved

    def _request(self, payload: dict[str, object]) -> dict[str, object]:
        socket_path = self._ready_socket()
        try:
            return native_runtime.request(payload, socket_path=socket_path)
        except native_runtime.NativeRuntimeError as error:
            raise SessionBackendError(error.detail, error.status_code) from error

    async def _request_async(self, payload: dict[str, object]) -> dict[str, object]:
        import asyncio

        return await asyncio.to_thread(self._request, payload)

    def health(self) -> SessionBackendHealth:
        try:
            self._ready_socket()
        except SessionBackendError as error:
            return SessionBackendHealth(
                id=self.id,
                available=False,
                detail=error.detail,
            )
        return SessionBackendHealth(
            id=self.id,
            available=True,
            detail="Built-in persistent PTY backend is ready.",
            executable=sys.executable,
        )

    def attach_command(self, session_name: str) -> tuple[str, ...]:
        socket_path = self._ready_socket()
        return (
            sys.executable,
            "-m",
            "dolphin_terminal.native_attach",
            "--socket",
            str(socket_path),
            "--session",
            session_name,
        )

    async def list_workspace_sessions(self, workspace_path: Path) -> list[SessionInfo]:
        result = await self._request_async(
            {"op": "list", "workspace_path": str(workspace_path.resolve())}
        )
        sessions = result.get("sessions")
        if not isinstance(sessions, list):
            raise SessionBackendError("The native session inventory is invalid.")
        return [_native_session_info(item) for item in sessions]

    async def create_session(
        self,
        workspace_path: Path,
        workspace_name: str,
        *,
        requested_name: str | None,
        mode: str,
    ) -> SessionInfo:
        result = await self._request_async(
            {
                "op": "create",
                "workspace_path": str(workspace_path.resolve()),
                "workspace_name": workspace_name,
                "requested_name": requested_name,
                "mode": mode,
            }
        )
        return _native_session_info(result.get("session"))

    async def rename_session(
        self,
        workspace_path: Path,
        workspace_name: str,
        session_name: str,
        requested_name: str,
    ) -> SessionInfo:
        result = await self._request_async(
            {
                "op": "rename",
                "workspace_path": str(workspace_path.resolve()),
                "workspace_name": workspace_name,
                "session_name": session_name,
                "requested_name": requested_name,
            }
        )
        return _native_session_info(result.get("session"))

    async def kill_session(self, workspace_path: Path, session_name: str) -> None:
        await self._request_async(
            {
                "op": "kill",
                "workspace_path": str(workspace_path.resolve()),
                "session_name": session_name,
            }
        )

    async def capture_session(
        self, workspace_path: Path, session_name: str, lines: int
    ) -> SessionSnapshot:
        result = await self._request_async(
            {
                "op": "capture",
                "workspace_path": str(workspace_path.resolve()),
                "session_name": session_name,
                "lines": lines,
            }
        )
        try:
            captured_at = datetime.fromisoformat(str(result["captured_at"]))
            content = str(result["content"])
            captured_name = str(result["session_name"])
        except (KeyError, TypeError, ValueError) as error:
            raise SessionBackendError(
                "The native session snapshot is invalid."
            ) from error
        return SessionSnapshot(
            session_name=captured_name,
            content=content,
            captured_at=captured_at,
        )

    async def require_workspace_session(
        self, workspace_path: Path, session_name: str
    ) -> SessionInfo:
        result = await self._request_async(
            {
                "op": "require",
                "workspace_path": str(workspace_path.resolve()),
                "session_name": session_name,
            }
        )
        return _native_session_info(result.get("session"))

    async def pane_current_paths(self, session_name: str) -> list[Path]:
        result = await self._request_async(
            {"op": "paths", "session_name": session_name}
        )
        paths = result.get("paths")
        if not isinstance(paths, list):
            raise SessionBackendError("The native session path response is invalid.")
        resolved: list[Path] = []
        for path in paths:
            try:
                resolved.append(Path(str(path)).expanduser().resolve())
            except (OSError, RuntimeError, ValueError):
                continue
        return resolved


def _tmux_error(error: tmux_service.TmuxServiceError) -> SessionBackendError:
    return SessionBackendError(error.detail, error.status_code)


def _session_info(session: tmux_service.TmuxSessionInfo) -> SessionInfo:
    return SessionInfo(
        name=session.name,
        path=session.path,
        created_at=session.created_at,
        windows=session.windows,
        attached=session.attached,
        current_command=session.current_command,
        is_codex_running=session.is_codex_running,
        is_claude_code_running=session.is_claude_code_running,
        has_recent_activity=session.has_recent_activity,
    )


def _native_session_info(value: object) -> SessionInfo:
    if not isinstance(value, dict):
        raise SessionBackendError("The native session response is invalid.")
    try:
        return SessionInfo(
            name=str(value["name"]),
            path=str(value["path"]),
            created_at=datetime.fromisoformat(str(value["created_at"])),
            windows=int(value.get("windows", 1)),
            attached=bool(value.get("attached", False)),
            current_command=(
                str(value["current_command"])
                if value.get("current_command") is not None
                else None
            ),
            is_codex_running=bool(value.get("is_codex_running", False)),
            is_claude_code_running=bool(value.get("is_claude_code_running", False)),
            has_recent_activity=bool(value.get("has_recent_activity", False)),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise SessionBackendError("The native session response is invalid.") from error


def create_session_backend(backend_id: str) -> SessionBackend:
    normalized = backend_id.strip().lower()
    if normalized == "native":
        return NativeSessionBackend()
    if normalized == "tmux":
        return TmuxSessionBackend()
    raise ValueError(
        f"Unsupported session backend {backend_id!r}. Installed backends: native, tmux."
    )
