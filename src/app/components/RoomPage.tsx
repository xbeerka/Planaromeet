import { useState, useEffect } from 'react';
import { PreJoinLobby } from './PreJoinLobby';
import { MeetingRoom } from './MeetingRoom';

const SESSION_PREFIX = 'meeting_confirmed_';

type RoomView = 'lobby' | 'meeting';

const getInitialView = (roomId: string): RoomView => {
  try {
    return sessionStorage.getItem(SESSION_PREFIX + roomId) === '1' ? 'meeting' : 'lobby';
  } catch {
    return 'lobby';
  }
};

interface RoomPageProps {
  roomId: string;
  onLeave: () => void;
}

export function RoomPage({ roomId, onLeave }: RoomPageProps) {
  const [view, setView] = useState<RoomView>(() => getInitialView(roomId));

  // Сбрасываем вид если roomId поменялся
  useEffect(() => {
    setView(getInitialView(roomId));
  }, [roomId]);

  const handleJoinConfirmed = () => {
    try { sessionStorage.setItem(SESSION_PREFIX + roomId, '1'); } catch {}
    setView('meeting');
  };

  const handleCancel = () => {
    onLeave();
  };

  const handleLeave = () => {
    try { sessionStorage.removeItem(SESSION_PREFIX + roomId); } catch {}
    onLeave();
  };

  if (view === 'lobby') {
    return (
      <PreJoinLobby
        roomId={roomId}
        onJoin={handleJoinConfirmed}
        onCancel={handleCancel}
      />
    );
  }

  return <MeetingRoom roomId={roomId} onLeave={handleLeave} />;
}
