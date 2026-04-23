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

// ─── Config ──────────────────────────────────────────────────────────────────
const TOKEN_URL          = 'https://meet.planaro.ru/livekit-token';
export const LIVEKIT_URL = 'wss://meet.planaro.ru';
const CONNECT_TIMEOUT_MS = 20_000;

// Single shared interval: stats collection + adaptive quality.
// 2.5s is fast enough to react to congestion while not spamming RTCStats.
const STATS_INTERVAL_MS  = 2_500;

// ─── Types ───────────────────────────────────────────────────────────────────
export type RtcConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface VideoStats {
  /** Send/receive bitrate in kbps — from RTCStats, updated every ~2.5s */
  kbps: number | null;
  /**
   * FPS decoded by the codec — from RTCStats. Used by adaptive quality.
   * VideoTile additionally measures display FPS via requestVideoFrameCallback
   * which is shown in the badge (more accurate for what the user actually sees).
   */
  rtcFps: number | null;
}

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
  if (c.type)          parts.push(`type=${c.type}`);
  if (c.effectiveType) parts.push(`eff=${c.effectiveType}`);
  if (c.downlink)      parts.push(`dl=${c.downlink}Mbps`);
  if (c.rtt)           parts.push(`rtt=${c.rtt}ms`);
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

// ─── ICE Pre-warm ─────────────────────────────────────────────────────────────
/**
 * Creates a throwaway RTCPeerConnection to probe STUN servers *before* the real
 * LiveKit connection starts. The OS and Chrome cache the STUN reflexive mapping
 * for ~30 seconds, so when LiveKit does its own ICE gathering the srflx candidate
 * is ready in <10ms instead of the usual 50–200ms round-trip.
 *
 * Run this in parallel with the token fetch — total cost ≈ 0ms on the critical path.
 *
 * Also gathers mDNS / host candidates first so the ICE agent has a full picture
 * before LiveKit's offer/answer exchange even begins.
 */
async function preWarmICE(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let pc: RTCPeerConnection | null = null;

    const settle = (reason: string) => {
      if (settled) return;
      settled = true;
      console.info(`[ICE warm] done (${reason})`);
      try { pc?.close(); } catch {}
      resolve();
    };

    try {
      const lkHost = new URL(LIVEKIT_URL.replace(/^wss?/, 'https')).hostname;

      pc = new RTCPeerConnection({
        iceServers: [
          // Primary: Google public STUN — same as what LiveKit typically adds
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          // Secondary: the LiveKit server's own STUN port (3478 UDP)
          { urls: `stun:${lkHost}:3478` },
        ],
        // Pre-pool 4 candidates immediately — browser starts gathering before
        // createOffer() completes, shaving another ~50ms off first-candidate latency.
        iceCandidatePoolSize: 4,
      });

      // DataChannel triggers ICE gathering on Chromium (otherwise no media → no gathering)
      pc.createDataChannel('lk-warmup');

      pc.createOffer()
        .then(offer => pc!.setLocalDescription(offer))
        .catch(() => settle('offer-failed'));

      let srflxSeen = 0;
      pc.onicecandidate = (evt) => {
        if (!evt.candidate) { settle('gathering-complete'); return; }

        const { type, address, protocol } = evt.candidate;
        console.info(`[ICE warm] candidate type=${type} proto=${protocol} addr=${address ?? '(mdns)'}`);

        if (type === 'srflx') {
          srflxSeen++;
          // Two srflx candidates (UDP + TCP or two STUN servers) → we have enough
          if (srflxSeen >= 2) settle('srflx×2');
          // One srflx + wait 100ms for more (host/relay on same RTT budget)
          else setTimeout(() => settle('srflx+100ms'), 100);
        }
      };

      // Hard cap: never block room.connect() for more than 900ms
      setTimeout(() => settle('timeout-900ms'), 900);

    } catch (err) {
      console.warn('[ICE warm] setup failed:', err);
      resolve();
    }
  });
}

