import { useEffect, useRef, useState } from 'react';

interface AudioVisualizerProps {
  stream: MediaStream | null;
  isEnabled: boolean;
}

export function AudioVisualizer({ stream, isEnabled }: AudioVisualizerProps) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    // Guard: need a stream with at least one audio track
    if (!stream || !isEnabled || stream.getAudioTracks().length === 0) {
      setIsSpeaking(false);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }

    let audioContext: AudioContext | null = null;
    let microphone: MediaStreamAudioSourceNode | null = null;
    let analyzer: AnalyserNode | null = null;

    try {
      audioContext = new AudioContext();
      analyzer = audioContext.createAnalyser();
      microphone = audioContext.createMediaStreamSource(stream);
      analyzer.fftSize = 256;
      microphone.connect(analyzer);
      analyzerRef.current = analyzer;

      const dataArray = new Uint8Array(analyzer.frequencyBinCount);

      const checkAudioLevel = () => {
        if (!analyzerRef.current) return;
        analyzerRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        setIsSpeaking(average > 10);
        animationRef.current = requestAnimationFrame(checkAudioLevel);
      };

      checkAudioLevel();
    } catch (err) {
      console.warn('[AudioVisualizer] Failed to setup audio analysis:', err);
      setIsSpeaking(false);
    }

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      try { microphone?.disconnect(); } catch {}
      try { analyzer?.disconnect(); } catch {}
      try { audioContext?.close(); } catch {}
      analyzerRef.current = null;
    };
  }, [stream, isEnabled]);

  if (!isSpeaking || !isEnabled) return null;

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-end gap-0.5 h-4 pointer-events-none">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="w-1 bg-[#34a853] rounded-full"
          style={{
            height: `${30 + Math.random() * 70}%`,
            animation: `pulse 400ms ease-in-out infinite`,
            animationDelay: `${i * 100}ms`,
          }}
        />
      ))}
    </div>
  );
}