import { useState } from 'react';
import { Button, TextField } from '@mui/material';
import { Videocam, Add, Link as LinkIcon } from '@mui/icons-material';

const validateRoomCode = (code: string): boolean =>
  /^[a-z0-9]{3,30}$/i.test(code);

const parseRoomCode = (raw: string): string => {
  const s = raw.trim();
  // full URL with /#/room/code
  const roomMatch = s.match(/#\/room\/([a-z0-9]+)/i);
  if (roomMatch) return roomMatch[1];
  // just the code
  return s.split(/[^a-z0-9]/i).find(p => validateRoomCode(p)) ?? s;
};

interface HomeProps {
  onNavigate: (roomId: string) => void;
}

export function Home({ onNavigate }: HomeProps) {
  const [roomInput, setRoomInput] = useState('');
  const [error, setError] = useState('');

  const handleCreateRoom = () => {
    const newRoomId = Math.random().toString(36).substring(2, 15);
    onNavigate(newRoomId);
  };

  const handleJoinWithCode = () => {
    const raw = roomInput.trim();
    if (!raw) {
      setError('Введите код встречи');
      return;
    }

    const code = parseRoomCode(raw);

    if (!validateRoomCode(code)) {
      setError('Неверный формат кода. Код должен содержать 3-30 символов (буквы и цифры)');
      return;
    }

    onNavigate(code);
    setError('');
  };

  return (
    <div className="size-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-10 max-w-sm w-full px-4">

        {/* Logo */}
        <div className="flex flex-col items-center gap-5">
          <div style={{
            width: 72,
            height: 72,
            borderRadius: 24,
            background: 'rgba(138,180,248,0.14)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid rgba(138,180,248,0.2)',
          }}>
            <Videocam sx={{ fontSize: 34, color: '#8ab4f8' }} />
          </div>
          <div className="flex flex-col items-center gap-1">
            <h1 className="text-[1.75rem] text-[#e8eaed]">Planaro <span style={{ color: '#8ab4f8' }}>Meet</span></h1>
            <p style={{ color: '#9aa0a6', fontSize: '0.875rem', textAlign: 'center' }}>
              Видеозвонки без лишних шагов
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-4 w-full">

          {/* Create */}
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={handleCreateRoom}
            sx={{
              backgroundColor: '#8ab4f8',
              color: '#202124',
              textTransform: 'none',
              fontSize: '0.9rem',
              fontWeight: 500,
              padding: '14px 24px',
              borderRadius: '50px',
              boxShadow: 'none',
              '&:hover': {
                backgroundColor: '#a8c7fa',
                boxShadow: 'none',
              },
            }}
          >
            Новая встреча
          </Button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div style={{ flex: 1, height: 1, background: '#3c4043' }} />
            <span style={{ color: '#5f6368', fontSize: '0.8rem' }}>или</span>
            <div style={{ flex: 1, height: 1, background: '#3c4043' }} />
          </div>

          {/* Join */}
          <div className="flex flex-col gap-2 w-full">
            <div className="flex gap-2">
              <TextField
                placeholder="Код или ссылка встречи"
                value={roomInput}
                onChange={(e) => {
                  setRoomInput(e.target.value);
                  setError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinWithCode()}
                variant="outlined"
                fullWidth
                error={!!error}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: '#28292c',
                    color: '#e8eaed',
                    borderRadius: '16px',
                    '& fieldset': {
                      borderColor: error ? '#ea4335' : '#3c4043',
                    },
                    '&:hover fieldset': {
                      borderColor: error ? '#ea4335' : '#5f6368',
                    },
                    '&.Mui-focused fieldset': {
                      borderColor: error ? '#ea4335' : '#8ab4f8',
                    },
                  },
                  '& .MuiOutlinedInput-input': {
                    padding: '14px 16px',
                  },
                  '& .MuiInputBase-input::placeholder': {
                    color: '#5f6368',
                    opacity: 1,
                  },
                }}
              />
              <Button
                variant="contained"
                onClick={handleJoinWithCode}
                disabled={!roomInput.trim()}
                sx={{
                  backgroundColor: roomInput.trim() ? 'rgba(138,180,248,0.15)' : 'rgba(255,255,255,0.05)',
                  color: roomInput.trim() ? '#8ab4f8' : '#5f6368',
                  textTransform: 'none',
                  fontWeight: 500,
                  padding: '14px 20px',
                  borderRadius: '16px',
                  boxShadow: 'none',
                  whiteSpace: 'nowrap',
                  minWidth: 'auto',
                  '&:hover': {
                    backgroundColor: 'rgba(138,180,248,0.22)',
                    boxShadow: 'none',
                  },
                  '&.Mui-disabled': {
                    color: '#5f6368',
                    backgroundColor: 'rgba(255,255,255,0.05)',
                  },
                }}
              >
                Войти
              </Button>
            </div>
            {error && (
              <div style={{ color: '#ea4335', fontSize: '0.8rem', paddingLeft: 4 }}>{error}</div>
            )}
          </div>
        </div>

        {/* Hint */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LinkIcon sx={{ fontSize: 16, color: '#5f6368' }} />
          <span style={{ color: '#5f6368', fontSize: '0.8rem' }}>
            Поделитесь{' '}
            <span
              onClick={() => { setRoomInput('testroom'); setError(''); }}
              style={{ color: '#5f6368', cursor: 'default' }}
            >
              ссылкой
            </span>
            , чтобы пригласить участников
          </span>
        </div>

      </div>
    </div>
  );
}