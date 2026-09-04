"""Private PTY-owning daemon used by the built-in native session backend."""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import struct
import termios
import time
from typing import Any
import uuid


MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_HISTORY_BYTES = 5 * 1024 * 1024
MAX_CLIENT_BUFFER_BYTES = 2 * 1024 * 1024
SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
ANSI_ESCAPE_RE = re.compile(
    r"(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[P_X^][\s\S]*?\x1B\\|\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))"
)


class OperationError(Exception):
    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _response(**values: Any) -> bytes:
    return (json.dumps(values, separators=(",", ":")) + "\n").encode()


def _bounded_size(cols: Any, rows: Any) -> tuple[int, int]:
    try:
        bounded_cols = max(20, min(int(cols or 120), 300))
        bounded_rows = max(8, min(int(rows or 36), 120))
    except (TypeError, ValueError) as error:
        raise OperationError("Terminal dimensions must be integers.") from error
    return bounded_cols, bounded_rows


def _resize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _session_name(project_name: str, requested_name: Any) -> str:
    suffix = "-dolphin"
    if requested_name is not None:
        if not isinstance(requested_name, str):
            raise OperationError("Session names must be text.")
        name = requested_name.strip()
        if not name or not SESSION_NAME_RE.fullmatch(name):
            raise OperationError(
                "Session names may only contain letters, numbers, dots, dashes, and underscores."
            )
        if name.startswith("dolphin-"):
            return name[:80]
        if name.endswith(suffix):
            name = name[: -len(suffix)]
        return f"{name[: 80 - len(suffix)]}{suffix}"
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", project_name.strip().lower())
    slug = slug.strip("-._")[:36] or "workspace"
    return f"{slug}-{uuid.uuid4().hex[:6]}{suffix}"


def _proc_children(pid: int) -> list[int]:
    try:
        raw = Path(f"/proc/{pid}/task/{pid}/children").read_text()
    except OSError:
        return []
    result: list[int] = []
    for value in raw.split():
        with contextlib.suppress(ValueError):
            result.append(int(value))
    return result


def _process_tree(root_pid: int) -> list[int]:
    pending = [root_pid]
    seen: set[int] = set()
    while pending and len(seen) < 4096:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        pending.extend(_proc_children(pid))
    return list(seen)


