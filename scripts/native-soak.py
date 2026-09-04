#!/usr/bin/env python3
"""Restart/reattach soak for the one-command native distribution."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
import uuid

from websockets.sync.client import connect


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from dolphin_terminal.native_runtime import request, stop_daemon  # noqa: E402

CYCLES = 8


def free_port() -> int:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = int(listener.getsockname()[1])
    listener.close()
    return port


def http_json(url: str, *, method: str = "GET", data: object | None = None):
    body = None if data is None else json.dumps(data).encode()
    request = Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    with urlopen(request, timeout=3) as response:
        payload = response.read()
    return json.loads(payload) if payload else None


def wait_for_health(base_url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"Gateway exited during startup with {process.returncode}."
            )
        try:
            health = http_json(f"{base_url}/health")
            if health.get("status") == "ok":
                return
        except (OSError, URLError, ValueError):
            pass
        time.sleep(0.04)
    raise RuntimeError("Gateway did not become healthy during the soak test.")


def start_gateway(
    workspace: Path, port: int, environment: dict[str, str], log
) -> subprocess.Popen[bytes]:
    process = subprocess.Popen(
        (
            sys.executable,
            "-m",
            "dolphin_terminal",
            "serve",
            str(workspace),
            "--port",
            str(port),
            "--session-backend",
            "native",
            "--no-ui",
            "--no-open",
        ),
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    wait_for_health(f"http://127.0.0.1:{port}", process)
    return process


def stop_gateway(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def main() -> int:
    started = time.monotonic()
    process: subprocess.Popen[bytes] | None = None
    with tempfile.TemporaryDirectory(prefix="dolphin-terminal-soak-") as temporary:
        scratch = Path(temporary)
        workspace = scratch / "workspace"
        workspace.mkdir()
        runtime = scratch / "runtime"
        state = scratch / "state"
        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        workspace_url = f"{base_url}/terminal/v1/workspaces/workspace"
        requested_name = f"soak-{uuid.uuid4().hex[:10]}"
        session_name = f"{requested_name}-dolphin"
        log_path = scratch / "gateway.log"
        environment = os.environ.copy()
        environment.update(
            {
                "PYTHONPATH": str(ROOT / "python"),
                "DOLPHIN_TERMINAL_NATIVE_RUNTIME_DIR": str(runtime),
                "DOLPHIN_TERMINAL_NATIVE_STATE_DIR": str(state),
            }
        )
        daemon_pids: list[int] = []
        created_at = ""
        markers: list[str] = []
        try:
            with log_path.open("wb", buffering=0) as log:
                process = start_gateway(workspace, port, environment, log)
                created = http_json(
                    f"{workspace_url}/sessions",
                    method="POST",
                    data={"name": requested_name, "mode": "shell"},
                )
                assert created["name"] == session_name
                created_at = created["created_at"]

                socket_path = runtime / "native.sock"
                for cycle in range(CYCLES):
                    ping = request({"op": "ping"}, socket_path=socket_path)
                    daemon_pids.append(int(ping["pid"]))
                    inventory = http_json(workspace_url)
                    exact = [
                        item
                        for item in inventory["sessions"]
                        if item["name"] == session_name
                    ]
                    assert len(exact) == 1
                    assert exact[0]["created_at"] == created_at

                    marker = f"SOAK_{cycle}_{uuid.uuid4().hex[:8]}"
                    markers.append(marker)
                    with connect(
                        f"ws://127.0.0.1:{port}/terminal/v1/workspaces/workspace/"
                        f"sessions/{session_name}/stream",
                        origin=base_url,
                        open_timeout=5,
                        close_timeout=2,
                        max_size=8 * 1024 * 1024,
                    ) as terminal:
                        terminal.send(f"printf '{marker}\\n'\n".encode())
                        output = b""
                        deadline = time.monotonic() + 5
                        while (
                            marker.encode() not in output
                            and time.monotonic() < deadline
                        ):
                            try:
                                frame = terminal.recv(timeout=0.5)
                            except TimeoutError:
                                continue
                            output += (
                                frame if isinstance(frame, bytes) else frame.encode()
                            )
                        if marker.encode() not in output:
                            raise RuntimeError(
                                f"Terminal marker was not observed; received {output[-500:]!r}."
                            )

                    snapshot = http_json(
                        f"{workspace_url}/sessions/{session_name}/snapshot?lines=2000"
                    )
                    assert marker in snapshot["content"]
                    stop_gateway(process)
                    process = None
                    if cycle + 1 < CYCLES:
                        process = start_gateway(workspace, port, environment, log)

                process = start_gateway(workspace, port, environment, log)
                http_json(f"{workspace_url}/sessions/{session_name}", method="DELETE")
                assert http_json(workspace_url)["sessions"] == []
                stop_gateway(process)
                process = None
                stop_daemon(socket_path=socket_path, state_dir=state)
        finally:
            stop_gateway(process)
            stop_daemon(
                socket_path=runtime / "native.sock", state_dir=state, force=True
            )

        report = {
            "schema": "dolphin-terminal-native-soak-v1",
            "passed": True,
            "cycles": CYCLES,
            "gateway_restarts": CYCLES,
            "websocket_attachments": CYCLES,
            "session_name_sha256": hashlib.sha256(session_name.encode()).hexdigest(),
            "session_created_at_stable": bool(created_at),
            "daemon_pid_stable": len(set(daemon_pids)) == 1,
            "marker_count": len(markers),
            "duration_seconds": round(time.monotonic() - started, 3),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        assert report["daemon_pid_stable"] is True
        evidence_dir = ROOT / "test-results" / "evidence"
        evidence_dir.mkdir(parents=True, exist_ok=True)
        evidence_path = evidence_dir / "native-soak.json"
        evidence_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
