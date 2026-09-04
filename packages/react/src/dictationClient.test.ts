import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTerminalDictationHttpClient } from './dictationClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTerminalDictationHttpClient', () => {
  it('forwards preview metadata and the original audio body', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(Blob);
      expect(init?.headers).toEqual({
        'Content-Type': 'audio/webm',
        'X-Audio-Filename': 'dictation.webm',
        'X-Dictation-Language': 'en',
        'X-Dictation-Mode': 'preview',
      });
      return new Response(
        JSON.stringify({
          text: 'hello',
          language: 'en',
          engine: 'test',
          model: 'local',
          device: 'cpu',
          duration_ms: 5,
          preview: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createTerminalDictationHttpClient('http://127.0.0.1:8733/');
    const transcript = await client.transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      'dictation.webm',
      { language: 'en', preview: true },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8733/terminal/v1/dictation/transcribe',
      expect.any(Object),
    );
    expect(transcript.text).toBe('hello');
  });

  it('surfaces the gateway detail for unavailable local speech', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: 'ASR is offline.' }), {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const client = createTerminalDictationHttpClient();
    await expect(client.fetchStatus()).rejects.toThrow('ASR is offline.');
  });
});