def _process_name(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text(errors="replace").strip()
    except OSError:
        return ""


def _process_command(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        raw = b""
    return raw.replace(b"\0", b" ").decode(errors="replace").strip()


def _contains_agent(root_pid: int, executable: str) -> bool:
    expected = executable.lower()
    for pid in _process_tree(root_pid):
        name = _process_name(pid).lower()
        command = _process_command(pid).lower()
        if name == expected or Path(command.partition(" ")[0]).name == expected:
            return True
    return False


def _foreground_pid(fd: int, fallback: int) -> int:
    try:
        return os.tcgetpgrp(fd)
    except OSError:
        return fallback


def _cwd(pid: int, fallback: str) -> str:
    try:
        return str(Path(os.readlink(f"/proc/{pid}/cwd")).resolve())
    except (OSError, RuntimeError):
        return fallback


def _snapshot_text(raw: bytes, lines: int) -> str:
    text = raw.decode(errors="replace")
    text = ANSI_ESCAPE_RE.sub("", text).replace("\x00", "")
    rendered: list[str] = []
    current: list[str] = []
    cursor = 0
    for character in text:
        if character == "\r":
            cursor = 0
        elif character == "\n":
            rendered.append("".join(current).rstrip())
            current = []
            cursor = 0
        elif character == "\b":
            cursor = max(0, cursor - 1)
        elif character == "\t":
            spaces = 8 - (cursor % 8)
            for _ in range(spaces):
                if cursor < len(current):
                    current[cursor] = " "
                else:
                    current.append(" ")
                cursor += 1
        elif character >= " " and character != "\x7f":
            if cursor < len(current):
                current[cursor] = character
            else:
                current.extend(" " for _ in range(cursor - len(current)))
                current.append(character)
            cursor += 1
    if current:
        rendered.append("".join(current).rstrip())
    return "\n".join(rendered[-lines:])


def _shell() -> str:
    configured = os.getenv("DOLPHIN_TERMINAL_SHELL")
    candidate = configured or pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
    resolved = Path(candidate)
    if (
        not resolved.is_absolute()
        or not resolved.is_file()
        or not os.access(resolved, os.X_OK)
    ):
        return "/bin/sh"
    return str(resolved)


@dataclass
class NativeSession:
    name: str
    workspace_path: str
    created_at: datetime
    pid: int
    master_fd: int
    history: bytearray = field(default_factory=bytearray)
    clients: set[asyncio.StreamWriter] = field(default_factory=set)
    last_activity_at: float = field(default_factory=time.time)

    def info(self) -> dict[str, Any]:
        foreground = _foreground_pid(self.master_fd, self.pid)
        command = _process_name(foreground) or _process_name(self.pid) or None
        return {
            "name": self.name,
            "path": self.workspace_path,
            "created_at": self.created_at.isoformat(),
            "windows": 1,
            "attached": bool(self.clients),
            "current_command": command,
            "is_codex_running": _contains_agent(self.pid, "codex"),
            "is_claude_code_running": _contains_agent(self.pid, "claude"),
            "has_recent_activity": time.time() - self.last_activity_at <= 5.0,
            "current_path": _cwd(foreground, self.workspace_path),
        }


class NativeDaemon:
    def __init__(self, socket_path: Path, pid_path: Path):
        self.socket_path = socket_path
        self.pid_path = pid_path
        self.sessions: dict[str, NativeSession] = {}
        self.server: asyncio.AbstractServer | None = None
        self.stop_event = asyncio.Event()
        self.loop = asyncio.get_running_loop()

    def _write(self, writer: asyncio.StreamWriter, **values: Any) -> bool:
        transport = writer.transport
        if transport is None or transport.is_closing():
            return False
        if transport.get_write_buffer_size() > MAX_CLIENT_BUFFER_BYTES:
            writer.close()
            return False
        writer.write(_response(**values))
        return True

    def _append_history(self, session: NativeSession, data: bytes) -> None:
        session.history.extend(data)
        excess = len(session.history) - MAX_HISTORY_BYTES
        if excess <= 0:
            return
        boundary = session.history.find(
            b"\n", excess, min(len(session.history), excess + 65536)
        )
        del session.history[: boundary + 1 if boundary >= 0 else excess]

    def _readable(self, session: NativeSession) -> None:
        try:
            data = os.read(session.master_fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self._remove_session(session.name, notify=True)
            return
        session.last_activity_at = time.time()
        self._append_history(session, data)
        encoded = base64.b64encode(data).decode()
        stale: list[asyncio.StreamWriter] = []
        for writer in session.clients:
            if not self._write(writer, type="output", data=encoded):
                stale.append(writer)
        for writer in stale:
            session.clients.discard(writer)

    def _remove_session(self, name: str, *, notify: bool) -> None:
        session = self.sessions.pop(name, None)
        if session is None:
            return
        with contextlib.suppress(Exception):
            self.loop.remove_reader(session.master_fd)
        if notify:
            for writer in session.clients:
                self._write(writer, type="exit")
        for writer in session.clients:
            writer.close()
        with contextlib.suppress(OSError):
            os.close(session.master_fd)
        with contextlib.suppress(ChildProcessError):
            os.waitpid(session.pid, os.WNOHANG)

    def _create(
        self, workspace_path: str, project_name: str, requested_name: Any
    ) -> NativeSession:
        resolved = Path(workspace_path).expanduser().resolve()
        if not resolved.is_dir():
            raise OperationError(
                "The configured workspace directory is unavailable.", 404
            )
        name = _session_name(project_name, requested_name)
        if name in self.sessions:
            raise OperationError(
                "A persistent session with that name already exists.", 409
            )
        master_fd, slave_fd = os.openpty()
        _resize(master_fd, 132, 36)
        child_pid = os.fork()
        if child_pid == 0:
            try:
                os.close(master_fd)
                os.setsid()
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
                os.dup2(slave_fd, 0)
                os.dup2(slave_fd, 1)
                os.dup2(slave_fd, 2)
                if slave_fd > 2:
                    os.close(slave_fd)
                # ``fork`` inherits the daemon listener and every other session
                # master.  Close all non-standard descriptors before executing
                # the shell so one session can never keep another alive.
                try:
                    descriptor_limit = int(os.sysconf("SC_OPEN_MAX"))
                except (OSError, ValueError):
                    descriptor_limit = 65536
                os.closerange(3, min(descriptor_limit, 1_048_576))
                os.chdir(resolved)
                environment = os.environ.copy()
                environment.update(
                    {
                        "TERM": "xterm-256color",
                        "COLORTERM": "truecolor",
                        "DOLPHIN_TERMINAL_SESSION": name,
                    }
                )
                shell = _shell()
                os.execve(shell, (shell,), environment)
            except BaseException:
                os._exit(127)
        os.close(slave_fd)
        os.set_blocking(master_fd, False)
        session = NativeSession(
            name=name,
            workspace_path=str(resolved),
            created_at=datetime.now(timezone.utc),
            pid=child_pid,
            master_fd=master_fd,
        )
        self.sessions[name] = session
        self.loop.add_reader(master_fd, self._readable, session)
        return session

    def _require(self, name: Any, workspace_path: Any = None) -> NativeSession:
        if not isinstance(name, str) or not SESSION_NAME_RE.fullmatch(name):
            raise OperationError("Invalid persistent session name.")
        session = self.sessions.get(name)
        if session is None:
            raise OperationError("That persistent session is no longer available.", 404)
        if workspace_path is not None:
            try:
                expected = str(Path(str(workspace_path)).expanduser().resolve())
            except (OSError, RuntimeError, ValueError) as error:
                raise OperationError("Invalid workspace path.") from error
            if session.workspace_path != expected:
                raise OperationError(
                    "That persistent session does not belong to this workspace.", 409
                )
        return session

    async def _kill(self, session: NativeSession) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(session.pid, signal.SIGHUP)
        deadline = time.monotonic() + 0.75
        while time.monotonic() < deadline:
            try:
                waited, _status = os.waitpid(session.pid, os.WNOHANG)
            except ChildProcessError:
                waited = session.pid
            if waited:
                break
            # Keep inventory, attachment, and health requests responsive while
            # this exact process group gets its graceful shutdown window.
            await asyncio.sleep(0.01)
        else:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(session.pid, signal.SIGKILL)
        self._remove_session(session.name, notify=True)

    async def _handle_attach(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        payload: dict[str, Any],
    ) -> None:
        session = self._require(payload.get("session_name"))
        cols, rows = _bounded_size(payload.get("cols"), payload.get("rows"))
        _resize(session.master_fd, cols, rows)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(session.pid, signal.SIGWINCH)
        session.clients.add(writer)
        self._write(writer, ok=True, type="attached", session_name=session.name)
        if session.history:
            self._write(
                writer,
                type="output",
                data=base64.b64encode(bytes(session.history)).decode(),
                replay=True,
            )
        await writer.drain()
        try:
            while not reader.at_eof() and session.name in self.sessions:
                line = await reader.readline()
                if not line:
                    break
                if len(line) > MAX_LINE_BYTES:
                    raise OperationError("Native attachment frame is too large.", 413)
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(frame, dict):
                    continue
                operation = frame.get("op")
                if operation == "input":
                    try:
                        data = base64.b64decode(frame.get("data", ""), validate=True)
                    except (ValueError, TypeError) as error:
                        raise OperationError("Invalid terminal input frame.") from error
                    if data:
                        view = memoryview(data)
                        while view:
                            try:
                                written = os.write(session.master_fd, view)
                                view = view[written:]
                            except BlockingIOError:
                                await asyncio.sleep(0)
                elif operation == "resize":
                    cols, rows = _bounded_size(frame.get("cols"), frame.get("rows"))
                    _resize(session.master_fd, cols, rows)
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(session.pid, signal.SIGWINCH)
                elif operation == "detach":
                    break
        finally:
            session.clients.discard(writer)

    async def _dispatch(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        payload: dict[str, Any],
    ) -> None:
        operation = payload.get("op")
        if operation == "attach":
            await self._handle_attach(reader, writer, payload)
            return
        if operation == "ping":
            self._write(
                writer,
                ok=True,
                service="dolphin-terminal-native",
                pid=os.getpid(),
                sessions=len(self.sessions),
            )
        elif operation == "list":
            workspace_path = str(
                Path(str(payload.get("workspace_path", ""))).expanduser().resolve()
            )
            sessions = [
                session.info()
                for session in self.sessions.values()
                if session.workspace_path == workspace_path
            ]
            sessions.sort(key=lambda item: (item["created_at"], item["name"]))
            self._write(writer, ok=True, sessions=sessions)
        elif operation == "create":
            if payload.get("mode") != "shell":
                raise OperationError(
                    "The native backend only accepts shell session creation."
                )
            session = self._create(
                str(payload.get("workspace_path", "")),
                str(payload.get("workspace_name", "workspace")),
                payload.get("requested_name"),
            )
            self._write(writer, ok=True, session=session.info())
        elif operation == "require":
            session = self._require(
                payload.get("session_name"), payload.get("workspace_path")
            )
            self._write(writer, ok=True, session=session.info())
        elif operation == "rename":
            session = self._require(
                payload.get("session_name"), payload.get("workspace_path")
            )
            final_name = _session_name(
                str(payload.get("workspace_name", "workspace")),
                payload.get("requested_name"),
            )
            if final_name == session.name:
                self._write(writer, ok=True, session=session.info())
                return
            if final_name in self.sessions:
                raise OperationError(
                    "A persistent session with that name already exists.", 409
                )
            previous = session.name
            self.sessions.pop(previous)
            session.name = final_name
            self.sessions[final_name] = session
            self._write(writer, ok=True, session=session.info())
        elif operation == "kill":
            session = self._require(
                payload.get("session_name"), payload.get("workspace_path")
            )
            await self._kill(session)
            self._write(writer, ok=True)
        elif operation == "capture":
            session = self._require(
                payload.get("session_name"), payload.get("workspace_path")
            )
            try:
                lines = max(40, min(int(payload.get("lines") or 2000), 2000))
            except (TypeError, ValueError) as error:
                raise OperationError("Snapshot lines must be an integer.") from error
            self._write(
                writer,
                ok=True,
                session_name=session.name,
                content=_snapshot_text(bytes(session.history), lines),
                captured_at=datetime.now(timezone.utc).isoformat(),
            )
        elif operation == "paths":
            session = self._require(payload.get("session_name"))
            foreground = _foreground_pid(session.master_fd, session.pid)
            self._write(
                writer, ok=True, paths=[_cwd(foreground, session.workspace_path)]
            )
        elif operation == "stop":
            force = payload.get("force") is True
            if self.sessions and not force:
                raise OperationError(
                    "Refusing to stop the native daemon while persistent sessions exist.",
                    409,
                )
            for session in list(self.sessions.values()):
                await self._kill(session)
            self._write(writer, ok=True)
            self.loop.call_soon(self.stop_event.set)
        else:
            raise OperationError("Unsupported native session operation.", 404)
        await writer.drain()

    async def handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not line or len(line) > MAX_LINE_BYTES:
                raise OperationError(
                    "Native session request is missing or too large.", 413
                )
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as error:
                raise OperationError("Invalid native session request.") from error
            if not isinstance(payload, dict):
                raise OperationError("Invalid native session request.")
            await self._dispatch(reader, writer, payload)
        except OperationError as error:
            self._write(
                writer,
                ok=False,
                detail=error.detail,
                status_code=error.status_code,
            )
            with contextlib.suppress(ConnectionError):
                await writer.drain()
        except (asyncio.TimeoutError, ConnectionError, BrokenPipeError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    def reap_children(self) -> None:
        for session in list(self.sessions.values()):
            try:
                waited, _status = os.waitpid(session.pid, os.WNOHANG)
            except ChildProcessError:
                waited = session.pid
            if waited:
                self._remove_session(session.name, notify=True)

    async def run(self) -> None:
        try:
            existing = self.socket_path.lstat()
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if not stat.S_ISSOCK(existing.st_mode):
                raise RuntimeError(
                    f"Refusing to replace non-socket path: {self.socket_path}"
                )
            self.socket_path.unlink()
        self.server = await asyncio.start_unix_server(
            self.handle_client,
            path=str(self.socket_path),
            limit=MAX_LINE_BYTES + 1,
        )
        os.chmod(self.socket_path, 0o600)
        self.pid_path.write_text(f"{os.getpid()}\n")
        os.chmod(self.pid_path, 0o600)

        async def reaper() -> None:
            while not self.stop_event.is_set():
                self.reap_children()
                try:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass

        reaper_task = asyncio.create_task(reaper())
        try:
            async with self.server:
                await self.stop_event.wait()
        finally:
            reaper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper_task
            self.server.close()
            await self.server.wait_closed()
            for session in list(self.sessions.values()):
                await self._kill(session)
            with contextlib.suppress(FileNotFoundError):
                self.socket_path.unlink()
            with contextlib.suppress(FileNotFoundError):
                self.pid_path.unlink()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--pid-file", type=Path, required=True)
    return parser


async def _main_async(args: argparse.Namespace) -> None:
    daemon = NativeDaemon(args.socket.absolute(), args.pid_file.absolute())
    loop = asyncio.get_running_loop()
    for watched in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(watched, daemon.stop_event.set)
    await daemon.run()


def main() -> int:
    args = _parser().parse_args()
    os.umask(0o077)
    socket_path = args.socket.absolute()
    socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.pid_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    asyncio.run(_main_async(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
