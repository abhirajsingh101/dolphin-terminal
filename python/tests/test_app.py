from datetime import datetime, timezone

from fastapi.testclient import TestClient

from dolphin_terminal import app as gateway
from dolphin_terminal.config import Settings, Workspace
from dolphin_terminal.dictation_service import DictationServiceError
from dolphin_terminal.session_backend import SessionBackendError, SessionBackendHealth
from dolphin_terminal.tmux_service import TmuxSessionInfo


def _session(name: str = "alpha-shell") -> TmuxSessionInfo:
    return TmuxSessionInfo(
        name=name,
        path="/tmp/alpha",
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
        has_recent_activity=False,
    )


class FakeSessionBackend:
    id = "fake"

    def __init__(self):
        self.sessions = []
        self.observed = []
        self.require_error = None

    def health(self):
        return SessionBackendHealth(self.id, True, "Fake backend is ready.")

    def attach_command(self, session_name):
        return ("true", session_name)

    async def list_workspace_sessions(self, workspace_path):
        self.observed.append(("list", workspace_path))
        return self.sessions

    async def create_session(
        self, workspace_path, workspace_name, *, requested_name, mode
    ):
        self.observed.append(
            ("create", workspace_path, workspace_name, requested_name, mode)
        )
        return _session("alpha-new")

    async def rename_session(
        self, workspace_path, workspace_name, session_name, requested_name
    ):
        self.observed.append(
            (
                "rename",
                workspace_path,
                workspace_name,
                session_name,
                requested_name,
            )
        )
        return _session("alpha-renamed")

    async def kill_session(self, workspace_path, session_name):
        self.observed.append(("kill", workspace_path, session_name))

    async def capture_session(self, _workspace_path, session_name, _lines):
        raise AssertionError(f"Unexpected snapshot for {session_name}")

    async def require_workspace_session(self, _workspace_path, _session_name):
        if self.require_error:
            raise self.require_error
        return _session()

    async def pane_current_paths(self, _session_name):
        return []


def _client(
    tmp_path, *, dictation_enabled=False, backend=None
) -> tuple[TestClient, Workspace, FakeSessionBackend]:
    workspace = Workspace("alpha", "Alpha", tmp_path.resolve(), "🐬")
    settings = Settings(
        (workspace,),
        ("http://127.0.0.1:8734",),
        dictation_enabled=dictation_enabled,
    )
    resolved_backend = backend or FakeSessionBackend()
    return (
        TestClient(gateway.create_app(settings, session_backend=resolved_backend)),
        workspace,
        resolved_backend,
    )


def test_workspace_inventory_and_status(tmp_path, monkeypatch):
    client, workspace, backend = _client(tmp_path)
    backend.sessions = [_session()]
    assert client.get("/health").json()["workspace_count"] == 1
    assert client.get("/terminal/v1/workspaces").json() == [workspace.descriptor()]

    response = client.get("/terminal/v1/workspaces/alpha")
    assert response.status_code == 200
    assert response.json()["sessions"][0]["name"] == "alpha-shell"
    assert response.json()["sessions"][0]["rename_allowed"] is True


def test_session_mutations_stay_scoped_to_resolved_workspace(tmp_path, monkeypatch):
    client, workspace, backend = _client(tmp_path)

    assert (
        client.post(
            "/terminal/v1/workspaces/alpha/sessions",
            json={"name": "new", "mode": "shell"},
        ).status_code
        == 201
    )
    assert (
        client.patch(
            "/terminal/v1/workspaces/alpha/sessions/alpha-new", json={"name": "renamed"}
        ).status_code
        == 200
    )
    assert (
        client.delete(
            "/terminal/v1/workspaces/alpha/sessions/alpha-renamed"
        ).status_code
        == 204
    )
    assert all(item[1] == workspace.path for item in backend.observed)
    assert client.get("/terminal/v1/workspaces/missing").status_code == 404


def test_download_route_cannot_leave_allowlist(tmp_path):
    client, _, _ = _client(tmp_path)
    artifact = tmp_path / "artifact.txt"
    artifact.write_text("verified\n")

    allowed = client.get("/terminal/v1/files", params={"path": str(artifact)})
    denied = client.get("/terminal/v1/files", params={"path": "/etc/passwd"})

    assert allowed.status_code == 200
    assert allowed.content == b"verified\n"
    assert allowed.headers["x-content-type-options"] == "nosniff"
    assert denied.status_code == 403


