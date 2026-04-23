import { useEffect, useRef, useState, useCallback } from 'react';

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
  getVideoStats?: (participantId: string) => Promise<{ kbps: number | null; fps: number | null }>;
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
    cleanupRef.current?.();
    cleanupRef.current = null;
    cancelAnimationFrame(rafRef.current);

    if (!stream || !audioEnabled) { setSpeaking(false); return; }

    const audioTracks = stream.getAudioTracks().filter((t) => t.readyState !== 'ended');
    if (audioTracks.length === 0) { setSpeaking(false); return; }

    let ctx: AudioContext;
    try { ctx = new AudioContext(); } catch { return; }

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
      if (rms > 14) { silentFrames = 0; setSpeaking(true); }
      else { silentFrames++; if (silentFrames > 12) setSpeaking(false); }
      rafRef.current = requestAnimationFrame(tick);
    };

    const start = () => { rafRef.current = requestAnimationFrame(tick); };
    if (ctx.state === 'suspended') { ctx.resume().then(start); } else { start(); }

    cleanupRef.current = () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
      try { source.disconnect(); } catch {}
      ctx.close();
      setSpeaking(false);
    };

    return () => { cleanupRef.current?.(); cleanupRef.current = null; };
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

/**
 * Returns { cols, rows } for the CSS grid.
 * Desktop: wide layout. Mobile: portrait-optimised (prefer 1 col for ≤3 to keep good 16:9 tiles).
 */
function getGridDimensions(count: number, isMobile: boolean): { cols: number; rows: number } {
  if (count === 0) return { cols: 1, rows: 1 };

  if (isMobile) {
    if (count === 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 1, rows: 2 };
    if (count === 3) return { cols: 1, rows: 3 };
    if (count === 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 2, rows: 3 };
    return { cols: 2, rows: Math.ceil(count / 2) };
  }

  // Desktop
  if (count === 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count === 3) return { cols: 3, rows: 1 };
  if (count === 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

/** Polls video bitrate + fps for one participant every 2.5s */
function useVideoStats(
  participantId: string,
  active: boolean,
  getStats?: (id: string) => Promise<{ kbps: number | null; fps: number | null }>,
): { kbps: number | null; fps: number | null } {
  const [stats, setStats] = useState<{ kbps: number | null; fps: number | null }>({ kbps: null, fps: null });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    if (!getStats || !active) { setStats({ kbps: null, fps: null }); return; }
    const v = await getStats(participantId).catch(() => ({ kbps: null, fps: null }));
    setStats(v);
  }, [participantId, active, getStats]);

  useEffect(() => {
    if (!active || !getStats) { setStats({ kbps: null, fps: null }); return; }
    const init = setTimeout(poll, 1500);
    timerRef.current = setInterval(poll, 2500);
    return () => { clearTimeout(init); if (timerRef.current) clearInterval(timerRef.current); };
  }, [active, poll]);

  return stats;
}

