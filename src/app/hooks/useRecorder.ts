import { useRef, useState, useCallback } from 'react';

export type RecorderState = 'idle' | 'recording' | 'ready';

export interface RecordingParticipant {
  stream: MediaStream | null | undefined;
  name: string;
  isLocal: boolean;
}

// ── MIME type selector ────────────────────────────────────────────────────────
function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

// ── Grid layout ───────────────────────────────────────────────────────────────
function gridFor(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

// ── canvas roundRect polyfill ─────────────────────────────────────────────────
function rrect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  if (typeof (ctx as any).roundRect === 'function') {
    (ctx as any).roundRect(x, y, w, h, r);
  } else {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }
}

// ── Canvas size ───────────────────────────────────────────────────────────────
const W = 1280;
const H = 720;
const GAP = 8;
const BG = '#202124';
const TILE_BG = '#28292c';
const LABEL_BG = 'rgba(0,0,0,0.65)';
const LABEL_FG = '#e8eaed';
const AVATAR_FG = '#8ab4f8';

// ── Draw one frame ────────────────────────────────────────────────────────────
function drawFrame(
  ctx: CanvasRenderingContext2D,
  tiles: Array<{ el: HTMLVideoElement; name: string }>
) {
  const n = tiles.length;
  const { cols, rows } = gridFor(n);
  const tileW = (W - GAP * (cols + 1)) / cols;
  const tileH = (H - GAP * (rows + 1)) / rows;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  tiles.forEach(({ el, name }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);

    // Center last row when not full
    const lastRowStart = (rows - 1) * cols;
    const lastRowCount = n - lastRowStart;
    const xOffset =
      i >= lastRowStart && lastRowCount < cols
        ? ((cols - lastRowCount) * (tileW + GAP)) / 2
        : 0;

    const x = GAP + col * (tileW + GAP) + xOffset;
    const y = GAP + row * (tileH + GAP);

    // Tile background
    ctx.fillStyle = TILE_BG;
    ctx.beginPath();
    rrect(ctx, x, y, tileW, tileH, 10);
    ctx.fill();

    // Video (contain — letterboxed)
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      const scale = Math.min(tileW / el.videoWidth, tileH / el.videoHeight);
      const dw = el.videoWidth * scale;
      const dh = el.videoHeight * scale;
      const dx = x + (tileW - dw) / 2;
      const dy = y + (tileH - dh) / 2;
      ctx.save();
      ctx.beginPath();
      rrect(ctx, x, y, tileW, tileH, 10);
      ctx.clip();
      ctx.drawImage(el, dx, dy, dw, dh);
      ctx.restore();
    } else {
      // No video — draw initials avatar
      const initials = (name || '?').charAt(0).toUpperCase();
      const fs = Math.round(Math.min(tileW, tileH) * 0.22);
      ctx.fillStyle = AVATAR_FG;
      ctx.font = `${fs}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, x + tileW / 2, y + tileH / 2);
    }

    // Name label (bottom-left)
    if (name) {
      const fs2 = Math.max(11, Math.round(tileH * 0.055));
      ctx.font = `${fs2}px sans-serif`;
      const textW = ctx.measureText(name).width;
      const lh = fs2 + 8;
      const lx = x + 6;
      const ly = y + tileH - lh - 6;
      const lw = Math.min(textW + 14, tileW - 12);
      ctx.fillStyle = LABEL_BG;
      ctx.beginPath();
      rrect(ctx, lx, ly, lw, lh, 4);
      ctx.fill();
      ctx.fillStyle = LABEL_FG;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      // Clip label text to pill width
      ctx.save();
      ctx.beginPath();
      rrect(ctx, lx, ly, lw, lh, 4);
      ctx.clip();
      ctx.fillText(name, lx + 7, ly + lh / 2);
      ctx.restore();
    }
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useRecorder() {
  const [state, setState] = useState<RecorderState>('idle');
  const [recordingTime, setRecordingTime] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mimeRef = useRef<string>('');
  const recordingTimeRef = useRef(0);        // mirror of recordingTime for closures
  const roomIdRef = useRef<string>('');      // set by stopRecording
  // Hidden video elements and canvas kept alive for the recording duration
  const videoElsRef = useRef<HTMLVideoElement[]>([]);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    videoElsRef.current.forEach((el) => { try { el.srcObject = null; el.remove(); } catch {} });
    videoElsRef.current = [];
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const startRecording = useCallback(
    async (allParticipants: RecordingParticipant[]) => {
      setError(null);

      if (!window.MediaRecorder) {
        setError('MediaRecorder не поддерживается в этом браузере');
        return;
      }

      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
        setDownloadUrl(null);
      }

      const mimeType = pickMimeType();
      if (!mimeType) {
        setError('Запись видео не поддерживается в этом браузере');
        return;
      }
      mimeRef.current = mimeType;

      // All participants go into the canvas grid — those without video
      // will show an initials avatar tile (drawFrame already handles videoWidth===0)
      if (allParticipants.length === 0) {
        setError('Нет участников для записи');
        return;
      }

      // ── Create hidden <video> elements for every participant ───────────────
      // We draw all of them onto a <canvas> in a grid layout,
      // then use canvas.captureStream() as the video track.
      // This completely sidesteps any WebRTC / MediaRecorder track conflicts.
      const tiles = allParticipants.map(({ stream, name }) => {
        const el = document.createElement('video');
        if (stream && stream.getTracks().length > 0) {
          el.srcObject = stream;
        }
        el.muted = true;
        el.playsInline = true;
        el.setAttribute('playsinline', '');
        // Must be *visually* hidden but still rendered; display:none stops
        // frame delivery on some Chromium builds.
        el.style.cssText =
          'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;' +
          'opacity:0;pointer-events:none;visibility:hidden';
        document.body.appendChild(el);
        el.play().catch(() => {});
        return { el, name };
      });
      videoElsRef.current = tiles.map((t) => t.el);

      // Wait up to 2 s for each video to have dimensions
      await Promise.allSettled(
        tiles.map(
          ({ el }) =>
            new Promise<void>((resolve) => {
              if (el.videoWidth > 0) { resolve(); return; }
              const maxWait = setTimeout(resolve, 2000);
              el.onloadedmetadata = () => { clearTimeout(maxWait); resolve(); };
            })
        )
      );

      // ── Canvas compositor ─────────────────────────────────────────────────
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d')!;

      const loop = () => {
        drawFrame(ctx, tiles);
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();

      // ── Audio: mix everyone's mic/audio via WebAudio ───────────────────────
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const dest = audioCtx.createMediaStreamDestination();

      allParticipants.forEach(({ stream }) => {
        if (!stream) return;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;
        try { audioCtx.createMediaStreamSource(stream).connect(dest); } catch (_) {}
      });

      // ── Combined stream: canvas video + mixed audio ────────────────────────
      const canvasStream = (canvas as any).captureStream(30) as MediaStream;
      const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);

      chunksRef.current = [];

      // ── MediaRecorder ──────────────────────────────────────────────────────
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, { mimeType });
      } catch {
        try {
          recorder = new MediaRecorder(combined);
          mimeRef.current = recorder.mimeType || 'video/webm';
        } catch {
          setError('Не удалось запустить запись');
          cleanup();
          return;
        }
      }
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const elapsed = recordingTimeRef.current;
        cleanup();

        if (elapsed < 5) {
          setError('Запись слишком короткая — должна быть длиннее 5 секунд');
          setState('idle');
          return;
        }

        // Auto-download immediately — no "ready" banner needed
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const date = new Date()
          .toISOString()
          .slice(0, 19)
          .replace('T', '_')
          .replace(/:/g, '-');
        const ext = mimeRef.current.includes('mp4') ? 'mp4' : 'webm';
        a.download = `meet_${roomIdRef.current}_${date}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setState('idle');
      };

      recorder.onerror = () => {
        setError('Ошибка записи');
        setState('idle');
        cleanup();
      };

      recorder.start(1000);
      setState('recording');
      setRecordingTime(0);
      recordingTimeRef.current = 0;

      timerRef.current = window.setInterval(() => {
        setRecordingTime((t) => {
          recordingTimeRef.current = t + 1;
          return t + 1;
        });
      }, 1000);
    },
    [downloadUrl, cleanup]
  );

  const stopRecording = useCallback((roomId: string) => {
    roomIdRef.current = roomId;
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }
  }, []);

  const download = useCallback(
    (roomId: string) => {
      if (!downloadUrl) return;
      const a = document.createElement('a');
      a.href = downloadUrl;
      const date = new Date()
        .toISOString()
        .slice(0, 19)
        .replace('T', '_')
        .replace(/:/g, '-');
      const ext = mimeRef.current.includes('mp4') ? 'mp4' : 'webm';
      a.download = `meet_${roomId}_${date}.${ext}`;
      a.click();
    },
    [downloadUrl]
  );

  const dismiss = useCallback(() => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setState('idle');
    setError(null);
  }, [downloadUrl]);

  return {
    recorderState: state,
    recordingTime,
    downloadUrl,
    error,
    startRecording,
    stopRecording,
    download,
    dismiss,
  };
}