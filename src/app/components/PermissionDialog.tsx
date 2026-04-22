import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Button,
  Alert,
} from '@mui/material';
import { Videocam, Mic } from '@mui/icons-material';

interface PermissionDialogProps {
  open: boolean;
  onGranted: () => void;
  onDenied: () => void;
  roomId?: string; // When set, shows "You're joining room X" context
}

export function PermissionDialog({
  open,
  onGranted,
  onDenied,
  roomId,
}: PermissionDialogProps) {
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [availableDevices, setAvailableDevices] = useState<{
    hasVideo: boolean;
    hasAudio: boolean;
  }>({ hasVideo: true, hasAudio: true });

  // Check available devices when dialog opens
  useEffect(() => {
    if (open) {
      checkDevices();
    }
  }, [open]);

  const checkDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasVideo = devices.some((d) => d.kind === 'videoinput');
      const hasAudio = devices.some((d) => d.kind === 'audioinput');
      setAvailableDevices({ hasVideo, hasAudio });
    } catch (err) {
      console.error('Error checking devices:', err);
    }
  };

  const requestPermissions = async () => {
    setRequesting(true);
    setError('');

    try {
      // Clear any saved invalid device IDs
      localStorage.removeItem('selectedVideoDevice');
      localStorage.removeItem('selectedAudioDevice');
      localStorage.removeItem('selectedOutputDevice');

      let videoStream: MediaStream | null = null;
      let audioStream: MediaStream | null = null;
      let hasVideo = false;
      let hasAudio = false;

      // Try to get video first
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        hasVideo = true;
      } catch (videoErr: any) {
        console.warn('Video not available:', videoErr.name);
        // Video not available, continue without it
      }

      // Try to get audio
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true,
        });
        hasAudio = true;
      } catch (audioErr: any) {
        console.warn('Audio not available:', audioErr.name);
      }

      // Stop streams immediately, we just needed permissions
      if (videoStream) {
        videoStream.getTracks().forEach((track) => track.stop());
      }
      if (audioStream) {
        audioStream.getTracks().forEach((track) => track.stop());
      }

      // Update available devices
      setAvailableDevices({ hasVideo, hasAudio });

      // Check if we got at least one
      if (!hasVideo && !hasAudio) {
        throw new Error('Ни камера, ни микрофон не доступны');
      }

      onGranted();
    } catch (err: any) {
      console.error('Permission denied:', err);

      let errorMessage = 'Не удалось получить доступ к устройствам.';

      if (err.name === 'NotAllowedError') {
        errorMessage = 'Доступ запрещен. Разрешите использование устройств в настройках браузера.';
      } else if (err.name === 'NotFoundError') {
        errorMessage = 'Устройства не найдены. Подключите хотя бы микрофон или камеру.';
      } else if (err.name === 'NotReadableError') {
        errorMessage = 'Устройство уже используется другим приложением.';
      } else if (err.message) {
        errorMessage = err.message;
      }

      setError(errorMessage);
      setRequesting(false);
    }
  };

  return (
    <Dialog
      open={open}
      PaperProps={{
        sx: {
          backgroundColor: '#28292c',
          borderRadius: '8px',
          minWidth: '400px',
        },
      }}
    >
      <DialogTitle
        sx={{
          color: '#e8eaed',
          pb: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>
          {availableDevices.hasVideo && availableDevices.hasAudio
            ? 'Разрешения'
            : availableDevices.hasVideo
            ? 'Доступ к камере'
            : 'Доступ к микрофону'}
        </span>
        <Button
          onClick={onGranted}
          sx={{
            color: '#9aa0a6',
            textTransform: 'none',
            fontSize: '0.875rem',
            minWidth: 'auto',
            padding: '4px 8px',
            '&:hover': {
              backgroundColor: 'rgba(154, 160, 166, 0.08)',
            },
          }}
        >
          Пропустить
        </Button>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <div className="flex flex-col gap-4">
          {/* Room context when opening via direct link */}
          {roomId && (
            <div className="flex items-center gap-3 bg-[#3c4043] rounded-lg px-4 py-3">
              <div className="w-8 h-8 bg-[#8ab4f8] rounded-full flex items-center justify-center shrink-0">
                <Videocam sx={{ color: '#202124', fontSize: 18 }} />
              </div>
              <div>
                <div className="text-[#e8eaed] text-sm">Вас пригласили во встречу</div>
                <div className="text-[#8ab4f8] text-xs font-mono mt-0.5">{roomId}</div>
              </div>
            </div>
          )}

          <div className="text-[#9aa0a6] text-sm">
            {availableDevices.hasVideo && availableDevices.hasAudio
              ? 'Для видеозвонков требуется доступ к камере и микрофону'
              : availableDevices.hasVideo
              ? 'Для видеозвонков требуется доступ к камере'
              : availableDevices.hasAudio
              ? 'Для аудиозвонков требуется доступ к микрофону'
              : 'Подключите камеру или микрофон'}
          </div>

          <div className="flex flex-col gap-3">
            {availableDevices.hasVideo && (
              <div className="flex items-center gap-3 text-[#e8eaed]">
                <div className="w-10 h-10 bg-[#8ab4f8] rounded-full flex items-center justify-center">
                  <Videocam sx={{ color: '#202124' }} />
                </div>
                <span>Камера</span>
              </div>
            )}

            {availableDevices.hasAudio && (
              <div className="flex items-center gap-3 text-[#e8eaed]">
                <div className="w-10 h-10 bg-[#8ab4f8] rounded-full flex items-center justify-center">
                  <Mic sx={{ color: '#202124' }} />
                </div>
                <span>Микрофон</span>
              </div>
            )}

            {!availableDevices.hasVideo && !availableDevices.hasAudio && (
              <div className="text-[#9aa0a6] text-sm">
                Подключите камеру или микрофон для видеозвонков
              </div>
            )}
          </div>

          {error && (
            <Alert
              severity="error"
              sx={{
                backgroundColor: '#5f2120',
                color: '#f28b82',
                '& .MuiAlert-icon': {
                  color: '#f28b82',
                },
              }}
            >
              {error}
            </Alert>
          )}

          <div className="flex gap-2 mt-2">
            <Button
              fullWidth
              variant="outlined"
              onClick={onDenied}
              sx={{
                color: '#9aa0a6',
                borderColor: '#5f6368',
                textTransform: 'none',
                fontSize: '0.875rem',
                padding: '10px 24px',
                borderRadius: '4px',
                '&:hover': {
                  borderColor: '#9aa0a6',
                  backgroundColor: 'rgba(154, 160, 166, 0.08)',
                },
              }}
            >
              Отмена
            </Button>
            <Button
              fullWidth
              variant="contained"
              onClick={requestPermissions}
              disabled={requesting || (!availableDevices.hasVideo && !availableDevices.hasAudio)}
              sx={{
                backgroundColor: '#8ab4f8',
                color: '#202124',
                textTransform: 'none',
                fontSize: '0.875rem',
                padding: '10px 24px',
                borderRadius: '4px',
                '&:hover': {
                  backgroundColor: '#a8c7fa',
                },
                '&.Mui-disabled': {
                  backgroundColor: '#5f6368',
                  color: '#9aa0a6',
                },
              }}
            >
              {requesting
                ? 'Запрос...'
                : !availableDevices.hasVideo && !availableDevices.hasAudio
                ? 'Устройства не найдены'
                : 'Разрешить'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}