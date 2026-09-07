export const MAX_TERMINAL_ATTACHMENT_FILES = 4;
export const MAX_TERMINAL_ATTACHMENT_BYTES = 600 * 1024 * 1024;
const MIN_UPLOAD_TIMEOUT_MS = 30_000;
const CONSERVATIVE_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

/**
 * Preserve stalled-request recovery without making the advertised large-file
 * limit depend on a fast connection. The allowance scales to roughly 0.5 Mbps
 * and always includes a 30-second setup margin.
 */
export function terminalAttachmentUploadTimeoutMs(fileSize: number): number {
  const safeSize = Number.isFinite(fileSize) && fileSize > 0 ? fileSize : 0;
  return (
    MIN_UPLOAD_TIMEOUT_MS +
    Math.ceil((safeSize * 1_000) / CONSERVATIVE_UPLOAD_BYTES_PER_SECOND)
  );
}

export function terminalAttachmentLimitLabel(maxBytes: number): string {
  if (maxBytes >= 1024 * 1024 && maxBytes % (1024 * 1024) === 0) {
    return `${maxBytes / (1024 * 1024)} MiB`;
  }
  if (maxBytes >= 1024 && maxBytes % 1024 === 0) {
    return `${maxBytes / 1024} KiB`;
  }
  return `${maxBytes} bytes`;
}

export type TerminalAttachmentKind = 'file' | 'image';

export interface SelectedTerminalAttachment {
  file: File;
  contentType: string;
  kind: TerminalAttachmentKind;
}

export interface TerminalAttachmentSelection {
  accepted: SelectedTerminalAttachment[];
  errors: string[];
}

export interface TerminalAttachmentTargetIdentity {
  projectId: string;
  sessionName: string;
  connectionGeneration: number;
}

export type TerminalAttachmentAgent = 'codex' | 'claude-code';

export interface TerminalAttachmentSessionLike {
  current_command?: string | null;
  is_codex_running: boolean;
  is_claude_code_running?: boolean;
}

const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

function imageContentTypeFromName(name: string): string | null {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.(?:jpe?g)$/i.test(name)) return 'image/jpeg';
  return null;
}

function contentTypeForFile(file: File): string {
  const declaredType = file.type.trim().toLowerCase().split(';', 1)[0];
  if (MIME_TYPE_PATTERN.test(declaredType)) return declaredType;
  return imageContentTypeFromName(file.name) ?? 'application/octet-stream';
}

function hasSafeAttachmentName(name: string): boolean {
  if (!name || name === '.' || name === '..' || name.length > 255) return false;
  if (new TextEncoder().encode(name).byteLength > 512) return false;
  return !/[/\\\u0000-\u001f\u007f]/.test(name);
}

export function selectTerminalAttachments(
  files: ArrayLike<File> | Iterable<File>,
  maxBytes = MAX_TERMINAL_ATTACHMENT_BYTES,
): TerminalAttachmentSelection {
  const resolvedMaxBytes =
    Number.isFinite(maxBytes) && Math.floor(maxBytes) > 0
      ? Math.floor(maxBytes)
      : MAX_TERMINAL_ATTACHMENT_BYTES;
  const accepted: SelectedTerminalAttachment[] = [];
  const errors: string[] = [];

  for (const file of Array.from(files)) {
    if (accepted.length >= MAX_TERMINAL_ATTACHMENT_FILES) {
      errors.push(
        `${file.name}: only ${MAX_TERMINAL_ATTACHMENT_FILES} attachments can be added at once.`,
      );
      continue;
    }
    if (!hasSafeAttachmentName(file.name)) {
      errors.push(`${file.name || 'Unnamed file'}: the filename is not safe.`);
      continue;
    }
    if (file.size <= 0) {
      errors.push(`${file.name}: the file is empty.`);
      continue;
    }
    if (file.size > resolvedMaxBytes) {
      errors.push(
        `${file.name}: files must be ${terminalAttachmentLimitLabel(resolvedMaxBytes)} or smaller.`,
      );
      continue;
    }

    const contentType = contentTypeForFile(file);
    const kind =
      contentType === 'image/png' ||
      contentType === 'image/jpeg' ||
      imageContentTypeFromName(file.name) !== null
        ? 'image'
        : 'file';
    accepted.push({ file, contentType, kind });
  }

  return { accepted, errors };
}

export function isFileDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes('Files');
}

export function terminalAttachmentAgent(
  session: TerminalAttachmentSessionLike | null | undefined,
): TerminalAttachmentAgent | null {
  if (!session) return null;
  const hasCodex = session.is_codex_running;
  const hasClaudeCode = session.is_claude_code_running === true;
  if (hasCodex && hasClaudeCode) {
    const currentCommand = session.current_command?.toLowerCase();
    if (currentCommand === 'codex') return 'codex';
    if (currentCommand === 'claude') return 'claude-code';
    return null;
  }
  if (hasCodex) return 'codex';
  if (hasClaudeCode) return 'claude-code';
  return null;
}

export function terminalAttachmentAgentLabel(
  agent: TerminalAttachmentAgent,
): 'Codex' | 'Claude Code' {
  return agent === 'codex' ? 'Codex' : 'Claude Code';
}

export function attachmentPasteMessage(
  count: number,
  agent: TerminalAttachmentAgent | null,
): string {
  const lead =
    count === 1
      ? 'Path pasted for 1 attachment.'
      : `Paths pasted for ${count} attachments.`;
  /* The agent is a copywriter here, not a gatekeeper. In a plain shell the
     path is still useful -- it is on the command line, unsent. */
  const tail = agent
    ? `${terminalAttachmentAgentLabel(agent)} can inspect ${
        count === 1 ? 'it' : 'them'
      } by path.`
    : `the ${count === 1 ? 'path is' : 'paths are'} on the command line.`;
  return `${lead} Press Enter yourself; ${tail}`;
}

export function sameTerminalAttachmentTarget(
  expected: TerminalAttachmentTargetIdentity,
  current: TerminalAttachmentTargetIdentity,
): boolean {
  return (
    expected.projectId === current.projectId &&
    expected.sessionName === current.sessionName &&
    expected.connectionGeneration === current.connectionGeneration
  );
}
