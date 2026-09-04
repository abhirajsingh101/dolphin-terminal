import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  DictationStatus,
  DictationTarget,
  PreparedDictationTarget,
  TerminalDictationBridge,
  TerminalDictationClient,
} from '@dolphin-terminal/protocol';
import {
  defaultTerminalIcons,
  type TerminalIconRegistry,
} from './customization.js';

type DictationPhase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing'
  | 'inserted'
  | 'error';

interface DictationControlValue {
  controlDisabled: boolean;
  hasTarget: boolean;
  isRecording: boolean;
  liveTranscript: string;
  phase: DictationPhase;
  serviceDegraded: boolean;
  serviceText: string;
  shortcutHint: string;
  showLiveTranscript: boolean;
  startRecording: () => Promise<void>;
  statusText: string;
  stopRecording: () => void;
}

export interface TerminalDictationProviderProps {
  children: ReactNode;
  client: TerminalDictationClient;
  enabled?: boolean;
  language?: string;
  maxRecordingMs?: number;
  previewIntervalMs?: number;
}

const BridgeContext = createContext<TerminalDictationBridge | null>(null);
const ControlContext = createContext<DictationControlValue | null>(null);
const MIN_AUDIO_BYTES = 100;

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function audioFilename(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'dictation.ogg';
  if (mimeType.includes('mp4')) return 'dictation.m4a';
  if (mimeType.includes('mpeg')) return 'dictation.mp3';
  return 'dictation.webm';
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone permission was denied. Allow it for this site and try again.';
    }
    if (error.name === 'NotFoundError') return 'No microphone was found.';
    if (error.name === 'NotReadableError') {
      return 'The microphone is busy in another application.';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** The bridge passed to TerminalRuntimeProvider. */
export function useTerminalDictation(): TerminalDictationBridge {
  const value = useContext(BridgeContext);
  if (!value) {
    throw new Error(
      'useTerminalDictation must be used inside TerminalDictationProvider.',
    );
  }
  return value;
}

/** Visible microphone/status control for the local-ASR provider. */
export interface TerminalDictationControlProps {
  icons?: Partial<
    Pick<
      TerminalIconRegistry,
      'CheckCircle2' | 'LoaderCircle' | 'Mic' | 'Square' | 'TriangleAlert'
    >
  >;
}

export function TerminalDictationControl({ icons }: TerminalDictationControlProps = {}) {
  const value = useContext(ControlContext);
  if (!value) {
    throw new Error(
      'TerminalDictationControl must be used inside TerminalDictationProvider.',
    );
  }
  const {
    controlDisabled,
    hasTarget,
    isRecording,
    liveTranscript,
    phase,
    serviceDegraded,
    serviceText,
    shortcutHint,
    showLiveTranscript,
    startRecording,
    statusText,
    stopRecording,
  } = value;
  const { CheckCircle2, LoaderCircle, Mic, Square, TriangleAlert } = {
    ...defaultTerminalIcons,
    ...icons,
  };

  return (
    <div
      className={`terminal-dictation-control phase-${phase}${
        showLiveTranscript ? ' has-live-transcript' : ''
      }`}
      aria-label="Voice input"
      aria-live="polite"
      data-testid="terminal-dictation-control"
    >
      <button
        type="button"
        className="terminal-dictation-button"
        aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
        aria-pressed={isRecording}
        disabled={controlDisabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (isRecording) stopRecording();
          else void startRecording();
        }}
        title="Hold Ctrl/Command + Shift + Space to dictate. Escape cancels."
      >
        {phase === 'requesting' || phase === 'transcribing' ? (
          <LoaderCircle className="terminal-dictation-spinner" size={20} />
        ) : phase === 'recording' ? (
          <Square size={17} />
        ) : phase === 'inserted' ? (
          <CheckCircle2 size={20} />
        ) : phase === 'error' ? (
          <TriangleAlert size={20} />
        ) : (
          <Mic size={20} />
        )}
      </button>
      {phase === 'idle' && !hasTarget && !serviceDegraded ? null : (
        <div className="terminal-dictation-copy">
          <strong>{statusText}</strong>
          {showLiveTranscript ? (
            <span
              className={`terminal-dictation-live-transcript${
                liveTranscript ? '' : ' pending'
              }`}
              data-testid="terminal-dictation-live-transcript"
            >
              {liveTranscript ||
                (phase === 'transcribing'
                  ? 'Stabilizing the final words…'
                  : 'Speak now…')}
            </span>
          ) : null}
          {phase !== 'idle' || serviceDegraded ? (
            <span className="terminal-dictation-service-meta">{serviceText}</span>
          ) : null}
        </div>
      )}
      {phase === 'idle' && !serviceDegraded ? (
        <kbd className="terminal-dictation-shortcut" title={serviceText}>
          {shortcutHint}
        </kbd>
      ) : null}
    </div>
  );
}

