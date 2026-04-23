import { useState, useEffect, useRef, useCallback } from 'react';
import { IconButton, Tooltip, Snackbar, Menu, MenuItem, ListItemIcon, ListItemText, Divider, useMediaQuery } from '@mui/material';
import {
  Mic,
  MicOff,
  Videocam,
  VideocamOff,
  CallEnd,
  PresentToAll,
  People,
  Link as LinkIcon,
  Check,
  MoreVert,
  RadioButtonChecked,
  Stop,
  Settings as SettingsIcon,
  Refresh,
  WifiOff,
} from '@mui/icons-material';
import { ParticipantsList } from './ParticipantsList';
import { Settings } from './Settings';
import { NameDialog } from './NameDialog';
import { AudioVisualizer } from './AudioVisualizer';
import { useWebRTC } from '../hooks/useWebRTC';
import { VideoGrid } from './VideoGrid';
import { useRecorder } from '../hooks/useRecorder';
import { BottomSheet } from './BottomSheet';

interface MeetingRoomProps {
  roomId: string;
  onLeave: () => void;
  initialStream?: MediaStream | null;
}

// ── Spinner SVG ───────────────────────────────────────────────────────────────
function Spinner({ color = '#8ab4f8' }: { color?: string }) {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="24" cy="24" r="18" stroke="#3c4043" strokeWidth="4" />
      <path d="M24 6 A18 18 0 0 1 42 24" stroke={color} strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function MeetingRoom({ roomId, onLeave, initialStream }: MeetingRoomProps) {
  const [showParticipants, setShowParticipants] = useState(false);
  const [showSettings, setShowSettings]         = useState(false);
  const [showNameDialog, setShowNameDialog]     = useState(false);
  const [linkCopied, setLinkCopied]             = useState(false);
  const [currentTime, setCurrentTime]           = useState(() =>
    new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  );
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuOpen = Boolean(menuAnchor);

  const isMobile = useMediaQuery('(max-width: 640px)');

  const [userName, setUserName] = useState<string>(() => localStorage.getItem('userName') || '');

  // ── WebRTC ────────────────────────────────────────────────────────────────
  const {
    participants,
    localStream,
    toggleAudio,
    toggleVideo,
    leaveRoom,
    changeDevices,
    videoAvailable,
    audioAvailable,
    forceControlParticipant,
    isScreenSharing,
    startScreenShare,
    stopScreenShare,
    localAudioEnabled,
    localVideoEnabled,
    connectionState,
    connectionError,
    retryJoin,
    subscribeToVideoStats,
  } = useWebRTC(roomId, userName, initialStream);

  const [audioEnabled, setAudioEnabled] = useState(localAudioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(localVideoEnabled);

  // ── Recorder ──────────────────────────────────────────────────────────────
  const { recorderState, recordingTime, error: recorderError, startRecording, stopRecording, dismiss } = useRecorder();

  // ── Snackbar queue ────────────────────────────────────────────────────────
  const [snackQueue, setSnackQueue]   = useState<Array<{ msg: string; key: number }>>([]);
  const [activeSnack, setActiveSnack] = useState<{ msg: string; key: number } | null>(null);
  const [snackOpen, setSnackOpen]     = useState(false);
  const snackKeyRef                   = useRef(0);
  const prevRemoteRef                 = useRef<Map<string, string>>(new Map());
  const isFirstRemoteBatch            = useRef(true);

  const enqueueSnack = useCallback((msg: string) => {
    setSnackQueue((prev) => [...prev, { msg, key: ++snackKeyRef.current }]);
  }, []);

  useEffect(() => {
    if (snackQueue.length > 0 && !snackOpen) {
      setActiveSnack(snackQueue[0]);
      setSnackQueue((prev) => prev.slice(1));
      setSnackOpen(true);
    }
  }, [snackQueue, snackOpen]);

  useEffect(() => {
    const remote = participants.filter((p) => !p.isLocal);
    const currentMap = new Map(remote.map((p) => [p.id, p.name]));
    const prev = prevRemoteRef.current;
    if (isFirstRemoteBatch.current && currentMap.size > 0) {
      isFirstRemoteBatch.current = false;
    } else {
      currentMap.forEach((name, id) => { if (!prev.has(id)) enqueueSnack(`${name || 'Участник'} подключился`); });
    }
    prev.forEach((name, id) => { if (!currentMap.has(id)) enqueueSnack(`${name || 'Участник'} покинул встречу`); });
    prevRemoteRef.current = currentMap;
  }, [participants, enqueueSnack]);

  useEffect(() => { if (!localStorage.getItem('userName')) setShowNameDialog(true); }, []);

  useEffect(() => {
    const update = () => setCurrentTime(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    const id = setInterval(update, 10_000);
    return () => clearInterval(id);
  }, []);

  const formatRecTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const handleToggleAudio = () => { const next = !audioEnabled; setAudioEnabled(next); toggleAudio(next); };
  const handleToggleVideo = () => { const next = !videoEnabled; setVideoEnabled(next); toggleVideo(next); };
  const handleLeave = () => { leaveRoom(); onLeave(); };

  const copyMeetingLink = () => {
    const text = `${window.location.origin}/#/room/${roomId}`;
    const done = () => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); };
    navigator.clipboard.writeText(text).then(done).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta); done();
    });
  };

  const handleNameSubmit = (name: string) => { setUserName(name); setShowNameDialog(false); };
  const handleDeviceChange = (devices: { videoId?: string; audioId?: string; outputId?: string }) => {
    changeDevices(devices);
    const savedName = localStorage.getItem('userName');
    if (savedName && savedName !== userName) setUserName(savedName);
  };

  const handleScreenShare = () => {
    const someoneIsSharing = participants.some((p) => !p.isLocal && p.screensharing);
    if (!isScreenSharing && someoneIsSharing) return;
    isScreenSharing ? stopScreenShare() : startScreenShare();
  };

  const handleRecord = () => {
    if (recorderState === 'recording') {
      stopRecording(roomId);
    } else {
      startRecording(participants.map((p) => ({ stream: p.isLocal ? localStream : p.stream, name: p.name, isLocal: p.isLocal })));
    }
  };

  const someoneIsSharing = participants.some((p) => !p.isLocal && p.screensharing);
  const shareBlocked = !isScreenSharing && someoneIsSharing;

  // ── Overlay visibility ────────────────────────────────────────────────────
  const showLoading      = connectionState === 'connecting' && participants.length === 0;
  const showReconnecting = connectionState === 'reconnecting';
  const showFailed       = connectionState === 'failed';

  // ── Full-screen overlay helper ────────────────────────────────────────────
  const FullOverlay = ({ children }: { children: React.ReactNode }) => (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      background: 'rgba(32,33,36,0.96)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 20,
    }}>
      {children}
    </div>
  );

  return (
    <div className="size-full flex flex-col bg-[#202124]">

      {/* ── Connecting overlay ─────────────────────────────────────────────── */}
      {showLoading && (
        <FullOverlay>
          <Spinner />
          <span style={{ color: '#9aa0a6', fontSize: '0.9rem' }}>Подключение к комнате…</span>
        </FullOverlay>
      )}

      {/* ── Reconnecting banner (non-blocking) ────────────────────────────── */}
      {showReconnecting && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 90,
          background: 'rgba(251,188,4,0.15)',
          borderBottom: '1px solid rgba(251,188,4,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 10, padding: '10px 16px',
        }}>
          <Spinner color="#fbbc04" />
          <span style={{ color: '#fbbc04', fontSize: '0.875rem' }}>
            Переподключение… Пожалуйста, подождите
          </span>
        </div>
      )}

      {/* ── Connection failed overlay ──────────────────────────────────────── */}
      {showFailed && (
        <FullOverlay>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'rgba(234,67,53,0.15)',
            border: '2px solid rgba(234,67,53,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <WifiOff style={{ color: '#ea4335', fontSize: 28 }} />
          </div>
          <div style={{ textAlign: 'center', maxWidth: 320 }}>
            <div style={{ color: '#e8eaed', fontSize: '1rem', marginBottom: 8 }}>
              Не удалось подключиться
            </div>
            <div style={{ color: '#9aa0a6', fontSize: '0.82rem', lineHeight: 1.5 }}>
              {connectionError ?? 'Сеть заблокировала медиа-порты (CGNAT/LTE).\nВключите TURN в livekit.yaml или смените сеть.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            <button
              onClick={retryJoin}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 22px', borderRadius: 24,
                background: '#8ab4f8', color: '#202124',
                border: 'none', cursor: 'pointer', fontSize: '0.875rem',
              }}
            >
              <Refresh style={{ fontSize: 18 }} />
              Попробовать снова
            </button>
            <button
              onClick={handleLeave}
              style={{
                padding: '10px 22px', borderRadius: 24,
                background: 'transparent', color: '#9aa0a6',
                border: '1px solid #3c4043', cursor: 'pointer', fontSize: '0.875rem',
              }}
            >
              Выйти
            </button>
          </div>
        </FullOverlay>
      )}

      {/* ── Recording indicator ───────────────────────────────────────────── */}
      {recorderState === 'recording' && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 50, display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(30,30,32,0.92)', border: '1px solid #ea4335',
          borderRadius: 24, padding: '6px 16px 6px 10px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
        }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ea4335', display: 'inline-block', animation: 'pulse-rec 1.2s infinite' }} />
          <span style={{ color: '#e8eaed', fontSize: '0.82rem' }}>Запись</span>
          <span style={{ color: '#ea4335', fontSize: '0.82rem', fontVariantNumeric: 'tabular-nums', minWidth: 36 }}>{formatRecTime(recordingTime)}</span>
        </div>
      )}

      {/* ── Main video area ───────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 min-h-0" style={{ position: 'relative' }}>
          <VideoGrid participants={participants} localStream={localStream} subscribeToVideoStats={subscribeToVideoStats} />
        </div>

        {/* Participants sidebar — desktop */}
        {!isMobile && (
          <div
            className="h-full shrink-0 overflow-hidden"
            style={{ width: showParticipants ? 296 : 0, transition: 'width 320ms cubic-bezier(0.4,0,0.2,1)' }}
          >
            <div style={{
              width: 296, height: '100%', padding: '12px 12px 12px 0',
              transform: showParticipants ? 'translateX(0)' : 'translateX(100%)',
              transition: 'transform 320ms cubic-bezier(0.4,0,0.2,1)',
            }}>
              <ParticipantsList participants={participants} onClose={() => setShowParticipants(false)} onForceControl={forceControlParticipant} />
            </div>
          </div>
        )}

        {/* Participants bottom sheet — mobile */}
        {isMobile && (
          <BottomSheet open={showParticipants} onClose={() => setShowParticipants(false)} maxHeight="calc(100vh - 24px)">
            <ParticipantsList participants={participants} onClose={() => setShowParticipants(false)} onForceControl={forceControlParticipant} />
          </BottomSheet>
        )}
      </div>

      {/* ── Controls bar ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-6 bg-[#202124]">

        {/* Left: room link — desktop only */}
        <div className="hidden sm:flex items-center" style={{ minWidth: 0 }}>
          <Tooltip title="Нажмите, чтобы скопировать ссылку на встречу">
            <button
              onClick={() => {
                const text = `${window.location.origin}/#/room/${roomId}`;
                navigator.clipboard.writeText(text).then(
                  () => enqueueSnack('Ссылка скопирована'),
                  () => {
                    const ta = document.createElement('textarea');
                    ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                    document.body.appendChild(ta); ta.focus(); ta.select();
                    try { document.execCommand('copy'); } catch {}
                    document.body.removeChild(ta);
                    enqueueSnack('Ссылка скопирована');
                  }
                );
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                height: 44, padding: '0 14px', borderRadius: 22,
                backgroundColor: '#3c4043', border: 'none', cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#5f6368')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#3c4043')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5f6368" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              <span style={{ color: '#9aa0a6', fontSize: '0.78rem', fontFamily: 'monospace', whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
                {roomId}
              </span>
            </button>
          </Tooltip>
        </div>
        <div className="flex sm:hidden" style={{ minWidth: 40 }} />

        {/* Center: control buttons */}
        <div className="flex items-center gap-2">
          {/* Mic */}
          <Tooltip title={!audioAvailable ? 'Микрофон недоступен' : audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}>
            <div className="relative">
              <IconButton
                onClick={!audioAvailable ? () => setShowSettings(true) : handleToggleAudio}
                sx={{
                  backgroundColor: !audioAvailable ? 'rgba(255,255,255,0.08)' : audioEnabled ? '#3c4043' : '#ffffff',
                  color: !audioAvailable ? '#5f6368' : audioEnabled ? '#e8eaed' : '#202124',
                  width: 56, height: 56,
                  '&:hover': { backgroundColor: !audioAvailable ? 'rgba(255,255,255,0.14)' : audioEnabled ? '#5f6368' : '#e8eaed' },
                }}
              >
                {audioEnabled && audioAvailable ? <Mic /> : <MicOff />}
              </IconButton>
              <AudioVisualizer stream={localStream} isEnabled={audioEnabled} />
              {!audioAvailable && (
                <div className="absolute -top-1 -right-1 w-5 h-5 bg-[#ea4335] rounded-full flex items-center justify-center border-2 border-[#202124] pointer-events-none">
                  <span className="text-white leading-none" style={{ fontSize: 11, fontWeight: 700 }}>!</span>
                </div>
              )}
            </div>
          </Tooltip>

          {/* Camera */}
          <Tooltip title={!videoAvailable ? 'Камера недоступна' : videoEnabled ? 'Выключить камеру' : 'Включить камеру'}>
            <div className="relative">
              <IconButton
                onClick={!videoAvailable ? () => setShowSettings(true) : handleToggleVideo}
                sx={{
                  backgroundColor: !videoAvailable ? 'rgba(255,255,255,0.08)' : videoEnabled ? '#3c4043' : '#ffffff',
                  color: !videoAvailable ? '#5f6368' : videoEnabled ? '#e8eaed' : '#202124',
                  width: 56, height: 56,
                  '&:hover': { backgroundColor: !videoAvailable ? 'rgba(255,255,255,0.14)' : videoEnabled ? '#5f6368' : '#e8eaed' },
                }}
              >
                {videoEnabled && videoAvailable ? <Videocam /> : <VideocamOff />}
              </IconButton>
              {!videoAvailable && (
                <div className="absolute -top-1 -right-1 w-5 h-5 bg-[#ea4335] rounded-full flex items-center justify-center border-2 border-[#202124] pointer-events-none">
                  <span className="text-white leading-none" style={{ fontSize: 11, fontWeight: 700 }}>!</span>
                </div>
              )}
            </div>
          </Tooltip>

          {/* Screen share — desktop */}
          <div className="hidden sm:block">
            <Tooltip title={shareBlocked ? 'Другой участник уже показывает экран' : isScreenSharing ? 'Остановить показ экрана' : 'Показать экран'}>
              <span>
                <IconButton
                  onClick={handleScreenShare} disabled={shareBlocked}
                  sx={{
                    backgroundColor: isScreenSharing ? '#8ab4f8' : shareBlocked ? 'rgba(255,255,255,0.05)' : '#3c4043',
                    color: isScreenSharing ? '#202124' : shareBlocked ? '#5f6368' : '#e8eaed',
                    width: 56, height: 56, opacity: shareBlocked ? 0.5 : 1,
                    '&:hover': { backgroundColor: isScreenSharing ? '#a8c7fa' : shareBlocked ? 'rgba(255,255,255,0.05)' : '#5f6368' },
                    '&.Mui-disabled': { backgroundColor: 'rgba(255,255,255,0.05)', color: '#5f6368' },
                  }}
                >
                  <PresentToAll />
                </IconButton>
              </span>
            </Tooltip>
          </div>

          {/* Record — desktop */}
          <div className="hidden sm:block">
            <Tooltip title={recorderState === 'recording' ? 'Остановить запись' : 'Начать запись'}>
              <IconButton
                onClick={handleRecord}
                sx={{
                  backgroundColor: recorderState === 'recording' ? '#ea4335' : '#3c4043',
                  color: '#e8eaed', width: 56, height: 56,
                  '&:hover': { backgroundColor: recorderState === 'recording' ? '#d93025' : '#5f6368' },
                }}
              >
                {recorderState === 'recording' ? <Stop /> : <RadioButtonChecked />}
              </IconButton>
            </Tooltip>
          </div>

          {/* ⋮ More */}
          <Tooltip title="Ещё">
            <IconButton
              onClick={(e) => setMenuAnchor(e.currentTarget)}
              sx={{
                backgroundColor: menuOpen ? '#8ab4f8' : '#3c4043',
                color: menuOpen ? '#202124' : '#e8eaed',
                width: 40, height: 56, borderRadius: '28px',
                '&:hover': { backgroundColor: menuOpen ? '#a8c7fa' : '#5f6368' },
              }}
            >
              <MoreVert />
            </IconButton>
          </Tooltip>

          <Menu
            anchorEl={menuAnchor} open={menuOpen} onClose={() => setMenuAnchor(null)}
            transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
            PaperProps={{ sx: { backgroundColor: '#28292c', border: '1px solid #3c4043', borderRadius: '12px', minWidth: 220, boxShadow: '0 8px 32px rgba(0,0,0,0.6)', transform: 'translateY(-12px) !important' } }}
          >
            {isMobile && [
              <MenuItem key="link" onClick={() => { copyMeetingLink(); setMenuAnchor(null); }} sx={{ color: '#ffffff', gap: 1.5, borderRadius: '8px', mx: 0.5, '&:hover': { backgroundColor: 'rgba(255,255,255,0.08)' } }}>
                <ListItemIcon sx={{ color: linkCopied ? '#8ab4f8' : '#9aa0a6', minWidth: 32 }}>
                  {linkCopied ? <Check fontSize="small" /> : <LinkIcon fontSize="small" />}
                </ListItemIcon>
                <ListItemText primary={linkCopied ? 'Скопировано' : 'Скопировать ссылку'} primaryTypographyProps={{ fontSize: '0.875rem' }} />
              </MenuItem>,
              <MenuItem key="share" onClick={() => { handleScreenShare(); setMenuAnchor(null); }} disabled={shareBlocked} sx={{ color: isScreenSharing ? '#8ab4f8' : '#ffffff', gap: 1.5, borderRadius: '8px', mx: 0.5, '&:hover': { backgroundColor: 'rgba(255,255,255,0.08)' }, '&.Mui-disabled': { color: '#5f6368', opacity: 0.6 } }}>
                <ListItemIcon sx={{ color: isScreenSharing ? '#8ab4f8' : '#9aa0a6', minWidth: 32 }}><PresentToAll fontSize="small" /></ListItemIcon>
                <ListItemText primary={isScreenSharing ? 'Остановить экран' : 'Показать экран'} primaryTypographyProps={{ fontSize: '0.875rem' }} />
              </MenuItem>,
              <MenuItem key="record" onClick={() => { handleRecord(); setMenuAnchor(null); }} sx={{ color: recorderState === 'recording' ? '#ea4335' : '#ffffff', gap: 1.5, borderRadius: '8px', mx: 0.5, '&:hover': { backgroundColor: 'rgba(255,255,255,0.08)' } }}>
                <ListItemIcon sx={{ color: recorderState === 'recording' ? '#ea4335' : '#9aa0a6', minWidth: 32 }}>
                  {recorderState === 'recording' ? <Stop fontSize="small" /> : <RadioButtonChecked fontSize="small" />}
                </ListItemIcon>
                <ListItemText primary={recorderState === 'recording' ? 'Остановить запись' : 'Начать запись'} primaryTypographyProps={{ fontSize: '0.875rem' }} />
              </MenuItem>,
              <Divider key="divider" sx={{ borderColor: '#3c4043', my: 0.5 }} />,
            ]}
            <MenuItem onClick={() => { setShowSettings(true); setMenuAnchor(null); }} sx={{ color: '#ffffff', gap: 1.5, borderRadius: '8px', mx: 0.5, '&:hover': { backgroundColor: 'rgba(255,255,255,0.08)' } }}>
              <ListItemIcon sx={{ color: '#9aa0a6', minWidth: 32 }}><SettingsIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="Настройки" primaryTypographyProps={{ fontSize: '0.875rem' }} />
            </MenuItem>
          </Menu>

          {/* Hang up */}
          <Tooltip title="Завершить звонок">
            <IconButton onClick={handleLeave} sx={{ backgroundColor: '#ea4335', color: '#fff', width: 80, height: 56, borderRadius: '28px', '&:hover': { backgroundColor: '#d93025' } }}>
              <CallEnd />
            </IconButton>
          </Tooltip>
        </div>

        {/* Right: participants */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>
          <Tooltip title="Участники">
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <IconButton
                onClick={() => setShowParticipants(!showParticipants)}
                sx={{
                  backgroundColor: showParticipants ? '#8ab4f8' : '#3c4043',
                  color: showParticipants ? '#202124' : '#e8eaed',
                  width: 56, height: 56,
                  '&:hover': { backgroundColor: showParticipants ? '#a8c7fa' : '#5f6368' },
                }}
              >
                <People />
              </IconButton>
              {!showParticipants && participants.length > 0 && (
                <span style={{
                  position: 'absolute', top: -4, right: -4,
                  minWidth: 18, height: 18, borderRadius: 9,
                  background: '#8ab4f8', color: '#202124',
                  fontSize: 11, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 4px', pointerEvents: 'none', lineHeight: 1,
                  border: '2px solid #202124',
                }}>
                  {participants.length}
                </span>
              )}
            </div>
          </Tooltip>
        </div>
      </div>

      {/* ── Snackbars ─────────────────────────────────────────────────────── */}
      <Snackbar open={snackOpen} autoHideDuration={3000} onClose={() => setSnackOpen(false)} message={activeSnack?.msg} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} ContentProps={{ sx: { backgroundColor: '#3c4043', color: '#e8eaed' } }} />
      <Snackbar open={linkCopied && !menuOpen} autoHideDuration={2000} onClose={() => setLinkCopied(false)} message="Ссылка скопирована" anchorOrigin={{ vertical: 'top', horizontal: 'right' }} ContentProps={{ sx: { backgroundColor: '#3c4043', color: '#e8eaed' } }} />
      <Snackbar open={!!recorderError} autoHideDuration={4000} onClose={dismiss} message={recorderError} anchorOrigin={{ vertical: 'top', horizontal: 'right' }} ContentProps={{ sx: { backgroundColor: '#ea4335', color: '#fff' } }} />

      <NameDialog open={showNameDialog} onSubmit={handleNameSubmit} />
      <Settings open={showSettings} onClose={() => setShowSettings(false)} onDeviceChange={handleDeviceChange} />
    </div>
  );
}