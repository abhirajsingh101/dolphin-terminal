"""Public v1 HTTP contract for the standalone gateway."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SessionResponse(BaseModel):
    name: str
    path: str
    created_at: datetime
    windows: int
    attached: bool
    current_command: str | None = None
    is_codex_running: bool = False
    is_claude_code_running: bool = False
    has_recent_activity: bool = False
    rename_allowed: bool = True
    rename_block_reason: str | None = None


class WorkspaceResponse(BaseModel):
    project_id: str
    path: str | None = None
    path_exists: bool
    is_directory: bool
    is_allowed: bool
    message: str
    session_count: int
    sessions: list[SessionResponse] = Field(default_factory=list)


class SessionCreate(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    mode: Literal["shell"] = "shell"


class SessionRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class PathResolveRequest(BaseModel):
    session_name: str | None = None
    candidates: list[str] = Field(max_length=300)


class AutomationUpdate(BaseModel):
    mode: Literal["off", "learn", "active"]
    goal: str = ""
    max_turns: int = Field(default=8, ge=1, le=100)
    max_minutes: int = Field(default=30, ge=1, le=1440)
    max_failures: int = Field(default=3, ge=1, le=10)
    send_delay_seconds: int = Field(default=5, ge=3, le=30)


class BriefContent(BaseModel):
    purpose: str = ""
    user_intent: str = ""
    direction: str = ""
    goals: list[str] = Field(default_factory=list)
    working_preferences: list[str] = Field(default_factory=list)
    success_signals: list[str] = Field(default_factory=list)
    boundaries: list[str] = Field(default_factory=list)
