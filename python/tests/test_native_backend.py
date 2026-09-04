import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import stat
import time

import pytest

from dolphin_terminal.native_runtime import request, stop_daemon
from dolphin_terminal.session_backend import (
    NativeSessionBackend,
    SessionBackendError,
)


@pytest.fixture
def native_backend(tmp_path):
    socket_path = tmp_path / "run" / "native.sock"
    state_dir = tmp_path / "state"
    backend = NativeSessionBackend(socket_path=socket_path, state_dir=state_dir)
    try:
        yield backend, socket_path, state_dir
    finally:
        stop_daemon(socket_path=socket_path, state_dir=state_dir, force=True)
        deadline = time.monotonic() + 3
        while socket_path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)


def _connect(socket_path: Path) -> tuple[socket.socket, object]:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(3)
    client.connect(str(socket_path))
    return client, client.makefile("rb")


def _send(client: socket.socket, **payload) -> None:
    client.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode())


def _receive(stream) -> dict:
    return json.loads(stream.readline())


@pytest.mark.asyncio
async def test_native_backend_crud_is_exact_and_survives_gateway_recreation(
    tmp_path, native_backend
):
    backend, socket_path, state_dir = native_backend
    workspace = tmp_path / "workspace"
    other = tmp_path / "other"
    workspace.mkdir()
    other.mkdir()

    health = backend.health()
    created = await backend.create_session(
        workspace,
        "Example Workspace",
        requested_name="review",
        mode="shell",
    )

    assert health.available is True
    assert health.id == "native"
    assert created.name == "review-dolphin"
    assert created.path == str(workspace.resolve())
    assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(socket_path.parent.stat().st_mode) == 0o700

    recreated_gateway_backend = NativeSessionBackend(
        socket_path=socket_path, state_dir=state_dir
    )
    listed = await recreated_gateway_backend.list_workspace_sessions(workspace)
    assert [session.name for session in listed] == [created.name]

    with pytest.raises(SessionBackendError) as wrong_workspace:
        await recreated_gateway_backend.require_workspace_session(other, created.name)
    assert wrong_workspace.value.status_code == 409

    renamed = await recreated_gateway_backend.rename_session(
        workspace,
        "Example Workspace",
        created.name,
        "release",
    )
    assert renamed.name == "release-dolphin"
    with pytest.raises(SessionBackendError) as old_name:
        await recreated_gateway_backend.require_workspace_session(
            workspace, created.name
        )
    assert old_name.value.status_code == 404

    await recreated_gateway_backend.kill_session(workspace, renamed.name)
    assert await recreated_gateway_backend.list_workspace_sessions(workspace) == []


@pytest.mark.asyncio
async def test_native_attachment_detaches_without_killing_and_replays_history(
    tmp_path, native_backend
):
    backend, socket_path, _state_dir = native_backend
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    created = await backend.create_session(
        workspace,
        "Workspace",
        requested_name="persistent",
        mode="shell",
    )

    first, first_stream = _connect(socket_path)
    _send(
        first,
        op="attach",
        session_name=created.name,
        cols=100,
        rows=30,
    )
    assert _receive(first_stream)["type"] == "attached"
    first_output = _receive(first_stream)
    assert first_output["type"] == "output"
    marker = f"NATIVE_REPLAY_{os.getpid()}"
    _send(
        first,
        op="input",
        data=base64.b64encode(f"printf '{marker}\\n'\n".encode()).decode(),
    )
    received = b""
    deadline = time.monotonic() + 5
    while marker.encode() not in received and time.monotonic() < deadline:
        frame = _receive(first_stream)
        if frame.get("type") == "output":
            received += base64.b64decode(frame["data"])
    assert marker.encode() in received
    first.close()
    first_stream.close()

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        session = await backend.require_workspace_session(workspace, created.name)
        if not session.attached:
            break
        await asyncio.sleep(0.02)
    assert session.attached is False

    second, second_stream = _connect(socket_path)
    _send(
        second,
        op="attach",
        session_name=created.name,
        cols=120,
        rows=36,
    )
    assert _receive(second_stream)["type"] == "attached"
    replay = _receive(second_stream)
    assert replay["replay"] is True
    assert marker.encode() in base64.b64decode(replay["data"])
    second.close()
    second_stream.close()

    snapshot = await backend.capture_session(workspace, created.name, 200)
    assert marker in snapshot.content
    assert backend.attach_command(created.name)[-1] == created.name


@pytest.mark.asyncio
async def test_native_backend_conflicts_and_daemon_stop_are_fail_closed(
    tmp_path, native_backend
):
    backend, socket_path, _state_dir = native_backend
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    created = await backend.create_session(
        workspace, "Workspace", requested_name="one", mode="shell"
    )

    with pytest.raises(SessionBackendError) as duplicate:
        await backend.create_session(
            workspace, "Workspace", requested_name="one", mode="shell"
        )
    assert duplicate.value.status_code == 409

    with pytest.raises(SessionBackendError, match="letters, numbers"):
        await backend.rename_session(
            workspace, "Workspace", created.name, "unsafe:name"
        )

    with pytest.raises(Exception) as stop_error:
        request({"op": "stop", "force": False}, socket_path=socket_path)
    assert getattr(stop_error.value, "status_code", None) == 409

    await backend.kill_session(workspace, created.name)