// ─── Jitter Buffer Hints ──────────────────────────────────────────────────────
/**
 * Reduces playout latency by hinting a lower target jitter buffer to the browser.
 *
 * WebRTC's default jitter buffer targets 150–500ms to absorb network jitter.
 * In a conference on a modern network (LTE / broadband / office wifi) the actual
 * jitter is typically <20ms — the extra buffer is pure unnecessary latency.
 *
 * Two APIs, applied in tandem:
 *   • playoutDelayHint  (Chrome 87+, seconds) — adaptive: browser targets this
 *     value but increases it automatically when real jitter exceeds the hint.
 *   • jitterBufferTarget (Chrome 113+, ms as DOMHighResTimeStamp) — more
 *     authoritative; overrides the browser's own adaptive algorithm.
 *
 * Values chosen:
 *   Video 20ms / Audio 40ms.
 *   Audio needs more headroom: a single late audio packet causes a perceptible
 *   click/dropout, while a late video frame just shows the previous frame briefly.
 *
 * Wrapped in try/catch — the properties are non-standard; missing them is fine.
 */
function applyJitterBufferHints(track: { kind: string; [k: string]: any }): void {
  const receiver = track.receiver as RTCRtpReceiver | undefined;
  if (!receiver) return;

  const isVideo  = track.kind === 'video';
  const hintSecs = isVideo ? 0.02 : 0.04;    // seconds  (playoutDelayHint)
  const hintMs   = isVideo ? 20   : 40;      // ms       (jitterBufferTarget)

  try {
    if ('playoutDelayHint' in receiver) {
      (receiver as any).playoutDelayHint = hintSecs;
    }
    // Chrome 113+ — DOMHighResTimeStamp in ms (confusingly named "Target", not "Hint")
    if ('jitterBufferTarget' in receiver) {
      (receiver as any).jitterBufferTarget = hintMs;
    }
    console.info(
      `[JB] set playoutDelayHint=${hintSecs * 1000}ms jitterBufferTarget=${hintMs}ms` +
      ` kind=${track.kind}` +
      ` supported=[${['playoutDelayHint', 'jitterBufferTarget'].filter(k => k in receiver).join(',')}]`,
    );
  } catch (e) {
    console.warn('[JB] could not set jitter buffer hints:', e);
  }
}

// ─── ICE Path Logger ─────────────────────────────────────────────────────────
/**
 * Reads RTCStats ~2s after connect to log the selected ICE candidate pair.
 * Purely observational — helps diagnose "am I going through TURN or direct?"
 * Output: [ICE path] host|srflx|relay RTT=Xms local=… remote=…
 */
