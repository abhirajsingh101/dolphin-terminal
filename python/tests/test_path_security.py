import pytest

from dolphin_terminal.terminal_path_service import (
    resolve_download_target,
    resolve_terminal_paths,
)
from dolphin_terminal.workspace_file_service import WorkspaceFileError


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.ts").write_text("export {};\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret\n")
    (root / "escape").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("DOLPHIN_TERMINAL_WORKSPACE_ROOTS", str(root))
    return root, outside


def test_resolves_workspace_files_and_rejects_escapes(workspace):
    root, outside = workspace
    results = resolve_terminal_paths(
        ["src/app.ts", str(outside / "secret.txt"), "escape/secret.txt", "/etc/passwd"],
        bases=[root],
    )

    assert results[0].kind == "file"
    assert [item.kind for item in results[1:]] == ["denied", "denied", "denied"]


def test_download_revalidates_and_refuses_symlinks(workspace):
    root, outside = workspace
    allowed_root, relative = resolve_download_target(str(root / "src" / "app.ts"))
    assert allowed_root == root
    assert relative == "src/app.ts"

    for candidate, status in [
        (str(outside / "secret.txt"), 403),
        (str(root / "escape" / "secret.txt"), 403),
        (str(root / "src"), 415),
        ("src/app.ts", 400),
    ]:
        with pytest.raises(WorkspaceFileError) as error:
            resolve_download_target(candidate)
        assert error.value.status_code == status