export function TerminalDictationProvider({
  children,
  client,
  enabled = true,
  language,
  maxRecordingMs = 60_000,
  previewIntervalMs = 900,
}: TerminalDictationProviderProps) {
  const [activeTarget, setActiveTarget] = useState<DictationTarget | null>(null);
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [serviceStatus, setServiceStatus] = useState<DictationStatus | null>(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const activeTargetRef = useRef<DictationTarget | null>(null);
  const phaseRef = useRef<DictationPhase>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const preparedTargetRef = useRef<PreparedDictationTarget | null>(null);
  const maxRecordingTimerRef = useRef<number | null>(null);
  const statusResetTimerRef = useRef<number | null>(null);
  const shortcutHeldRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const finalizingRef = useRef(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewInFlightRef = useRef(false);
  const previewQueuedRef = useRef(false);
  const recordingEpochRef = useRef(0);
  const mountedRef = useRef(true);

  const setCurrentPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  const clearStatusReset = useCallback(() => {
    if (statusResetTimerRef.current !== null) {
      window.clearTimeout(statusResetTimerRef.current);
      statusResetTimerRef.current = null;
    }
  }, []);

  const stopLivePreview = useCallback((clearTranscript: boolean) => {
    recordingEpochRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewInFlightRef.current = false;
    previewQueuedRef.current = false;
    if (clearTranscript && mountedRef.current) setLiveTranscript('');
  }, []);

  const releaseMicrophone = useCallback(() => {
    if (maxRecordingTimerRef.current !== null) {
      window.clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const showError = useCallback(
    (message: string) => {
      clearStatusReset();
      setLiveTranscript('');
      setErrorMessage(message);
      setCurrentPhase('error');
    },
    [clearStatusReset, setCurrentPhase],
  );

  const activateTarget = useCallback((target: DictationTarget) => {
    activeTargetRef.current = target;
    setActiveTarget(target);
  }, []);

  const clearTarget = useCallback((targetId: string) => {
    if (activeTargetRef.current?.id !== targetId) return;
    activeTargetRef.current = null;
    setActiveTarget(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setServiceStatus({
        available: false,
        ready: false,
        status: 'disabled',
        detail: 'Voice input is disabled for this terminal.',
      });
      return;
    }
    const controller = new AbortController();
    void client
      .fetchStatus(controller.signal)
      .then(setServiceStatus)
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setServiceStatus({
          available: false,
          ready: false,
          status: 'unavailable',
          detail: error.message,
        });
      });
    return () => controller.abort();
  }, [client, enabled]);

  const requestLivePreview = useCallback(async function runLivePreview() {
    if (
      phaseRef.current !== 'recording' ||
      stopRequestedRef.current ||
      cancelRequestedRef.current
    ) {
      return;
    }
    if (previewInFlightRef.current) {
      previewQueuedRef.current = true;
      return;
    }

    const recorder = recorderRef.current;
    const chunks = chunksRef.current.slice();
    if (!recorder || chunks.length === 0) return;
    const mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
    const audio = new Blob(chunks, { type: mimeType });
    if (audio.size < MIN_AUDIO_BYTES) return;

    const epoch = recordingEpochRef.current;
    const controller = new AbortController();
    previewInFlightRef.current = true;
    previewQueuedRef.current = false;
    previewAbortRef.current = controller;
    try {
      const result = await client.transcribe(audio, audioFilename(mimeType), {
        language,
        preview: true,
        signal: controller.signal,
      });
      if (
        epoch === recordingEpochRef.current &&
        phaseRef.current === 'recording' &&
        !stopRequestedRef.current &&
        !cancelRequestedRef.current &&
        result.text.trim()
      ) {
        setLiveTranscript(result.text.trim());
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('Live terminal dictation preview failed:', error);
      }
    } finally {
      if (epoch !== recordingEpochRef.current) return;
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
      previewInFlightRef.current = false;
      if (
        previewQueuedRef.current &&
        phaseRef.current === 'recording' &&
        !stopRequestedRef.current &&
        !cancelRequestedRef.current
      ) {
        previewQueuedRef.current = false;
        void runLivePreview();
      }
    }
  }, [client, language]);

  const finalizeRecording = useCallback(
    async (recorder: MediaRecorder) => {
      if (finalizingRef.current) return;
      finalizingRef.current = true;
      stopLivePreview(false);
      const cancelled = cancelRequestedRef.current;
      const target = preparedTargetRef.current;
      const mimeType =
        recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
      const audio = new Blob(chunksRef.current, { type: mimeType });
      releaseMicrophone();

      if (cancelled || !mountedRef.current) {
        preparedTargetRef.current = null;
        if (mountedRef.current) setLiveTranscript('');
        if (phaseRef.current !== 'error') setCurrentPhase('idle');
        return;
      }
      if (!target) {
        showError('The dictation target is no longer available.');
        return;
      }
      if (audio.size < MIN_AUDIO_BYTES) {
        showError('No microphone audio was captured.');
        return;
      }

      setCurrentPhase('transcribing');
      try {
        const result = await client.transcribe(audio, audioFilename(mimeType), {
          language,
        });
        if (!result.text.trim()) {
          showError('No speech was detected.');
          return;
        }
        if (!target.insert(result.text)) {
          showError('The original terminal is no longer available.');
          return;
        }
        setServiceStatus((current) => ({
          ...(current ?? {}),
          available: true,
          ready: true,
          status: 'ok',
          engine: result.engine,
          model: result.model,
          device: result.device,
        }));
        setLiveTranscript(result.text.trim());
        setCurrentPhase('inserted');
        clearStatusReset();
        statusResetTimerRef.current = window.setTimeout(() => {
          setLiveTranscript('');
          setCurrentPhase('idle');
          statusResetTimerRef.current = null;
        }, 1800);
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        preparedTargetRef.current = null;
      }
    },
    [
      clearStatusReset,
      client,
      language,
      releaseMicrophone,
      setCurrentPhase,
      showError,
      stopLivePreview,
    ],
  );

  const stopRecording = useCallback(() => {
    stopRequestedRef.current = true;
    stopLivePreview(false);
    if (phaseRef.current === 'requesting') return;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, [stopLivePreview]);

  const cancelRecording = useCallback(() => {
    if (phaseRef.current !== 'requesting' && phaseRef.current !== 'recording') {
      return;
    }
    cancelRequestedRef.current = true;
    stopRequestedRef.current = true;
    stopLivePreview(true);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, [stopLivePreview]);

  const startRecording = useCallback(async () => {
    if (!enabled) {
      showError('Voice input is disabled for this terminal.');
      return;
    }
    if (
      phaseRef.current === 'requesting' ||
      phaseRef.current === 'recording' ||
      phaseRef.current === 'transcribing'
    ) {
      return;
    }
    clearStatusReset();
    setErrorMessage('');
    stopLivePreview(true);

    const target = activeTargetRef.current;
    const prepared = target?.prepare() ?? null;
    if (!prepared) {
      showError('Focus a connected terminal first.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showError('Voice input is not supported in this browser or connection.');
      return;
    }

    preparedTargetRef.current = prepared;
    chunksRef.current = [];
    stopRequestedRef.current = false;
    cancelRequestedRef.current = false;
    finalizingRef.current = false;
    setCurrentPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size <= 0) return;
        chunksRef.current.push(event.data);
        if (!stopRequestedRef.current && !cancelRequestedRef.current) {
          void requestLivePreview();
        }
      });
      recorder.addEventListener(
        'stop',
        () => void finalizeRecording(recorder),
        { once: true },
      );
      recorder.addEventListener(
        'error',
        () => {
          cancelRequestedRef.current = true;
          releaseMicrophone();
          showError('The browser could not record microphone audio.');
        },
        { once: true },
      );
      recorder.start(previewIntervalMs);
      setCurrentPhase('recording');
      maxRecordingTimerRef.current = window.setTimeout(
        stopRecording,
        maxRecordingMs,
      );
      if (stopRequestedRef.current) stopRecording();
    } catch (error) {
      releaseMicrophone();
      preparedTargetRef.current = null;
      showError(microphoneErrorMessage(error));
    }
  }, [
    clearStatusReset,
    enabled,
    finalizeRecording,
    maxRecordingMs,
    previewIntervalMs,
    releaseMicrophone,
    requestLivePreview,
    setCurrentPhase,
    showError,
    stopLivePreview,
    stopRecording,
  ]);

  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key === 'Escape' &&
        (phaseRef.current === 'requesting' || phaseRef.current === 'recording')
      ) {
        event.preventDefault();
        event.stopPropagation();
        cancelRecording();
        return;
      }
      const isShortcut =
        event.code === 'Space' &&
        event.shiftKey &&
        (event.ctrlKey || event.metaKey);
      if (!isShortcut || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutHeldRef.current = true;
      void startRecording();
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code !== 'Space' || !shortcutHeldRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutHeldRef.current = false;
      stopRecording();
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, [cancelRecording, enabled, startRecording, stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRequestedRef.current = true;
      stopLivePreview(false);
      clearStatusReset();
      if (maxRecordingTimerRef.current !== null) {
        window.clearTimeout(maxRecordingTimerRef.current);
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [clearStatusReset, stopLivePreview]);

  const bridge = useMemo<TerminalDictationBridge>(
    () => ({ activateTarget, clearTarget }),
    [activateTarget, clearTarget],
  );
  const isRecording = phase === 'recording' || phase === 'requesting';
  const controlDisabled =
    !enabled || phase === 'transcribing' || (!activeTarget && phase === 'idle');
  const showLiveTranscript =
    Boolean(liveTranscript) || phase === 'recording' || phase === 'transcribing';
  const statusText = (() => {
    if (phase === 'requesting') return 'Opening microphone…';
    if (phase === 'recording') {
      return `Listening to ${preparedTargetRef.current?.label ?? 'terminal'}…`;
    }
    if (phase === 'transcribing') return 'Transcribing locally…';
    if (phase === 'inserted') return 'Voice text inserted';
    if (phase === 'error') return errorMessage;
    if (activeTarget) return `Voice → ${activeTarget.label}`;
    return 'Focus a terminal for voice input';
  })();
  const serviceText = serviceStatus?.last_error
    ? `Speech model error: ${serviceStatus.last_error}`
    : serviceStatus?.available
      ? serviceStatus.ready
        ? `${serviceStatus.model ?? 'local ASR'}${
            serviceStatus.device ? ` · ${serviceStatus.device}` : ''
          }`
        : 'Local speech model is warming up'
      : serviceStatus?.detail || 'Local speech service is starting';
  const serviceDegraded = Boolean(
    serviceStatus?.last_error || !serviceStatus?.available || !serviceStatus.ready,
  );
  const shortcutHint = navigator.platform.toLowerCase().includes('mac')
    ? '⌘⇧Space'
    : 'Ctrl+Shift+Space';
  const control = useMemo<DictationControlValue>(
    () => ({
      controlDisabled,
      hasTarget: activeTarget !== null,
      isRecording,
      liveTranscript,
      phase,
      serviceDegraded,
      serviceText,
      shortcutHint,
      showLiveTranscript,
      startRecording,
      statusText,
      stopRecording,
    }),
    [
      activeTarget,
      controlDisabled,
      isRecording,
      liveTranscript,
      phase,
      serviceDegraded,
      serviceText,
      shortcutHint,
      showLiveTranscript,
      startRecording,
      statusText,
      stopRecording,
    ],
  );

  return (
    <BridgeContext.Provider value={bridge}>
      <ControlContext.Provider value={control}>
        {children}
      </ControlContext.Provider>
    </BridgeContext.Provider>
  );
}
