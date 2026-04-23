import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  Participant as LKParticipant,
  VideoPresets,
  VideoQuality,
} from 'livekit-client';
import { projectId, publicAnonKey } from '/utils/supabase/info';

// ─── Config ──────────────────────────────────────────────────────────────────
const TOKEN_URL   = 'https://meet.planaro.ru/livekit-token';
export const LIVEKIT_URL = 'wss://meet.planaro.ru';

// Timeout for room.connect() — без TURN на LTE зависает навсегда
const CONNECT_TIMEOUT_MS = 20_000;

// ─── Types ───────────────────────────────────────────────────────────────────
export type RtcConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

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

// ─── Network info helper ─────────────────────────────────────────────────────
function networkInfo(): string {
  const nav = navigator as any;
  const c = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (!c) return 'unknown';
  const parts: string[] = [];
  if (c.type)        parts.push(`type=${c.type}`);
  if (c.effectiveType) parts.push(`eff=${c.effectiveType}`);
  if (c.downlink)    parts.push(`dl=${c.downlink}Mbps`);
  if (c.rtt)         parts.push(`rtt=${c.rtt}ms`);
  return parts.length ? parts.join(' ') : 'unknown';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getSessionParticipantId(): string {
  let id = sessionStorage.getItem('participantId');
  if (!id) {
    id = Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('participantId', id);
  }
  return id;
}

function collectTracks(lkp: LKParticipant, isLocal: boolean): MediaStreamTrack[] {
  const tracks: MediaStreamTrack[] = [];
  const screenPub = lkp.getTrackPublication(Track.Source.ScreenShare);
  const cameraPub = lkp.getTrackPublication(Track.Source.Camera);
  const audioPub  = lkp.getTrackPublication(Track.Source.Microphone);
  const hasScreen = !!screenPub?.track?.mediaStreamTrack;
  const activePub = hasScreen ? screenPub : cameraPub;
  const videoMST  = activePub?.track?.mediaStreamTrack;
  if (videoMST && videoMST.readyState !== 'ended') tracks.push(videoMST);
  if (!isLocal) {
    const audioMST = audioPub?.track?.mediaStreamTrack;
    if (audioMST && audioMST.readyState !== 'ended') tracks.push(audioMST);
  }
  return tracks;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[timeout] ${label} took > ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useWebRTC(
  roomId: string,
  localParticipantName: string,
  initialStream?: MediaStream | null,
) {
  const [participants, setParticipants]         = useState<Participant[]>([]);
  const [localStream, setLocalStream]           = useState<MediaStream | null>(null);
  const [videoAvailable, setVideoAvailable]     = useState(true);
  const [audioAvailable, setAudioAvailable]     = useState(true);
  const [mediaReady, setMediaReady]             = useState(false);
  const [isScreenSharing, setIsScreenSharing]   = useState(false);
  const [connectionState, setConnectionState]   = useState<RtcConnectionState>('idle');
  const [connectionError, setConnectionError]   = useState<string | null>(null);

  const [localAudioEnabled] = useState<boolean>(() => {
    if (!initialStream) return true;
    const at = initialStream.getAudioTracks();
    return at.length > 0 ? at.some(t => t.enabled) : true;
  });
  const [localVideoEnabled] = useState<boolean>(() => {
    if (!initialStream) return true;
    const vt = initialStream.getVideoTracks();
    return vt.length > 0 ? vt.some(t => t.enabled) : true;
  });

  const roomRef            = useRef<Room | null>(null);
  const localParticipantId = useRef(getSessionParticipantId());
  const participantNameRef = useRef(localParticipantName);
  const hasJoined          = useRef(false);
  const streamsRef         = useRef<Map<string, MediaStream>>(new Map());
  const trackIdsRef        = useRef<Map<string, string>>(new Map());
  // Adaptive quality: per-participant fps history for debounced tier decisions
  const fpsHistRef         = useRef<Map<string, { quality: VideoQuality; lowCount: number; okCount: number }>>(new Map());
  const adaptTimerRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { participantNameRef.current = localParticipantName; }, [localParticipantName]);

  // ── Stable stream cache ──────────────────────────────────────────────────
  const resolveStream = useCallback((pid: string, tracks: MediaStreamTrack[]): MediaStream | undefined => {
    if (tracks.length === 0) {
      streamsRef.current.delete(pid); trackIdsRef.current.delete(pid); return undefined;
    }
    const newKey = tracks.map(t => t.id).sort().join(',');
    const prevKey = trackIdsRef.current.get(pid) ?? '';
    if (newKey === prevKey) return streamsRef.current.get(pid);
    const ms = new MediaStream(tracks);
    streamsRef.current.set(pid, ms); trackIdsRef.current.set(pid, newKey);
    return ms;
  }, []);

  // ── Refresh participants ─────────────────────────────────────────────────
  const refreshParticipants = useCallback(() => {
    const room = roomRef.current; if (!room) return;
    const list: Participant[] = [];
    const localId = room.localParticipant.identity;
    const localLKP   = room.localParticipant;
    const camPubL    = localLKP.getTrackPublication(Track.Source.Camera);
    const screenPubL = localLKP.getTrackPublication(Track.Source.ScreenShare);
    const audioPubL  = localLKP.getTrackPublication(Track.Source.Microphone);
    const localScreen = !!screenPubL?.track?.mediaStreamTrack;
    const localTracks = collectTracks(localLKP, true);
    const newLocalStream = resolveStream(localId, localTracks);
    setLocalStream(prev => (prev === newLocalStream ? prev : newLocalStream ?? null));
    setIsScreenSharing(localScreen);
    list.push({
      id: localId, name: localLKP.name || localParticipantName, isLocal: true,
      videoEnabled: !localScreen && !!camPubL?.track && !camPubL.isMuted,
      audioEnabled: !!audioPubL?.track && !audioPubL.isMuted,
      screensharing: localScreen, stream: undefined,
    });
    const liveIds = new Set<string>([localId]);
    room.remoteParticipants.forEach(rp => {
      const rpId = rp.identity; liveIds.add(rpId);
      const camPubR    = rp.getTrackPublication(Track.Source.Camera);
      const screenPubR = rp.getTrackPublication(Track.Source.ScreenShare);
      const audioPubR  = rp.getTrackPublication(Track.Source.Microphone);
      const rpScreen   = !!screenPubR?.track?.mediaStreamTrack;
      list.push({
        id: rpId, name: extractName(rp.identity, rp.name), isLocal: false,
        videoEnabled: !rpScreen && !!camPubR?.track && !camPubR.isMuted,
        audioEnabled: !!audioPubR?.track && !audioPubR.isMuted,
        screensharing: rpScreen, stream: resolveStream(rpId, collectTracks(rp, false)),
        reconnecting: (rp as any).__lkReconnecting ?? false,
      });
    });
    streamsRef.current.forEach((_, id) => {
      if (!liveIds.has(id)) { streamsRef.current.delete(id); trackIdsRef.current.delete(id); }
    });
    setParticipants(list);
  }, [localParticipantName, resolveStream]);

  const refreshRef = useRef(refreshParticipants);
  useEffect(() => { refreshRef.current = refreshParticipants; }, [refreshParticipants]);

  // ── Video bitrate + fps stats ────────────────────────────────────────────
  const prevStatsRef = useRef<Map<string, { bytes: number; frames: number; ts: number }>>(new Map());

  // Internal helper — resolves track + computes { kbps, fps } for any participant
  const getVideoStats = useCallback(async (participantId: string): Promise<{ kbps: number | null; fps: number | null }> => {
    const room = roomRef.current;
    if (!room) return { kbps: null, fps: null };

    let track: any = null;
    let isLocal = false;

    if (participantId === room.localParticipant.identity) {
      isLocal = true;
      const screenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const camPub    = room.localParticipant.getTrackPublication(Track.Source.Camera);
      track = (screenPub?.track?.mediaStreamTrack) ? screenPub.track : camPub?.track ?? null;
    } else {
      const rp = room.remoteParticipants.get(participantId);
      if (!rp) return { kbps: null, fps: null };
      const screenPub = rp.getTrackPublication(Track.Source.ScreenShare);
      const camPub    = rp.getTrackPublication(Track.Source.Camera);
      track = (screenPub?.track?.mediaStreamTrack) ? screenPub.track : camPub?.track ?? null;
    }

    if (!track?.getRTCStatsReport) return { kbps: null, fps: null };
    const report: RTCStatsReport | undefined = await track.getRTCStatsReport();
    if (!report) return { kbps: null, fps: null };

    let bytes = 0;
    let frames = 0;
    report.forEach((stat: any) => {
      if (isLocal && stat.type === 'outbound-rtp' && stat.kind === 'video') {
        bytes  += stat.bytesSent     ?? 0;
        frames  = Math.max(frames, stat.framesEncoded ?? 0); // max across simulcast layers (same content)
      }
      if (!isLocal && stat.type === 'inbound-rtp' && stat.kind === 'video') {
        bytes  += stat.bytesReceived ?? 0;
        frames += stat.framesDecoded ?? 0;
      }
    });

    const now  = Date.now();
    const prev = prevStatsRef.current.get(participantId);
    prevStatsRef.current.set(participantId, { bytes, frames, ts: now });

    if (!prev || prev.bytes === 0) return { kbps: null, fps: null };
    const dt = (now - prev.ts) / 1000;
    if (dt <= 0) return { kbps: null, fps: null };

    const kbps = Math.round((bytes  - prev.bytes)  * 8 / dt / 1000);
    const fps  = Math.round((frames - prev.frames) / dt);

    return {
      kbps: kbps > 0 ? kbps  : null,
      fps:  fps  > 0 ? fps   : null,
    };
  }, []);

  // ── Join room ─────────────────────────────────────────────────────────────
  const joinRoom = useCallback(async () => {
    if (hasJoined.current) return;
    hasJoined.current = true;

    const participantId = localParticipantId.current;
    const name          = participantNameRef.current;

    if (initialStream) initialStream.getTracks().forEach(t => t.stop());

    const initVideoOn = !initialStream ? true : initialStream.getVideoTracks().some(t => t.enabled);
    const initAudioOn = !initialStream ? true : initialStream.getAudioTracks().some(t => t.enabled);
    const hadVideo    = !initialStream || initialStream.getVideoTracks().length > 0;
    const hadAudio    = !initialStream || initialStream.getAudioTracks().length > 0;

    setConnectionState('connecting');
    setConnectionError(null);

    // ── STEP 1: Environment info ────────────────────────────────────────────
    console.info(`[LK 1/6] joinRoom start | room=${roomId} | name=${name} | network=${networkInfo()} | ua=${navigator.userAgent.slice(0, 80)}`);

    try {
      // ── STEP 2: Token fetch ──────────────────────────────────────────────
      console.info(`[LK 2/6] Fetching token → ${TOKEN_URL}`);
      const t0 = Date.now();
      // Encode display name inside identity so remote peers can always read it
      // Format: "DisplayName|||randomId"  — works even if server ignores the name param
      const identityWithName = `${name}|||${participantId}`;
      const tokenUrl = `${TOKEN_URL}?room=${encodeURIComponent(roomId)}&identity=${encodeURIComponent(identityWithName)}&name=${encodeURIComponent(name)}`;
      const tokenRes = await fetch(tokenUrl, { method: 'GET' });
      console.info(`[LK 2/6] Token response: status=${tokenRes.status} in ${Date.now() - t0}ms`);
      if (!tokenRes.ok) throw new Error(`Token fetch failed: ${tokenRes.status}`);
      const { token, url } = await tokenRes.json();
      const livekitUrl = url ?? LIVEKIT_URL;
      console.info(`[LK 2/6] Token OK | url=${livekitUrl} | tokenLen=${token?.length ?? 0}`);

      // ── STEP 3: Create Room ──────────────────────────────────────────────
      console.info(`[LK 3/6] Creating Room (adaptiveStream, dynacast, simulcast 180/360/720)`);
      const room = new Room({
        adaptiveStream: false,  // ← НЕ ограничиваем качество размером DOM-элемента;
                                //   реальный bitrate регулирует WebRTC GCC/TWCC (congestion control)
        dynacast: true,         // не тратим аплоад на слои, которые никто не смотрит
        stopLocalTrackOnUnpublish: false,

        videoCaptureDefaults: {
          resolution: VideoPresets.h2160.resolution, // захват 4K (2160p) если камера поддерживает
          facingMode: 'user',
        },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },

        publishDefaults: {
          simulcast: true,
          videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h720, VideoPresets.h1080],
          videoEncoding: {
            maxBitrate: 8_000_000, // 8 Mbps — верхний слой 4K
            maxFramerate: 30,
          },
          audioPreset: {
            maxBitrate: 128_000,   // Opus 128 kbps
          },
          dtx: true,  // экономия аудио-бирейта в тишине
          red: true,  // восстановление аудио-пакетов при потерях
        },
      });
      roomRef.current = room;
      console.info(`[LK 3/6] Room created`);

      const refresh = () => refreshRef.current();

      // ── Connection state events ──────────────────────────────────────────
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        console.info(`[LK] ConnectionStateChanged → ${state}`);
        switch (state) {
          case ConnectionState.Connecting:   setConnectionState('connecting');   break;
          case ConnectionState.Connected:    setConnectionState('connected');    break;
          case ConnectionState.Reconnecting: setConnectionState('reconnecting'); break;
          case ConnectionState.Disconnected:
            setConnectionState('idle');
            setParticipants([]); setLocalStream(null);
            hasJoined.current = false;
            break;
        }
      });

      room
        .on(RoomEvent.ParticipantConnected,    (p) => { console.info(`[LK] ParticipantConnected: ${p.identity}`); refresh(); })
        .on(RoomEvent.ParticipantDisconnected, (p) => { console.info(`[LK] ParticipantDisconnected: ${p.identity}`); (p as any).__lkReconnecting = false; refresh(); })
        .on(RoomEvent.TrackSubscribed,         (track, pub, p) => {
          console.info(`[LK] TrackSubscribed: ${p.identity} kind=${pub.kind} src=${pub.source}`);
          if (track.kind === Track.Kind.Video) {
            // Говрим серверу «нам нужно HIGH» → dynacast включит верхний слой у отправителя
            // Реальный bitrate всё равно ограничит GCC по факту канала, а не по размеру экрана
            (pub as any).setVideoQuality?.(VideoQuality.HIGH);
          }
          refresh();
        })
        .on(RoomEvent.TrackUnsubscribed,       (_, pub, p) => { console.info(`[LK] TrackUnsubscribed: ${p.identity} kind=${pub.kind}`); refresh(); })
        .on(RoomEvent.TrackMuted,              refresh)
        .on(RoomEvent.TrackUnmuted,            refresh)
        .on(RoomEvent.LocalTrackPublished,     (pub) => { console.info(`[LK] LocalTrackPublished: kind=${pub.kind} src=${pub.source}`); refresh(); })
        .on(RoomEvent.LocalTrackUnpublished,   (pub) => { console.info(`[LK] LocalTrackUnpublished: kind=${pub.kind}`); refresh(); })
        .on(RoomEvent.Reconnecting, () => {
          console.warn('[LK] Reconnecting...');
          setConnectionState('reconnecting');
          room.remoteParticipants.forEach(rp => { (rp as any).__lkReconnecting = true; });
          refresh();
        })
        .on(RoomEvent.Reconnected, () => {
          console.info('[LK] Reconnected ✓');
          setConnectionState('connected');
          room.remoteParticipants.forEach(rp => { (rp as any).__lkReconnecting = false; });
          refresh();
        });

      // ── STEP 4: Connect ──────────────────────────────────────────────────
      // НЕ используем forceRelay — пусть WebRTC сам выберет путь:
      //   1. Прямой P2P (host/srflx кандидаты) — минимальная задержка, нет джиттера TURN
      //   2. TURN relay — автоматический fallback если P2P не сработал (CGNAT, корпоративный файрвол)
      // TURN всё равно настроен на сервере и будет предложен ICE агентом как кандидат.
      console.info(`[LK 4/6] room.connect() → ${livekitUrl} (icePolicy=all, timeout=${CONNECT_TIMEOUT_MS}ms)`);
      const t1 = Date.now();
      await withTimeout(
        room.connect(livekitUrl, token),
        CONNECT_TIMEOUT_MS,
        'room.connect',
      );
      console.info(`[LK 4/6] room.connect() ✓ in ${Date.now() - t1}ms | state=${room.state} | sid=${room.sid ?? 'n/a'}`);

      // ── STEP 5: Camera ───────────────────────────────────────────────────
      console.info(`[LK 5/6] Camera: hadVideo=${hadVideo} initVideoOn=${initVideoOn}`);
      if (hadVideo) {
        try {
          await room.localParticipant.setCameraEnabled(initVideoOn);
          console.info(`[LK 5/6] Camera ✓`);
          setVideoAvailable(true);
        } catch (e) {
          console.info(`[LK 5/6] Camera unavailable: ${(e as any)?.name ?? e}`);
          setVideoAvailable(false);
        }
      } else { setVideoAvailable(false); }

      // ── STEP 6: Microphone ───────────────────────────────────────────────
      console.info(`[LK 6/6] Mic: hadAudio=${hadAudio} initAudioOn=${initAudioOn}`);
      if (hadAudio) {
        try {
          await room.localParticipant.setMicrophoneEnabled(initAudioOn);
          console.info(`[LK 6/6] Mic ✓`);
          setAudioAvailable(true);
        } catch (e) {
          console.info(`[LK 6/6] Mic unavailable: ${(e as any)?.name ?? e}`);
          setAudioAvailable(false);
        }
      } else { setAudioAvailable(false); }

      console.info(`[LK ✓] All ready | participants=${room.remoteParticipants.size + 1} | network=${networkInfo()}`);
      setMediaReady(true);
      setConnectionState('connected');
      setConnectionError(null);
      refreshRef.current();

      // ── Adaptive quality loop ────────────────────────────────────────────
      // Runs every 3s. Monitors FPS for each remote participant and adjusts
      // the requested simulcast tier so GCC has room to breathe:
      //   fps < 15 for 2 polls  → downgrade to LOW  (360p)
      //   fps 15-23 for 2 polls → downgrade to MEDIUM (720p) if currently HIGH
      //   fps ≥ 24 for 4 polls  → restore previous tier upward (up to HIGH)
      // This prevents unnecessary keyframe storms and encoder overload.
      if (adaptTimerRef.current) clearInterval(adaptTimerRef.current);
      adaptTimerRef.current = setInterval(async () => {
        const r = roomRef.current;
        if (!r) return;
        for (const [pid, rp] of r.remoteParticipants) {
          const stats = await getVideoStats(pid).catch(() => ({ kbps: null, fps: null }));
          const { fps } = stats;
          if (fps === null) continue;

          const h = fpsHistRef.current.get(pid) ?? { quality: VideoQuality.HIGH, lowCount: 0, okCount: 0 };

          // Helper: apply quality to both camera and screen publications
          const setQ = (q: VideoQuality) => {
            const cam    = rp.getTrackPublication(Track.Source.Camera);
            const screen = rp.getTrackPublication(Track.Source.ScreenShare);
            if (cam)    (cam    as any).setVideoQuality?.(q);
            if (screen) (screen as any).setVideoQuality?.(q);
            console.info(`[AQ] ${pid.slice(0, 12)} fps=${fps} → quality=${q === VideoQuality.HIGH ? 'HIGH' : q === VideoQuality.MEDIUM ? 'MED' : 'LOW'}`);
          };

          if (fps < 15) {
            h.lowCount++; h.okCount = 0;
            if (h.lowCount >= 2 && h.quality !== VideoQuality.LOW) {
              h.quality = VideoQuality.LOW;  setQ(VideoQuality.LOW);
            }
          } else if (fps < 24) {
            h.lowCount++; h.okCount = 0;
            if (h.lowCount >= 2 && h.quality === VideoQuality.HIGH) {
              h.quality = VideoQuality.MEDIUM; setQ(VideoQuality.MEDIUM);
            }
          } else {
            // fps ≥ 24 — connection is healthy, try to step quality back up
            h.okCount++; h.lowCount = 0;
            if (h.okCount >= 4) {
              h.okCount = 0;
              if (h.quality === VideoQuality.LOW)    { h.quality = VideoQuality.MEDIUM; setQ(VideoQuality.MEDIUM); }
              else if (h.quality === VideoQuality.MEDIUM) { h.quality = VideoQuality.HIGH;   setQ(VideoQuality.HIGH);   }
            }
          }

          fpsHistRef.current.set(pid, h);
        }
      }, 3_000);

    } catch (e: any) {
      console.error(`[LK ✗] joinRoom FAILED:`, e?.message ?? e);
      hasJoined.current = false;
      const isTimeout = e?.message?.includes('timeout');
      setConnectionState('failed');
      setConnectionError(
        isTimeout
          ? 'Timeout: сеть заблокировала медиа-порты (CGNAT/LTE). Попробуйте снова или смените сеть.'
          : `Ошибка: ${e?.message ?? 'неизвестная ошибка'}`,
      );
    }
  }, [roomId, initialStream]);

  // ── Retry ─────────────────────────────────────────────────────────────────
  const retryJoin = useCallback(() => {
    console.info('[LK] retryJoin — resetting and reconnecting...');
    const room = roomRef.current;
    if (room) { room.disconnect(); roomRef.current = null; }
    streamsRef.current.clear(); trackIdsRef.current.clear();
    hasJoined.current = false;
    setConnectionError(null); setConnectionState('idle');
    setParticipants([]); setLocalStream(null); setMediaReady(false);
    if (participantNameRef.current) joinRoom();
  }, [joinRoom]);

  // ── Leave ─────────────────────────────────────────────────────────────────
  const leaveRoom = useCallback(() => {
    if (adaptTimerRef.current) { clearInterval(adaptTimerRef.current); adaptTimerRef.current = null; }
    fpsHistRef.current.clear();
    const room = roomRef.current;
    if (room) { room.disconnect(); roomRef.current = null; }
    streamsRef.current.clear(); trackIdsRef.current.clear();
    hasJoined.current = false;
    setParticipants([]); setLocalStream(null); setMediaReady(false);
    setIsScreenSharing(false); setConnectionState('idle'); setConnectionError(null);
  }, []);

  // ── Controls ──────────────────────────────────────────────────────────────
  const toggleAudio = useCallback(async (enabled: boolean) => {
    const room = roomRef.current; if (!room) return;
    try { await room.localParticipant.setMicrophoneEnabled(enabled); refreshRef.current(); }
    catch (e) { console.warn('[LK] toggleAudio:', e); }
  }, []);

  const toggleVideo = useCallback(async (enabled: boolean) => {
    const room = roomRef.current; if (!room) return;
    try { await room.localParticipant.setCameraEnabled(enabled); refreshRef.current(); }
    catch (e) { console.warn('[LK] toggleVideo:', e); }
  }, []);

  const startScreenShare = useCallback(async () => {
    const room = roomRef.current; if (!room) return;
    try { await room.localParticipant.setScreenShareEnabled(true); setIsScreenSharing(true); refreshRef.current(); }
    catch (e) { console.warn('[LK] startScreenShare:', e); }
  }, []);

  const stopScreenShare = useCallback(async () => {
    const room = roomRef.current; if (!room) return;
    try { await room.localParticipant.setScreenShareEnabled(false); setIsScreenSharing(false); refreshRef.current(); }
    catch (e) { console.warn('[LK] stopScreenShare:', e); }
  }, []);

  const changeDevices = useCallback(async (d: { videoId?: string; audioId?: string; outputId?: string }) => {
    const room = roomRef.current; if (!room) return;
    try {
      if (d.videoId)  await room.switchActiveDevice('videoinput',  d.videoId);
      if (d.audioId)  await room.switchActiveDevice('audioinput',  d.audioId);
      if (d.outputId) await room.switchActiveDevice('audiooutput', d.outputId);
      refreshRef.current();
    } catch (e) { console.warn('[LK] changeDevices:', e); }
  }, []);

  const forceControlParticipant = useCallback(
    (_pid: string, _audio: boolean, _video: boolean) => {
      console.info('[LK] forceControl: requires LiveKit Admin API');
    }, [],
  );

  // ── Auto-join ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (localParticipantName && !hasJoined.current) joinRoom();
  }, [localParticipantName, joinRoom]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (adaptTimerRef.current) { clearInterval(adaptTimerRef.current); adaptTimerRef.current = null; }
      const room = roomRef.current;
      if (room) { room.disconnect(); roomRef.current = null; }
      streamsRef.current.clear(); trackIdsRef.current.clear();
    };
  }, []);

  return {
    participants, localStream, videoAvailable, audioAvailable, mediaReady, isScreenSharing,
    localAudioEnabled, localVideoEnabled, connectionState, connectionError,
    toggleAudio, toggleVideo, joinRoom, retryJoin, leaveRoom,
    changeDevices, forceControlParticipant, startScreenShare, stopScreenShare,
    getVideoStats,
  };
}

// Extract display name from identity (format: "Name|||randomId") or fall back to identity itself
function extractName(identity: string, lkName?: string): string {
  if (lkName && lkName.trim()) return lkName.trim();
  const sep = identity.indexOf('|||');
  if (sep > 0) return identity.slice(0, sep);
  return identity;
}