def test_missing_workspace_path_fails_before_backend_mutation(tmp_path):
    missing = tmp_path / "missing"
    workspace = Workspace("missing", "Missing", missing.resolve(), "⌁")
    settings = Settings((workspace,), ("http://127.0.0.1:8733",))
    backend = FakeSessionBackend()
    client = TestClient(gateway.create_app(settings, session_backend=backend))

    status = client.get("/terminal/v1/workspaces/missing")
    create = client.post(
        "/terminal/v1/workspaces/missing/sessions",
        json={"name": "unsafe", "mode": "shell"},
    )

    assert status.status_code == 200
    assert status.json()["is_allowed"] is True
    assert status.json()["path_exists"] is False
    assert create.status_code == 404
    assert backend.observed == []


def test_unconfigured_automation_is_truthful(tmp_path, monkeypatch):
    client, _, _ = _client(tmp_path)
    path = "/terminal/v1/workspaces/alpha/sessions/alpha-shell/automation"

    status = client.get(path)
    enabled = client.put(path, json={"mode": "active", "goal": "finish"})

    assert status.json()["available"] is False
    assert status.json()["mode"] == "off"
    assert enabled.status_code == 409


def test_automation_rejects_a_session_outside_the_workspace(tmp_path, monkeypatch):
    client, _, backend = _client(tmp_path)
    backend.require_error = SessionBackendError(
        "Session not found in this workspace.", 404
    )
    response = client.get("/terminal/v1/workspaces/alpha/sessions/elsewhere/automation")
    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found in this workspace."


def test_dictation_status_and_preview_proxy(tmp_path, monkeypatch):
    client, _, _ = _client(tmp_path, dictation_enabled=True)
    observed = {}

    async def status():
        return {"available": True, "ready": True, "status": "ok", "model": "local"}

    async def transcribe(audio, **options):
        observed["audio"] = audio
        observed.update(options)
        return {
            "text": "hello terminal",
            "language": "en",
            "engine": "test",
            "model": "local",
            "device": "cpu",
            "duration_ms": 4,
            "preview": options["preview"],
        }

    monkeypatch.setattr(gateway, "dictation_status", status)
    monkeypatch.setattr(gateway, "transcribe_audio", transcribe)

    assert client.get("/terminal/v1/dictation/status").json()["ready"] is True
    response = client.post(
        "/terminal/v1/dictation/transcribe",
        content=b"recording",
        headers={
            "Content-Type": "audio/webm",
            "X-Audio-Filename": "speech.webm",
            "X-Dictation-Language": "en",
            "X-Dictation-Mode": "preview",
        },
    )
    assert response.status_code == 200
    assert response.json()["text"] == "hello terminal"
    assert observed == {
        "audio": b"recording",
        "content_type": "audio/webm",
        "filename": "speech.webm",
        "language": "en",
        "preview": True,
    }


def test_dictation_proxy_bounds_and_maps_worker_errors(tmp_path, monkeypatch):
    client, _, _ = _client(tmp_path, dictation_enabled=True)
    monkeypatch.setattr(gateway, "MAX_AUDIO_BYTES", 4)
    oversized = client.post(
        "/terminal/v1/dictation/transcribe",
        content=b"12345",
        headers={"Content-Type": "audio/webm"},
    )
    assert oversized.status_code == 413

    async def unavailable(_audio, **_options):
        raise DictationServiceError("Local speech recognition is offline.", 503)

    monkeypatch.setattr(gateway, "MAX_AUDIO_BYTES", 16)
    monkeypatch.setattr(gateway, "transcribe_audio", unavailable)
    failed = client.post(
        "/terminal/v1/dictation/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )
    assert failed.status_code == 503
    assert failed.json()["detail"] == "Local speech recognition is offline."


def test_optional_capabilities_are_disabled_by_default(tmp_path):
    client, _, _ = _client(tmp_path)

    capabilities = client.get("/terminal/v1/capabilities").json()
    status = client.get("/terminal/v1/dictation/status").json()
    transcribe = client.post(
        "/terminal/v1/dictation/transcribe",
        content=b"audio",
        headers={"Content-Type": "audio/webm"},
    )

    assert capabilities == {
        "session_backend": {
            "id": "fake",
            "available": True,
            "detail": "Fake backend is ready.",
        },
        "dictation": {"enabled": False},
        "automation": {"enabled": False},
    }
    assert status["status"] == "disabled"
    assert transcribe.status_code == 404
