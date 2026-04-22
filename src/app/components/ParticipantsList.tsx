import { useState } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { Close, Mic, MicOff, Videocam, VideocamOff, Search } from '@mui/icons-material';

interface Participant {
  id: string;
  name: string;
  isLocal: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  stream?: MediaStream;
}

interface ParticipantsListProps {
  participants: Participant[];
  onClose: () => void;
  onForceControl?: (participantId: string, audioEnabled: boolean, videoEnabled: boolean) => void;
}

// Generates a stable color from a string
function nameToColor(name: string): string {
  const colors = [
    '#5c6bc0', '#7e57c2', '#ec407a', '#26a69a',
    '#42a5f5', '#66bb6a', '#ef5350', '#ab47bc',
    '#26c6da', '#ff7043',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function ParticipantRow({
  participant,
  onForceControl,
}: {
  participant: Participant;
  onForceControl?: (id: string, audio: boolean, video: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const avatarColor = nameToColor(participant.name || '?');
  const initial = (participant.name || '?').charAt(0).toUpperCase();

  const handleToggleMic = () => {
    onForceControl?.(participant.id, !participant.audioEnabled, participant.videoEnabled);
  };

  const handleToggleCamera = () => {
    onForceControl?.(participant.id, participant.audioEnabled, !participant.videoEnabled);
  };

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 mx-2 rounded-xl transition-colors cursor-default"
      style={{ background: hovered ? 'rgba(255,255,255,0.06)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Avatar */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
        style={{ background: avatarColor }}
      >
        <span className="text-white" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
          {initial}
        </span>
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className="text-[#e8eaed] truncate" style={{ fontSize: '0.875rem' }}>
          {participant.name || 'Участник'}
        </div>
        {participant.isLocal && (
          <div className="text-[#9aa0a6]" style={{ fontSize: '0.72rem' }}>Вы</div>
        )}
      </div>

      {/* Controls — only for remote participants, appear on hover or when media is off */}
      {!participant.isLocal && (hovered || !participant.audioEnabled || !participant.videoEnabled) && (
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip
            title={participant.audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
            placement="top"
          >
            <IconButton
              size="small"
              onClick={handleToggleMic}
              sx={{
                width: 30,
                height: 30,
                color: participant.audioEnabled ? '#9aa0a6' : '#ea4335',
                background: participant.audioEnabled ? 'transparent' : 'rgba(234,67,53,0.12)',
                '&:hover': {
                  background: participant.audioEnabled
                    ? 'rgba(255,255,255,0.1)'
                    : 'rgba(234,67,53,0.22)',
                },
              }}
            >
              {participant.audioEnabled
                ? <Mic sx={{ fontSize: 16 }} />
                : <MicOff sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>

          <Tooltip
            title={participant.videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
            placement="top"
          >
            <IconButton
              size="small"
              onClick={handleToggleCamera}
              sx={{
                width: 30,
                height: 30,
                color: participant.videoEnabled ? '#9aa0a6' : '#ea4335',
                background: participant.videoEnabled ? 'transparent' : 'rgba(234,67,53,0.12)',
                '&:hover': {
                  background: participant.videoEnabled
                    ? 'rgba(255,255,255,0.1)'
                    : 'rgba(234,67,53,0.22)',
                },
              }}
            >
              {participant.videoEnabled
                ? <Videocam sx={{ fontSize: 16 }} />
                : <VideocamOff sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

export function ParticipantsList({ participants, onClose, onForceControl }: ParticipantsListProps) {
  const [search, setSearch] = useState('');

  const filtered = participants.filter((p) =>
    (p.name || '').toLowerCase().includes(search.toLowerCase())
  );

  // Local participant first, then sorted alphabetically
  const sorted = [...filtered].sort((a, b) => {
    if (a.isLocal) return -1;
    if (b.isLocal) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return (
    <div className="w-full h-full bg-[#28292c] rounded-xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-[#e8eaed]" style={{ fontWeight: 500 }}>Участники</span>
          <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-white/15 text-[#e8eaed] text-xs flex items-center justify-center">
            {participants.length}
          </span>
        </div>
        <IconButton onClick={onClose} size="small" sx={{ color: '#9aa0a6', '&:hover': { color: '#e8eaed' } }}>
          <Close fontSize="small" />
        </IconButton>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div
          className="flex items-center gap-2 px-3 rounded-xl"
          style={{
            background: 'rgba(255,255,255,0.07)',
            
            height: 36,
          }}
        >
          <Search sx={{ fontSize: 16, color: '#9aa0a6', flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск участников"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#e8eaed',
              fontSize: '0.82rem',
              width: '100%',
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#9aa0a6', lineHeight: 1 }}
            >
              <Close sx={{ fontSize: 14 }} />
            </button>
          )}
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 16px' }} />

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2" style={{ scrollbarWidth: 'thin', scrollbarColor: '#5f6368 transparent' }}>
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[#9aa0a6]" style={{ fontSize: '0.82rem' }}>
            <Search sx={{ fontSize: 32, opacity: 0.4 }} />
            Не найдено
          </div>
        ) : (
          sorted.map((participant) => (
            <ParticipantRow
              key={participant.id}
              participant={participant}
              onForceControl={onForceControl}
            />
          ))
        )}
      </div>
    </div>
  );
}