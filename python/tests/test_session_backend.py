from datetime import datetime, timezone

import pytest

from dolphin_terminal import tmux_service
from dolphin_terminal.session_backend import (
    NativeSessionBackend,
    TmuxSessionBackend,
    create_session_backend,
)


def _session():
    return tmux_service.TmuxSessionInfo(
        name="alpha",
        path="/work/alpha",
        created_at=datetime.now(timezone.utc),
        windows=1,
        attached=False,
        current_command="bash",
        is_codex_running=False,
    )


def test_tmux_backend_health_and_attach_command(monkeypatch):
    monkeypatch.setattr(tmux_service, "tmux_binary", lambda: "/usr/bin/tmux")
    backend = TmuxSessionBackend()

    assert backend.health().available is True
    assert backend.health().executable == "/usr/bin/tmux"
    assert backend.attach_command("alpha") == (
        "/usr/bin/tmux",
        "attach-session",
        "-t",
        "alpha",
    )
    assert create_session_backend(" TMUX ").id == "tmux"


def test_tmux_backend_reports_missing_executable(monkeypatch):
    def unavailable():
        raise tmux_service.TmuxServiceError("tmux is missing", 500)

    monkeypatch.setattr(tmux_service, "tmux_binary", unavailable)
    health = TmuxSessionBackend().health()

    assert health.available is False
    assert health.detail == "tmux is missing"
    assert isinstance(create_session_backend("native"), NativeSessionBackend)
    with pytest.raises(ValueError, match="Installed backends: native, tmux"):
        create_session_backend("screen")


@pytest.mark.asyncio
async def test_tmux_backend_delegates_without_changing_session_semantics(
    tmp_path, monkeypatch
):
    expected = _session()
    observed = []

    async def create(path, name, *, requested_name, mode):
        observed.append((path, name, requested_name, mode))
        return expected

    monkeypatch.setattr(tmux_service, "create_session", create)
    result = await TmuxSessionBackend().create_session(
        tmp_path, "Alpha", requested_name="review", mode="shell"
    )

    assert result.name == expected.name
    assert result.path == expected.path
    assert observed == [(tmp_path, "Alpha", "review", "shell")]


@pytest.mark.asyncio
async def test_tmux_errors_are_translated_to_provider_neutral_errors(
    tmp_path, monkeypatch
):
    from dolphin_terminal.session_backend import SessionBackendError

    async def reject(_path, _name, *, requested_name, mode):
        raise tmux_service.TmuxServiceError(
            f"duplicate {requested_name} in {mode}", 409
        )

    monkeypatch.setattr(tmux_service, "create_session", reject)

    with pytest.raises(SessionBackendError) as error:
        await TmuxSessionBackend().create_session(
            tmp_path, "Alpha", requested_name="review", mode="shell"
        )

    assert error.value.status_code == 409
    assert error.value.detail == "duplicate review in shell"
