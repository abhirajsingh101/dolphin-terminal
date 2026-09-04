"""FastAPI gateway for trusted, explicitly configured terminal workspaces."""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import signal
import struct
import termios
import tty
from typing import Any
from urllib.parse import quote, unquote_to_bytes

from fastapi import (
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, Workspace
from .dictation_service import (
    MAX_AUDIO_BYTES,
    DictationServiceError,
    dictation_status,
    transcribe_audio,
)
from .schemas import (
    AutomationUpdate,
    BriefContent,
    PathResolveRequest,
    SessionCreate,
    SessionRename,
    SessionResponse,
    WorkspaceResponse,
)
from .session_backend import (
    SessionBackend,
    SessionBackendError,
    create_session_backend,
)
from .terminal_attachment_service import (
    TerminalAttachmentError,
    store_terminal_attachment_stream,
    terminal_attachment_settings,
)
from .terminal_path_service import resolve_download_target, resolve_terminal_paths
from .workspace_service import (
    WorkspaceServiceError,
    require_workspace_path,
    workspace_path_status,
)
from .workspace_file_service import (
    WorkspaceFileError,
    iter_file_bytes,
    open_workspace_file,
)


_MAX_COALESCED_OUTPUT_BYTES = 256 * 1024


def _http_backend(error: SessionBackendError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail)


def _session_response(session: Any) -> SessionResponse:
    return SessionResponse(
        name=session.name,
        path=session.path,
        created_at=session.created_at,
        windows=session.windows,
        attached=session.attached,
        current_command=session.current_command,
        is_codex_running=session.is_codex_running,
        is_claude_code_running=session.is_claude_code_running,
        has_recent_activity=session.has_recent_activity,
        rename_allowed=True,
        rename_block_reason=None,
    )


def _settings(container: FastAPI | Request | WebSocket) -> Settings:
    app = container if isinstance(container, FastAPI) else container.app
    return app.state.terminal_settings


def _backend(container: FastAPI | Request | WebSocket) -> SessionBackend:
    app = container if isinstance(container, FastAPI) else container.app
    return app.state.session_backend


def _workspace(
    container: FastAPI | Request | WebSocket, workspace_id: str
) -> Workspace:
    try:
        return _settings(container).workspace(workspace_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Workspace not found.") from error


def _trusted_workspace_path(workspace: Workspace) -> Path:
    try:
        return require_workspace_path(str(workspace.path))
    except WorkspaceServiceError as error:
        raise HTTPException(
            status_code=error.status_code, detail=error.detail
        ) from error


async def _require_workspace_session(
    request: Request, workspace_id: str, session_name: str
) -> Workspace:
    """Resolve both sides of a provider request before returning any state."""
    workspace = _workspace(request, workspace_id)
    try:
        await _backend(request).require_workspace_session(
            _trusted_workspace_path(workspace), session_name
        )
    except SessionBackendError as error:
        raise _http_backend(error) from error
    return workspace


def _resize_pty(fd: int, cols: int, rows: int) -> None:
    bounded_cols = max(20, min(int(cols or 120), 300))
    bounded_rows = max(8, min(int(rows or 36), 120))
    packed = struct.pack("HHHH", bounded_rows, bounded_cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


async def write_all_to_pty(fd: int, data: bytes) -> None:
    """Write a complete websocket input frame without truncating large pastes."""
    view = memoryview(data)
    loop = asyncio.get_running_loop()
    while view:
        try:
            written = os.write(fd, view)
        except BlockingIOError:
            written = 0
        except OSError:
            return
        if written:
            view = view[written:]
            continue
        writable = loop.create_future()

        def on_writable() -> None:
            if not writable.done():
                writable.set_result(None)

        try:
            loop.add_writer(fd, on_writable)
        except (OSError, ValueError):
            return
        try:
            await writable
        finally:
            with contextlib.suppress(OSError, ValueError):
                loop.remove_writer(fd)


def coalesce_pty_output(queue: "asyncio.Queue[bytes | None]", first: bytes) -> bytes:
    chunks = [first]
    total = len(first)
    while total < _MAX_COALESCED_OUTPUT_BYTES:
        try:
            following = queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if following is None:
            queue.put_nowait(None)
            break
        chunks.append(following)
        total += len(following)
    return b"".join(chunks)


async def stream_session_attach(
    websocket: WebSocket, attach_command: tuple[str, ...]
) -> None:
    """Attach one browser client without owning the persistent session lifetime."""
    master_fd, slave_fd = pty.openpty()
    current_pty_size = (120, 36)
    _resize_pty(master_fd, *current_pty_size)
    # Put the attachment side in raw mode before the WebSocket can become
    # writable. This closes a short startup race where the kernel line
    # discipline could echo the user's first keystrokes before the attach
    # client (native or tmux) had configured its TTY.
    tty.setraw(slave_fd)
    environment = os.environ.copy()
    environment["TERM"] = "xterm-256color"
    process = await asyncio.create_subprocess_exec(
        *attach_command,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=environment,
        start_new_session=True,
    )
    os.close(slave_fd)
    os.set_blocking(master_fd, False)
    loop = asyncio.get_running_loop()
    output_queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def on_pty_readable() -> None:
        try:
            data = os.read(master_fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if data:
            output_queue.put_nowait(data)
            return
        with contextlib.suppress(ValueError):
            loop.remove_reader(master_fd)
        output_queue.put_nowait(None)

    loop.add_reader(master_fd, on_pty_readable)

    async def pty_to_websocket() -> None:
        while True:
            data = await output_queue.get()
            if data is None:
                return
            try:
                await websocket.send_bytes(coalesce_pty_output(output_queue, data))
            except (RuntimeError, WebSocketDisconnect):
                return

    async def websocket_to_pty() -> None:
        nonlocal current_pty_size
        while True:
            try:
                message = await websocket.receive()
            except (RuntimeError, WebSocketDisconnect):
                return
            if message["type"] == "websocket.disconnect":
                return
            if message.get("bytes") is not None:
                await write_all_to_pty(master_fd, message["bytes"])
                continue
            text = message.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            if payload.get("type") == "input":
                data = str(payload.get("data", ""))
                if data:
                    await write_all_to_pty(master_fd, data.encode())
            elif payload.get("type") == "resize":
                cols = max(20, min(int(payload.get("cols") or 120), 300))
                rows = max(8, min(int(payload.get("rows") or 36), 120))
                if (cols, rows) == current_pty_size:
                    continue
                current_pty_size = (cols, rows)
                _resize_pty(master_fd, cols, rows)
                with contextlib.suppress(ProcessLookupError):
                    process.send_signal(signal.SIGWINCH)

    tasks = {
        asyncio.create_task(pty_to_websocket()),
        asyncio.create_task(websocket_to_pty()),
        asyncio.create_task(process.wait()),
    }
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        for task in pending:
            task.cancel()
    finally:
        with contextlib.suppress(ValueError):
            loop.remove_reader(master_fd)
        with contextlib.suppress(ValueError):
            loop.remove_writer(master_fd)
        for task in tasks:
            task.cancel()
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        with contextlib.suppress(OSError):
            os.close(master_fd)


def _automation_response(workspace_id: str, session_name: str) -> dict[str, Any]:
    return {
        "project_id": workspace_id,
        "session_name": session_name,
        "mode": "off",
        "state": "idle",
        "available": False,
        "availability_message": "No automation provider is configured for this gateway.",
        "provider": None,
        "goal": "",
        "max_turns": 8,
        "max_minutes": 30,
        "max_failures": 3,
        "send_delay_seconds": 5,
        "turns_used": 0,
        "no_progress_count": 0,
        "pending_send_at": None,
        "last_decision": None,
        "last_reason": None,
        "last_error": None,
        "last_learning_error": None,
        "warning": None,
        "updated_at": None,
    }


def create_app(
    settings: Settings | None = None,
    session_backend: SessionBackend | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    resolved_settings.apply_workspace_roots()
    resolved_backend = session_backend or create_session_backend(
        resolved_settings.session_backend
    )
    application = FastAPI(
        title="Dolphin Terminal Gateway",
        version="0.3.0",
        docs_url="/terminal/docs",
        openapi_url="/terminal/openapi.json",
    )
    application.state.terminal_settings = resolved_settings
    application.state.session_backend = resolved_backend
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Content-Type",
            "X-Audio-Filename",
            "X-Dictation-Language",
            "X-Dictation-Mode",
            "X-Dolphin-Attachment-Upload",
            "X-Dolphin-Attachment-Name",
        ],
    )

    @application.get("/health")
    async def health() -> dict[str, Any]:
        backend_health = resolved_backend.health()
        return {
            "status": "ok" if backend_health.available else "degraded",
            "service": "dolphin-terminal",
            "workspace_count": len(resolved_settings.workspaces),
            "session_backend": backend_health.id,
            "session_backend_available": backend_health.available,
            "ui_available": resolved_settings.static_dir is not None,
        }

    @application.get("/terminal/v1/capabilities")
    async def capabilities() -> dict[str, Any]:
        backend_health = resolved_backend.health()
        return {
            "session_backend": {
                "id": backend_health.id,
                "available": backend_health.available,
                "detail": backend_health.detail,
            },
            "dictation": {"enabled": resolved_settings.dictation_enabled},
            # The reference distribution deliberately ships without an agent
            # runner. Embedders can provide one through the React runtime.
            "automation": {"enabled": False},
        }

    @application.get("/terminal/v1/workspaces")
    async def list_workspaces() -> list[dict[str, str]]:
        return [workspace.descriptor() for workspace in resolved_settings.workspaces]

    @application.get("/terminal/v1/dictation/status")
    async def get_dictation_status() -> dict[str, Any]:
        if not resolved_settings.dictation_enabled:
            return {
                "available": False,
                "ready": False,
                "status": "disabled",
                "detail": "Voice input is an optional capability and is not enabled.",
            }
        return await dictation_status()

    @application.post("/terminal/v1/dictation/transcribe")
    async def transcribe_dictation(request: Request) -> dict[str, Any]:
        if not resolved_settings.dictation_enabled:
            raise HTTPException(
                status_code=404,
                detail="Voice input is not enabled for this Dolphin Terminal instance.",
            )
        content_length_header = request.headers.get("content-length")
        if content_length_header:
            try:
                content_length = int(content_length_header)
            except ValueError as error:
                raise HTTPException(
                    status_code=400, detail="Invalid dictation Content-Length header."
                ) from error
            if content_length < 0:
                raise HTTPException(
                    status_code=400, detail="Invalid dictation Content-Length header."
                )
            if content_length > MAX_AUDIO_BYTES:
                raise HTTPException(
                    status_code=413, detail="Audio recording is too large."
                )

        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_AUDIO_BYTES:
                raise HTTPException(
                    status_code=413, detail="Audio recording is too large."
                )
            chunks.append(chunk)

        try:
            return await transcribe_audio(
                b"".join(chunks),
                content_type=request.headers.get(
                    "content-type", "application/octet-stream"
                ),
                filename=request.headers.get("x-audio-filename", "dictation.webm"),
                language=request.headers.get("x-dictation-language"),
                preview=request.headers.get("x-dictation-mode") == "preview",
            )
        except DictationServiceError as error:
            raise HTTPException(
                status_code=error.status_code, detail=error.detail
            ) from error

    @application.get(
        "/terminal/v1/workspaces/{workspace_id}",
        response_model=WorkspaceResponse,
    )
    async def get_workspace(workspace_id: str, request: Request) -> WorkspaceResponse:
        workspace = _workspace(request, workspace_id)
        status = workspace_path_status(str(workspace.path))
        sessions = []
        if status.path_exists and status.is_directory and status.is_allowed:
            try:
                sessions = await resolved_backend.list_workspace_sessions(
                    _trusted_workspace_path(workspace)
                )
            except SessionBackendError as error:
                raise _http_backend(error) from error
        return WorkspaceResponse(
            project_id=workspace.id,
            path=status.path,
            path_exists=status.path_exists,
            is_directory=status.is_directory,
            is_allowed=status.is_allowed,
            message=status.message,
            session_count=len(sessions),
            sessions=[_session_response(session) for session in sessions],
        )

    @application.post(
        "/terminal/v1/workspaces/{workspace_id}/sessions",
        response_model=SessionResponse,
        status_code=201,
    )
    async def create_workspace_session(
        workspace_id: str, data: SessionCreate, request: Request
    ) -> SessionResponse:
        workspace = _workspace(request, workspace_id)
        try:
            session = await resolved_backend.create_session(
                _trusted_workspace_path(workspace),
                workspace.name,
                requested_name=data.name,
                mode=data.mode,
            )
        except SessionBackendError as error:
            raise _http_backend(error) from error
        return _session_response(session)

    @application.patch(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}",
        response_model=SessionResponse,
    )
    async def rename_workspace_session(
        workspace_id: str, session_name: str, data: SessionRename, request: Request
    ) -> SessionResponse:
        workspace = _workspace(request, workspace_id)
        try:
            session = await resolved_backend.rename_session(
                _trusted_workspace_path(workspace),
                workspace.name,
                session_name,
                data.name,
            )
        except SessionBackendError as error:
            raise _http_backend(error) from error
        return _session_response(session)

    @application.delete(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}",
        status_code=204,
    )
    async def close_workspace_session(
        workspace_id: str, session_name: str, request: Request
    ) -> None:
        workspace = _workspace(request, workspace_id)
        try:
            await resolved_backend.kill_session(
                _trusted_workspace_path(workspace), session_name
            )
        except SessionBackendError as error:
            raise _http_backend(error) from error

    @application.get(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/snapshot"
    )
    async def snapshot(
        workspace_id: str,
        session_name: str,
        request: Request,
        lines: int = Query(default=2000, ge=40, le=2000),
    ) -> dict[str, Any]:
        workspace = _workspace(request, workspace_id)
        try:
            captured = await resolved_backend.capture_session(
                _trusted_workspace_path(workspace), session_name, lines
            )
        except SessionBackendError as error:
            raise _http_backend(error) from error
        return {
            "session_name": captured.session_name,
            "content": captured.content,
            "captured_at": captured.captured_at,
        }

    @application.post("/terminal/v1/workspaces/{workspace_id}/paths/resolve")
    async def resolve_paths(
        workspace_id: str, data: PathResolveRequest, request: Request
    ) -> dict[str, Any]:
        workspace = _workspace(request, workspace_id)
        root = _trusted_workspace_path(workspace)
        bases: list[Path] = []
        if data.session_name:
            try:
                await resolved_backend.require_workspace_session(
                    root, data.session_name
                )
                bases.extend(
                    await resolved_backend.pane_current_paths(data.session_name)
                )
            except SessionBackendError:
                pass
        bases.append(root)
        unique_bases = list(dict.fromkeys(bases))
        paths = await asyncio.to_thread(
            resolve_terminal_paths, data.candidates, bases=unique_bases
        )
        return {
            "paths": [
                {
                    "candidate": item.candidate,
                    "path": item.path,
                    "kind": item.kind,
                    "size_bytes": item.size_bytes,
                }
                for item in paths
            ]
        }

    @application.get("/terminal/v1/files", response_model=None)
    async def download_file(path: str = Query(min_length=1)):
        try:
            root, relative = await asyncio.to_thread(resolve_download_target, path)
            opened = await asyncio.to_thread(open_workspace_file, root, relative)
        except WorkspaceFileError as error:
            raise HTTPException(
                status_code=error.status_code, detail=error.detail
            ) from error

        def stream_file():
            try:
                yield from iter_file_bytes(opened)
            finally:
                opened.close()

        return StreamingResponse(
            stream_file(),
            headers={
                "Cache-Control": "private, no-store, max-age=0",
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(opened.name, safe=""),
                "Content-Length": str(opened.size_bytes),
                "Content-Type": opened.content_type,
                "Cross-Origin-Resource-Policy": "same-site",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @application.post(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/attachments",
        status_code=201,
    )
    async def upload_attachment(
        workspace_id: str, session_name: str, request: Request
    ) -> dict[str, Any]:
        if request.headers.get("x-dolphin-attachment-upload") != "1":
            raise HTTPException(
                status_code=400, detail="Missing Dolphin attachment upload header."
            )
        encoded_name = request.headers.get("x-dolphin-attachment-name", "")
        if (
            not encoded_name
            or len(encoded_name) > 1536
            or re.search(r"%(?![0-9A-Fa-f]{2})", encoded_name)
        ):
            raise HTTPException(
                status_code=400,
                detail="Missing or invalid Dolphin attachment filename header.",
            )
        try:
            original_name = unquote_to_bytes(encoded_name).decode(
                "utf-8", errors="strict"
            )
        except UnicodeDecodeError as error:
            raise HTTPException(
                status_code=400, detail="Invalid Dolphin attachment filename encoding."
            ) from error
        workspace = _workspace(request, workspace_id)
        try:
            await resolved_backend.require_workspace_session(
                _trusted_workspace_path(workspace), session_name
            )
        except SessionBackendError as error:
            raise _http_backend(error) from error
        content_length_header = request.headers.get("content-length")
        content_length: int | None = None
        if content_length_header:
            try:
                content_length = int(content_length_header)
            except ValueError as error:
                raise HTTPException(
                    status_code=400, detail="Invalid attachment Content-Length header."
                ) from error
            if content_length < 0:
                raise HTTPException(
                    status_code=400, detail="Invalid attachment Content-Length header."
                )
            if content_length > terminal_attachment_settings().max_attachment_bytes:
                raise HTTPException(
                    status_code=413, detail="Attachment file is too large."
                )
        try:
            attachment = await store_terminal_attachment_stream(
                project_id=workspace_id,
                original_name=original_name,
                content_type=request.headers.get("content-type", ""),
                chunks=request.stream(),
                content_length=content_length,
            )
        except TerminalAttachmentError as error:
            raise HTTPException(
                status_code=error.status_code, detail=error.detail
            ) from error
        return {
            "attachment_id": attachment.attachment_id,
            "path": attachment.path,
            "original_name": attachment.original_name,
            "kind": attachment.kind,
            "content_type": attachment.content_type,
            "width": attachment.width,
            "height": attachment.height,
            "size_bytes": attachment.size_bytes,
            "created_at": attachment.created_at,
            "expires_at": attachment.expires_at,
        }

    @application.websocket(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/stream"
    )
    async def stream_session(
        websocket: WebSocket, workspace_id: str, session_name: str
    ) -> None:
        origin = websocket.headers.get("origin")
        if origin and origin.rstrip("/") not in resolved_settings.allowed_origins:
            await websocket.close(code=1008, reason="Origin is not allowed.")
            return
        try:
            workspace = _workspace(websocket, workspace_id)
            await resolved_backend.require_workspace_session(
                _trusted_workspace_path(workspace), session_name
            )
        except HTTPException as error:
            await websocket.accept()
            await websocket.send_json({"type": "error", "message": error.detail})
            await websocket.close(code=1008)
            return
        except SessionBackendError as error:
            await websocket.accept()
            await websocket.send_json({"type": "error", "message": error.detail})
            await websocket.close(code=1008)
            return
        await websocket.accept()
        try:
            await stream_session_attach(
                websocket, resolved_backend.attach_command(session_name)
            )
        except WebSocketDisconnect:
            return

    @application.get(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/automation"
    )
    async def get_automation(
        workspace_id: str, session_name: str, request: Request
    ) -> dict[str, Any]:
        await _require_workspace_session(request, workspace_id, session_name)
        return _automation_response(workspace_id, session_name)

    @application.put(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/automation"
    )
    async def update_automation(
        workspace_id: str,
        session_name: str,
        data: AutomationUpdate,
        request: Request,
    ) -> dict[str, Any]:
        await _require_workspace_session(request, workspace_id, session_name)
        if data.mode != "off":
            raise HTTPException(
                status_code=409,
                detail="No automation provider is configured for this gateway.",
            )
        return _automation_response(workspace_id, session_name)

    @application.post(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/automation/cancel",
        status_code=204,
    )
    async def cancel_automation(
        workspace_id: str, session_name: str, request: Request
    ) -> None:
        await _require_workspace_session(request, workspace_id, session_name)

    @application.get(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/automation/details"
    )
    async def automation_details(
        workspace_id: str, session_name: str, request: Request
    ) -> dict[str, Any]:
        workspace = await _require_workspace_session(
            request, workspace_id, session_name
        )
        return {
            "brief": {
                "schema_version": "dolphin-project-brief-v1",
                "project_id": workspace_id,
                "project_name": workspace.name,
                "revision": 0,
                "evidence_count": 0,
                "updated_at": None,
                "last_source_event_key": None,
                "purpose": "",
                "user_intent": "",
                "direction": "",
                "goals": [],
                "working_preferences": [],
                "success_signals": [],
                "boundaries": [],
            },
            "source_context": None,
            "source_context_status": "missing",
            "source_context_message": "No automation provider is configured.",
            "events": [],
        }

    @application.put(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/automation/brief"
    )
    async def update_brief(
        workspace_id: str,
        session_name: str,
        data: BriefContent,
        request: Request,
    ) -> dict[str, Any]:
        await _require_workspace_session(request, workspace_id, session_name)
        raise HTTPException(
            status_code=409,
            detail="No automation memory provider is configured for this gateway.",
        )

    @application.post(
        "/terminal/v1/workspaces/{workspace_id}/sessions/{session_name}/automation/source-context/refresh"
    )
    async def refresh_source_context(
        workspace_id: str, session_name: str, request: Request
    ) -> dict[str, str]:
        await _require_workspace_session(request, workspace_id, session_name)
        raise HTTPException(
            status_code=409,
            detail="No automation source-context provider is configured for this gateway.",
        )

    @application.post("/terminal/v1/automation/stop-all")
    async def stop_all_automation() -> dict[str, int]:
        return {"stopped": 0}

    if resolved_settings.static_dir is not None:
        application.mount(
            "/",
            StaticFiles(directory=resolved_settings.static_dir, html=True),
            name="terminal-ui",
        )

    return application


app = create_app()
