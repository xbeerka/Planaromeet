import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Videocam, VideocamOff } from '@mui/icons-material';

interface PreJoinLobbyProps {
  roomId: string;
  onJoin: (stream: MediaStream | null) => void;  // pass stream instead of stopping it
  onCancel: () => void;
}

export function PreJoinLobby({ roomId, onJoin, onCancel }: PreJoinLobbyProps) {
  const [name, setName] = useState(() => localStorage.getItem('userName') || '');
  const [audioOn, setAudioOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [hasCamera, setHasCamera] = useState(false);
  const [hasMic, setHasMic] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [nameHovered, setNameHovered] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [nameError, setNameError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Set to true when the user confirms join — prevents cleanup from stopping
  // tracks that have been handed off to the meeting room.
  const streamHandedOff = useRef(false);

  // Acquire preview stream
  useEffect(() => {
    let active = true;
    const tracks: MediaStreamTrack[] = [];

    (async () => {
      // ── Single combined request: one permission prompt on Android ────────
      // Requesting video+audio together avoids multiple browser permission
      // dialogs. Fall back to separate calls only if combined fails (e.g.
      // device not present).
      let vt: MediaStreamTrack | null = null;
      let at: MediaStreamTrack | null = null;

      try {
        const combined = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'user' } },
          audio: true,
        });
        vt = combined.getVideoTracks()[0] ?? null;
        at = combined.getAudioTracks()[0] ?? null;
      } catch {
        // Combined failed (one device missing) — try each separately
        const [vRes, aRes] = await Promise.allSettled([
          navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: false }),
          navigator.mediaDevices.getUserMedia({ video: false, audio: true }),
        ]);
        if (vRes.status === 'fulfilled') vt = vRes.value.getVideoTracks()[0] ?? null;
        if (aRes.status === 'fulfilled') at = aRes.value.getAudioTracks()[0] ?? null;
      }

      // ── Ensure front camera ──────────────────────────────────────────────
      if (vt) {
        const facing = vt.getSettings?.().facingMode;
        const isBackCamera =
          facing === 'environment' ||
          /ultra.?wide|wide.?angle|\b(back|rear)\b/i.test(vt.label);
        if (isBackCamera) {
          try {
            vt.stop();
            const frontVs = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { exact: 'user' } },
              audio: false,
            });
            vt = frontVs.getVideoTracks()[0] ?? vt;
          } catch {
            // facingMode:exact not supported (desktop) — keep current track
          }
        }
        tracks.push(vt);
        if (active) setHasCamera(true);
      }

      if (at) {
        tracks.push(at);
        if (active) setHasMic(true);
      }

      if (!active) { tracks.forEach(t => t.stop()); return; }

      if (tracks.length > 0) {
        const ms = new MediaStream(tracks);
        setStream(ms);
      }
    })();

    return () => {
      active = false;
      // Only stop tracks if we kept the stream (user cancelled / backed out).
      // If the stream was handed off to the meeting room, leave it alive.
      if (!streamHandedOff.current) {
        tracks.forEach(t => t.stop());
      }
    };
  }, []);

  // Attach to video element
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = (videoOn && stream) ? stream : null;
    if (videoOn && stream) el.play().catch(() => {});
  }, [stream, videoOn]);

  // Toggle tracks
  useEffect(() => {
    stream?.getVideoTracks().forEach(t => { t.enabled = videoOn; });
  }, [videoOn, stream]);

  useEffect(() => {
    stream?.getAudioTracks().forEach(t => { t.enabled = audioOn; });
  }, [audioOn, stream]);

  const handleJoin = () => {
    if (!name.trim()) {
      setNameError(true);
      nameInputRef.current?.focus();
      return;
    }
    localStorage.setItem('userName', name.trim());
    // Mark stream as handed off so the cleanup effect won't stop its tracks.
    streamHandedOff.current = true;
    // Don't stop tracks — hand the live stream to the meeting room
    // so useWebRTC can reuse it without a second getUserMedia call.
    onJoin(stream);
  };

  const nameBorderColor = nameFocused
    ? '#8ab4f8'
    : nameError
    ? '#ea4335'
    : nameHovered
    ? '#5f6368'
    : 'transparent';

  const initials = (name || '?').charAt(0).toUpperCase();

  return (
    <div className="size-full flex flex-col bg-[#202124]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0">
        <h1 className="text-white text-xl select-none">
          Planaro <span style={{ color: '#8ab4f8' }}>meet</span>
        </h1>
        <button
          onClick={onCancel}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9aa0a6',
            cursor: 'pointer',
            fontSize: '0.875rem',
            padding: '6px 12px',
            borderRadius: 4,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#e8eaed')}
          onMouseLeave={e => (e.currentTarget.style.color = '#9aa0a6')}
        >
          Назад
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-4 pb-8">
        <div
          className="flex flex-col items-center w-full"
          style={{ maxWidth: 420 }}
        >
          {/* Title */}
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ color: '#e8eaed', fontSize: '1.5rem', marginBottom: 6 }}>
              Готовы присоединиться?
            </div>
            {roomId && (
              <div style={{
                display: 'inline-block',
                color: '#9aa0a6', fontSize: '0.78rem', fontFamily: 'monospace',
                background: 'rgba(255,255,255,0.06)',
                borderRadius: 50, padding: '3px 12px',
              }}>
                {roomId}
              </div>
            )}
          </div>

          {/* Video preview with overlay controls */}
          <div style={{
            position: 'relative',
            width: '100%',
            aspectRatio: '4/3',
            borderRadius: 24,
            overflow: 'hidden',
            background: '#28292c',
            marginBottom: 12,
          }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: 'scaleX(-1)',
                display: videoOn && hasCamera ? 'block' : 'none',
              }}
            />
            {/* Avatar fallback */}
            {(!videoOn || !hasCamera) && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: 88, height: 88,
                  background: 'rgba(138,180,248,0.18)',
                  border: '2px solid rgba(138,180,248,0.3)',
                  borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#8ab4f8', fontSize: '2.2rem', userSelect: 'none',
                }}>
                  {initials}
                </div>
              </div>
            )}

            {/* Bottom gradient + toggle controls */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              background: 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.55))',
              padding: '40px 0 18px',
              display: 'flex', justifyContent: 'center', gap: 12,
            }}>
              <ToggleButton
                on={audioOn && hasMic}
                disabled={!hasMic}
                onClick={() => setAudioOn(v => !v)}
                title={audioOn ? 'Выключить микрофон' : 'Включить микрофон'}
                iconOn={<Mic sx={{ color: '#e8eaed', fontSize: 20 }} />}
                iconOff={<MicOff sx={{ color: '#fff', fontSize: 20 }} />}
              />
              <ToggleButton
                on={videoOn && hasCamera}
                disabled={!hasCamera}
                onClick={() => setVideoOn(v => !v)}
                title={videoOn ? 'Выключить камеру' : 'Включить камеру'}
                iconOn={<Videocam sx={{ color: '#e8eaed', fontSize: 20 }} />}
                iconOff={<VideocamOff sx={{ color: '#fff', fontSize: 20 }} />}
              />
            </div>
          </div>

          {/* Device status chips — shown only when unavailable */}
          {(!hasMic || !hasCamera) && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
              {!hasMic && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'rgba(234,67,53,0.1)',
                  border: '1px solid rgba(234,67,53,0.25)',
                  borderRadius: 50, padding: '4px 12px',
                  color: '#f28b82', fontSize: '0.75rem',
                }}>
                  <MicOff sx={{ fontSize: 13 }} />
                  Нет микрофона
                </div>
              )}
              {!hasCamera && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'rgba(234,67,53,0.1)',
                  border: '1px solid rgba(234,67,53,0.25)',
                  borderRadius: 50, padding: '4px 12px',
                  color: '#f28b82', fontSize: '0.75rem',
                }}>
                  <VideocamOff sx={{ fontSize: 13 }} />
                  Нет камеры
                </div>
              )}
            </div>
          )}

          {/* Name input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginBottom: 16 }}>
            <div style={{
              display: 'flex', alignItems: 'center',
              background: '#28292c',
              border: `1.5px solid ${nameFocused ? '#8ab4f8' : nameError ? '#ea4335' : nameHovered ? '#5f6368' : '#3c4043'}`,
              borderRadius: 16,
              padding: '0 16px',
              transition: 'border-color 0.15s',
            }}>
              <input
                ref={nameInputRef}
                value={name}
                onChange={e => { setName(e.target.value); setNameError(false); }}
                onKeyDown={e => e.key === 'Enter' && handleJoin()}
                onMouseEnter={() => setNameHovered(true)}
                onMouseLeave={() => setNameHovered(false)}
                onFocus={() => { setNameFocused(true); setNameError(false); }}
                onBlur={() => setNameFocused(false)}
                placeholder="Ваше имя"
                maxLength={40}
                style={{
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#e8eaed',
                  fontSize: '0.95rem',
                  padding: '14px 0',
                  width: '100%',
                  caretColor: '#8ab4f8',
                }}
              />
            </div>
            {nameError && (
              <span style={{ color: '#ea4335', fontSize: '0.75rem', paddingLeft: 4 }}>
                Укажите ваше имя
              </span>
            )}
          </div>

          {/* Join button */}
          <JoinButton onClick={handleJoin} enabled={!!name.trim()} />
        </div>
      </div>
    </div>
  );
}

function ToggleButton({
  on, disabled, onClick, title, iconOn, iconOff,
}: {
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
  iconOn: React.ReactNode;
  iconOff: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = disabled
    ? '#3c4043'
    : on
    ? hovered ? '#4a4d50' : '#3c4043'
    : hovered ? '#c5382e' : '#ea4335';

  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 52, height: 52,
        borderRadius: '50%',
        background: bg,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 0.15s, opacity 0.15s',
      }}
    >
      {on ? iconOn : iconOff}
    </button>
  );
}

function JoinButton({ onClick, enabled }: { onClick: () => void; enabled: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '13px 24px',
        borderRadius: 50,
        background: enabled ? (hovered ? '#a8c7fa' : '#8ab4f8') : '#3c4043',
        color: enabled ? '#202124' : '#9aa0a6',
        border: 'none',
        cursor: enabled ? 'pointer' : 'not-allowed',
        fontSize: '0.9rem',
        fontWeight: 500,
        transition: 'background 0.15s',
        width: '100%',
      }}
    >
      Присоединиться
    </button>
  );
}