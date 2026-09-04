import type {
  ProjectBriefContent,
  ProjectBriefDocument,
  SessionAutomation,
  SessionAutomationDetails,
  SessionAutomationUpdate,
  TerminalAttachment,
  TerminalClient,
  TerminalCapabilities,
  TerminalPathResolution,
  TerminalSession,
  TerminalSnapshot,
  TerminalWorkspaceDescriptor,
  TerminalWorkspaceStatus,
} from '@dolphin-terminal/protocol';

export interface TerminalHttpClient extends TerminalClient {
  listWorkspaces(signal?: AbortSignal): Promise<TerminalWorkspaceDescriptor[]>;
  fetchCapabilities(signal?: AbortSignal): Promise<TerminalCapabilities>;
}

export class TerminalHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'TerminalHttpError';
  }
}

function websocketBase(httpBase: string): string {
  return httpBase.replace(/^http/i, 'ws');
}

export function createTerminalHttpClient(
  baseUrl = 'http://127.0.0.1:8733',
): TerminalHttpClient {
  const apiBase = baseUrl.replace(/\/+$/, '');
  const wsBase = websocketBase(apiBase);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      let code: string | null = null;
      try {
        const payload = (await response.json()) as {
          detail?: string | { message?: string; code?: string };
        };
        if (typeof payload.detail === 'string') message = payload.detail;
        else if (payload.detail) {
          message = payload.detail.message ?? message;
          code = payload.detail.code ?? null;
        }
      } catch {
        // Preserve the status line when a proxy returned non-JSON content.
      }
      throw new TerminalHttpError(message, response.status, code);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const workspacePath = (projectId: string) =>
    `/terminal/v1/workspaces/${encodeURIComponent(projectId)}`;
  const sessionPath = (projectId: string, sessionName: string) =>
    `${workspacePath(projectId)}/sessions/${encodeURIComponent(sessionName)}`;

  return {
    fetchCapabilities(signal) {
      return request<TerminalCapabilities>('/terminal/v1/capabilities', {
        signal,
      });
    },
    listWorkspaces(signal) {
      return request<TerminalWorkspaceDescriptor[]>('/terminal/v1/workspaces', {
        signal,
      });
    },
    fetchWorkspace(projectId, signal) {
      return request<TerminalWorkspaceStatus>(workspacePath(projectId), { signal });
    },
    createSession(projectId, name) {
      return request<TerminalSession>(`${workspacePath(projectId)}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ name: name?.trim() || null, mode: 'shell' }),
      });
    },
    renameSession(projectId, sessionName, name) {
      return request<TerminalSession>(sessionPath(projectId, sessionName), {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
    },
    closeSession(projectId, sessionName) {
      return request<void>(sessionPath(projectId, sessionName), {
        method: 'DELETE',
      });
    },
    fetchSnapshot(projectId, sessionName, lines = 2000) {
      return request<TerminalSnapshot>(
        `${sessionPath(projectId, sessionName)}/snapshot?lines=${encodeURIComponent(String(lines))}`,
      );
    },
    async resolvePaths(projectId, sessionName, candidates, signal) {
      const response = await request<{ paths: TerminalPathResolution[] }>(
        `${workspacePath(projectId)}/paths/resolve`,
        {
          method: 'POST',
          body: JSON.stringify({ session_name: sessionName, candidates }),
          signal,
        },
      );
      return response.paths;
    },
    fileDownloadUrl(path) {
      return `${apiBase}/terminal/v1/files?path=${encodeURIComponent(path)}`;
    },
    streamUrl(projectId, sessionName) {
      return `${wsBase}${sessionPath(projectId, sessionName)}/stream`;
    },
    async uploadAttachment(
      projectId,
      sessionName,
      file,
      originalName,
      contentType,
      signal,
    ) {
      const response = await fetch(
        `${apiBase}${sessionPath(projectId, sessionName)}/attachments`,
        {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'X-Dolphin-Attachment-Upload': '1',
            'X-Dolphin-Attachment-Name': encodeURIComponent(originalName),
          },
          body: file,
          signal,
        },
      );
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const payload = (await response.json()) as { detail?: string };
          message = payload.detail ?? message;
        } catch {
          // Preserve HTTP status.
        }
        throw new TerminalHttpError(message, response.status);
      }
      return (await response.json()) as TerminalAttachment;
    },
    fetchAutomation(projectId, sessionName, signal) {
      return request<SessionAutomation>(
        `${sessionPath(projectId, sessionName)}/automation`,
        { signal },
      );
    },
    updateAutomation(projectId, sessionName, update: SessionAutomationUpdate) {
      return request<SessionAutomation>(
        `${sessionPath(projectId, sessionName)}/automation`,
        { method: 'PUT', body: JSON.stringify(update) },
      );
    },
    cancelAutomation(projectId, sessionName) {
      return request<void>(`${sessionPath(projectId, sessionName)}/automation/cancel`, {
        method: 'POST',
      });
    },
    fetchAutomationDetails(projectId, sessionName, signal) {
      return request<SessionAutomationDetails>(
        `${sessionPath(projectId, sessionName)}/automation/details`,
        { signal },
      );
    },
    updateProjectBrief(
      projectId,
      sessionName,
      brief: ProjectBriefContent,
    ) {
      return request<ProjectBriefDocument>(
        `${sessionPath(projectId, sessionName)}/automation/brief`,
        { method: 'PUT', body: JSON.stringify(brief) },
      );
    },
    refreshAutomationSourceContext(projectId, sessionName) {
      return request<{ status: 'queued' | 'already_queued' }>(
        `${sessionPath(projectId, sessionName)}/automation/source-context/refresh`,
        { method: 'POST' },
      );
    },
    stopAllAutomation() {
      return request<{ stopped: number }>('/terminal/v1/automation/stop-all', {
        method: 'POST',
      });
    },
  };
}
