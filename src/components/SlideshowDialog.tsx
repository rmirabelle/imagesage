import { FilmStrip, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { cancelAiRequest } from "../lib/ai";
import { formatMegabytes } from "../lib/models";
import { AUDIO_FILE_EXTENSIONS, decodeAudioFile, decodeTrack, downloadTrack, listTracks, type TrackInfo } from "../lib/music";
import type { SlideshowOptions } from "../lib/slideshowVideo";
import {
  defaultLayerSeconds,
  defaultSlideSeconds,
  MAX_LAYER_SECONDS,
  MAX_SLIDE_SECONDS,
  MIN_LAYER_SECONDS,
  MIN_SLIDE_SECONDS,
  slideshowDuration,
  slideshowSegments,
  standardSegments,
  type SlideshowStyle
} from "../editor/slideshow";
import { MusicPicker } from "./MusicPicker";

/** The music picked last in any image: the choice for an image that has no video yet. */
const MUSIC_KEY = "imagesage.slideshow-music";
/** Each image's music from its last video: a map from the image's keys to the track and its start. */
const IMAGE_MUSIC_KEY = "imagesage.slideshow-music-by-image";
/** The newest choices kept in that map; older ones are dropped. */
const IMAGE_MUSIC_LIMIT = 200;
/** The video shape picked last: "vertical" for 9:16, anything else for the image's own shape. */
const SHAPE_KEY = "imagesage.slideshow-shape";
/** The video style picked last: "standard", or anything else for the story style. */
const STYLE_KEY = "imagesage.slideshow-style";
/** What each style's video shows, for the dialog's header. */
const STYLE_TEXT: Record<SlideshowStyle, string> = {
  story: "Opens on the final image with a title box, shows the original image and each visible layer with its name, then the original image again, and closes as the final image fades in over it. MP4, up to 1080p.",
  standard: "Shows the original image, then each visible layer once, in order, with a 2-second crossfade between them. No names and no title box. MP4, up to 1080p."
};
type ImageMusic = { track: string; start: number };
/** A music choice that is an audio file on this PC: this prefix, then its path. */
const FILE_PREFIX = "file:";
/** The list item that opens the file picker; it is never the chosen music itself. */
const CHOOSE_FILE = "choose-file";
const fileNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** Seconds as minutes and seconds, such as "1:28". */
const formatLength = (seconds: number) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const readImageMusic = (): Record<string, ImageMusic> => {
  try {
    const parsed: unknown = JSON.parse(readStored(IMAGE_MUSIC_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, ImageMusic> : {};
  } catch {
    return {};
  }
};

/** Remembers an image's music under each of its keys, newest last. */
const storeImageMusic = (keys: string[], music: ImageMusic) => {
  const map = readImageMusic();
  for (const key of keys) {
    delete map[key];
    map[key] = music;
  }
  const kept = Object.entries(map).slice(-IMAGE_MUSIC_LIMIT);
  try { localStorage.setItem(IMAGE_MUSIC_KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* Remembering is a convenience only. */ }
};

interface Props {
  /** The default title: the image's name. */
  defaultTitle: string;
  /** The pictures in the video: the original image plus each visible layer. */
  stages: number;
  /** The image's keys (its file path, its document id), most lasting first: its last video's music is stored under them. */
  imageKeys: string[];
  onCancel: () => void;
  onExport: (options: SlideshowOptions) => void;
}

/** A track being made ready: downloaded (`progress` 0 to 1), then decoded (`progress` null). */
type TrackLoad = { id: string; progress: number | null; requestId: string };

/** Settings for the video slideshow: the title in its title box, and the music. */
export function SlideshowDialog({ defaultTitle, stages, imageKeys, onCancel, onExport }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [vertical, setVertical] = useState(() => readStored(SHAPE_KEY) === "vertical");
  const [style, setStyle] = useState<SlideshowStyle>(() => readStored(STYLE_KEY) === "standard" ? "standard" : "story");
  const standard = style === "standard";
  /** Seconds each layer shows in the story style; by default the video fits in 90 seconds. */
  const [layerSeconds, setLayerSeconds] = useState(() => defaultLayerSeconds(stages, true));
  /** Seconds each slide shows alone in the standard style, after its crossfade. */
  const [slideSeconds, setSlideSeconds] = useState(() => defaultSlideSeconds(stages));
  const seconds = standard ? slideSeconds : layerSeconds;
  const setSeconds = standard ? setSlideSeconds : setLayerSeconds;
  const minSeconds = standard ? MIN_SLIDE_SECONDS : MIN_LAYER_SECONDS;
  const maxSeconds = standard ? MAX_SLIDE_SECONDS : MAX_LAYER_SECONDS;
  /** The seconds box's text while the user types in it; null shows `seconds`. */
  const [secondsDraft, setSecondsDraft] = useState<string | null>(null);
  /** How long the video runs, in seconds: the music box is this long. */
  const videoSeconds = slideshowDuration(standard ? standardSegments(stages, slideSeconds) : slideshowSegments(stages, true, layerSeconds));
  /** Typed text that is a number goes into the range at one decimal; other text keeps the old value. */
  const commitSecondsDraft = () => {
    const typed = Number(secondsDraft);
    if (secondsDraft !== null && secondsDraft.trim() && Number.isFinite(typed)) {
      setSeconds(Math.round(Math.min(maxSeconds, Math.max(minSeconds, typed)) * 10) / 10);
    }
    setSecondsDraft(null);
  };
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

  /** `startAt` is where a remembered choice started in the track; it is kept inside the track. */
  const pickTrack = async (id: string, list: TrackInfo[], startAt = 0) => {
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
    const ready = (buffer: AudioBuffer) => {
      setStart(Math.max(0, Math.min(startAt, buffer.duration - videoSeconds)));
      setMusic({ id, buffer });
    };
    const requestId = crypto.randomUUID();
    if (id.startsWith(FILE_PREFIX)) {
      try {
        setLoad({ id, progress: null, requestId });
        const buffer = await decodeAudioFile(id.slice(FILE_PREFIX.length));
        if (pickRef.current === id) ready(buffer);
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
      ready(buffer);
    } catch (caught) {
      if (pickRef.current === id) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoad((current) => current?.id === id ? null : current);
    }
  };

  /**
   * The track list loads once. The music of this image's last video comes
   * back, with its start; an image without one gets the track picked last in
   * any image. Either comes back only when it is still offered.
   */
  useEffect(() => {
    let cancelled = false;
    listTracks().then((list) => {
      if (cancelled) return;
      setTracks(list);
      const map = readImageMusic();
      const remembered = imageKeys.map((key) => map[key]).find((entry) => entry && typeof entry.track === "string");
      const stored = remembered ? remembered.track : readStored(MUSIC_KEY);
      const startAt = remembered && Number.isFinite(remembered.start) ? remembered.start : 0;
      if (stored === "") return;
      if (stored && (stored.startsWith(FILE_PREFIX) || list.some((track) => track.id === stored))) void pickTrack(stored, list, startAt);
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
    storeImageMusic(imageKeys, { track: music ? trackId : "", start: music ? start : 0 });
    try {
      localStorage.setItem(SHAPE_KEY, vertical ? "vertical" : "image");
      localStorage.setItem(STYLE_KEY, style);
    } catch { /* Remembering is a convenience only. */ }
    onExport({ style, title, music: music ? { buffer: music.buffer, start } : null, layerSeconds: seconds, vertical });
  };

  return (
    <div className="save-dialog-overlay" role="presentation" onPointerDown={onCancel}>
      <div className="save-dialog slideshow-dialog" role="dialog" aria-modal="true" aria-labelledby="slideshow-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="save-dialog-header">
          <div className="save-dialog-title-icon"><FilmStrip size={22} weight="duotone" /></div>
          <div>
            <h2 id="slideshow-title">Export video slideshow</h2>
            <p>{STYLE_TEXT[style]}</p>
          </div>
          <button className="save-dialog-close" onClick={onCancel} aria-label="Close" data-help="Close">
            <X size={18} />
          </button>
        </header>
        <div className="save-dialog-body slideshow-body">
          <label className="form-row">
            <span className="form-row-label">Style</span>
            <select value={style} onChange={(event) => { setStyle(event.target.value === "standard" ? "standard" : "story"); setSecondsDraft(null); }}>
              <option value="story">Story: title box, layer names</option>
              <option value="standard">Standard: crossfades only</option>
            </select>
          </label>
          {!standard && (
            <label className="form-row">
              <span className="form-row-label">Title</span>
              <input className="settings-input" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} spellCheck={false} />
            </label>
          )}
          <label className="form-row" data-help="Vertical puts the whole image in the middle of a 1080 by 1920 video, over a blurred copy of it. Use it for Instagram Reels and other phone feeds.">
            <span className="form-row-label">Shape</span>
            <select value={vertical ? "vertical" : "image"} onChange={(event) => setVertical(event.target.value === "vertical")}>
              <option value="image">Same as the image</option>
              <option value="vertical">Vertical 9:16, blurred background</option>
            </select>
          </label>
          <label
            className="form-row"
            data-help={standard
              ? `Seconds each slide shows alone after its 2-second crossfade, ${MIN_SLIDE_SECONDS} to ${MAX_SLIDE_SECONDS}. The first value fits the video in 90 seconds, up to 3 seconds per slide.`
              : `Seconds each layer shows, ${MIN_LAYER_SECONDS} to ${MAX_LAYER_SECONDS}. The first value fits the video in 90 seconds.`}
          >
            <span className="form-row-label">{standard ? "Seconds per slide" : "Seconds per layer"}</span>
            <span className="slideshow-seconds">
              <input
                className="settings-input"
                type="number"
                min={minSeconds}
                max={maxSeconds}
                step={0.1}
                value={secondsDraft ?? seconds.toFixed(1)}
                onChange={(event) => {
                  setSecondsDraft(event.target.value);
                  /** The spinner arrows give a whole value at once, so the video length follows them. */
                  const typed = Number(event.target.value);
                  if (event.target.value.trim() && typed >= minSeconds && typed <= maxSeconds) setSeconds(Math.round(typed * 10) / 10);
                }}
                onBlur={commitSecondsDraft}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
              <span className="slideshow-length">Video {formatLength(videoSeconds)}</span>
            </span>
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
          {!standard && <p className="slideshow-note">The title box also says "made with Image Sage™" with the app icon, and the app version.</p>}
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
