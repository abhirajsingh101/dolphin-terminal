"""One-command entry point for the self-hosted Dolphin Terminal."""

from __future__ import annotations

import argparse
from dataclasses import replace
import ipaddress
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import webbrowser

import uvicorn

from .config import ConfigurationError, Settings, parse_workspaces
from .session_backend import create_session_backend


VERSION = "0.3.0"


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _same_origin_entries(port: int) -> tuple[str, ...]:
    return (
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dolphin-terminal",
        description="Persistent, agent-oriented terminal workspaces in your browser.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    subcommands = parser.add_subparsers(dest="command")

    serve = subcommands.add_parser(
        "serve", help="start the complete gateway and compiled web interface"
    )
    serve.add_argument(
        "workspaces",
        metavar="WORKSPACE",
        nargs="*",
        help="trusted path or stable-id=/path; defaults to the current directory",
    )
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument(
        "--session-backend",
        choices=("native", "tmux"),
        default=None,
        help="persistent session provider; native is self-contained, tmux preserves existing tmux sessions",
    )
    serve.add_argument(
        "--dictation",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="enable the optional configured local speech provider",
    )
    serve.add_argument(
        "--ui",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="serve the compiled standalone interface from the gateway",
    )
    serve.add_argument(
        "--static-dir",
        type=Path,
        default=None,
        help="compiled UI directory (normally discovered automatically)",
    )
    serve.add_argument(
        "--open",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="open the local URL in the default browser",
    )
    serve.add_argument(
        "--allow-remote",
        action="store_true",
        help="acknowledge that a trusted authentication/TLS proxy protects a non-loopback bind",
    )

    doctor = subcommands.add_parser(
        "doctor", help="check the packaged UI, session backend and configuration"
    )
    doctor.add_argument("--json", action="store_true", dest="as_json")
    return parser


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    raw = list(sys.argv[1:] if argv is None else argv)
    if not raw:
        raw = ["serve"]
    elif raw[0] not in {"serve", "doctor", "-h", "--help", "--version"}:
        raw.insert(0, "serve")
    return _parser().parse_args(raw)


def _serve_settings(args: argparse.Namespace) -> Settings:
    settings = Settings.from_environment()
    if args.workspaces:
        settings = replace(
            settings,
            workspaces=parse_workspaces(os.pathsep.join(args.workspaces)),
        )
    elif not settings.workspaces:
        settings = replace(settings, workspaces=parse_workspaces(str(Path.cwd())))

    host = args.host or settings.host
    port = args.port or settings.port
    backend = args.session_backend or settings.session_backend
    dictation_enabled = (
        settings.dictation_enabled if args.dictation is None else bool(args.dictation)
    )
    static_dir = args.static_dir.resolve() if args.static_dir else settings.static_dir
    if args.ui and (static_dir is None or not (static_dir / "index.html").is_file()):
        raise ConfigurationError(
            "The compiled interface is missing. Run `npm run build` when using a "
            "source checkout, or install a release package that includes the UI."
        )
    if not args.ui:
        static_dir = None

    origins = tuple(
        dict.fromkeys((*settings.allowed_origins, *_same_origin_entries(port)))
    )
    resolved = replace(
        settings,
        host=host,
        port=port,
        session_backend=backend,
        dictation_enabled=dictation_enabled,
        static_dir=static_dir,
        allowed_origins=origins,
    )
    resolved.apply_workspace_roots()
    return resolved


def doctor_report() -> dict[str, object]:
    settings = Settings.from_environment()
    try:
        backend = create_session_backend(settings.session_backend)
        health = backend.health()
        backend_result = {
            "id": health.id,
            "available": health.available,
            "detail": health.detail,
            "executable": health.executable,
        }
    except ValueError as error:
        backend_result = {
            "id": settings.session_backend,
            "available": False,
            "detail": str(error),
            "executable": None,
        }
    ui_available = bool(
        settings.static_dir and (settings.static_dir / "index.html").is_file()
    )
    return {
        "ready": bool(backend_result["available"] and ui_available),
        "version": VERSION,
        "python": sys.version.split()[0],
        "session_backend": backend_result,
        "ui": {
            "available": ui_available,
            "path": str(settings.static_dir) if settings.static_dir else None,
        },
        "dictation": {
            "enabled": settings.dictation_enabled,
            "provider_url": os.getenv("DOLPHIN_TERMINAL_ASR_URL")
            if settings.dictation_enabled
            else None,
        },
        "source_tools": {
            "node": shutil.which("node"),
            "npm": shutil.which("npm"),
        },
    }


def _run_doctor(as_json: bool) -> int:
    report = doctor_report()
    if as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        backend = report["session_backend"]
        ui = report["ui"]
        dictation = report["dictation"]
        assert isinstance(backend, dict)
        assert isinstance(ui, dict)
        assert isinstance(dictation, dict)
        print(f"Dolphin Terminal {report['version']}")
        print(
            f"  session backend: {'ready' if backend['available'] else 'missing'} "
            f"({backend['id']})"
        )
        print(f"  compiled UI:     {'ready' if ui['available'] else 'missing'}")
        print(
            f"  dictation:       {'enabled' if dictation['enabled'] else 'optional / disabled'}"
        )
    return 0 if report["ready"] else 1


def _run_server(args: argparse.Namespace) -> int:
    settings = _serve_settings(args)
    if not _is_loopback(settings.host) and not (
        args.allow_remote or os.getenv("DOLPHIN_TERMINAL_ALLOW_REMOTE") == "1"
    ):
        raise ConfigurationError(
            "Refusing a non-loopback bind. Use --allow-remote only behind trusted "
            "TLS, authentication and authorization."
        )

    backend = create_session_backend(settings.session_backend)
    backend_health = backend.health()
    if not backend_health.available:
        raise ConfigurationError(
            f"Persistent session backend is unavailable: {backend_health.detail}"
        )

    from .app import create_app

    application = create_app(settings, session_backend=backend)
    browser_host = "127.0.0.1" if not _is_loopback(settings.host) else settings.host
    url = f"http://{browser_host}:{settings.port}"
    print(f"Dolphin Terminal {VERSION}")
    print(f"  URL:        {url}")
    print(f"  workspaces: {len(settings.workspaces)}")
    print(f"  sessions:   {settings.session_backend} backend")
    print(
        "  dictation:  "
        + ("enabled" if settings.dictation_enabled else "optional / disabled")
    )
    if args.open:
        timer = threading.Timer(0.8, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    uvicorn.run(application, host=settings.host, port=settings.port, reload=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        args = _arguments(argv)
        if args.command == "doctor":
            return _run_doctor(args.as_json)
        return _run_server(args)
    except (ConfigurationError, ValueError) as error:
        print(f"dolphin-terminal: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
