import { describe, expect, it } from 'vitest';

import {
  MAX_TERMINAL_ATTACHMENT_BYTES,
  MAX_TERMINAL_ATTACHMENT_FILES,
  attachmentPasteMessage,
  isFileDrag,
  sameTerminalAttachmentTarget,
  selectTerminalAttachments,
  terminalAttachmentAgent,
} from './terminalAttachmentDrop';

function file(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

describe('selectTerminalAttachments', () => {
  it('uses a 600 MiB inclusive per-file boundary', () => {
    expect(MAX_TERMINAL_ATTACHMENT_BYTES).toBe(600 * 1024 * 1024);

    const selection = selectTerminalAttachments([
      file('exact.bin', 'application/octet-stream', MAX_TERMINAL_ATTACHMENT_BYTES),
      file(
        'over.bin',
        'application/octet-stream',
        MAX_TERMINAL_ATTACHMENT_BYTES + 1,
      ),
    ]);

    expect(selection.accepted.map((item) => item.file.name)).toEqual([
      'exact.bin',
    ]);
    expect(selection.errors).toEqual([
      'over.bin: files must be 600 MiB or smaller.',
    ]);
  });

  it('accepts ordinary files and classifies supported images', () => {
    const selection = selectTerminalAttachments([
      file('notes.txt', 'text/plain', 100),
      file('paper.pdf', 'application/pdf', 200),
      file('screen.png', 'image/png', 300),
      file('photo.jpeg', '', 400),
    ]);

    expect(
      selection.accepted.map((item) => ({
        name: item.file.name,
        contentType: item.contentType,
        kind: item.kind,
      })),
    ).toEqual([
      { name: 'notes.txt', contentType: 'text/plain', kind: 'file' },
      {
        name: 'paper.pdf',
        contentType: 'application/pdf',
        kind: 'file',
      },
      { name: 'screen.png', contentType: 'image/png', kind: 'image' },
      { name: 'photo.jpeg', contentType: 'image/jpeg', kind: 'image' },
    ]);
    expect(selection.errors).toEqual([]);
  });

  it('uses an opaque MIME type when the browser has no trustworthy type', () => {
    const selection = selectTerminalAttachments([
      file('script.py', '', 100),
      file('archive.dat', 'not a mime type', 100),
    ]);

    expect(selection.accepted.map((item) => item.contentType)).toEqual([
      'application/octet-stream',
      'application/octet-stream',
    ]);
  });

  it('rejects empty, oversized, and unsafe names without hiding valid files', () => {
    const selection = selectTerminalAttachments([
      file('good.txt', 'text/plain', 100),
      file('empty.txt', 'text/plain', 0),
      file('large.pdf', 'application/pdf', MAX_TERMINAL_ATTACHMENT_BYTES + 1),
      file('../unsafe.txt', 'text/plain', 100),
    ]);

    expect(selection.accepted.map((item) => item.file.name)).toEqual(['good.txt']);
    expect(selection.errors).toHaveLength(3);
    expect(selection.errors.join(' ')).toContain('empty.txt');
    expect(selection.errors.join(' ')).toContain('large.pdf');
    expect(selection.errors.join(' ')).toContain('../unsafe.txt');
  });

  it('accepts only the first bounded batch and reports every extra file', () => {
    const files = Array.from(
      { length: MAX_TERMINAL_ATTACHMENT_FILES + 2 },
      (_, index) => file(`file-${index}.txt`, 'text/plain', 100),
    );

    const selection = selectTerminalAttachments(files);

    expect(selection.accepted).toHaveLength(MAX_TERMINAL_ATTACHMENT_FILES);
    expect(selection.errors).toHaveLength(2);
  });
});

describe('terminal attachment target guards', () => {
  it('distinguishes supported agents without treating a shell as attachable', () => {
    expect(
      terminalAttachmentAgent({
        is_codex_running: true,
        is_claude_code_running: false,
      }),
    ).toBe('codex');
    expect(
      terminalAttachmentAgent({
        is_codex_running: false,
        is_claude_code_running: true,
      }),
    ).toBe('claude-code');
    expect(
      terminalAttachmentAgent({
        is_codex_running: false,
        is_claude_code_running: false,
      }),
    ).toBeNull();
  });

  it('recognizes file drags without treating text drags as uploads', () => {
    expect(isFileDrag(['Files', 'text/plain'])).toBe(true);
    expect(isFileDrag(['text/plain'])).toBe(false);
  });

  it('fails closed when project, session, or connection generation changes', () => {
    const target = {
      projectId: 'project-a',
      sessionName: 'dolphin-a',
      connectionGeneration: 3,
    };

    expect(sameTerminalAttachmentTarget(target, { ...target })).toBe(true);
    expect(
      sameTerminalAttachmentTarget(target, {
        ...target,
        projectId: 'project-b',
      }),
    ).toBe(false);
    expect(
      sameTerminalAttachmentTarget(target, {
        ...target,
        sessionName: 'dolphin-b',
      }),
    ).toBe(false);
    expect(
      sameTerminalAttachmentTarget(target, {
        ...target,
        connectionGeneration: 4,
      }),
    ).toBe(false);
  });
});

describe('attachmentPasteMessage', () => {
  it('names the agent when one is running', () => {
    expect(attachmentPasteMessage(1, 'codex')).toBe(
      'Path pasted for 1 attachment. Press Enter yourself; Codex can inspect it by path.',
    );
    expect(attachmentPasteMessage(3, 'claude-code')).toBe(
      'Paths pasted for 3 attachments. Press Enter yourself; Claude Code can inspect them by path.',
    );
  });

  it('stays neutral when no agent is running', () => {
    expect(attachmentPasteMessage(1, null)).toBe(
      'Path pasted for 1 attachment. Press Enter yourself; the path is on the command line.',
    );
    expect(attachmentPasteMessage(2, null)).toBe(
      'Paths pasted for 2 attachments. Press Enter yourself; the paths are on the command line.',
    );
  });

  it('never promises that Enter was sent', () => {
    for (const agent of ['codex', 'claude-code', null] as const) {
      for (const count of [1, 2]) {
        expect(attachmentPasteMessage(count, agent)).toContain(
          'Press Enter yourself',
        );
      }
    }
  });
});
