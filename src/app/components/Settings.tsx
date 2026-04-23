import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  IconButton,
  TextField,
  Select,
  MenuItem,
  FormControl,
  Button,
  Typography,
  Box,
  CircularProgress,
} from '@mui/material';
import { Close, Videocam, Mic, VolumeUp, Person, VideocamOff } from '@mui/icons-material';

/* ─── shared select menu style ─────────────────────────────────────────────── */
const menuProps = {
  PaperProps: {
    sx: {
      mt: '6px',
      backgroundColor: '#28292c',
      backgroundImage: 'none',
      borderRadius: '16px',
      border: '1px solid #3c4043',
      boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
      '& .MuiList-root': { p: '6px' },
      '& .MuiMenuItem-root': {
        color: '#e8eaed',
        borderRadius: '10px',
        fontSize: '0.875rem',
        minHeight: 44,
        '&:hover': { backgroundColor: 'rgba(138,180,248,0.10)' },
        '&.Mui-selected': {
          backgroundColor: 'rgba(138,180,248,0.15)',
          color: '#8ab4f8',
          fontWeight: 500,
          '&:hover': { backgroundColor: 'rgba(138,180,248,0.22)' },
        },
      },
    },
  },
};

/* ─── shared select sx ─────────────────────────────────────────────────────── */
const selectSx = {
  backgroundColor: '#28292c',
  color: '#e8eaed',
  borderRadius: '16px',
  fontSize: '0.875rem',
  '& .MuiOutlinedInput-notchedOutline': { borderColor: '#3c4043', borderRadius: '16px' },
  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#5f6368' },
  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#8ab4f8', borderWidth: 2 },
  '& .MuiSelect-icon': { color: '#9aa0a6' },
  '& .MuiSelect-select': { padding: '14px 16px' },
};

