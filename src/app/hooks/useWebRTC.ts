import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import { projectId, publicAnonKey } from '/utils/supabase/info';

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

const SERVER_URL = `https://${projectId}.supabase.co/functions/v1/make-server-b5560c10`;
const SUPABASE_URL = `https://${projectId}.supabase.co`;

const ICE_SERVERS = {
  iceServers: [
    // STUN — discovers public IP/port (fails for same-NAT peers without hairpin support)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN — relay fallback for same-LAN / symmetric-NAT / mDNS-failure scenarios.
    // Open Relay Project: free public TURN for dev/testing.
    // ⚠️  Replace with a production TURN provider (Twilio, metered.ca, Cloudflare Calls)
    //    before going to production.
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:80?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    // Secondary free TURN fallback
    {
      urls: 'turn:numb.viagenie.ca',
      username: 'webrtc@live.com',
      credential: 'muazkh',
    },
  ],
};

// Find the sender for a given track kind on a PC, including pre-negotiated
// null-track senders (used when no camera/mic was available at join time).
function findSenderForKind(pc: RTCPeerConnection, kind: 'video' | 'audio'): RTCRtpSender | null {
  // 1. Active sender with a live track
  const active = pc.getSenders().find(s => s.track?.kind === kind);
  if (active) return active;
  // 2. Stored transceiver added by us when offerer had no tracks
  const storedKey = kind === 'video' ? '__videoTransceiver' : '__audioTransceiver';
  const stored = (pc as any)[storedKey] as RTCRtpTransceiver | undefined;
  if (stored?.sender) return stored.sender;
  // 3. Auto-created transceiver on the answerer side (receiver track reveals kind)
  const autoTc = pc.getTransceivers().find(t =>
    t.sender.track === null && t.receiver.track?.kind === kind
  );
  return autoTc?.sender ?? null;
}

// Shared Supabase client (singleton per session)
// Auth is disabled — we only use Realtime for signaling, so there's no need
// for a GoTrueClient at all. This avoids the "Multiple GoTrueClient instances"
// warning when Figma Make's own Supabase client is also present.
const supabase = createClient(SUPABASE_URL, publicAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: 'planaro-webrtc-auth',
  },
  global: { headers: {} },
});

function getSessionParticipantId(): string {
  let id = sessionStorage.getItem('participantId');
  if (!id) {
    id = Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('participantId', id);
  }
  return id;
}

