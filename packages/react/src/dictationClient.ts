import type {
  DictationStatus,
  DictationTranscript,
  TerminalDictationClient,
} from '@dolphin-terminal/protocol';

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const payload = (await response.json()) as { detail?: string };
    message = payload.detail ?? message;
  } catch {
    // Preserve the HTTP status when a proxy returned non-JSON content.
  }
  return new Error(message);
}

/** Create the optional local-ASR client used by TerminalDictationProvider. */
export function createTerminalDictationHttpClient(
  baseUrl = 'http://127.0.0.1:8733',
): TerminalDictationClient {
  const apiBase = baseUrl.replace(/\/+$/, '');

  return {
    async fetchStatus(signal) {
      const response = await fetch(`${apiBase}/terminal/v1/dictation/status`, {
        signal,
      });
      if (!response.ok) throw await responseError(response);
      return (await response.json()) as DictationStatus;
    },

    async transcribe(audio, filename, options) {
      const response = await fetch(
        `${apiBase}/terminal/v1/dictation/transcribe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': audio.type || 'application/octet-stream',
            'X-Audio-Filename': filename,
            ...(options?.language
              ? { 'X-Dictation-Language': options.language }
              : {}),
            ...(options?.preview ? { 'X-Dictation-Mode': 'preview' } : {}),
          },
          body: audio,
          signal: options?.signal,
        },
      );
      if (!response.ok) throw await responseError(response);
      return (await response.json()) as DictationTranscript;
    },
  };
}
