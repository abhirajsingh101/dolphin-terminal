"""Client and lifecycle helpers for the built-in persistent PTY daemon.

The daemon is an implementation detail of ``dolphin-terminal serve``.  It owns
shell PTYs independently from the HTTP process so browser disconnects and
gateway restarts do not terminate sessions.  Communication is restricted to a
private Unix-domain socket owned by the current user.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any


MAX_CONTROL_LINE_BYTES = 8 * 1024 * 1024
START_TIMEOUT_SECONDS = 4.0


class NativeRuntimeError(Exception):
    """Failure reported by, or while connecting to, the native daemon."""

    def __init__(self, detail: str, status_code: int = 500):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _secure_directory(path: Path) -> Path:
    """Create or validate a directory that only the current user can access."""
    try:
        existing = path.lstat()
    except FileNotFoundError:
        path.mkdir(mode=0o700, parents=True, exist_ok=False)
        existing = path.lstat()
    if stat.S_ISLNK(existing.st_mode) or not stat.S_ISDIR(existing.st_mode):
        raise NativeRuntimeError(f"Native runtime path is not a directory: {path}")
    if existing.st_uid != os.getuid():
        raise NativeRuntimeError(
            f"Native runtime path is not owned by this user: {path}"
        )
    if stat.S_IMODE(existing.st_mode) & 0o077:
        os.chmod(path, 0o700)
    return path


def default_runtime_dir() -> Path:
    configured = os.getenv("DOLPHIN_TERMINAL_NATIVE_RUNTIME_DIR")
    if configured:
        return _secure_directory(Path(configured).expanduser().absolute())
    xdg_runtime = os.getenv("XDG_RUNTIME_DIR")
    if xdg_runtime:
        candidate = Path(xdg_runtime) / "dolphin-terminal"
    else:
        candidate = Path(tempfile.gettempdir()) / f"dolphin-terminal-{os.getuid()}"
    return _secure_directory(candidate)


def default_state_dir() -> Path:
    configured = os.getenv("DOLPHIN_TERMINAL_NATIVE_STATE_DIR")
    if configured:
        return _secure_directory(Path(configured).expanduser().absolute())
    xdg_state = os.getenv("XDG_STATE_HOME")
    base = (
        Path(xdg_state).expanduser() if xdg_state else Path.home() / ".local" / "state"
    )
    return _secure_directory(base / "dolphin-terminal")


def default_socket_path() -> Path:
    configured = os.getenv("DOLPHIN_TERMINAL_NATIVE_SOCKET")
    if configured:
        candidate = Path(configured).expanduser().absolute()
        _secure_directory(candidate.parent)
        return candidate
    return default_runtime_dir() / "native.sock"


def _instance_key(socket_path: Path) -> str:
    return hashlib.sha256(str(socket_path).encode()).hexdigest()[:16]


def daemon_files(
    socket_path: Path | None = None, state_dir: Path | None = None
) -> tuple[Path, Path, Path, Path]:
    resolved_socket = (socket_path or default_socket_path()).absolute()
    resolved_state = _secure_directory(state_dir or default_state_dir())
    key = _instance_key(resolved_socket)
    return (
        resolved_socket,
        resolved_state / f"native-{key}.pid",
        resolved_state / f"native-{key}.lock",
        resolved_state / f"native-{key}.log",
    )


def _read_pid(pid_path: Path) -> int | None:
    try:
        value = int(pid_path.read_text().strip())
    except (FileNotFoundError, OSError, ValueError):
        return None
    return value if value > 1 else None


def _pid_is_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def request(
    payload: dict[str, Any],
    *,
    socket_path: Path | None = None,
    timeout: float = 3.0,
) -> dict[str, Any]:
    """Perform one authenticated-by-OS local control request."""
    resolved_socket = (socket_path or default_socket_path()).absolute()
    encoded = json.dumps(payload, separators=(",", ":")).encode() + b"\n"
    if len(encoded) > MAX_CONTROL_LINE_BYTES:
        raise NativeRuntimeError("Native session request is too large.", 413)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(resolved_socket))
        client.sendall(encoded)
        received = bytearray()
        while b"\n" not in received:
            chunk = client.recv(65536)
            if not chunk:
                break
            received.extend(chunk)
            if len(received) > MAX_CONTROL_LINE_BYTES:
                raise NativeRuntimeError("Native session response is too large.")
    except (FileNotFoundError, ConnectionError, socket.timeout, OSError) as error:
        raise NativeRuntimeError("The native session daemon is unavailable.") from error
    finally:
        client.close()
    line, separator, _remaining = bytes(received).partition(b"\n")
    if not separator:
        raise NativeRuntimeError(
            "The native session daemon returned an incomplete response."
        )
    try:
        result = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise NativeRuntimeError(
            "The native session daemon returned an invalid response."
        ) from error
    if not isinstance(result, dict):
        raise NativeRuntimeError(
            "The native session daemon returned an invalid response."
        )
    if not result.get("ok"):
        raise NativeRuntimeError(
            str(result.get("detail") or "Native session operation failed."),
            int(result.get("status_code") or 500),
        )
    return result


def ping(*, socket_path: Path | None = None, timeout: float = 0.4) -> bool:
    try:
        return (
            request({"op": "ping"}, socket_path=socket_path, timeout=timeout).get(
                "service"
            )
            == "dolphin-terminal-native"
        )
    except NativeRuntimeError:
        return False


def ensure_daemon(
    *, socket_path: Path | None = None, state_dir: Path | None = None
) -> Path:
    """Return a ready socket, starting the private daemon exactly once."""
    resolved_socket, pid_path, lock_path, log_path = daemon_files(
        socket_path, state_dir
    )
    _secure_directory(resolved_socket.parent)
    with lock_path.open("a+") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if ping(socket_path=resolved_socket):
            return resolved_socket

        existing_pid = _read_pid(pid_path)
        if _pid_is_alive(existing_pid):
            raise NativeRuntimeError(
                "The native session daemon process is running but its private socket is unavailable. "
                f"Inspect {log_path}."
            )

        for stale in (pid_path, resolved_socket):
            try:
                mode = stale.lstat().st_mode
            except FileNotFoundError:
                continue
            if stale == resolved_socket and not stat.S_ISSOCK(mode):
                raise NativeRuntimeError(
                    f"Refusing to replace a non-socket native runtime path: {stale}"
                )
            stale.unlink()

        log = log_path.open("ab", buffering=0)
        try:
            subprocess.Popen(
                (
                    sys.executable,
                    "-m",
                    "dolphin_terminal.native_daemon",
                    "--socket",
                    str(resolved_socket),
                    "--pid-file",
                    str(pid_path),
                ),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                close_fds=True,
                start_new_session=True,
                env=os.environ.copy(),
            )
        finally:
            log.close()

        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if ping(socket_path=resolved_socket):
                return resolved_socket
            launched_pid = _read_pid(pid_path)
            if launched_pid is not None and not _pid_is_alive(launched_pid):
                break
            time.sleep(0.04)
    raise NativeRuntimeError(
        f"The native session daemon did not become ready. Inspect {log_path}."
    )


def stop_daemon(
    *,
    socket_path: Path | None = None,
    state_dir: Path | None = None,
    force: bool = False,
) -> None:
    """Stop one exact daemon; intended for tests and explicit administration."""
    resolved_socket, pid_path, _lock_path, _log_path = daemon_files(
        socket_path, state_dir
    )
    try:
        request(
            {"op": "stop", "force": force},
            socket_path=resolved_socket,
            timeout=2.0,
        )
    except NativeRuntimeError:
        pid = _read_pid(pid_path)
        if force and pid is not None and _pid_is_alive(pid):
            os.kill(pid, signal.SIGTERM)
