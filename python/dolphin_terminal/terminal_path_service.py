"""Resolving path-shaped tokens from terminal output to downloadable files.

Terminal output is untrusted text. Every candidate that comes out of it is a
string that *wants* to become a filesystem path, and the only way it does is by
surviving, in order: length and control-character checks, lexical
normalisation, containment in a configured workspace root, and a dir-fd walk
from that root that refuses a symlink at every component.

Normalisation is deliberately lexical (``os.path.normpath``) and never
``Path.resolve()``. ``resolve()`` follows symlinks, so a link inside a root
could launder a path to a target outside it and still satisfy the containment
check that comes afterwards. ``tests/test_terminal_path_service.py`` pins that
case directly.

The search bases for relative candidates are supplied by the caller and are
derived server-side in ``main.py`` — never accepted from a client, which could
otherwise nominate ``/`` and enumerate the filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import stat
from typing import Literal, Sequence

from .workspace_file_service import WorkspaceFileError, lstat_within_root
from .workspace_service import workspace_roots

MAX_CANDIDATES = 300
MAX_CANDIDATE_LENGTH = 4096

ResolvedKind = Literal[
    "file",
    "directory",
    "symlink",
    "special",
    "missing",
    "denied",
]


@dataclass(frozen=True)
class ResolvedTerminalPath:
    candidate: str
    path: str | None
    kind: ResolvedKind
    size_bytes: int | None = None


def _expand(candidate: str) -> str | None:
    """Normalise one raw candidate, or None if it cannot be a path at all."""
    if not candidate or len(candidate) > MAX_CANDIDATE_LENGTH:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in candidate):
        return None
    if candidate.startswith("~"):
        expanded = os.path.expanduser(candidate)
        # expanduser returns its input unchanged for an unknown ~user.
        return None if expanded.startswith("~") else expanded
    return candidate


def _absolute_forms(expanded: str, bases: Sequence[Path]) -> list[Path]:
    if os.path.isabs(expanded):
        return [Path(os.path.normpath(expanded))]
    return [Path(os.path.normpath(os.path.join(str(base), expanded))) for base in bases]


def _root_for(path: Path) -> Path | None:
    for root in workspace_roots():
        if path == root or root in path.parents:
            return root
    return None


def _classify(path: Path) -> ResolvedTerminalPath | None:
    """Classify one absolute, already-normalised path.

    Returns None when the path is not usable at all — outside every root, or
    behind a component the safe walk refused — so the caller can try the next
    base before giving up.
    """
    root = _root_for(path)
    if root is None:
        return None
    if path == root:
        return ResolvedTerminalPath(str(path), str(path), "directory", None)

    try:
        info = lstat_within_root(root, path.relative_to(root).as_posix())
    except WorkspaceFileError as error:
        if error.status_code == 404:
            return ResolvedTerminalPath(str(path), None, "missing", None)
        return None

    mode = info.st_mode
    if stat.S_ISLNK(mode):
        return ResolvedTerminalPath(str(path), str(path), "symlink", None)
    if stat.S_ISDIR(mode):
        return ResolvedTerminalPath(str(path), str(path), "directory", None)
    if stat.S_ISREG(mode):
        return ResolvedTerminalPath(str(path), str(path), "file", info.st_size)
    return ResolvedTerminalPath(str(path), str(path), "special", None)


def resolve_terminal_paths(
    candidates: Sequence[str],
    *,
    bases: Sequence[Path],
) -> list[ResolvedTerminalPath]:
    """Resolve candidate tokens against the given base directories.

    A candidate that misses in one base is still tried against the rest: the
    pane's working directory is searched first because that is what an agent
    prints paths relative to, but a miss there must not shadow a hit in the
    project root.
    """
    results: list[ResolvedTerminalPath] = []

    for candidate in list(candidates)[:MAX_CANDIDATES]:
        expanded = _expand(candidate)
        resolved: ResolvedTerminalPath | None = None

        if expanded is not None:
            for absolute in _absolute_forms(expanded, bases):
                found = _classify(absolute)
                if found is None:
                    continue
                if resolved is None or found.kind != "missing":
                    resolved = found
                if found.kind != "missing":
                    break

        results.append(
            ResolvedTerminalPath(candidate, None, "denied", None)
            if resolved is None
            else ResolvedTerminalPath(
                candidate,
                resolved.path,
                resolved.kind,
                resolved.size_bytes,
            )
        )

    return results


def resolve_download_target(raw_path: str) -> tuple[Path, str]:
    """Validate an absolute path and return ``(root, relative_path)``.

    Runs every check in this module again from scratch. What the resolve
    endpoint returned is a rendering hint; this is the security boundary, and a
    request that never called resolve at all is subject to exactly the same
    checks.
    """
    expanded = _expand(raw_path)
    if expanded is None or not os.path.isabs(expanded):
        raise WorkspaceFileError("An absolute file path is required.", 400)

    path = Path(os.path.normpath(expanded))
    root = _root_for(path)
    if root is None or path == root:
        raise WorkspaceFileError(
            "That path is outside the allowed workspace roots.",
            403,
        )

    relative = path.relative_to(root).as_posix()
    info = lstat_within_root(root, relative)
    if stat.S_ISLNK(info.st_mode):
        raise WorkspaceFileError("Symbolic links cannot be opened.", 403)
    if not stat.S_ISREG(info.st_mode):
        raise WorkspaceFileError("Only regular files can be downloaded.", 415)
    return root, relative