/** Formats kbps to a compact string like "1.2 Mb" or "842 kb" */
function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mb`;
  return `${kbps} kb`;
}

/** FPS color: green ≥ 24, yellow 15-23, red < 15 */
function fpsColor(fps: number): string {
  if (fps >= 24) return 'rgba(87,242,135,0.85)';   // green
  if (fps >= 15) return 'rgba(255,214,0,0.9)';     // yellow
  return 'rgba(242,87,87,0.95)';                   // red
}

function VideoTile({
  participant,
  stream,
  getVideoStats,
}: {
  participant: Participant;
  stream?: MediaStream;
  getVideoStats?: (id: string) => Promise<{ kbps: number | null; fps: number | null }>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [connectTimedOut, setConnectTimedOut] = useState(false);
  const [slowConnect, setSlowConnect] = useState(false);
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
    if (stream) { el.play().catch(() => {}); }
  }, [stream, participant.isLocal]);

  // Hard timeout (8s): give up showing spinner, show avatar
  useEffect(() => {
    const connecting = !participant.isLocal && !stream && !everConnected.current;
    if (!connecting) { setConnectTimedOut(false); setSlowConnect(false); return; }
    setConnectTimedOut(false);
    setSlowConnect(false);
    // After 1.5s with no stream → show subtle pulsing ring
    const t1 = window.setTimeout(() => setSlowConnect(true), 1500);
    // After 8s → give up
    const t2 = window.setTimeout(() => setConnectTimedOut(true), 8000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [participant.isLocal, stream]);

  const hasVideoTrack = !!(stream?.getVideoTracks().some((t) => t.readyState !== 'ended'));
  const showVideo = hasVideoTrack && participant.videoEnabled;
  const isScreenShareActive = !!participant.screensharing;
  const isScreenShareBadge = isScreenShareActive && !participant.isLocal;

  // Connecting: no stream yet, never had a stream
  const isConnecting = !participant.isLocal && !stream && !connectTimedOut && !everConnected.current;
  // Video track exists but frames not flowing yet
  const isWaitingVideo = !participant.isLocal && !!stream && participant.videoEnabled && !hasVideoTrack;

  // We only show the heavy spinner for isWaitingVideo (stream arrived, waiting for first frame)
  // For isConnecting we show a clean avatar (like Google Meet) — no jarring spinner
  const showHeavySpinner = isWaitingVideo || (showVideo && !videoReady && !everConnected.current);

  // Avatar tile: shown whenever no video + not a heavy-spinner case
  const showAvatar = !showVideo && !showHeavySpinner;

  const bitrateActive = showVideo || isScreenShareActive;
  const { kbps, fps } = useVideoStats(participant.id, bitrateActive, getVideoStats);

  const showStatsBadge = bitrateActive && (kbps !== null || fps !== null);

  return (
    <div className="relative bg-[#1a1a1a] rounded-xl overflow-hidden w-full h-full">
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

      {/* ── Avatar tile (shown immediately — no spinner while waiting for stream) ── */}
      {showAvatar && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center bg-[#28292c]"
          style={{ borderRadius: '14px' }}
        >
          {/* Avatar circle with optional slow-connect pulse ring */}
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            {/* Pulsing ring — only appears after 1.5s if still no stream */}
            {isConnecting && slowConnect && (
              <span
                style={{
                  position: 'absolute', inset: -6,
                  borderRadius: '50%',
                  border: '2px solid rgba(138,180,248,0.5)',
                  animation: 'lk-pulse 1.6s ease-in-out infinite',
                }}
              />
            )}
            <div
              style={{
                width: 72, height: 72,
                borderRadius: '50%',
                background: isConnecting ? '#3c4043' : '#8ab4f8',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 28, color: isConnecting ? '#9aa0a6' : '#202124',
                fontWeight: 600, userSelect: 'none',
                transition: 'background 0.4s',
              }}
            >
              {(participant.name || '?').charAt(0).toUpperCase()}
            </div>
          </div>
          {/* Name under avatar */}
          <span style={{ color: '#9aa0a6', fontSize: 13, marginTop: 10 }}>
            {participant.name || (isConnecting ? 'Подключается…' : '—')}
          </span>
          {/* Subtle "connecting" hint — only after 1.5s */}
          {isConnecting && slowConnect && (
            <span style={{ color: '#5f6368', fontSize: 11, marginTop: 4 }}>
              Загрузка видео…
            </span>
          )}
        </div>
      )}

      {/* ── Heavy spinner: only when stream exists but video not ready yet ─── */}
      {showHeavySpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#28292c] gap-3">
          {participant.name && (
            <div className="w-16 h-16 bg-[#8ab4f8] rounded-full flex items-center justify-center text-[#202124] text-xl select-none opacity-40">
              {participant.name.charAt(0).toUpperCase()}
            </div>
          )}
          <Spinner />
          <span className="text-[#9aa0a6] text-xs">Загрузка видео…</span>
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
        <div className="bg-[#000000cc] px-3 py-1 rounded-full flex items-center gap-2">
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

      {/* Stats badge — bottom right: bitrate + fps with health colour */}
      {showStatsBadge && (
        <div
          className="absolute bottom-3 right-3 flex items-center gap-1.5"
          style={{
            background: 'rgba(0,0,0,0.6)',
            borderRadius: 10,
            padding: '2px 8px',
            pointerEvents: 'none',
          }}
        >
          {fps !== null && (
            <span style={{
              color: fpsColor(fps),
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
              fontWeight: fps < 24 ? 600 : 400,
              letterSpacing: '0.01em',
            }}>
              {fps}fps
            </span>
          )}
          {fps !== null && kbps !== null && (
            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>·</span>
          )}
          {kbps !== null && (
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em' }}>
              {formatBitrate(kbps)}
            </span>
          )}
        </div>
      )}

      {/* Speaking outline overlay */}
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

      {/* Keyframes for pulse ring */}
      <style>{`
        @keyframes lk-pulse {
          0%   { transform: scale(1);    opacity: 0.7; }
          50%  { transform: scale(1.12); opacity: 0.3; }
          100% { transform: scale(1);    opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

export function VideoGrid({ participants, localStream, getVideoStats }: VideoGridProps) {
  const isMobile = useIsMobile();
  const count = participants.length;
  const { cols, rows } = getGridDimensions(count, isMobile);

  // The last item gets full-width span when the grid has an odd item in the last row
  const lastRowCount = count % cols;
  const hasOddLast = lastRowCount !== 0;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gap: 10,
        padding: 10,
        boxSizing: 'border-box',
        overflow: 'hidden', // ← never scroll; tiles always fit the container
      }}
    >
      {participants.map((participant, idx) => {
        // If this is the lone last item in a multi-col grid, centre it by spanning all cols
        const isLoneLast = hasOddLast && idx === count - 1 && cols > 1;
        return (
          <div
            key={participant.id}
            style={{
              minWidth: 0,
              minHeight: 0,
              gridColumn: isLoneLast ? `1 / -1` : undefined,
              // When the lone tile spans all columns, cap its width so it doesn't stretch weirdly
              ...(isLoneLast ? { justifySelf: 'center', width: `calc(100% / ${cols})` } : {}),
            }}
          >
            <VideoTile
              participant={participant}
              stream={participant.isLocal ? localStream || undefined : participant.stream}
              getVideoStats={getVideoStats}
            />
          </div>
        );
      })}
    </div>
  );
}