export function useWebRTC(roomId: string, localParticipantName: string) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [videoAvailable, setVideoAvailable] = useState(true);
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [mediaReady, setMediaReady] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const stopScreenShareRef = useRef<(() => Promise<void>) | null>(null);
  // Remembers camera videoEnabled state before screen share took over
  const prevVideoEnabledRef = useRef(true);
  // Ref mirror of isScreenSharing for use inside closures
  const isScreenSharingRef = useRef(false);

  const localParticipantId = useRef(getSessionParticipantId());
  const participantNameRef = useRef(localParticipantName);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const dataChannels = useRef<Map<string, RTCDataChannel>>(new Map());
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const heartbeatInterval = useRef<number>();
  const hasJoined = useRef(false);
  const prevNameRef = useRef(localParticipantName);
  const mediaGeneration = useRef(0);
  const audioEnabledRef = useRef(true);
  const videoEnabledRef = useRef(true);
  const sessionNonce = useRef(Math.random().toString(36).slice(2));
  const peerNonces = useRef<Map<string, string>>(new Map());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const channelReadyRef = useRef(false);
  // True once media acquisition has been attempted (even if no devices found)
  const mediaAttempted = useRef(false);
  // Timers: when a peer goes disconnected, we wait before declaring them gone
  const disconnectTimers = useRef<Map<string, number>>(new Map());

  useEffect(() => { participantNameRef.current = localParticipantName; }, [localParticipantName]);

  // ─── upsertParticipant ────────────────────────────────────────────────────
  const upsertParticipant = useCallback(
    (id: string, patch: Partial<Omit<Participant, 'id'>>) => {
      setParticipants((prev) => {
        const idx = prev.findIndex((p) => p.id === id);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...patch };
          return updated;
        }
        return [
          ...prev,
          {
            id,
            name: patch.name ?? '',
            isLocal: false,
            audioEnabled: patch.audioEnabled ?? true,
            videoEnabled: patch.videoEnabled ?? true,
            screensharing: patch.screensharing ?? false,
            stream: patch.stream,
          },
        ];
      });
    },
    []
  );

  // ─── Send signal via Supabase Realtime (WebSocket, ~50ms) ────────────────
  const sendSignal = useCallback((toId: string, type: string, data: any) => {
    const channel = channelRef.current;
    if (channel && channelReadyRef.current) {
      channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
          fromId: localParticipantId.current,
          toId,
          type,
          data,
        },
      }).catch((e: any) => console.warn('[WebRTC] Realtime send error:', e));
    } else {
      // Fallback: HTTP (should rarely happen)
      fetch(`${SERVER_URL}/room/${roomId}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicAnonKey}` },
        body: JSON.stringify({ fromId: localParticipantId.current, toId, type, data }),
      }).catch(() => {});
    }
  }, [roomId]);

  const sendSignalRef = useRef(sendSignal);
  useEffect(() => { sendSignalRef.current = sendSignal; }, [sendSignal]);

  // ─── Data channel: instant P2P (media-state, leave) ─────────────────────
  const setupDataChannel = useCallback((dc: RTCDataChannel, peerId: string) => {
    dataChannels.current.set(peerId, dc);
    dc.onclose = () => { dataChannels.current.delete(peerId); };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'media-state') {
          upsertParticipant(peerId, {
            audioEnabled: msg.audioEnabled,
            videoEnabled: msg.videoEnabled,
            screensharing: msg.screensharing ?? false,
          });
        } else if (msg.type === 'leave') {
          setParticipants((prev) => prev.filter((p) => p.id !== peerId));
          const pc = peerConnections.current.get(peerId);
          if (pc) { pc.close(); peerConnections.current.delete(peerId); }
          dataChannels.current.delete(peerId);
          peerNonces.current.delete(peerId);
          pendingCandidates.current.delete(peerId);
        } else if (msg.type === 'force-control') {
          // Host is asking us to mute/disable our media
          const newAudio = msg.audioEnabled ?? audioEnabledRef.current;
          const newVideo = msg.videoEnabled ?? videoEnabledRef.current;
          audioEnabledRef.current = newAudio;
          videoEnabledRef.current = newVideo;
          if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = newAudio; });
            localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = newVideo; });
            setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, audioEnabled: newAudio, videoEnabled: newVideo } : p)));
          }
          // Broadcast updated state to all peers
          const stateMsg = { type: 'media-state', audioEnabled: newAudio, videoEnabled: newVideo };
          peerConnections.current.forEach((_, pid) => {
            const pdc = dataChannels.current.get(pid);
            if (pdc && pdc.readyState === 'open') { try { pdc.send(JSON.stringify(stateMsg)); } catch {} }
          });
        }
      } catch {}
    };
  }, [upsertParticipant]);

  // Send via data channel if open, otherwise via Realtime
  const sendDirectOrSignal = useCallback(
    (peerId: string, dcMsg: object, sigType: string, sigData: object) => {
      const dc = dataChannels.current.get(peerId);
      if (dc && dc.readyState === 'open') {
        try { dc.send(JSON.stringify(dcMsg)); return; } catch {}
      }
      sendSignalRef.current(peerId, sigType, sigData);
    },
    []
  );

  // ─── Flush buffered ICE candidates ───────────────────────────────────────
  const flushCandidates = async (pc: RTCPeerConnection, peerId: string) => {
    const buffered = pendingCandidates.current.get(peerId) || [];
    pendingCandidates.current.set(peerId, []);
    for (const c of buffered) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  };

  // ─── Remove ghost participant (closes PC, clears state) ──────────────────
  const removeGhost = useCallback((peerId: string, reason: string) => {
    console.log(`[WebRTC] removing ghost ${peerId} (${reason})`);
    // Clear any pending disconnect timer
    const t = disconnectTimers.current.get(peerId);
    if (t) { clearTimeout(t); disconnectTimers.current.delete(peerId); }
    setParticipants((prev) => prev.filter((p) => p.id !== peerId));
    const pc = peerConnections.current.get(peerId);
    if (pc) { try { pc.close(); } catch {} peerConnections.current.delete(peerId); }
    dataChannels.current.delete(peerId);
    peerNonces.current.delete(peerId);
    pendingCandidates.current.delete(peerId);
  }, []);

  // ─── Create peer connection ───────────────────────────────────────────────
  const createPeerConnection = useCallback((peerId: string, remoteName?: string, isOfferer = false) => {
    const existing = peerConnections.current.get(peerId);
    if (existing) {
      existing.close();
      peerConnections.current.delete(peerId);
      dataChannels.current.delete(peerId);
      pendingCandidates.current.delete(peerId);
    }

    console.log('[WebRTC] createPC for', peerId);
    const pc = new RTCPeerConnection(ICE_SERVERS);

    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    // ── Pre-negotiate transceivers when offerer has no tracks ──────────────
    // BOTH video AND audio must be included from the start.
    // If only video is added, the remote peer (who has audio) will trigger its
    // own onnegotiationneeded to add audio, causing a second offer/answer round.
    // That second round races with the first, producing "m-lines order mismatch".
    // Note: onnegotiationneeded checks !pc.remoteDescription and exits early,
    // so adding these transceivers here does NOT cause a spurious renegotiation.
    if (isOfferer) {
      if (!stream || stream.getVideoTracks().length === 0) {
        const vt = pc.addTransceiver('video', { direction: 'sendrecv' });
        (pc as any).__videoTransceiver = vt;
      }
      if (!stream || stream.getAudioTracks().length === 0) {
        const at = pc.addTransceiver('audio', { direction: 'sendrecv' });
        (pc as any).__audioTransceiver = at;
      }
    }

    // Data channel setup
    if (isOfferer) {
      const dc = pc.createDataChannel('control', { ordered: true });
      setupDataChannel(dc, peerId);
    } else {
      pc.ondatachannel = (event) => setupDataChannel(event.channel, peerId);
    }

    // ontrack — accumulate tracks into a stable MediaStream
    pc.ontrack = (event) => {
      const addTrack = () => {
        const prev: MediaStream | undefined = (pc as any).__remoteStream;
        const existingTracks: MediaStreamTrack[] = prev ? prev.getTracks() : [];
        if (existingTracks.find((t) => t.id === event.track.id)) return;
        const fresh = new MediaStream([...existingTracks, event.track]);
        (pc as any).__remoteStream = fresh;
        upsertParticipant(peerId, { stream: fresh });
        console.log('[WebRTC] track added for', peerId, event.track.kind, event.track.readyState);
      };
      event.track.onunmute = addTrack;
      addTrack();
    };

    // ICE — batch candidates, send every 80ms to reduce round-trips
    const iceBatch: RTCIceCandidateInit[] = [];
    let iceTimer: number | undefined;
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        console.log('[WebRTC] ICE gathering done for', peerId);
        return;
      }
      console.log('[WebRTC] ICE candidate for', peerId, event.candidate.type, event.candidate.address ?? '');
      iceBatch.push(event.candidate.toJSON());
      if (iceTimer) return;
      iceTimer = window.setTimeout(() => {
        iceTimer = undefined;
        if (iceBatch.length === 0) return;
        const batch = iceBatch.splice(0);
        // Send each candidate (Realtime is cheap)
        batch.forEach((c) => sendSignalRef.current(peerId, 'ice-candidate', c));
      }, 80);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[WebRTC] connectionState', peerId, state);

      if (state === 'connected') {
        // Cancel ghost-removal timer — peer reconnected in time
        const t = disconnectTimers.current.get(peerId);
        if (t) { clearTimeout(t); disconnectTimers.current.delete(peerId); }
        // Reset restart counter on success
        (pc as any).__iceRestarts = 0;
        // Clear reconnecting banner
        upsertParticipant(peerId, { reconnecting: false });
      }

      if (state === 'disconnected' || state === 'failed') {
        // Show "Reconnecting…" on the tile immediately
        upsertParticipant(peerId, { reconnecting: true });
        if (state === 'failed') {
          // Limit ICE restarts to prevent infinite loops
          const restarts = ((pc as any).__iceRestarts ?? 0);
          if (restarts < 4) {
            (pc as any).__iceRestarts = restarts + 1;
            pc.restartIce();
          }
        }
        // Start removal countdown — give 12 s for ICE restart / reconnect
        if (!disconnectTimers.current.has(peerId)) {
          const t = window.setTimeout(() => {
            disconnectTimers.current.delete(peerId);
            // Only remove if still in bad state
            const currentPc = peerConnections.current.get(peerId);
            if (
              currentPc &&
              (currentPc.connectionState === 'disconnected' ||
                currentPc.connectionState === 'failed' ||
                currentPc.connectionState === 'closed')
            ) {
              removeGhost(peerId, `connectionState=${state} timeout`);
            }
          }, 12000);
          disconnectTimers.current.set(peerId, t);
        }
      }
    };

    // Renegotiation (only after initial offer/answer, with debounce)
    // __skipNegotiation is set during/after processOffer to suppress the
    // spurious onnegotiationneeded that Chrome fires when setRemoteDescription
    // adds new transceivers — those transceivers are already in our answer,
    // so there is nothing left to negotiate.
    let renego: number | undefined;
    pc.onnegotiationneeded = async () => {
      if (!pc.remoteDescription) return;
      if (pc.signalingState !== 'stable') return;
      if ((pc as any).__skipNegotiation) return;
      clearTimeout(renego);
      renego = window.setTimeout(async () => {
        if (pc.signalingState !== 'stable' || !pc.remoteDescription) return;
        if ((pc as any).__skipNegotiation) return;
        console.log('[WebRTC] renegotiating with', peerId);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignalRef.current(peerId, 'offer', {
            type: offer.type,
            sdp: offer.sdp ?? '',
            senderName: participantNameRef.current,
            nonce: sessionNonce.current,
          });
        } catch (e) {
          console.warn('[WebRTC] renegotiation error:', e);
        }
      }, 150);
    };

    if (remoteName !== undefined) upsertParticipant(peerId, { name: remoteName });
    peerConnections.current.set(peerId, pc);
    return pc;
  }, [upsertParticipant, setupDataChannel, removeGhost]);

  // ─── Process incoming offer ───────────────────────────────────────────────
  const processOffer = async (
    pc: RTCPeerConnection,
    peerId: string,
    sdpData: { type: RTCSdpType; sdp: string },
    senderName?: string
  ) => {
    // Suppress onnegotiationneeded while processing.
    // setRemoteDescription may add new transceivers, which sets Chrome's
    // negotiation-needed flag. Since our answer already contains those
    // transceivers, the flag is stale — firing onnegotiationneeded here
    // would start an unnecessary (and race-prone) second renegotiation.
    (pc as any).__skipNegotiation = true;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdpData));
      await flushCandidates(pc, peerId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignalRef.current(peerId, 'answer', {
        type: answer.type,
        sdp: answer.sdp ?? '',
        senderName: participantNameRef.current,
      });
      // Immediately share our media state
      sendSignalRef.current(peerId, 'media-state', {
        audioEnabled: audioEnabledRef.current,
        videoEnabled: videoEnabledRef.current,
        screensharing: isScreenSharingRef.current,
      });
    } finally {
      // Lift suppression after a short settle period.
      // Any track/direction change that happens AFTER this window
      // (e.g. user starts screen share) will trigger a legitimate renegotiation.
      window.setTimeout(() => { (pc as any).__skipNegotiation = false; }, 500);
    }
  };

  // ─── Handle incoming signal ───────────────────────────────────────────────
  const handleSignalRef = useRef<((signal: any) => Promise<void>) | null>(null);
  handleSignalRef.current = async (signal: any) => {
    const { fromId, type, data } = signal;

    if (type === 'name-update') {
      upsertParticipant(fromId, { name: data.name });
      return;
    }

    if (type === 'media-state') {
      upsertParticipant(fromId, {
        audioEnabled: data.audioEnabled,
        videoEnabled: data.videoEnabled,
        screensharing: data.screensharing ?? false,
      });
      return;
    }

    if (type === 'participant-left') {
      const storedNonce = peerNonces.current.get(fromId);
      const leftNonce: string | undefined = data?.nonce;
      if (leftNonce && storedNonce && leftNonce !== storedNonce) return;
      setParticipants((prev) => prev.filter((p) => p.id !== fromId));
      const pc = peerConnections.current.get(fromId);
      if (pc) { pc.close(); peerConnections.current.delete(fromId); }
      dataChannels.current.delete(fromId);
      peerNonces.current.delete(fromId);
      pendingCandidates.current.delete(fromId);
      return;
    }

    const senderName: string | undefined = data.senderName;
    const sdpData = { type: data.type as RTCSdpType, sdp: data.sdp as string };

    if (type === 'offer') {
      const incomingNonce: string | undefined = data.nonce;
      const storedNonce = peerNonces.current.get(fromId);
      const nonceChanged = !!(incomingNonce && storedNonce && incomingNonce !== storedNonce);
      if (incomingNonce) peerNonces.current.set(fromId, incomingNonce);

      let pc = peerConnections.current.get(fromId);

      if (!pc || pc.signalingState === 'closed' || nonceChanged) {
        pc = createPeerConnection(fromId, senderName, false);
      } else {
        if (senderName) upsertParticipant(fromId, { name: senderName });
        if (pc.signalingState === 'have-local-offer') {
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch {
            pc = createPeerConnection(fromId, senderName, false);
          }
        }
      }

      try {
        await processOffer(pc, fromId, sdpData, senderName);
      } catch (e: any) {
        console.log('[WebRTC] offer failed (', e?.name, '), resetting PC for', fromId);
        const freshPc = createPeerConnection(fromId, senderName, false);
        try {
          await processOffer(freshPc, fromId, sdpData, senderName);
        } catch (e2) {
          console.warn('[WebRTC] offer retry failed:', e2);
        }
      }

    } else if (type === 'answer') {
      const pc = peerConnections.current.get(fromId);
      if (!pc) return;
      if (senderName) upsertParticipant(fromId, { name: senderName });
      try {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(sdpData));
          await flushCandidates(pc, fromId);
          sendSignalRef.current(fromId, 'media-state', {
            audioEnabled: audioEnabledRef.current,
            videoEnabled: videoEnabledRef.current,
            screensharing: isScreenSharingRef.current,
          });
        }
      } catch (e) {
        console.warn('[WebRTC] answer error:', e);
      }

    } else if (type === 'ice-candidate') {
      const pc = peerConnections.current.get(fromId);
      if (!pc || pc.signalingState === 'closed') return;
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data)); } catch {}
      } else {
        const buf = pendingCandidates.current.get(fromId) || [];
        buf.push(data);
        pendingCandidates.current.set(fromId, buf);
      }
    }
  };

  // ─── Setup Supabase Realtime channel ─────────────────────────────────────
  useEffect(() => {
    const channelName = `meet-${roomId}`;
    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false, ack: false } },
    });

    channel
      .on('broadcast', { event: 'signal' }, ({ payload }: { payload: any }) => {
        // Each peer receives ALL broadcasts; only process those addressed to us
        if (payload.toId === localParticipantId.current && handleSignalRef.current) {
          handleSignalRef.current(payload);
        }
      })
      .subscribe((status: string) => {
        console.log('[Realtime] channel status:', status);
        if (status === 'SUBSCRIBED') {
          channelReadyRef.current = true;
          channelRef.current = channel;
        }
      });

    return () => {
      channelReadyRef.current = false;
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  // ─── Join room ────────────────────────────────────────────────────────────
  const joinRoom = useCallback(async () => {
    const name = participantNameRef.current;
    if (!name || hasJoined.current) return;
    hasJoined.current = true;
    sessionNonce.current = Math.random().toString(36).slice(2);

    try {
      const res = await fetch(`${SERVER_URL}/room/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicAnonKey}` },
        body: JSON.stringify({ participantId: localParticipantId.current, participantName: name }),
      });
      if (!res.ok) throw new Error('Failed to join room');

      const { participants: roomParticipants } = await res.json();
      const seenIds = new Set<string>();
      const unique = (roomParticipants as any[]).filter((p) => {
        if (seenIds.has(p.id)) return false;
        seenIds.add(p.id);
        return true;
      });

      setParticipants(
        unique.map((p: any) => ({
          id: p.id,
          name: p.name,
          isLocal: p.id === localParticipantId.current,
          audioEnabled: true,
          videoEnabled: true,
        }))
      );

      const remotes = unique.filter((p: any) => p.id !== localParticipantId.current);

      // ── Create ALL offers in PARALLEL (was sequential) ────────────────────
      await Promise.all(
        remotes.map(async (p: any) => {
          const pc = createPeerConnection(p.id, p.name, true);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignalRef.current(p.id, 'offer', {
            type: offer.type,
            sdp: offer.sdp ?? '',
            senderName: name,
            nonce: sessionNonce.current,
          });
        })
      );
    } catch (e) {
      hasJoined.current = false;
      console.error('[WebRTC] joinRoom:', e);
    }
  }, [roomId, createPeerConnection]);

  // ─── Leave room ───────────────────────────────────────────────────────────
  const leaveRoom = useCallback(() => {
    if (heartbeatInterval.current) { clearInterval(heartbeatInterval.current); heartbeatInterval.current = undefined; }

    // 1. Instant leave via data channels (P2P, zero lag)
    const leaveMsg = JSON.stringify({ type: 'leave', nonce: sessionNonce.current });
    dataChannels.current.forEach((dc) => {
      if (dc.readyState === 'open') {
        try { dc.send(leaveMsg); } catch {}
      }
    });

    // 2. Realtime broadcast to peers whose data channel isn't open yet
    peerConnections.current.forEach((_, peerId) => {
      sendSignalRef.current(peerId, 'participant-left', { nonce: sessionNonce.current });
    });

    // 3. Close everything immediately
    peerConnections.current.forEach((pc) => pc.close());
    peerConnections.current.clear();
    dataChannels.current.clear();
    pendingCandidates.current.clear();
    peerNonces.current.clear();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }

    // 4. Server cleanup (fire-and-forget)
    fetch(`${SERVER_URL}/room/${roomId}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicAnonKey}` },
      body: JSON.stringify({ participantId: localParticipantId.current }),
    }).catch(() => {});

    hasJoined.current = false;
  }, [roomId]);

  // ─── Get media stream ─────────────────────────────────────────────────────
  const getMediaStream = useCallback(async (videoDeviceId?: string, audioDeviceId?: string) => {
    const myGeneration = ++mediaGeneration.current;
    const validVideoId = videoDeviceId?.trim() || undefined;
    const validAudioId = audioDeviceId?.trim() || undefined;

    let videoTrack: MediaStreamTrack | null = null;
    let audioTrack: MediaStreamTrack | null = null;

    // Acquire video + audio in parallel
    const [videoResult, audioResult] = await Promise.allSettled([
      navigator.mediaDevices.getUserMedia({
        // When no explicit deviceId saved: prefer the standard front camera
        // (ideal 'user' facingMode) rather than bare `true` which on iPad
        // defaults to the ultra-wide lens.
        video: validVideoId
          ? { deviceId: { ideal: validVideoId } }
          : { facingMode: { ideal: 'user' } },
        audio: false,
      }),
      navigator.mediaDevices.getUserMedia({
        video: false,
        audio: validAudioId ? { deviceId: { ideal: validAudioId } } : true,
      }),
    ]);

    if (mediaGeneration.current !== myGeneration) {
      if (videoResult.status === 'fulfilled') videoResult.value.getTracks().forEach((t) => t.stop());
      if (audioResult.status === 'fulfilled') audioResult.value.getTracks().forEach((t) => t.stop());
      return null;
    }

    if (videoResult.status === 'fulfilled') {
      videoTrack = videoResult.value.getVideoTracks()[0] ?? null;
      setVideoAvailable(true);
      videoEnabledRef.current = true;

      // ── Auto-select standard camera when no explicit preference saved ─────
      // Browsers often default to the wide-angle / ultra-wide lens.
      // The standard camera is reliably the LAST device in the enumerated list
      // on most hardware. We also keep label-based detection as a secondary
      // trigger in case a stale saved deviceId points to a wide lens.
      const isWideLabel = videoTrack ? /ultra.?wide|wide.?angle/i.test(videoTrack.label) : false;
      if (videoTrack && (!validVideoId || isWideLabel)) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cameras = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
          if (cameras.length > 1) {
            const currentId = videoTrack.getSettings().deviceId ?? '';
            // Prefer the last non-wide camera; fall back to simply the last one
            const nonWide = cameras.filter((d) => !/ultra.?wide|wide.?angle/i.test(d.label));
            const target = (nonWide.length > 0 ? nonWide : cameras)[cameras.length - 1] ?? cameras[cameras.length - 1];
            if (target.deviceId && target.deviceId !== currentId) {
              console.log('[WebRTC] switching to preferred camera:', target.label || target.deviceId);
              videoTrack.stop();
              const s = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: target.deviceId } },
                audio: false,
              });
              const betterTrack = s.getVideoTracks()[0];
              if (betterTrack) {
                videoTrack = betterTrack;
                localStorage.setItem('selectedVideoDevice', target.deviceId);
                console.log('[WebRTC] switched to:', betterTrack.label);
              }
            } else if (target.deviceId) {
              // Already on the right camera — persist the id for next load
              localStorage.setItem('selectedVideoDevice', target.deviceId);
            }
          }
        } catch (e) {
          console.warn('[WebRTC] camera auto-select failed:', e);
        }
      }
    } else {
      console.log('[WebRTC] No video:', (videoResult.reason as any)?.name);
      setVideoAvailable(false);
      videoEnabledRef.current = false;
      if (validVideoId) localStorage.removeItem('selectedVideoDevice');
    }

    if (audioResult.status === 'fulfilled') {
      audioTrack = audioResult.value.getAudioTracks()[0] ?? null;
      setAudioAvailable(true);
      audioEnabledRef.current = true;
    } else {
      console.log('[WebRTC] No audio:', (audioResult.reason as any)?.name);
      setAudioAvailable(false);
      audioEnabledRef.current = false;
      if (validAudioId) localStorage.removeItem('selectedAudioDevice');
    }

    const stream = new MediaStream();
    if (videoTrack) stream.addTrack(videoTrack);
    if (audioTrack) stream.addTrack(audioTrack);

    // Even with zero tracks we still set the stream so the join effect can fire.
    // The participant will join as a viewer (no video/audio sent) and still
    // receive remote tracks from other peers.
    if (stream.getTracks().length === 0) {
      console.log('[WebRTC] No media devices — joining as viewer (receive-only)');
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
    }
    localStreamRef.current = stream;
    setLocalStream(stream);

    // Replace tracks in existing PCs
    peerConnections.current.forEach((pc) => {
      if (pc.signalingState === 'closed') return;
      stream.getTracks().forEach((track) => {
        const sender = findSenderForKind(pc, track.kind as 'video' | 'audio');
        if (sender) {
          sender.replaceTrack(track).catch(() => {});
        } else {
          pc.addTrack(track, stream);
        }
      });
    });

    return stream;
  }, []);

  // ─── Init media ───────────────────────────────────────────────────────────
  useEffect(() => {
    const videoId = localStorage.getItem('selectedVideoDevice') || undefined;
    const audioId = localStorage.getItem('selectedAudioDevice') || undefined;

    const init = async () => {
      await getMediaStream(videoId, audioId);
      // Mark media as attempted so join can proceed even if no devices
      mediaAttempted.current = true;
      setMediaReady(true);
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Join once media attempted + name set + Realtime ready ───────────────
  useEffect(() => {
    if (mediaReady && localParticipantName && !hasJoined.current) {
      const tryJoin = () => {
        if (channelReadyRef.current) {
          joinRoom();
        } else {
          const t = setTimeout(tryJoin, 100);
          return () => clearTimeout(t);
        }
      };
      tryJoin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaReady, localParticipantName]);

  // ─── Broadcast name changes ───────────────────────────────────────────────
  useEffect(() => {
    if (!hasJoined.current) return;
    if (localParticipantName === prevNameRef.current) return;
    prevNameRef.current = localParticipantName;
    setParticipants((prev) =>
      prev.map((p) => (p.isLocal ? { ...p, name: localParticipantName } : p))
    );
    fetch(`${SERVER_URL}/room/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicAnonKey}` },
      body: JSON.stringify({ participantId: localParticipantId.current, participantName: localParticipantName }),
    }).catch(() => {});
    peerConnections.current.forEach((_, peerId) => {
      sendDirectOrSignal(
        peerId,
        { type: 'name-update', name: localParticipantName },
        'name-update',
        { name: localParticipantName }
      );
    });
  }, [localParticipantName, roomId, sendDirectOrSignal]);

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  useEffect(() => {
    const sendHeartbeat = async () => {
      if (!hasJoined.current) return;
      try {
        await fetch(`${SERVER_URL}/room/${roomId}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicAnonKey}` },
          body: JSON.stringify({ participantId: localParticipantId.current }),
        });
      } catch {}
    };
    heartbeatInterval.current = window.setInterval(sendHeartbeat, 30000);
    return () => { if (heartbeatInterval.current) clearInterval(heartbeatInterval.current); };
  }, [roomId]);

  // ─── Periodic server sync — removes ghosts missed by WebRTC events ────────
  useEffect(() => {
    const sync = async () => {
      if (!hasJoined.current) return;
      try {
        const res = await fetch(`${SERVER_URL}/room/${roomId}/participants`, {
          headers: { Authorization: `Bearer ${publicAnonKey}` },
        });
        if (!res.ok) return;
        const { participants: serverList } = await res.json();
        const serverIds = new Set<string>((serverList as any[]).map((p: any) => p.id));
        // Remove participants that are no longer on the server
        setParticipants((prev) => {
          const filtered = prev.filter((p) => {
            if (p.isLocal || serverIds.has(p.id)) return true;
            // Don't evict a peer whose WebRTC connection is still active —
            // the server heartbeat may have lapsed while the P2P link is fine.
            const pc = peerConnections.current.get(p.id);
            if (pc && pc.connectionState === 'connected') return true;
            return false;
          });
          if (filtered.length !== prev.length) {
            // Clean up PCs for removed ghosts
            prev.forEach((p) => {
              if (!p.isLocal && !serverIds.has(p.id)) {
                const pc = peerConnections.current.get(p.id);
                if (pc && pc.connectionState === 'connected') return; // skip — still alive
                console.log('[WebRTC] sync removed ghost:', p.id, p.name);
                if (pc) { try { pc.close(); } catch {} peerConnections.current.delete(p.id); }
                dataChannels.current.delete(p.id);
                peerNonces.current.delete(p.id);
                pendingCandidates.current.delete(p.id);
                const t = disconnectTimers.current.get(p.id);
                if (t) { clearTimeout(t); disconnectTimers.current.delete(p.id); }
              }
            });
          }
          return filtered;
        });
      } catch {}
    };

    const interval = window.setInterval(sync, 20000);
    return () => clearInterval(interval);
  }, [roomId]);

  // ─── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => { leaveRoom(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── beforeunload / pagehide — instant leave when tab closes ─────────────
  // fetch with keepalive:true outlives the page unload; data-channel message
  // is synchronous and reaches open peers immediately.
  useEffect(() => {
    const handleUnload = () => {
      if (!hasJoined.current) return;
      const leaveMsg = JSON.stringify({ type: 'leave', nonce: sessionNonce.current });
      dataChannels.current.forEach((dc) => {
        if (dc.readyState === 'open') { try { dc.send(leaveMsg); } catch {} }
      });
      fetch(`${SERVER_URL}/room/${roomId}/leave`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicAnonKey}` },
        body: JSON.stringify({ participantId: localParticipantId.current }),
      }).catch(() => {});
      hasJoined.current = false;
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, [roomId]);

  // ─── Controls ─────────────────────────────────────────────────────────────
  const toggleAudio = useCallback((enabled: boolean) => {
    audioEnabledRef.current = enabled;
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = enabled; });
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, audioEnabled: enabled } : p)));
    }
    const msg = { type: 'media-state', audioEnabled: enabled, videoEnabled: videoEnabledRef.current };
    peerConnections.current.forEach((_, peerId) => {
      sendDirectOrSignal(peerId, msg, 'media-state', { audioEnabled: enabled, videoEnabled: videoEnabledRef.current });
    });
  }, [sendDirectOrSignal]);

  const toggleVideo = useCallback((enabled: boolean) => {
    videoEnabledRef.current = enabled;
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = enabled; });
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, videoEnabled: enabled } : p)));
    }
    const msg = { type: 'media-state', audioEnabled: audioEnabledRef.current, videoEnabled: enabled };
    peerConnections.current.forEach((_, peerId) => {
      sendDirectOrSignal(peerId, msg, 'media-state', { audioEnabled: audioEnabledRef.current, videoEnabled: enabled });
    });
  }, [sendDirectOrSignal]);

  const changeDevices = useCallback(async (devices: { videoId?: string; audioId?: string; outputId?: string }) => {
    await getMediaStream(devices.videoId?.trim() || undefined, devices.audioId?.trim() || undefined);
  }, [getMediaStream]);

  // ─── Force-control a participant (mute mic/camera remotely) ──────────────
  const forceControlParticipant = useCallback(
    (participantId: string, audioEnabled: boolean, videoEnabled: boolean) => {
      // For local participant, control directly
      const isLocal = participantId === localParticipantId.current;
      if (isLocal) {
        if (audioEnabled !== audioEnabledRef.current) {
          audioEnabledRef.current = audioEnabled;
          if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = audioEnabled; });
          }
        }
        if (videoEnabled !== videoEnabledRef.current) {
          videoEnabledRef.current = videoEnabled;
          if (localStreamRef.current) {
            localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = videoEnabled; });
          }
        }
        setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, audioEnabled, videoEnabled } : p)));
        return;
      }
      // For remote participant: send force-control via data channel
      const dc = dataChannels.current.get(participantId);
      const msg = JSON.stringify({ type: 'force-control', audioEnabled, videoEnabled });
      if (dc && dc.readyState === 'open') {
        try { dc.send(msg); } catch {}
      }
      // Optimistically update local UI
      setParticipants((prev) =>
        prev.map((p) => (p.id === participantId ? { ...p, audioEnabled, videoEnabled } : p))
      );
    },
    []
  );

  // ─── Screen sharing ───────────────────────────────────────────────────────
  const stopScreenShare = useCallback(async () => {
    if (!screenStreamRef.current) return;

    // Stop all screen tracks
    screenStreamRef.current.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    isScreenSharingRef.current = false;
    setIsScreenSharing(false);

    // Restore the camera videoEnabled state that was active before screen share
    const wasVideoEnabled = prevVideoEnabledRef.current;
    videoEnabledRef.current = wasVideoEnabled;

    // Re-acquire camera
    const videoId = localStorage.getItem('selectedVideoDevice') || undefined;
    try {
      const camResult = await navigator.mediaDevices.getUserMedia({
        video: videoId ? { deviceId: { ideal: videoId } } : true,
        audio: false,
      });
      const camTrack = camResult.getVideoTracks()[0];
      if (!camTrack) return;

      // Apply the restored enabled state to the camera track
      camTrack.enabled = wasVideoEnabled;

      // Replace video track in all peer connections
      peerConnections.current.forEach((pc) => {
        if (pc.signalingState === 'closed') return;
        const videoSender = findSenderForKind(pc, 'video');
        if (videoSender) {
          videoSender.replaceTrack(camTrack).catch(() => {});
        }
      });

      // ── Broadcast restored video state + screensharing:false ─────────────
      const stateMsg = { type: 'media-state', audioEnabled: audioEnabledRef.current, videoEnabled: wasVideoEnabled, screensharing: false };
      peerConnections.current.forEach((_, peerId) => {
        sendDirectOrSignal(peerId, stateMsg, 'media-state', { audioEnabled: audioEnabledRef.current, videoEnabled: wasVideoEnabled, screensharing: false });
      });

      // Update local participant entry
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, videoEnabled: wasVideoEnabled, screensharing: false } : p)));

      // Update localStream
      const newStream = new MediaStream();
      localStreamRef.current?.getAudioTracks().forEach((t) => newStream.addTrack(t));
      newStream.addTrack(camTrack);
      localStreamRef.current = newStream;
      setLocalStream(newStream);
    } catch (e) {
      console.warn('[WebRTC] failed to restore camera after screen share:', e);
      // Still tell peers video is off
      const stateMsg = { type: 'media-state', audioEnabled: audioEnabledRef.current, videoEnabled: false, screensharing: false };
      peerConnections.current.forEach((_, peerId) => {
        sendDirectOrSignal(peerId, stateMsg, 'media-state', { audioEnabled: audioEnabledRef.current, videoEnabled: false, screensharing: false });
      });
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, videoEnabled: false, screensharing: false } : p)));
    }
  }, [sendDirectOrSignal]);

  const startScreenShare = useCallback(async () => {
    try {
      const screenStream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { cursor: 'always', displaySurface: 'monitor' },
        audio: true,
      }) as MediaStream;

      const screenVideoTrack = screenStream.getVideoTracks()[0];
      if (!screenVideoTrack) { screenStream.getTracks().forEach((t) => t.stop()); return; }

      // Stop any previous screen stream
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      screenStreamRef.current = screenStream;

      // Save camera enabled state, then force video=true for screen share
      prevVideoEnabledRef.current = videoEnabledRef.current;
      videoEnabledRef.current = true;
      isScreenSharingRef.current = true;
      screenVideoTrack.enabled = true;

      // Replace video track in all peer connections
      peerConnections.current.forEach((pc) => {
        if (pc.signalingState === 'closed') return;
        const videoSender = findSenderForKind(pc, 'video');
        if (videoSender) {
          videoSender.replaceTrack(screenVideoTrack).catch(() => {});
        } else {
          // No video sender yet (user joined without camera) — add track and renegotiate
          pc.addTrack(screenVideoTrack, screenStream);
        }
      });

      // ── Broadcast videoEnabled:true + screensharing:true ────────────────
      const stateMsg = { type: 'media-state', audioEnabled: audioEnabledRef.current, videoEnabled: true, screensharing: true };
      peerConnections.current.forEach((_, peerId) => {
        sendDirectOrSignal(peerId, stateMsg, 'media-state', { audioEnabled: audioEnabledRef.current, videoEnabled: true, screensharing: true });
      });

      // Update local participant entry
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, videoEnabled: true, screensharing: true } : p)));

      // Update localStream (keep mic audio, swap video)
      const newStream = new MediaStream();
      localStreamRef.current?.getAudioTracks().forEach((t) => newStream.addTrack(t));
      screenStream.getAudioTracks().forEach((t) => newStream.addTrack(t));
      newStream.addTrack(screenVideoTrack);
      localStreamRef.current = newStream;
      setLocalStream(newStream);
      setIsScreenSharing(true);

      // Auto-stop when user clicks "Stop sharing" in the browser UI
      screenVideoTrack.onended = () => {
        stopScreenShareRef.current?.();
      };
    } catch (e: any) {
      // User cancelled the picker — not an error
      if (e?.name !== 'NotAllowedError') {
        console.warn('[WebRTC] screen share error:', e);
      }
    }
  }, [sendDirectOrSignal]);

  useEffect(() => { stopScreenShareRef.current = stopScreenShare; }, [stopScreenShare]);

  return { participants, localStream, toggleAudio, toggleVideo, leaveRoom, changeDevices, videoAvailable, audioAvailable, forceControlParticipant, isScreenSharing, startScreenShare, stopScreenShare };
}