async function logIcePath(room: Room): Promise<void> {
  await new Promise(r => setTimeout(r, 2000)); // wait for ICE to settle
  try {
    // Access the underlying subscriber PeerConnection via LiveKit internals
    const pcManager = (room as any)._pcManager ?? (room as any).engine?.pcManager;
    const subPc: RTCPeerConnection | undefined =
      pcManager?.subscriber?.pc ?? pcManager?.subscriber?.peerConnection;
    if (!subPc) return;

    const stats = await subPc.getStats();
    let selectedPair: any = null;

    stats.forEach((s: any) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        selectedPair = s;
      }
    });

    if (!selectedPair) return;

    // Resolve local + remote candidate details
    let localType = '?', remoteType = '?', localAddr = '?', remoteAddr = '?';
    stats.forEach((s: any) => {
      if (s.id === selectedPair.localCandidateId) {
        localType = s.candidateType ?? '?';
        localAddr = s.address ? `${s.address}:${s.port}` : '(mdns)';
      }
      if (s.id === selectedPair.remoteCandidateId) {
        remoteType = s.candidateType ?? '?';
        remoteAddr = s.address ? `${s.address}:${s.port}` : '?';
      }
    });

    const rtt = selectedPair.currentRoundTripTime != null
      ? `${Math.round(selectedPair.currentRoundTripTime * 1000)}ms`
      : 'n/a';

    const pathLabel =
      localType === 'relay' || remoteType === 'relay' ? '🔄 TURN relay' :
      localType === 'srflx' || remoteType === 'srflx' ? '📡 STUN/srflx' :
      '🟢 host (direct)';

    console.info(
      `[ICE path] ${pathLabel} | RTT=${rtt}` +
      ` | local=${localType}(${localAddr}) → remote=${remoteType}(${remoteAddr})`,
    );
  } catch (e) {
    console.warn('[ICE path] stats read failed:', e);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useWebRTC(
  roomId: string,
  localParticipantName: string,
  initialStream?: MediaStream | null,
) {
  const [participants, setParticipants]       = useState<Participant[]>([]);
  const [localStream, setLocalStream]         = useState<MediaStream | null>(null);
  const [videoAvailable, setVideoAvailable]   = useState(true);
  const [audioAvailable, setAudioAvailable]   = useState(true);
  const [mediaReady, setMediaReady]           = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [connectionState, setConnectionState] = useState<RtcConnectionState>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);

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

  // ── Stats infrastructure ─────────────────────────────────────────────────
  // Snapshot per participant for delta-bitrate/fps computation
  const prevStatsRef = useRef<Map<string, { bytes: number; frames: number; ts: number }>>(new Map());
  // Adaptive quality: FPS history per remote participant for debounced tier decisions
  const fpsHistRef   = useRef<Map<string, { quality: VideoQuality; lowCount: number; okCount: number }>>(new Map());
  // Push-based: VideoTile calls subscribeToVideoStats() once → gets notified every STATS_INTERVAL_MS.
  // Zero polling in VideoTile, zero per-tile timers, one central loop for all participants.
  const statsListenersRef = useRef<Map<string, (stats: VideoStats) => void>>(new Map());
  // Single combined timer: stats collection + adaptive quality
  const statsTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { participantNameRef.current = localParticipantName; }, [localParticipantName]);

  // ── Stable stream cache ──────────────────────────────────────────────────
  // Returns same MediaStream reference when tracks haven't changed.
  // This ensures video <srcObject> is only reassigned when tracks actually change,
  // preventing unnecessary decoder restarts / black flash on unrelated re-renders.
  const resolveStream = useCallback((pid: string, tracks: MediaStreamTrack[]): MediaStream | undefined => {
    if (tracks.length === 0) {
      streamsRef.current.delete(pid); trackIdsRef.current.delete(pid); return undefined;
    }
    const newKey  = tracks.map(t => t.id).sort().join(',');
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
    const localId    = room.localParticipant.identity;
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
    // Purge stale entries (participant left) from all caches
    streamsRef.current.forEach((_, id) => {
      if (!liveIds.has(id)) {
        streamsRef.current.delete(id);
        trackIdsRef.current.delete(id);
        prevStatsRef.current.delete(id);
        fpsHistRef.current.delete(id);
        statsListenersRef.current.delete(id);
      }
    });
    setParticipants(list);
  }, [localParticipantName, resolveStream]);

  const refreshRef = useRef(refreshParticipants);
  useEffect(() => { refreshRef.current = refreshParticipants; }, [refreshParticipants]);

  // ── Stable subscription callback ─────────────────────────────────────────
  /**
   * VideoTile calls this once in a useEffect to receive push-based stats updates.
   * Returns an unsubscribe function. The listener is called every STATS_INTERVAL_MS
   * from the central loop — no per-tile timers, no parallel RTCStats calls.
   */
  const subscribeToVideoStats = useCallback((
    id: string,
    listener: (stats: VideoStats) => void,
  ): (() => void) => {
    statsListenersRef.current.set(id, listener);
    return () => { statsListenersRef.current.delete(id); };
  }, []);

  // ── Internal: collect RTCStats for one participant ───────────────────────
  const collectStats = useCallback(async (participantId: string): Promise<VideoStats> => {
    const room = roomRef.current;
    if (!room) return { kbps: null, rtcFps: null };

    let track: any = null;
    let isLocal = false;

    if (participantId === room.localParticipant.identity) {
      isLocal = true;
      const screenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const camPub    = room.localParticipant.getTrackPublication(Track.Source.Camera);
      track = (screenPub?.track?.mediaStreamTrack) ? screenPub.track : camPub?.track ?? null;
    } else {
      const rp = room.remoteParticipants.get(participantId);
      if (!rp) return { kbps: null, rtcFps: null };
      const screenPub = rp.getTrackPublication(Track.Source.ScreenShare);
      const camPub    = rp.getTrackPublication(Track.Source.Camera);
      track = (screenPub?.track?.mediaStreamTrack) ? screenPub.track : camPub?.track ?? null;
    }

    if (!track?.getRTCStatsReport) return { kbps: null, rtcFps: null };

    let report: RTCStatsReport;
    try { report = await track.getRTCStatsReport(); }
    catch { return { kbps: null, rtcFps: null }; }
    if (!report) return { kbps: null, rtcFps: null };

    let bytes = 0, frames = 0;
    report.forEach((stat: any) => {
      if (isLocal && stat.type === 'outbound-rtp' && stat.kind === 'video') {
        bytes  += stat.bytesSent  ?? 0;
        frames  = Math.max(frames, stat.framesEncoded ?? 0); // max across simulcast layers
      }
      if (!isLocal && stat.type === 'inbound-rtp' && stat.kind === 'video') {
        bytes  += stat.bytesReceived ?? 0;
        frames += stat.framesDecoded  ?? 0;
      }
    });

    const now  = Date.now();
    const prev = prevStatsRef.current.get(participantId);
    prevStatsRef.current.set(participantId, { bytes, frames, ts: now });

    if (!prev) return { kbps: null, rtcFps: null };
    const dt = (now - prev.ts) / 1000;
    if (dt < 0.1) return { kbps: null, rtcFps: null }; // avoid division by ~0

    const kbps   = Math.round((bytes  - prev.bytes)  * 8 / dt / 1000);
    const rtcFps = Math.round((frames - prev.frames) / dt);

    return {
      kbps:   kbps   > 0 ? kbps   : null,
      rtcFps: rtcFps > 0 ? rtcFps : null,
    };
  }, []);

  // ── Central stats + adaptive quality loop ────────────────────────────────
  /**
   * ONE interval does the work of N per-tile polling loops:
   *   1. Iterates all participants sequentially (no parallel RTCStats storms)
   *   2. Pushes { kbps, rtcFps } to each VideoTile subscriber
   *   3. Runs adaptive quality decisions on remote FPS:
   *        fps < 15 × 2 polls → request LOW  (360p/180p)
   *        fps < 24 × 2 polls → request MEDIUM (720p) if currently HIGH
   *        fps ≥ 24 × 4 polls → restore one tier upward toward HIGH
   */
  const startStatsLoop = useCallback(() => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    statsTimerRef.current = setInterval(async () => {
      const r = roomRef.current;
      if (!r) return;

      const localId = r.localParticipant.identity;
      const pids    = [localId, ...Array.from(r.remoteParticipants.keys())];

      for (const pid of pids) {
        const stats = await collectStats(pid);

        // Push stats to VideoTile subscriber (if any)
        statsListenersRef.current.get(pid)?.(stats);

        // Adaptive quality: remote participants only
        if (pid === localId || stats.rtcFps === null) continue;
        const rp = r.remoteParticipants.get(pid);
        if (!rp) continue;

        const fps = stats.rtcFps;
        const h   = fpsHistRef.current.get(pid) ?? { quality: VideoQuality.HIGH, lowCount: 0, okCount: 0 };

        const applyQuality = (q: VideoQuality) => {
          const cam    = rp.getTrackPublication(Track.Source.Camera);
          const screen = rp.getTrackPublication(Track.Source.ScreenShare);
          if (cam)    (cam    as any).setVideoQuality?.(q);
          if (screen) (screen as any).setVideoQuality?.(q);
          const label = q === VideoQuality.HIGH ? 'HIGH' : q === VideoQuality.MEDIUM ? 'MED' : 'LOW';
          console.info(`[AQ] ${pid.slice(0, 12)} fps=${fps} → ${label}`);
        };

        if (fps < 15) {
          h.lowCount++; h.okCount = 0;
          if (h.lowCount >= 2 && h.quality !== VideoQuality.LOW) {
            h.quality = VideoQuality.LOW; applyQuality(VideoQuality.LOW);
          }
        } else if (fps < 24) {
          h.lowCount++; h.okCount = 0;
          if (h.lowCount >= 2 && h.quality === VideoQuality.HIGH) {
            h.quality = VideoQuality.MEDIUM; applyQuality(VideoQuality.MEDIUM);
          }
        } else {
          h.okCount++; h.lowCount = 0;
          if (h.okCount >= 4) {
            h.okCount = 0;
            if      (h.quality === VideoQuality.LOW)    { h.quality = VideoQuality.MEDIUM; applyQuality(VideoQuality.MEDIUM); }
            else if (h.quality === VideoQuality.MEDIUM) { h.quality = VideoQuality.HIGH;   applyQuality(VideoQuality.HIGH);   }
          }
        }
        fpsHistRef.current.set(pid, h);
      }
    }, STATS_INTERVAL_MS);
  }, [collectStats]);

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

    console.info(`[LK 1/6] joinRoom | room=${roomId} | name=${name} | network=${networkInfo()} | ua=${navigator.userAgent.slice(0, 80)}`);

    try {
      // ── STEP 2: Token + ICE pre-warm (parallel) ──────────────────────────
      // preWarmICE() runs a throwaway RTCPeerConnection to prime the STUN cache.
      // It runs CONCURRENTLY with the token fetch — zero extra latency on the
      // critical path. By the time room.connect() starts ICE gathering, the OS
      // has already cached the reflexive address → srflx candidate ready in <10ms.
      console.info(`[LK 2/6] Token fetch + ICE pre-warm (parallel) → ${TOKEN_URL}`);
      const t0 = Date.now();
      const identityWithName = `${name}|||${participantId}`;
      const tokenUrl = `${TOKEN_URL}?room=${encodeURIComponent(roomId)}&identity=${encodeURIComponent(identityWithName)}&name=${encodeURIComponent(name)}`;

      const [tokenRes] = await Promise.all([
        fetch(tokenUrl, { method: 'GET' }),
        preWarmICE(),   // ← concurrent; result is the warm STUN cache, not a return value
      ]);

      console.info(`[LK 2/6] Token: status=${tokenRes.status} in ${Date.now() - t0}ms`);
      if (!tokenRes.ok) throw new Error(`Token fetch failed: ${tokenRes.status}`);
      const { token, url } = await tokenRes.json();
      const livekitUrl = url ?? LIVEKIT_URL;

      // ── STEP 3: Create Room ──────────────────────────────────────────────
      console.info(`[LK 3/6] Creating Room`);
      const room = new Room({
        adaptiveStream: false,      // Quality controlled by GCC/TWCC, not DOM element size
        dynacast: true,             // Disable unused simulcast layers server-side (saves uplink)
        stopLocalTrackOnUnpublish: false,

        videoCaptureDefaults: {
          // 1080p capture: enough for the top 720p simulcast layer + headroom.
          // 4K capture was wasting encoder CPU scaling down 4K→720p for every frame.
          resolution: VideoPresets.h1080.resolution,
          facingMode: 'user',
        },
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },

        publishDefaults: {
          simulcast: true,
          // 3-tier simulcast: h180 (bad connection) → h360 (medium) → h720 (good).
          // Previously: h360/h720/h1080 with 8 Mbps cap.
          //   - h1080 simulcast layer burned ~30% extra CPU/uplink vs h720 with minimal visible difference
          //     in conference tiles that are rarely fullscreen.
          //   - 8 Mbps cap meant GCC spent seconds probing before settling; 2.5 Mbps settles 3-4× faster.
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
          videoEncoding: {
            maxBitrate:   2_500_000, // 2.5 Mbps — sufficient for 720p@30fps H264/VP9; GCC stays below
            maxFramerate: 30,
          },
          audioPreset: {
            maxBitrate: 128_000,   // Opus 128 kbps stereo
          },
          dtx: true,  // Discontinuous Transmission: near-zero bitrate in silence
          red: true,  // Redundant Encoding: automatic packet-loss concealment (PLC) for audio
                      // Equivalent to Opus redundancy flag — recovers audio on 5-15% packet loss
        },
      });
      roomRef.current = room;

      const refresh = () => refreshRef.current();

      // ── Connection state ─────────────────────────────────────────────────
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
        .on(RoomEvent.ParticipantConnected, (p) => {
          console.info(`[LK] ParticipantConnected: ${p.identity}`);
          refresh();
        })
        .on(RoomEvent.ParticipantDisconnected, (p) => {
          console.info(`[LK] ParticipantDisconnected: ${p.identity}`);
          // Immediate cleanup of all per-participant refs — prevents memory creep on long calls
          const pid = p.identity;
          (p as any).__lkReconnecting = false;
          prevStatsRef.current.delete(pid);
          fpsHistRef.current.delete(pid);
          statsListenersRef.current.delete(pid);
          streamsRef.current.delete(pid);
          trackIdsRef.current.delete(pid);
          refresh();
        })
        .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
          console.info(`[LK] TrackSubscribed: ${p.identity} kind=${pub.kind} src=${pub.source}`);
          if (track.kind === Track.Kind.Video) {
            // Request HIGH immediately on subscribe — GCC/TWCC will throttle if bandwidth is tight.
            // Adaptive quality loop will downgrade if fps drops below threshold.
            (pub as any).setVideoQuality?.(VideoQuality.HIGH);
          }
          // ── Jitter buffer: target low playout delay ──────────────────────
          // Default WebRTC jitter buffer: 150–500ms. On modern broadband/LTE
          // real jitter is <20ms — the rest is wasted as pure E2E latency.
          // playoutDelayHint (Chrome 87+): browser targets this but adapts up on real jitter.
          // jitterBufferTarget (Chrome 113+): more authoritative override.
          // Video 20ms / Audio 40ms — audio needs more headroom to avoid audible dropouts.
          applyJitterBufferHints(track as any);
          refresh();
        })
        .on(RoomEvent.TrackUnsubscribed,     (_, pub, p) => { console.info(`[LK] TrackUnsubscribed: ${p.identity} kind=${pub.kind}`); refresh(); })
        .on(RoomEvent.TrackMuted,            refresh)
        .on(RoomEvent.TrackUnmuted,          refresh)
        .on(RoomEvent.LocalTrackPublished,   (pub) => { console.info(`[LK] LocalTrackPublished: src=${pub.source}`); refresh(); })
        .on(RoomEvent.LocalTrackUnpublished, (pub) => { console.info(`[LK] LocalTrackUnpublished: src=${pub.source}`); refresh(); })
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

      // ── STEP 4: Connect ────────────────────────────────────────────��─────
      console.info(`[LK 4/6] room.connect() → ${livekitUrl} (timeout=${CONNECT_TIMEOUT_MS}ms)`);
      const t1 = Date.now();
      await withTimeout(
        room.connect(livekitUrl, token, {
          // iceCandidatePoolSize: pre-pool candidates before offer/answer.
          // Combined with preWarmICE(), this means the ICE agent already has
          // candidates ready in its pool the instant the DTLS handshake begins.
          rtcConfig: { iceCandidatePoolSize: 8 },
        }),
        CONNECT_TIMEOUT_MS,
        'room.connect',
      );
      console.info(`[LK 4/6] Connected ✓ in ${Date.now() - t1}ms | sid=${room.sid ?? 'n/a'}`);

      // ── STEP 5: Camera ───────────────────────────────────────────────────
      if (hadVideo) {
        try   { await room.localParticipant.setCameraEnabled(initVideoOn); setVideoAvailable(true); }
        catch (e) { console.warn(`[LK 5/6] Camera unavailable:`, (e as any)?.name ?? e); setVideoAvailable(false); }
      } else { setVideoAvailable(false); }

      // ── STEP 6: Microphone ───────────────────────────────────────────────
      if (hadAudio) {
        try   { await room.localParticipant.setMicrophoneEnabled(initAudioOn); setAudioAvailable(true); }
        catch (e) { console.warn(`[LK 6/6] Mic unavailable:`, (e as any)?.name ?? e); setAudioAvailable(false); }
      } else { setAudioAvailable(false); }

      console.info(`[LK ✓] Ready | participants=${room.remoteParticipants.size + 1} | network=${networkInfo()}`);
      setMediaReady(true);
      setConnectionState('connected');
      setConnectionError(null);
      refreshRef.current();

      // Start the single combined stats + adaptive quality loop
      startStatsLoop();

      // Async: log the selected ICE path ~2s after connect (non-blocking).
      // Look for [ICE path] in the console to see host/srflx/relay + RTT.
      logIcePath(room).catch(() => {});

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
  }, [roomId, initialStream, startStatsLoop]);

  // ── Retry ─────────────────────────────────────────────────────────────────
  const retryJoin = useCallback(() => {
    console.info('[LK] retryJoin...');
    const room = roomRef.current;
    if (room) { room.disconnect(); roomRef.current = null; }
    if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    streamsRef.current.clear(); trackIdsRef.current.clear();
    prevStatsRef.current.clear(); fpsHistRef.current.clear();
    hasJoined.current = false;
    setConnectionError(null); setConnectionState('idle');
    setParticipants([]); setLocalStream(null); setMediaReady(false);
    if (participantNameRef.current) joinRoom();
  }, [joinRoom]);

  // ── Leave ─────────────────────────────────────────────────────────────────
  const leaveRoom = useCallback(() => {
    if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    const room = roomRef.current;
    if (room) { room.disconnect(); roomRef.current = null; }
    streamsRef.current.clear(); trackIdsRef.current.clear();
    prevStatsRef.current.clear(); fpsHistRef.current.clear(); statsListenersRef.current.clear();
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
      if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
      const room = roomRef.current;
      if (room) { room.disconnect(); roomRef.current = null; }
      streamsRef.current.clear(); trackIdsRef.current.clear();
      prevStatsRef.current.clear(); fpsHistRef.current.clear(); statsListenersRef.current.clear();
    };
  }, []);

  return {
    participants, localStream, videoAvailable, audioAvailable, mediaReady, isScreenSharing,
    localAudioEnabled, localVideoEnabled, connectionState, connectionError,
    toggleAudio, toggleVideo, joinRoom, retryJoin, leaveRoom,
    changeDevices, forceControlParticipant, startScreenShare, stopScreenShare,
    subscribeToVideoStats,
  };
}

// Extract display name from identity (format: "Name|||randomId") or fall back to identity itself
function extractName(identity: string, lkName?: string): string {
  if (lkName && lkName.trim()) return lkName.trim();
  const sep = identity.indexOf('|||');
  if (sep > 0) return identity.slice(0, sep);
  return identity;
}