/* ─── reusable setting block ────────────────────────────────────────────────── */
function SettingRow({
  icon, label, value, devices, onChange,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  devices: { deviceId: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2" style={{ color: '#9aa0a6', fontSize: '0.8rem' }}>
        {icon}
        {label}
      </div>
      <FormControl fullWidth>
        <Select value={value} onChange={(e) => onChange(e.target.value as string)}
          sx={selectSx} MenuProps={menuProps}>
          {devices.map((d) => (
            <MenuItem key={d.deviceId} value={d.deviceId}>{d.label}</MenuItem>
          ))}
        </Select>
      </FormControl>
    </div>
  );
}

/* ─── main component ────────────────────────────────────────────────────────── */
interface SettingsProps {
  open: boolean;
  onClose: () => void;
  onDeviceChange?: (devices: { videoId?: string; audioId?: string; outputId?: string }) => void;
}

interface DeviceInfo { deviceId: string; label: string; kind: string; }

export function Settings({ open, onClose, onDeviceChange }: SettingsProps) {
  const [name,           setName]           = useState('');
  const [videoDevices,   setVideoDevices]   = useState<DeviceInfo[]>([]);
  const [audioDevices,   setAudioDevices]   = useState<DeviceInfo[]>([]);
  const [outputDevices,  setOutputDevices]  = useState<DeviceInfo[]>([]);
  const [selectedVideo,  setSelectedVideo]  = useState('');
  const [selectedAudio,  setSelectedAudio]  = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');
  const [hasCamera,      setHasCamera]      = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [streamReady,    setStreamReady]    = useState(false);

  const videoRef         = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const initialDevices   = useRef({ video: '', audio: '', output: '' });

  /* helpers */
  const stopPreview = () => {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    previewStreamRef.current = null;
    setStreamReady(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const loadDevices = async () => {
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((d) => d.kind === 'videoinput' && d.label)) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: true });
          s.getTracks().forEach((t) => t.stop());
        } catch {
          try { const s = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); s.getTracks().forEach((t) => t.stop()); } catch {}
        }
        devices = await navigator.mediaDevices.enumerateDevices();
      }

      const videos  = devices.filter((d) => d.kind === 'videoinput') .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Камера ${i+1}`,   kind: d.kind })).reverse();
      const audios  = devices.filter((d) => d.kind === 'audioinput') .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Микрофон ${i+1}`, kind: d.kind }));
      const outputs = devices.filter((d) => d.kind === 'audiooutput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Динамик ${i+1}`,  kind: d.kind }));

      setVideoDevices(videos); setAudioDevices(audios); setOutputDevices(outputs);
      if (!videos.length) setHasCamera(false);

      const sv = localStorage.getItem('selectedVideoDevice')  ?? '';
      const sa = localStorage.getItem('selectedAudioDevice')  ?? '';
      const so = localStorage.getItem('selectedOutputDevice') ?? '';

      const rv = videos.find((d)  => d.deviceId === sv) ? sv : videos[0]?.deviceId  ?? '';
      const ra = audios.find((d)  => d.deviceId === sa) ? sa : audios[0]?.deviceId  ?? '';
      const ro = outputs.find((d) => d.deviceId === so) ? so : outputs[0]?.deviceId ?? '';

      initialDevices.current = { video: rv, audio: ra, output: ro };
      setSelectedVideo(rv); setSelectedAudio(ra); setSelectedOutput(ro);
    } catch (e) { console.error(e); }
  };

  /* open/close */
  useEffect(() => {
    if (open) {
      setHasCamera(true);
      setStreamReady(false);
      setName(localStorage.getItem('userName') || '');
      loadDevices();
    } else {
      stopPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* preview stream */
  useEffect(() => {
    if (!open || !hasCamera || !selectedVideo) return;
    let cancelled = false;
    setPreviewLoading(true);
    setStreamReady(false);

    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    previewStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { ideal: selectedVideo } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        previewStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setStreamReady(true);
        setPreviewLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        console.warn('Preview:', err.name);
        setHasCamera(false);
        setPreviewLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setPreviewLoading(false);
    };
  }, [selectedVideo, open, hasCamera]);

  /* save / cancel */
  const handleSave = () => {
    if (name.trim()) localStorage.setItem('userName', name.trim());
    localStorage.setItem('selectedVideoDevice',  selectedVideo);
    localStorage.setItem('selectedAudioDevice',  selectedAudio);
    localStorage.setItem('selectedOutputDevice', selectedOutput);
    stopPreview();
    onDeviceChange?.({ videoId: selectedVideo, audioId: selectedAudio, outputId: selectedOutput });
    onClose();
  };

  const handleCancel = () => {
    stopPreview();
    setSelectedVideo(initialDevices.current.video);
    setSelectedAudio(initialDevices.current.audio);
    setSelectedOutput(initialDevices.current.output);
    onClose();
  };

  const activeLabel = videoDevices.find((d) => d.deviceId === selectedVideo)?.label ?? '';

  return (
    <Dialog
      open={open}
      onClose={handleCancel}
      maxWidth="xs"
      fullWidth
      slotProps={{ backdrop: { style: { backgroundColor: 'rgba(0,0,0,0.65)' } } }}
      PaperProps={{
        elevation: 0,
        sx: {
          backgroundColor: '#202124',
          backgroundImage: 'none',
          borderRadius: '28px',
          border: '1px solid #3c4043',
          m: { xs: 2, sm: 3 },
          overflow: 'hidden',
        },
      }}
    >
      {/* title bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, pt: 3, pb: 0 }}>
        <Typography sx={{ color: '#e8eaed', fontSize: '1.25rem', fontWeight: 400 }}>
          Настройки
        </Typography>
        <IconButton onClick={handleCancel} size="small" sx={{
          color: '#9aa0a6',
          '&:hover': { backgroundColor: 'rgba(255,255,255,0.08)', color: '#e8eaed' },
        }}>
          <Close fontSize="small" />
        </IconButton>
      </Box>

      <DialogContent sx={{ px: 3, pt: 3, pb: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* name */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2" style={{ color: '#9aa0a6', fontSize: '0.8rem' }}>
            <Person sx={{ fontSize: '1rem' }} />
            Отображаемое имя
          </div>
          <TextField
            fullWidth value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Введите ваше имя" variant="outlined"
            sx={{
              '& .MuiOutlinedInput-root': {
                backgroundColor: '#28292c',
                color: '#e8eaed',
                borderRadius: '16px',
                '& fieldset': { borderColor: '#3c4043', borderRadius: '16px' },
                '&:hover fieldset': { borderColor: '#5f6368' },
                '&.Mui-focused fieldset': { borderColor: '#8ab4f8', borderWidth: 2 },
              },
              '& .MuiOutlinedInput-input': { padding: '14px 16px' },
              '& input::placeholder': { color: '#5f6368', opacity: 1 },
            }}
          />
        </div>

        {/* camera preview */}
        {hasCamera && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2" style={{ color: '#9aa0a6', fontSize: '0.8rem' }}>
              <Videocam sx={{ fontSize: '1rem' }} />
              Предпросмотр камеры
            </div>
            <div style={{
              position: 'relative', backgroundColor: '#000',
              borderRadius: 16, overflow: 'hidden', aspectRatio: '16/9',
            }}>
              <video ref={videoRef} autoPlay playsInline muted
                style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: 'block' }}
              />

              {/* placeholder */}
              {!previewLoading && !streamReady && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                  backgroundColor: '#28292c',
                }}>
                  <VideocamOff sx={{ fontSize: '1.75rem', color: '#5f6368' }} />
                  <span style={{ color: '#5f6368', fontSize: '0.78rem' }}>Нет изображения</span>
                </div>
              )}

              {/* spinner */}
              {previewLoading && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: 'rgba(0,0,0,0.5)',
                }}>
                  <CircularProgress size={28} thickness={3.5} sx={{ color: '#8ab4f8' }} />
                </div>
              )}

              {/* device chip */}
              {!previewLoading && streamReady && activeLabel && (
                <div style={{
                  position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
                  backgroundColor: 'rgba(0,0,0,0.55)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)',
                  borderRadius: 20, padding: '4px 14px',
                  maxWidth: '80%',
                }}>
                  <span style={{ color: '#fff', fontSize: '0.72rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
                    {activeLabel}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* camera select */}
        {hasCamera && videoDevices.length > 0 && (
          <SettingRow icon={<Videocam sx={{ fontSize: '1rem' }} />} label="Камера"
            value={selectedVideo} devices={videoDevices} onChange={setSelectedVideo} />
        )}

        {/* mic */}
        {audioDevices.length > 0 && (
          <SettingRow icon={<Mic sx={{ fontSize: '1rem' }} />} label="Микрофон"
            value={selectedAudio} devices={audioDevices} onChange={setSelectedAudio} />
        )}

        {/* speaker */}
        {outputDevices.length > 0 && (
          <SettingRow icon={<VolumeUp sx={{ fontSize: '1rem' }} />} label="Динамики"
            value={selectedOutput} devices={outputDevices} onChange={setSelectedOutput} />
        )}
      </DialogContent>

      {/* actions */}
      <DialogActions sx={{ px: 3, py: 3, gap: 1.5, flexDirection: 'column' }}>
        {/* save — primary pill, full-width like Home page */}
        <Button
          fullWidth variant="contained" onClick={handleSave}
          sx={{
            backgroundColor: '#8ab4f8',
            color: '#202124',
            textTransform: 'none',
            fontSize: '0.9rem',
            fontWeight: 500,
            padding: '14px 24px',
            borderRadius: '50px',
            boxShadow: 'none',
            '&:hover': { backgroundColor: '#a8c7fa', boxShadow: 'none' },
          }}
        >
          Сохранить
        </Button>
      </DialogActions>
    </Dialog>
  );
}