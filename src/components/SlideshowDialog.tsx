import { FilmStrip, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { cancelAiRequest } from "../lib/ai";
import { formatMegabytes } from "../lib/models";
import { AUDIO_FILE_EXTENSIONS, decodeAudioFile, decodeTrack, downloadTrack, listTracks, type TrackInfo } from "../lib/music";
import type { SlideshowOptions } from "../lib/slideshowVideo";
import { MusicPicker } from "./MusicPicker";

const MUSIC_KEY = "imagesage.slideshow-music";
/** A music choice that is an audio file on this PC: this prefix, then its path. */
const FILE_PREFIX = "file:";
/** The list item that opens the file picker; it is never the chosen music itself. */
const CHOOSE_FILE = "choose-file";
const fileNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

interface Props {
  /** The default title: the image's name. */
  defaultTitle: string;
  /** How long the video runs, in seconds: the music box is this long. */
  videoSeconds: number;
  onCancel: () => void;
  onExport: (options: SlideshowOptions) => void;
}

/** A track being made ready: downloaded (`progress` 0 to 1), then decoded (`progress` null). */
type TrackLoad = { id: string; progress: number | null; requestId: string };

/** Settings for the video slideshow: the title in its title box, and the music. */
export function SlideshowDialog({ defaultTitle, videoSeconds, onCancel, onExport }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [trackId, setTrackId] = useState("");
  const [load, setLoad] = useState<TrackLoad | null>(null);
  const [music, setMusic] = useState<{ id: string; buffer: AudioBuffer } | null>(null);
  const [start, setStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The audio file from this PC that the list offers, once one was chosen. */
  const [customFile, setCustomFile] = useState<string | null>(null);
  /** The track the user picked last; a slower load of an earlier pick must not replace it. */
  const pickRef = useRef("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  /** Opens the file picker; the chosen file becomes the music, and Cancel keeps the music as it was. */
  const chooseFile = async () => {
    const path = await open({
      title: "Choose music for the video",
      multiple: false,
      directory: false,
      filters: [{ name: "Audio", extensions: AUDIO_FILE_EXTENSIONS }]
    }).catch(() => null);
    if (typeof path === "string") await pickTrack(`${FILE_PREFIX}${path}`, tracks);
  };

  const pickTrack = async (id: string, list: TrackInfo[]) => {
    if (id === CHOOSE_FILE) {
      await chooseFile();
      return;
    }
    if (id.startsWith(FILE_PREFIX)) setCustomFile(id.slice(FILE_PREFIX.length));
    pickRef.current = id;
    setTrackId(id);
    setMusic(null);
    setStart(0);
    setError(null);
    try { localStorage.setItem(MUSIC_KEY, id); } catch { /* Remembering is a convenience only. */ }
    if (!id) return;
    const requestId = crypto.randomUUID();
    if (id.startsWith(FILE_PREFIX)) {
      try {
        setLoad({ id, progress: null, requestId });
        const buffer = await decodeAudioFile(id.slice(FILE_PREFIX.length));
        if (pickRef.current === id) setMusic({ id, buffer });
      } catch (caught) {
        if (pickRef.current === id) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoad((current) => current?.id === id ? null : current);
      }
      return;
    }
    const info = list.find((track) => track.id === id);
    if (!info) return;
    try {
      if (!info.installed) {
        setLoad({ id, progress: 0, requestId });
        await downloadTrack(id, requestId, (progress) => {
          if (pickRef.current === id) setLoad({ id, progress: progress.progress ?? 0, requestId });
        });
        setTracks((current) => current.map((track) => track.id === id ? { ...track, installed: true } : track));
      }
      if (pickRef.current !== id) return;
      setLoad({ id, progress: null, requestId });
      const buffer = await decodeTrack(id);
      if (pickRef.current !== id) return;
      setMusic({ id, buffer });
    } catch (caught) {
      if (pickRef.current === id) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoad((current) => current?.id === id ? null : current);
    }
  };

  /** The track list loads once; the last picked track comes back when it is still offered. */
  useEffect(() => {
    let cancelled = false;
    listTracks().then((list) => {
      if (cancelled) return;
      setTracks(list);
      const stored = readStored(MUSIC_KEY);
      if (stored && (stored.startsWith(FILE_PREFIX) || list.some((track) => track.id === stored))) void pickTrack(stored, list);
    }).catch((caught) => { if (!cancelled) setError(String(caught)); });
    return () => { cancelled = true; };
  }, []);

  /** Closing the dialog stops a download that is still running. */
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => () => {
    const running = loadRef.current;
    if (running && running.progress !== null) void cancelAiRequest(running.requestId);
  }, []);

  const busy = load !== null;
  const submit = () => {
    if (busy || (trackId && !music)) return;
    onExport({ title, music: music ? { buffer: music.buffer, start } : null });
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div className="save-dialog slideshow-dialog" role="dialog" aria-modal="true" aria-labelledby="slideshow-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon"><FilmStrip size={22} weight="duotone" /></div>
          <div>
            <h2 id="slideshow-title">Export video slideshow</h2>
            <p>Opens on the final image with a title box, shows the original image and each visible layer with its name, then closes on the final image. MP4, up to 1080p.</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>
        <div className="save-dialog-body slideshow-body">
          <label className="form-row">
            <span className="form-row-label">Title</span>
            <input className="settings-input" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} spellCheck={false} />
          </label>
          <label className="form-row">
            <span className="form-row-label">Music</span>
            <select value={trackId} onChange={(event) => void pickTrack(event.target.value, tracks)}>
              <option value="">No music</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.title}{track.installed ? "" : ` · downloads ${formatMegabytes(track.sizeBytes)}`}
                </option>
              ))}
              {customFile && <option value={`${FILE_PREFIX}${customFile}`}>{fileNameOf(customFile)} · your file</option>}
              <option value={CHOOSE_FILE}>Choose a file…</option>
            </select>
          </label>
          {(load || music || error) && (
            <div className="form-row form-row-top">
              <span className="form-row-label" />
              <div className="form-row-control">
                {load && (
                  <div className="music-status" role="status">
                    <SpinnerGap className="spin" size={15} />
                    {load.progress !== null ? `Downloading the track… ${Math.round(load.progress * 100)}%` : "Reading the track…"}
                  </div>
                )}
                {music && !load && <MusicPicker buffer={music.buffer} videoSeconds={videoSeconds} start={start} onStartChange={setStart} />}
                {error && <div className="settings-check error"><WarningCircle size={16} weight="fill" /><span>{error}</span></div>}
              </div>
            </div>
          )}
          <p className="slideshow-note">The title box also says "Made with Image Sage™" with the app icon, and the app version.</p>
        </div>
        <footer className="save-dialog-actions">
          <button className="button secondary" onClick={onCancel}>Cancel</button>
          <button className="button primary" disabled={busy || Boolean(trackId && !music)} onClick={submit}>
            <FilmStrip size={16} weight="bold" /> Make video
          </button>
        </footer>
      </div>
    </div>
  );
}
