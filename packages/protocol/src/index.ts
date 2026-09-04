export interface TerminalWorkspaceDescriptor {
  id: string;
  name: string;
  emoji: string;
  path: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface TerminalSession {
  name: string;
  path: string;
  created_at: string;
  windows: number;
  attached: boolean;
  current_command: string | null;
  is_codex_running: boolean;
  is_claude_code_running: boolean;
  has_recent_activity: boolean;
  rename_allowed: boolean;
  rename_block_reason: string | null;
}

export interface TerminalWorkspaceStatus {
  project_id: string;
  path: string | null;
  path_exists: boolean;
  is_directory: boolean;
  is_allowed: boolean;
  message: string;
  session_count: number;
  sessions: TerminalSession[];
}

export interface TerminalSnapshot {
  session_name: string;
  content: string;
  captured_at: string;
}

export interface TerminalAttachment {
  attachment_id: string;
  path: string;
  original_name: string;
  kind: 'file' | 'image';
  content_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

export interface TerminalPathResolution {
  candidate: string;
  path: string | null;
  kind: 'file' | 'directory' | 'symlink' | 'special' | 'missing' | 'denied';
  size_bytes: number | null;
}

export type SessionAutomationMode = 'off' | 'learn' | 'active';
export type SessionAutomationState =
  | 'idle'
  | 'observing'
  | 'thinking'
  | 'countdown'
  | 'sending'
  | 'waiting'
  | 'paused'
  | 'blocked'
  | 'error';

export interface SessionAutomation {
  project_id: string;
  session_name: string;
  mode: SessionAutomationMode;
  state: SessionAutomationState;
  available: boolean;
  availability_message: string;
  provider: 'codex' | 'claude' | null;
  goal: string;
  max_turns: number;
  max_minutes: number;
  max_failures: number;
  send_delay_seconds: number;
  turns_used: number;
  no_progress_count: number;
  pending_send_at: string | null;
  last_decision:
    | 'continue'
    | 'wait'
    | 'needs_user'
    | 'complete'
    | 'blocked'
    | null;
  last_reason: string | null;
  last_error: string | null;
  last_learning_error: string | null;
  warning: string | null;
  updated_at: string | null;
}

export interface ProjectBriefContent {
  purpose: string;
  user_intent: string;
  direction: string;
  goals: string[];
  working_preferences: string[];
  success_signals: string[];
  boundaries: string[];
}

export interface ProjectBriefDocument extends ProjectBriefContent {
  schema_version: 'dolphin-project-brief-v1';
  project_id: string;
  project_name: string;
  revision: number;
  evidence_count: number;
  updated_at: string | null;
  last_source_event_key: string | null;
}

export type ProjectSourceRole =
  | 'instructions'
  | 'overview'
  | 'project'
  | 'vision'
  | 'goals'
  | 'plan'
  | 'roadmap'
  | 'state'
  | 'requirements';

export interface ProjectSourceReference {
  path: string;
  role: ProjectSourceRole;
  sha256: string;
  size_bytes: number;
  modified_at: string;
}

export interface ProjectSourceContextDocument extends ProjectBriefContent {
  schema_version: 'dolphin-project-source-context-v1';
  project_id: string;
  project_name: string;
  revision: number;
  source_count: number;
  context_hash: string;
  updated_at: string;
  sources: ProjectSourceReference[];
  conflicts: string[];
}

export type ProjectSourceContextStatus =
  | 'missing'
  | 'refreshing'
  | 'ready'
  | 'stale'
  | 'error';

export interface SessionAutomationEvent {
  kind: string;
  status: 'pending' | 'processing' | 'processed' | 'cancelled' | 'failed';
  decision: SessionAutomation['last_decision'];
  reason: string | null;
  error_code: string | null;
  prompt_hash: string | null;
  source_event_key: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface SessionAutomationDetails {
  brief: ProjectBriefDocument;
  source_context: ProjectSourceContextDocument | null;
  source_context_status: ProjectSourceContextStatus;
  source_context_message: string;
  events: SessionAutomationEvent[];
}

export interface SessionAutomationUpdate {
  mode: SessionAutomationMode;
  goal?: string;
  max_turns?: number;
  max_minutes?: number;
  max_failures?: number;
  send_delay_seconds?: number;
}

export interface PreparedDictationTarget {
  id: string;
  kind: 'terminal';
  label: string;
  insert: (transcript: string) => boolean;
}

export interface DictationTarget {
  id: string;
  kind: 'terminal';
  label: string;
  prepare: () => PreparedDictationTarget | null;
}

export interface TerminalDictationBridge {
  activateTarget: (target: DictationTarget) => void;
  clearTarget: (targetId: string) => void;
}

export interface DictationStatus {
  available: boolean;
  ready: boolean;
  loading?: boolean;
  status: string;
  detail?: string;
  engine?: string;
  model?: string;
  device?: string;
  last_error?: string | null;
}

export interface DictationTranscript {
  text: string;
  language: string | null;
  language_probability?: number | null;
  engine: string;
  model: string;
  device: string;
  duration_ms: number;
  preview?: boolean;
}

export interface TerminalDictationClient {
  fetchStatus(signal?: AbortSignal): Promise<DictationStatus>;
  transcribe(
    audio: Blob,
    filename: string,
    options?: {
      language?: string;
      preview?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<DictationTranscript>;
}

export interface TerminalCapabilities {
  session_backend: {
    id: string;
    available: boolean;
    detail: string;
  };
  dictation: { enabled: boolean };
  automation: { enabled: boolean };
}

export interface TerminalClient {
  fetchWorkspace(projectId: string, signal?: AbortSignal): Promise<TerminalWorkspaceStatus>;
  createSession(projectId: string, name?: string): Promise<TerminalSession>;
  renameSession(projectId: string, sessionName: string, name: string): Promise<TerminalSession>;
  closeSession(projectId: string, sessionName: string): Promise<void>;
  fetchSnapshot(projectId: string, sessionName: string, lines?: number): Promise<TerminalSnapshot>;
  resolvePaths(
    projectId: string,
    sessionName: string | null,
    candidates: string[],
    signal?: AbortSignal,
  ): Promise<TerminalPathResolution[]>;
  fileDownloadUrl(path: string): string;
  streamUrl(projectId: string, sessionName: string): string;
  uploadAttachment(
    projectId: string,
    sessionName: string,
    file: Blob,
    originalName: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<TerminalAttachment>;
  fetchAutomation(
    projectId: string,
    sessionName: string,
    signal?: AbortSignal,
  ): Promise<SessionAutomation>;
  updateAutomation(
    projectId: string,
    sessionName: string,
    update: SessionAutomationUpdate,
  ): Promise<SessionAutomation>;
  cancelAutomation(projectId: string, sessionName: string): Promise<void>;
  fetchAutomationDetails(
    projectId: string,
    sessionName: string,
    signal?: AbortSignal,
  ): Promise<SessionAutomationDetails>;
  updateProjectBrief(
    projectId: string,
    sessionName: string,
    brief: ProjectBriefContent,
  ): Promise<ProjectBriefDocument>;
  refreshAutomationSourceContext(
    projectId: string,
    sessionName: string,
  ): Promise<{ status: 'queued' | 'already_queued' }>;
  stopAllAutomation(): Promise<{ stopped: number }>;
}

export interface TerminalTarget {
  projectId: string;
  sessionName: string;
}

export interface TerminalRuntimeOptions {
  client: TerminalClient;
  dictation?: TerminalDictationBridge;
  targetHref?: (target: TerminalTarget) => string;
  storage?: Storage;
  storageKey?: string;
  legacyStorageKey?: string;
  legacyMigrationKey?: string;
  automation?: boolean;
  labels?: Partial<TerminalRuntimeLabels>;
}

export interface TerminalRuntimeLabels {
  session: string;
  sessions: string;
  newSession: string;
  persistentEngine: string;
}
