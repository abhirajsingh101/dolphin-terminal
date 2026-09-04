import os
from pathlib import Path

import pytest

from dolphin_terminal.config import (
    ConfigurationError,
    Settings,
    Workspace,
    parse_workspaces,
)


def test_plain_and_named_workspace_entries_are_stable(tmp_path):
    alpha = tmp_path / "Alpha Project"
    beta = tmp_path / "beta"

    parsed = parse_workspaces(f"{alpha}:docs={beta}")

    assert parsed[0].id == "alpha-project"
    assert parsed[0].path == alpha.resolve()
    assert parsed[1].id == "docs"
    assert parsed[1].path == beta.resolve()


def test_json_workspace_entries_preserve_display_metadata(tmp_path):
    parsed = parse_workspaces(
        '[{"id":"agent-lab","name":"Agent Lab","emoji":"🐬","path":"'
        + str(tmp_path)
        + '"}]'
    )

    assert parsed[0].descriptor() == {
        "id": "agent-lab",
        "name": "Agent Lab",
        "emoji": "🐬",
        "path": str(tmp_path.resolve()),
    }


def test_duplicate_ids_fail_closed(tmp_path):
    with pytest.raises(ConfigurationError, match="unique"):
        parse_workspaces(f"same={tmp_path}:same={tmp_path / 'other'}")


def test_settings_publish_only_the_explicit_roots(tmp_path, monkeypatch):
    first = Workspace("first", "First", (tmp_path / "first").resolve())
    second = Workspace("second", "Second", (tmp_path / "second").resolve())
    settings = Settings((first, second), ("http://127.0.0.1:8734",))

    settings.apply_workspace_roots()

    assert os.environ["DOLPHIN_TERMINAL_WORKSPACE_ROOTS"] == os.pathsep.join(
        (str(first.path), str(second.path))
    )
    assert parse_workspaces("") == ()
    assert Path(first.path).is_absolute()
    assert monkeypatch is not None
