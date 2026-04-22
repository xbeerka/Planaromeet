import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Select,
  MenuItem,
  FormControl,
  Button,
} from '@mui/material';
import { Close, Videocam, Mic, VolumeUp } from '@mui/icons-material';

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  onDeviceChange?: (devices: {
    videoId?: string;
    audioId?: string;
    outputId?: string;
  }) => void;
}

interface MediaDeviceInfo {
  deviceId: string;
  label: string;
  kind: string;
}

export function Settings({ open, onClose, onDeviceChange }: SettingsProps) {
  const [name, setName] = useState('');
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideo, setSelectedVideo] = useState('');
  const [selectedAudio, setSelectedAudio] = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [hasCamera, setHasCamera] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (open) {
      // Reload name when dialog opens
      const savedName = localStorage.getItem('userName') || '';
      setName(savedName);
      loadDevices();
    }

    return () => {
      if (previewStream) {
        previewStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [open]);

  // Update preview when device changes
  useEffect(() => {
    if (!open) {
      if (previewStream) {
        previewStream.getTracks().forEach((track) => track.stop());
        setPreviewStream(null);
      }
      return;
    }

    const updatePreview = async () => {
      if (previewStream) {
        previewStream.getTracks().forEach((track) => track.stop());
      }

      // Only update if we have a camera
      if (!hasCamera) return;

      // Only update if we have a valid device ID
      if (selectedVideo && selectedVideo.trim() !== '') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { ideal: selectedVideo } },
            audio: false,
          });

          setPreviewStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } catch (error: any) {
          console.warn('Error updating preview with selected device:', error.name, error.message);
          // Try with default device
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
            setPreviewStream(stream);
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
            }
            // Update to first available device
            if (videoDevices.length > 0) {
              setSelectedVideo(videoDevices[0].deviceId);
            }
          } catch (fallbackError) {
            console.error('Error with fallback preview:', fallbackError);
            setHasCamera(false);
          }
        }
      } else if (!selectedVideo && videoDevices.length > 0) {
        // No device selected, use default
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
          setPreviewStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } catch (error) {
          console.error('Error starting preview:', error);
          setHasCamera(false);
        }
      }
    };

    if (open && hasCamera) {
      updatePreview();
    }
  }, [selectedVideo, open, videoDevices, hasCamera]);

  const loadDevices = async () => {
    try {
      // Request permissions separately (camera may not exist)
      let hasVideoPermission = false;
      let hasAudioPermission = false;

      try {
        // iOS Safari only registers cameras that have been accessed.
        // Request both facingModes so all cameras (front + rear) appear in enumerateDevices.
        const tryFacing = async (facingMode: string) => {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
            s.getTracks().forEach((t) => t.stop());
          } catch (_) {}
        };
        await tryFacing('user');
        await tryFacing('environment');

        // Fallback: plain video:true in case constraints above both failed
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          s.getTracks().forEach((t) => t.stop());
        } catch (_) {}

        hasVideoPermission = true;
      } catch (e) {
        console.warn('No video device available');
        setHasCamera(false);
      }

      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        audioStream.getTracks().forEach((track) => track.stop());
        hasAudioPermission = true;
      } catch (e) {
        console.warn('No audio device available');
      }

      const devices = await navigator.mediaDevices.enumerateDevices();

      const videos = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Камера ${devices.filter(x => x.kind === 'videoinput').indexOf(d) + 1}`,
          kind: d.kind,
        }))
        .reverse();

      const audios = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Микрофон ${devices.filter(x => x.kind === 'audioinput').indexOf(d) + 1}`,
          kind: d.kind,
        }));

      const outputs = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Динамик ${devices.filter(x => x.kind === 'audiooutput').indexOf(d) + 1}`,
          kind: d.kind,
        }));

      setVideoDevices(videos);
      setAudioDevices(audios);
      setOutputDevices(outputs);

      // Load saved preferences and validate they exist
      const savedVideo = localStorage.getItem('selectedVideoDevice');
      const savedAudio = localStorage.getItem('selectedAudioDevice');
      const savedOutput = localStorage.getItem('selectedOutputDevice');

      // Set video device (validate it exists)
      if (savedVideo && videos.find((d) => d.deviceId === savedVideo)) {
        setSelectedVideo(savedVideo);
      } else {
        // No saved preference — ask browser for the ideal front camera
        // (facingMode:'user' → standard portrait camera, not ultra-wide)
        let preferredId = videos[0]?.deviceId ?? '';
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'user' } },
            audio: false,
          });
          const track = s.getVideoTracks()[0];
          const detectedId = track?.getSettings().deviceId ?? '';
          track?.stop();
          if (detectedId && videos.find((d) => d.deviceId === detectedId)) {
            preferredId = detectedId;
          }
        } catch (_) {}
        if (preferredId) setSelectedVideo(preferredId);
        if (savedVideo) localStorage.removeItem('selectedVideoDevice');
      }

      // Set audio device (validate it exists)
      if (savedAudio && audios.find((d) => d.deviceId === savedAudio)) {
        setSelectedAudio(savedAudio);
      } else if (audios.length > 0) {
        setSelectedAudio(audios[0].deviceId);
        if (savedAudio) {
          // Clear invalid saved device
          localStorage.removeItem('selectedAudioDevice');
        }
      }

      // Set output device (validate it exists)
      if (savedOutput && outputs.find((d) => d.deviceId === savedOutput)) {
        setSelectedOutput(savedOutput);
      } else if (outputs.length > 0) {
        setSelectedOutput(outputs[0].deviceId);
        if (savedOutput) {
          // Clear invalid saved device
          localStorage.removeItem('selectedOutputDevice');
        }
      }
    } catch (error) {
      console.error('Error loading devices:', error);
    }
  };

  const handleSave = () => {
    if (name.trim()) {
      localStorage.setItem('userName', name.trim());
    }

    localStorage.setItem('selectedVideoDevice', selectedVideo);
    localStorage.setItem('selectedAudioDevice', selectedAudio);
    localStorage.setItem('selectedOutputDevice', selectedOutput);

    if (onDeviceChange) {
      onDeviceChange({
        videoId: selectedVideo,
        audioId: selectedAudio,
        outputId: selectedOutput,
      });
    }

    // Stop preview stream
    if (previewStream) {
      previewStream.getTracks().forEach((track) => track.stop());
      setPreviewStream(null);
    }

    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          backgroundColor: '#28292c',
          borderRadius: '8px',
        },
      }}
    >
      <DialogTitle
        sx={{
          color: '#e8eaed',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 2,
        }}
      >
        Настройки
        <IconButton onClick={onClose} sx={{ color: '#9aa0a6' }}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <div className="flex flex-col gap-6">
          {/* Name */}
          <div>
            <div className="text-[#9aa0a6] text-sm mb-2">Имя</div>
            <TextField
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Введите ваше имя"
              variant="outlined"
              sx={{
                '& .MuiOutlinedInput-root': {
                  backgroundColor: '#3c4043',
                  color: '#e8eaed',
                  borderRadius: '4px',
                  '& fieldset': {
                    borderColor: '#5f6368',
                  },
                  '&:hover fieldset': {
                    borderColor: '#8ab4f8',
                  },
                  '&.Mui-focused fieldset': {
                    borderColor: '#8ab4f8',
                  },
                },
                '& .MuiInputBase-input': {
                  padding: '12px 14px',
                },
              }}
            />
          </div>

          {/* Video Preview */}
          {hasCamera && (
            <div>
              <div className="text-[#9aa0a6] text-sm mb-2">Предпросмотр камеры</div>
              <div className="relative bg-[#000] rounded-lg overflow-hidden aspect-video">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover scale-x-[-1]"
                />
              </div>
            </div>
          )}

          {/* Video Device */}
          {hasCamera && videoDevices.length > 0 && (
            <div>
              <div className="text-[#9aa0a6] text-sm mb-2 flex items-center gap-2">
                <Videocam fontSize="small" />
                Камера
              </div>
              <FormControl fullWidth>
                <Select
                  value={selectedVideo}
                  onChange={(e) => setSelectedVideo(e.target.value)}
                  sx={{
                    backgroundColor: '#3c4043',
                    color: '#e8eaed',
                    borderRadius: '4px',
                    '& .MuiOutlinedInput-notchedOutline': {
                      borderColor: '#5f6368',
                    },
                    '&:hover .MuiOutlinedInput-notchedOutline': {
                      borderColor: '#8ab4f8',
                    },
                    '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                      borderColor: '#8ab4f8',
                    },
                    '& .MuiSelect-icon': {
                      color: '#9aa0a6',
                    },
                  }}
                  MenuProps={{
                    PaperProps: {
                      sx: {
                        backgroundColor: '#3c4043',
                        '& .MuiMenuItem-root': {
                          color: '#e8eaed',
                          '&:hover': {
                            backgroundColor: '#5f6368',
                          },
                          '&.Mui-selected': {
                            backgroundColor: '#5f6368',
                            '&:hover': {
                              backgroundColor: '#5f6368',
                            },
                          },
                        },
                      },
                    },
                  }}
                >
                  {videoDevices.map((device) => (
                    <MenuItem key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </div>
          )}

          {/* Audio Device */}
          <div>
            <div className="text-[#9aa0a6] text-sm mb-2 flex items-center gap-2">
              <Mic fontSize="small" />
              Микрофон
            </div>
            <FormControl fullWidth>
              <Select
                value={selectedAudio}
                onChange={(e) => setSelectedAudio(e.target.value)}
                sx={{
                  backgroundColor: '#3c4043',
                  color: '#e8eaed',
                  borderRadius: '4px',
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#5f6368',
                  },
                  '&:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#8ab4f8',
                  },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#8ab4f8',
                  },
                  '& .MuiSelect-icon': {
                    color: '#9aa0a6',
                  },
                }}
                MenuProps={{
                  PaperProps: {
                    sx: {
                      backgroundColor: '#3c4043',
                      '& .MuiMenuItem-root': {
                        color: '#e8eaed',
                        '&:hover': {
                          backgroundColor: '#5f6368',
                        },
                        '&.Mui-selected': {
                          backgroundColor: '#5f6368',
                          '&:hover': {
                            backgroundColor: '#5f6368',
                          },
                        },
                      },
                    },
                  },
                }}
              >
                {audioDevices.map((device) => (
                  <MenuItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </div>

          {/* Output Device */}
          <div>
            <div className="text-[#9aa0a6] text-sm mb-2 flex items-center gap-2">
              <VolumeUp fontSize="small" />
              Динамики
            </div>
            <FormControl fullWidth>
              <Select
                value={selectedOutput}
                onChange={(e) => setSelectedOutput(e.target.value)}
                sx={{
                  backgroundColor: '#3c4043',
                  color: '#e8eaed',
                  borderRadius: '4px',
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#5f6368',
                  },
                  '&:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#8ab4f8',
                  },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                    borderColor: '#8ab4f8',
                  },
                  '& .MuiSelect-icon': {
                    color: '#9aa0a6',
                  },
                }}
                MenuProps={{
                  PaperProps: {
                    sx: {
                      backgroundColor: '#3c4043',
                      '& .MuiMenuItem-root': {
                        color: '#e8eaed',
                        '&:hover': {
                          backgroundColor: '#5f6368',
                        },
                        '&.Mui-selected': {
                          backgroundColor: '#5f6368',
                          '&:hover': {
                            backgroundColor: '#5f6368',
                          },
                        },
                      },
                    },
                  },
                }}
              >
                {outputDevices.map((device) => (
                  <MenuItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </div>

          {/* Save Button */}
          <Button
            fullWidth
            variant="contained"
            onClick={handleSave}
            sx={{
              backgroundColor: '#8ab4f8',
              color: '#202124',
              textTransform: 'none',
              fontSize: '0.875rem',
              padding: '10px 24px',
              borderRadius: '4px',
              mt: 2,
              '&:hover': {
                backgroundColor: '#a8c7fa',
              },
            }}
          >
            Сохранить
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}