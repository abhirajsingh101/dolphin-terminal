import asyncio
import importlib
import os
import re
import time
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, PngImagePlugin


def _service():
    """Import inside tests so the RED run targets the new generic service."""
    return importlib.import_module("dolphin_terminal.terminal_attachment_service")


def _png_bytes(*, metadata: bool = False) -> bytes:
    image = Image.new("RGBA", (3, 2), (12, 34, 56, 200))
    output = BytesIO()
    pnginfo = None
    if metadata:
        pnginfo = PngImagePlugin.PngInfo()
        pnginfo.add_text("Comment", "private metadata")
    image.save(output, format="PNG", pnginfo=pnginfo)
    image.close()
    return output.getvalue()


async def test_store_keeps_an_opaque_file_private_with_a_generated_name(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    payload = b"meeting notes\nline two\n"

    stored = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="meeting notes.txt",
        content_type="text/plain; charset=utf-8",
        data=payload,
    )

    path = Path(stored.path)
    assert path.parent == root.resolve() / "project-alpha"
    assert path.name != "meeting notes.txt"
    assert re.fullmatch(r"[0-9a-f]{32}\.txt", path.name)
    assert path.read_bytes() == payload
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert stored.original_name == "meeting notes.txt"
    assert stored.kind == "file"
    assert stored.content_type == "text/plain"
    assert stored.width is None
    assert stored.height is None
    assert stored.expires_at > stored.created_at


@pytest.mark.asyncio
async def test_generic_store_still_sanitizes_png_content(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))

    stored = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="capture.png",
        content_type="application/octet-stream",
        data=_png_bytes(metadata=True),
    )

    path = Path(stored.path)
    assert stored.kind == "image"
    assert stored.content_type == "image/png"
    assert stored.width == 3
    assert stored.height == 2
    with Image.open(path, formats=["PNG"]) as sanitized:
        sanitized.load()
        assert sanitized.size == (3, 2)
        assert "Comment" not in sanitized.info


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("original_name", "data", "status_code"),
    [
        ("../private.txt", b"safe bytes", 400),
        ("folder/private.txt", b"safe bytes", 400),
        ("bad\x00name.txt", b"safe bytes", 400),
        ("empty.txt", b"", 400),
        ("large.bin", b"12345", 413),
    ],
)
async def test_generic_store_rejects_unsafe_names_empty_and_oversized_files(
    tmp_path,
    monkeypatch,
    original_name,
    data,
    status_code,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")

    with pytest.raises(service.TerminalAttachmentError) as exc_info:
        await service.store_terminal_attachment(
            project_id="project-alpha",
            original_name=original_name,
            content_type="application/octet-stream",
            data=data,
        )

    assert exc_info.value.status_code == status_code
    assert not root.exists()


@pytest.mark.asyncio
async def test_explicit_cleanup_removes_expired_managed_and_temp_files_only(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_RETENTION_SECONDS", "60")

    expired = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="expired.txt",
        content_type="text/plain",
        data=b"expired",
    )
    active = await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="active.pdf",
        content_type="application/pdf",
        data=b"%PDF-active",
    )
    removable = await service.store_terminal_attachment(
        project_id="project-empty",
        original_name="expired.bin",
        content_type="application/octet-stream",
        data=b"expired",
    )

    project_root = Path(expired.path).parent
    temp_path = project_root / f".{'a' * 32}.{'b' * 32}.tmp"
    temp_path.write_bytes(b"stale temp")
    unmanaged = project_root / "keep-me.txt"
    unmanaged.write_text("not managed by Dolphin")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    symlink = project_root / "outside-link"
    symlink.symlink_to(outside)
    old_time = time.time() - 120
    for path in (Path(expired.path), Path(removable.path), temp_path):
        os.utime(path, (old_time, old_time))

    result = await service.prune_terminal_attachments()

    assert result.deleted_files == 2
    assert result.deleted_temp_files == 1
    assert not Path(expired.path).exists()
    assert not Path(removable.path).exists()
    assert not temp_path.exists()
    assert Path(active.path).exists()
    assert unmanaged.read_text() == "not managed by Dolphin"
    assert symlink.is_symlink()
    assert outside.read_text() == "outside"
    assert not (root / "project-empty").exists()


