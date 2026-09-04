"""TTY bridge between one gateway attachment PTY and the native daemon."""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import sys
import termios
import tty


def _size(fd: int) -> tuple[int, int]:
    try:
        rows, cols, _x, _y = struct.unpack(
            "HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)
        )
    except OSError:
        return 120, 36
    return max(20, cols or 120), max(8, rows or 36)


def _send(client: socket.socket, **payload: object) -> None:
    client.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode())


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--session", required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    previous = termios.tcgetattr(stdin_fd)
    wake_read, wake_write = os.pipe()
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    buffer = bytearray()

    def resized(_signum: int, _frame: object) -> None:
        with contextlib.suppress(OSError):
            os.write(wake_write, b"r")

    previous_handler = signal.signal(signal.SIGWINCH, resized)
    try:
        # The gateway preconfigures this PTY as raw before exposing the
        # WebSocket. Use TCSANOW here: Python's default TCSAFLUSH would discard
        # any keystrokes that arrived during this helper's startup window.
        tty.setraw(stdin_fd, when=termios.TCSANOW)
        client.connect(str(args.socket.absolute()))
        cols, rows = _size(stdin_fd)
        _send(
            client,
            op="attach",
            session_name=args.session,
            cols=cols,
            rows=rows,
        )
        while True:
            readable, _, _ = select.select((stdin_fd, client, wake_read), (), ())
            if wake_read in readable:
                os.read(wake_read, 4096)
                cols, rows = _size(stdin_fd)
                _send(client, op="resize", cols=cols, rows=rows)
            if stdin_fd in readable:
                data = os.read(stdin_fd, 65536)
                if not data:
                    break
                _send(client, op="input", data=base64.b64encode(data).decode())
            if client in readable:
                data = client.recv(65536)
                if not data:
                    break
                buffer.extend(data)
                while b"\n" in buffer:
                    line, _, remaining = buffer.partition(b"\n")
                    buffer = bytearray(remaining)
                    try:
                        frame = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if frame.get("type") == "output":
                        with contextlib.suppress(ValueError, TypeError):
                            _write_all(
                                stdout_fd,
                                base64.b64decode(frame.get("data", ""), validate=True),
                            )
                    elif frame.get("type") == "exit":
                        return 0
                    elif frame.get("ok") is False:
                        message = str(
                            frame.get("detail") or "Native session attachment failed."
                        )
                        _write_all(stdout_fd, ("\r\n" + message + "\r\n").encode())
                        return 1
        return 0
    finally:
        with contextlib.suppress(OSError):
            _send(client, op="detach")
        client.close()
        signal.signal(signal.SIGWINCH, previous_handler)
        termios.tcsetattr(stdin_fd, termios.TCSADRAIN, previous)
        os.close(wake_read)
        os.close(wake_write)


if __name__ == "__main__":
    raise SystemExit(main())
