import { Play, Stop } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatClock, trackPeaks } from "../lib/music";

interface Props {
  buffer: AudioBuffer;
  /** The video length in seconds: the width of the box. */
  videoSeconds: number;
  /** The second of the track where the video starts. */
  start: number;
  onStartChange: (start: number) => void;
}

const WAVE_HEIGHT = 64;

/**
 * The track's waveform with a box the length of the video over it. Drag the
 * box, or click the waveform to center the box there, to choose the part of
 * the track that plays. Play previews that part.
 */
export function MusicPicker({ buffer, videoSeconds, start, onStartChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ pointerId: number; offset: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [playing, setPlaying] = useState<{ context: AudioContext; startedAt: number; from: number } | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const duration = buffer.duration;
  const span = Math.min(videoSeconds, duration);
  const latest = Math.max(0, duration - videoSeconds);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /** The waveform: one bar per device pixel column, mirrored around the middle. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(WAVE_HEIGHT * ratio);
    const context = canvas.getContext("2d")!;
    const peaks = trackPeaks(buffer, canvas.width);
    const middle = canvas.height / 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#6b7285";
    for (let x = 0; x < peaks.length; x++) {
      const half = Math.max(0.5, peaks[x] * middle * 0.95);
      context.fillRect(x, middle - half, 1, half * 2);
    }
  }, [buffer, width]);

  /** The preview's audio context, closed directly so it stops even while the picker is closing. */
  const contextRef = useRef<AudioContext | null>(null);
  const stop = () => {
    void contextRef.current?.close();
    contextRef.current = null;
    setPlaying(null);
    setPlayhead(null);
  };

  /** The preview stops when the track changes or the picker closes. */
  useEffect(() => () => {
    void contextRef.current?.close();
    contextRef.current = null;
  }, [buffer]);

  /** Moves the playhead while the preview plays, and stops at the end of the box. */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const at = playing.from + (playing.context.currentTime - playing.startedAt);
      if (at >= playing.from + span) {
        stop();
        return;
      }
      setPlayhead(at);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, span]);

  const play = () => {
    stop();
    const context = new AudioContext();
    contextRef.current = context;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0, start, span);
    setPlaying({ context, startedAt: context.currentTime, from: start });
  };

  const secondsAt = (clientX: number) => {
    const rect = hostRef.current!.getBoundingClientRect();
    return ((clientX - rect.left) / Math.max(1, rect.width)) * duration;
  };
  const clampStart = (value: number) => Math.min(latest, Math.max(0, value));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    stop();
    const at = secondsAt(event.clientX);
    const insideBox = at >= start && at <= start + span;
    /** A press outside the box centers the box there first; then the drag keeps the same grip. */
    const nextStart = insideBox ? start : clampStart(at - span / 2);
    if (!insideBox) onStartChange(nextStart);
    dragRef.current = { pointerId: event.pointerId, offset: at - nextStart };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onStartChange(clampStart(secondsAt(event.clientX) - drag.offset));
  };
  const endDrag = () => { dragRef.current = null; };

  return (
    <div className="music-picker">
      <div
        ref={hostRef}
        className="music-wave"
        style={{ height: WAVE_HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-help="Drag the box, or click the waveform, to choose the part of the track that plays"
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: WAVE_HEIGHT }} />
        <div className="music-window" style={{ left: `${(start / duration) * 100}%`, width: `${(span / duration) * 100}%` }} />
        {playhead !== null && <div className="music-playhead" style={{ left: `${(playhead / duration) * 100}%` }} />}
      </div>
      <div className="music-picker-info">
        <button
          type="button"
          className="button secondary music-play"
          onClick={() => (playing ? stop() : play())}
          data-help={playing ? "Stop the preview" : "Play the part of the track that the video uses"}
        >
          {playing ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}
          {playing ? "Stop" : "Play"}
        </button>
        <span>
          {formatClock(start)} – {formatClock(start + span)} of {formatClock(duration)}
          {duration < videoSeconds && ` · The track is shorter than the ${formatClock(videoSeconds)} video, so the music fades out early.`}
        </span>
      </div>
    </div>
  );
}