def test_generic_environment_overrides_legacy_image_environment(
    tmp_path,
    monkeypatch,
):
    service = _service()
    generic_root = tmp_path / "generic"
    legacy_root = tmp_path / "legacy"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(generic_root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_IMAGE_ROOT", str(legacy_root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "1234")
    monkeypatch.setenv("DOLPHIN_TERMINAL_IMAGE_MAX_BYTES", "5678")

    settings = service.terminal_attachment_settings()

    assert settings.root == generic_root.resolve()
    assert settings.max_attachment_bytes == 1234
    assert settings.max_image_bytes == 1234


def test_default_limits_allow_600_mib_per_file_and_one_full_batch(
    monkeypatch,
):
    service = _service()
    for name in (
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES",
        "DOLPHIN_TERMINAL_IMAGE_MAX_BYTES",
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES",
        "DOLPHIN_TERMINAL_IMAGE_MAX_STORAGE_BYTES",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = service.terminal_attachment_settings()

    assert settings.max_attachment_bytes == 600 * 1024 * 1024
    assert settings.max_storage_bytes == 4 * 1024 * 1024 * 1024
    assert settings.max_storage_bytes > 4 * settings.max_attachment_bytes


@pytest.mark.asyncio
async def test_stream_store_publishes_exact_limit_without_joining_chunks(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "16")

    async def chunks():
        yield b"12"
        yield b"34"

    stored = await service.store_terminal_attachment_stream(
        project_id="project-alpha",
        original_name="archive.bin",
        content_type="application/octet-stream",
        chunks=chunks(),
        content_length=4,
    )

    path = Path(stored.path)
    assert path.read_bytes() == b"1234"
    assert stored.size_bytes == 4
    assert path.stat().st_mode & 0o777 == 0o600
    assert not list(path.parent.glob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_rejects_actual_overflow_and_removes_temp_file(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "4")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "16")

    async def chunks():
        yield b"123"
        yield b"45"

    with pytest.raises(service.TerminalAttachmentError) as exc_info:
        await service.store_terminal_attachment_stream(
            project_id="project-alpha",
            original_name="archive.bin",
            content_type="application/octet-stream",
            chunks=chunks(),
            content_length=1,
        )

    assert exc_info.value.status_code == 413
    if root.exists():
        assert not list(root.rglob("*.bin"))
        assert not list(root.rglob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_sanitizes_image_from_staged_file(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    payload = _png_bytes(metadata=True)
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv(
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES",
        str(len(payload) + 1024),
    )
    monkeypatch.setenv(
        "DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES",
        str(len(payload) * 4),
    )

    async def chunks():
        midpoint = len(payload) // 2
        yield payload[:midpoint]
        yield payload[midpoint:]

    stored = await service.store_terminal_attachment_stream(
        project_id="project-alpha",
        original_name="capture.png",
        content_type="application/octet-stream",
        chunks=chunks(),
        content_length=len(payload),
    )

    path = Path(stored.path)
    assert stored.kind == "image"
    assert stored.content_type == "image/png"
    with Image.open(path, formats=["PNG"]) as sanitized:
        sanitized.load()
        assert sanitized.size == (3, 2)
        assert "Comment" not in sanitized.info
    assert not list(path.parent.glob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_cancellation_removes_only_its_temp_file(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "16")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "32")

    async def chunks():
        yield b"partial"
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await service.store_terminal_attachment_stream(
            project_id="project-alpha",
            original_name="cancelled.bin",
            content_type="application/octet-stream",
            chunks=chunks(),
            content_length=10,
        )

    if root.exists():
        assert not list(root.rglob("*.bin"))
        assert not list(root.rglob(".*.tmp"))


@pytest.mark.asyncio
async def test_stream_store_rejects_declared_upload_when_quota_cannot_fit_it(
    tmp_path,
    monkeypatch,
):
    service = _service()
    root = tmp_path / "terminal-attachments"
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_ROOT", str(root))
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES", "8")
    monkeypatch.setenv("DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES", "8")

    await service.store_terminal_attachment(
        project_id="project-alpha",
        original_name="existing.bin",
        content_type="application/octet-stream",
        data=b"123456",
    )

    async def chunks():
        yield b"789"

    with pytest.raises(service.TerminalAttachmentError) as exc_info:
        await service.store_terminal_attachment_stream(
            project_id="project-alpha",
            original_name="over-quota.bin",
            content_type="application/octet-stream",
            chunks=chunks(),
            content_length=3,
        )

    assert exc_info.value.status_code == 507
    assert len(list(root.rglob("*.bin"))) == 1
    assert not list(root.rglob(".*.tmp"))
