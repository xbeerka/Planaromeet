import { useState, useEffect, useCallback } from 'react';
import { RootLayout } from './components/RootLayout';
import { Home } from './components/Home';
import { RoomPage } from './components/RoomPage';

function parseRoomId(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash || '';
  // Поддержка форматов: "#/room/abc", "#room/abc", "#/abc" не подходит
  const match = hash.match(/#\/?room\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export default function App() {
  // Синхронно читаем hash при первом рендере, чтобы не мигать Home
  const [roomId, setRoomId] = useState<string | null>(() => parseRoomId());

  useEffect(() => {
    const sync = () => setRoomId(parseRoomId());
    // На случай, если hash появился между инициализацией useState и этим эффектом
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const goToRoom = useCallback((id: string) => {
    window.location.hash = `/room/${id}`;
    setRoomId(id);
  }, []);

  const goHome = useCallback(() => {
    window.location.hash = '/';
    setRoomId(null);
  }, []);

  return (
    <RootLayout>
      {roomId ? (
        <RoomPage roomId={roomId} onLeave={goHome} />
      ) : (
        <Home onNavigate={goToRoom} />
      )}
    </RootLayout>
  );
}
