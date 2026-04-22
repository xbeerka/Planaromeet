import { useEffect, useRef, useState } from 'react';

interface Participant {
  id: string;
  name: string;
  isLocal: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screensharing?: boolean;
  stream?: MediaStream;
  reconnecting?: boolean;
}

interface VideoGridProps {
  participants: Participant[];
  localStream: MediaStream | null;
}

function Spinner() {
  return (
    <svg className="animate-spin" width="36" height="36" viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="14" stroke="#3c4043" strokeWidth="3" />
      <path d="M18 4 A14 14 0 0 1 32 18" stroke="#8ab4f8" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Measures audio level of a stream — returns true while the participant is speaking. */
function useSpeaking(stream: MediaStream | undefined, audioEnabled: boolean): boolean {
  const [speaking, setSpeaking] = useState(false);
  const rafRef = useRef<number>(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Cancel previous listener
    cleanupRef.current?.();
    cleanupRef.current = null;
    cancelAnimationFrame(rafRef.current);

    if (!stream || !audioEnabled) {
      setSpeaking(false);
      return;
    }

    const audioTracks = stream.getAudioTracks().filter((t) => t.readyState !== 'ended');
    if (audioTracks.length === 0) {
      setSpeaking(false);
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let silentFrames = 0;
    let active = true;

    const tick = () => {
      if (!active) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);

      if (rms > 14) {
        silentFrames = 0;
        setSpeaking(true);
      } else {
        silentFrames++;
        // ~200ms of silence before turning off border
        if (silentFrames > 12) setSpeaking(false);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const start = () => { rafRef.current = requestAnimationFrame(tick); };
    if (ctx.state === 'suspended') {
      ctx.resume().then(start);
    } else {
      start();
    }

    cleanupRef.current = () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
      try { source.disconnect(); } catch {}
      ctx.close();
      setSpeaking(false);
    };

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [stream, audioEnabled]);

  return speaking;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

function VideoTile({ participant, stream }: { participant: Participant; stream?: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [connectTimedOut, setConnectTimedOut] = useState(false);
  const everConnected = useRef(false);

  const isSpeaking = useSpeaking(stream, participant.audioEnabled);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream ?? null;
    if (stream) {
      if (!everConnected.current) setVideoReady(false);
      everConnected.current = true;
      el.play().catch(() => {});
    } else {
      setVideoReady(false);
    }
  }, [stream]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || participant.isLocal) return;
    el.srcObject = stream ?? null;
    if (stream) {
      el.play().catch(() => {});
    }
  }, [stream, participant.isLocal]);

  useEffect(() => {
    const connecting = !participant.isLocal && !stream && !everConnected.current;
    if (!connecting) { setConnectTimedOut(false); return; }
    setConnectTimedOut(false);
    const t = window.setTimeout(() => setConnectTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, [participant.isLocal, stream]);

  const hasVideoTrack = !!(stream?.getVideoTracks().some((t) => t.readyState !== 'ended'));
  const showVideo = hasVideoTrack && participant.videoEnabled;
  const isScreenShareActive = !!participant.screensharing;
  const isScreenShareBadge = isScreenShareActive && !participant.isLocal;
  const isConnecting = !participant.isLocal && !stream && !connectTimedOut && !everConnected.current;
  const isWaitingVideo = !participant.isLocal && !!stream && participant.videoEnabled && !hasVideoTrack;
  const showSpinner = isConnecting || isWaitingVideo || (showVideo && !videoReady && !everConnected.current);

  return (
    <div
      className="relative bg-[#1a1a1a] rounded-xl overflow-hidden w-full h-full"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onCanPlay={() => setVideoReady(true)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          transform: participant.isLocal && !isScreenShareActive ? 'scaleX(-1)' : 'none',
          display: showVideo ? 'block' : 'none',
          background: '#000',
        }}
      />

      {!participant.isLocal && (
        <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />
      )}

      {showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#28292c] gap-3">
          {participant.name && (
            <div className="w-16 h-16 bg-[#8ab4f8] rounded-full flex items-center justify-center text-[#202124] text-xl select-none opacity-40">
              {participant.name.charAt(0).toUpperCase()}
            </div>
          )}
          <Spinner />
          <span className="text-[#9aa0a6] text-xs">
            {isConnecting ? 'Подключение…' : 'Загрузка видео…'}
          </span>
        </div>
      )}

      {participant.reconnecting && !participant.isLocal && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2"
          style={{ background: 'rgba(32,33,36,0.82)', backdropFilter: 'blur(2px)' }}
        >
          <Spinner />
          <span className="text-[#9aa0a6] text-xs">Повторное подключение…</span>
        </div>
      )}

      {!showVideo && !showSpinner && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-[#28292c]"
          style={{ borderRadius: '14px' }}
        >
          <div className="w-20 h-20 bg-[#8ab4f8] rounded-full flex items-center justify-center text-[#202124] text-2xl select-none">
            {(participant.name || '?').charAt(0).toUpperCase()}
          </div>
        </div>
      )}

      {isScreenShareBadge && (
        <div
          className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full"
          style={{ background: 'rgba(138,180,248,0.18)', border: '1px solid rgba(138,180,248,0.35)' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8ab4f8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          <span style={{ color: '#8ab4f8', fontSize: 11 }}>Экран</span>
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex items-center gap-2">
        <div
          className="bg-[#000000cc] px-3 py-1 rounded-full flex items-center gap-2"
        >
          <span className="text-white text-sm truncate max-w-[140px]">
            {participant.name || (isConnecting ? 'Подключается…' : '...')}
            {participant.isLocal && ' (вы)'}
          </span>
          {!participant.audioEnabled && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e8eaed" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </div>
      </div>

      {/* Speaking outline overlay — rendered last so it sits above video */}
      <div
        style={{
          position: 'absolute', inset: 0,
          borderRadius: '14px',
          boxShadow: isSpeaking ? 'inset 0 0 0 3px #8ab4f8' : 'none',
          transition: 'box-shadow 120ms ease',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      />
    </div>
  );
}

export function VideoGrid({ participants, localStream }: VideoGridProps) {
  const isMobile = useIsMobile();
  const count = participants.length;

  // On mobile: always 1 column (stack vertically)
  // On desktop: 1 col for solo, 2 cols for 2–4, 3 cols for 5+
  const cols = isMobile ? 1 : count <= 1 ? 1 : count <= 4 ? 2 : 3;

  const rowGroups: Participant[][] = [];
  for (let i = 0; i < participants.length; i += cols) {
    rowGroups.push(participants.slice(i, i + cols));
  }

  return (
    <div
      className="w-full h-full p-3"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: isMobile ? 'auto' : 'hidden' }}
    >
      {rowGroups.map((row, rowIdx) => (
        <div
          key={rowIdx}
          style={{
            display: 'flex',
            gap: 12,
            // On mobile each tile gets a fixed height so they stack nicely
            flex: isMobile ? 'none' : 1,
            height: isMobile ? `calc((100vh - 160px) / ${Math.min(count, 3)})` : undefined,
            minHeight: isMobile ? 180 : 0,
            justifyContent: 'center',
          }}
        >
          {row.map((participant) => (
            <div
              key={participant.id}
              style={{
                flex: `0 0 calc((100% - ${(cols - 1) * 12}px) / ${cols})`,
                minWidth: 0,
              }}
            >
              <VideoTile
                participant={participant}
                stream={participant.isLocal ? localStream || undefined : participant.stream}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}