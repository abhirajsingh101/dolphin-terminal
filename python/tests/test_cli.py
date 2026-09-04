from pathlib import Path

import pytest

from dolphin_terminal.__main__ import _arguments, _serve_settings
from dolphin_terminal.config import ConfigurationError


def test_bare_workspace_path_implies_serve():
    args = _arguments(["/work/project", "--no-open"])

    assert args.command == "serve"
    assert args.workspaces == ["/work/project"]
    assert args.open is False


def test_serve_defaults_to_current_directory_and_packaged_ui(tmp_path, monkeypatch):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("ready")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(workspace)
    monkeypatch.setenv("DOLPHIN_TERMINAL_STATIC_DIR", str(static_dir))
    monkeypatch.delenv("DOLPHIN_TERMINAL_WORKSPACES", raising=False)

    settings = _serve_settings(_arguments(["serve", "--no-open"]))

    assert settings.static_dir == static_dir.resolve()
    assert settings.workspaces[0].path == workspace.resolve()
    assert settings.dictation_enabled is False


def test_serve_fails_clearly_when_compiled_ui_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "dolphin_terminal.config.Settings.discover_static_dir",
        staticmethod(lambda: None),
    )
    monkeypatch.delenv("DOLPHIN_TERMINAL_STATIC_DIR", raising=False)

    with pytest.raises(ConfigurationError, match="compiled interface is missing"):
        _serve_settings(_arguments(["serve", str(Path(tmp_path)), "--no-open"]))
