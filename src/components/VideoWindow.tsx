import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckCircle, FilmStrip, FloppyDisk, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { canvasFromDataUrl, canvasToDataUrl, scaledCanvas } from "../editor/canvas";
import { CLIP_QUALITIES, CLIP_SECONDS, clipFrames, clipSize } from "../editor/clipSize";
import {
  CANCELLED_MESSAGE,
  VIDEO_FROM_PICTURE,
  VIDEO_MODELS,
  cancelAiRequest,
  localModelReady,
  localStatus,
  makeLocalVideo,
  type AiStage,
  type LocalStatus
} from "../lib/ai";
import { WindowControls } from "./WindowControls";

/** What the editor sent: the layer's picture (a PNG data URL), its prompt, and its name. */
interface VideoSource {
  image: string;
  prompt: string;
  name: string;
}

interface Job {
  requestId: string;
  stage: AiStage | null;
  progress: number | null;
  /** The engine's picture of the clip so far. */
  preview: string | null;
  startedAt: number;
}

interface Clip {
  url: string;
  width: number;
  height: number;
  seconds: number;
  /** The user saved this clip to a file. */
  saved: boolean;
}

type Note = { tone: "success" | "error"; message: string } | null;

const jobLabel = (job: Job) => {
  if (job.stage === "loading") return "Loading Wan 2.2…";
  if (job.stage === "finishing") return "Finishing the video…";
  if (job.stage === "generating" && job.progress !== null) return `Making the video… ${Math.round(job.progress * 100)}%`;
  return "Starting…";
};

const elapsed = (from: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const safeFileName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");

/**
 * The video window. The editor sends one layer (Edit, Animate Layer); this
 * window makes a short clip from it with Wan 2.2 on this computer, plays the
 * clip in a loop, and saves it as a WebM file. The editor has no video layers.
 * The clip stays in memory only; closing the window with a clip that is not
 * saved asks first.
 */
export function VideoWindow() {
  const [source, setSource] = useState<VideoSource | null>(null);
  /** The width and height of the source picture. */
  const [shape, setShape] = useState<{ width: number; height: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  /** The Wan 2.2 model the user chose; none means the first one whose files are set. */
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [quality, setQuality] = useState(CLIP_QUALITIES[0].id);
  const [seconds, setSeconds] = useState(CLIP_SECONDS[CLIP_SECONDS.length - 1]);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;
  const [clip, setClip] = useState<Clip | null>(null);
  const clipRef = useRef<Clip | null>(null);
  clipRef.current = clip;
  /** The window waits to close until the user saves the clip or not. `final`: the main window is closed, so the user cannot cancel. */
  const [closePrompt, setClosePrompt] = useState<{ final: boolean } | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [now, setNow] = useState(Date.now());

  /** Takes the layer that the editor sent; a new layer replaces the one before and its clip. */
  const takeSource = useCallback(async () => {
    const next = await invoke<VideoSource | null>("video_take_source");
    if (!next) return;
    const picture = await canvasFromDataUrl(next.image);
    setSource(next);
    setShape({ width: picture.width, height: picture.height });
    setPrompt(next.prompt);
    setNote(null);
    setClip((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
  }, []);

  const refreshStatus = useCallback(() => {
    localStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    void takeSource();
    refreshStatus();
    const stopSource = listen("video-source", () => void takeSource());
    /** The user can choose the model files in the main window; this window reads them again when it gets the focus. */
    window.addEventListener("focus", refreshStatus);
    /** Closing the window stops a clip that is still being made, and asks first when a clip is not saved. */
    const stopClose = getCurrentWindow().onCloseRequested(async (event) => {
      if (jobRef.current) await cancelAiRequest(jobRef.current.requestId).catch(() => {});
      if (clipRef.current && !clipRef.current.saved) {
        event.preventDefault();
        setClosePrompt((current) => current ?? { final: false });
      }
    });
    /** The main window closed while this window has a clip that is not saved. */
    const stopMainClosed = listen("video-close-requested", () => {
      if (clipRef.current && !clipRef.current.saved) setClosePrompt({ final: true });
      else void getCurrentWindow().destroy();
    });
    return () => {
      void stopSource.then((stop) => stop());
      void stopClose.then((stop) => stop());
      void stopMainClosed.then((stop) => stop());
      window.removeEventListener("focus", refreshStatus);
    };
  }, [refreshStatus, takeSource]);

  useEffect(() => {
    if (!job) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [job]);

  /** Image Sage picks the model: the user's choice when its files are set, else the first model whose files are set. */
  const readyModels = VIDEO_MODELS.filter((item) => localModelReady(status, item.id)).map((item) => item.id);
  const model = chosenModel && readyModels.includes(chosenModel) ? chosenModel : readyModels[0] ?? VIDEO_FROM_PICTURE;
  const ready = readyModels.includes(model);
  const fromPicture = model === VIDEO_FROM_PICTURE;
  const pixels = CLIP_QUALITIES.find((item) => item.id === quality)?.pixels ?? CLIP_QUALITIES[0].pixels;
  const size = shape ? clipSize(shape.width, shape.height, pixels) : null;

  const make = async () => {
    if (!source || !size || job) return;
    const requestId = crypto.randomUUID();
    const started: Job = { requestId, stage: null, progress: null, preview: null, startedAt: Date.now() };
    setNow(started.startedAt);
    setJob(started);
    setNote(null);
    try {
      const image = fromPicture ? await canvasToDataUrl(scaledCanvas(await canvasFromDataUrl(source.image), size.width, size.height)) : null;
      await makeLocalVideo(requestId, { model, prompt, size: `${size.width}x${size.height}`, frames: clipFrames(seconds), image }, (progress) => {
        setJob((current) => current?.requestId !== requestId ? current : progress.stage === "partial"
          ? { ...current, preview: progress.partialDataUrl ?? current.preview }
          : { ...current, stage: progress.stage, progress: progress.progress ?? current.progress });
      });
      const bytes = await invoke<ArrayBuffer>("video_read");
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
      setClip((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url, width: size.width, height: size.height, seconds, saved: false };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== CANCELLED_MESSAGE) setNote({ tone: "error", message });
    } finally {
      setJob(null);
      refreshStatus();
    }
  };

  /** Asks for a file and saves the clip there. Returns false when the user cancels or the save fails. */
  const saveClip = async () => {
    if (!clip) return false;
    try {
      const path = await save({
        title: "Save the video",
        defaultPath: `${safeFileName(source?.name ?? "") || "Video"}.webm`,
        filters: [{ name: "WebM video", extensions: ["webm"] }]
      });
      if (!path) return false;
      await invoke("video_save", { path });
      setClip((current) => current && { ...current, saved: true });
      setNote({ tone: "success", message: `Saved ${path}` });
      return true;
    } catch (error) {
      setNote({ tone: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const saveAndClose = async () => {
    if (await saveClip()) await getCurrentWindow().destroy();
    else setClosePrompt((current) => current?.final ? current : null);
  };

  /** What the stage shows: the clip, then the engine's picture of a running clip, then the layer. */
  const stillPicture = job?.preview ?? source?.image ?? null;
  const blocked = !source
    ? "Select a layer in Image Sage, then choose Edit, Animate Layer."
    : !size
      ? "This layer is wider or taller than 3:1, which is too far from the shape of a video."
      : !status?.engineInstalled
        ? "The local engine is not installed. In the Image Sage window, open File, Settings, Local."
        : !ready
          ? "Choose the Wan 2.2 files first. In the Image Sage window, open File, Settings, Local."
          : null;

  return (
    <main className="app-shell video-window">
      <header className="titlebar" data-tauri-drag-region onDoubleClick={() => void getCurrentWindow().toggleMaximize()}>
        <div className="brand" data-tauri-drag-region>
          <img src="/icon.ico" alt="" />
          <span>Image Sage Video</span>
        </div>
        <div className="titlebar-spacer" data-tauri-drag-region />
        <WindowControls />
      </header>

      <div className="video-stage">
        {clip && !job
          ? <video key={clip.url} src={clip.url} autoPlay loop muted controls playsInline />
          : stillPicture
            ? <img className={job?.preview ? "video-preview" : ""} src={stillPicture} alt="" />
            : <div className="video-empty"><FilmStrip size={34} /><span>No layer yet</span></div>}
      </div>

      <div className="video-form">
        <div className="form-row form-row-top">
          <label className="form-row-label" htmlFor="video-prompt">Prompt</label>
          <textarea
            id="video-prompt"
            className="settings-input video-prompt"
            spellCheck={false}
            placeholder="What happens in the video, and how the camera moves"
            value={prompt}
            disabled={Boolean(job)}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="form-row-label" htmlFor="video-start">Start</label>
          <select id="video-start" value={model} disabled={Boolean(job)} onChange={(event) => setChosenModel(event.target.value)}>
            {VIDEO_MODELS.map((item) => (
              <option key={item.id} value={item.id} disabled={!readyModels.includes(item.id)}>
                {item.label} ({item.note}){readyModels.includes(item.id) ? "" : ", files not set"}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="form-row-label" htmlFor="video-size">Size</label>
          <select id="video-size" value={quality} disabled={Boolean(job)} onChange={(event) => setQuality(event.target.value)}>
            {CLIP_QUALITIES.map((item) => {
              const itemSize = shape ? clipSize(shape.width, shape.height, item.pixels) : null;
              return <option key={item.id} value={item.id}>{item.label}{itemSize ? ` (${itemSize.width} × ${itemSize.height})` : ""}</option>;
            })}
          </select>
        </div>
        <div className="form-row">
          <label className="form-row-label" htmlFor="video-length">Length</label>
          <select id="video-length" value={seconds} disabled={Boolean(job)} onChange={(event) => setSeconds(Number(event.target.value))}>
            {CLIP_SECONDS.map((item) => <option key={item} value={item}>{item} seconds</option>)}
          </select>
        </div>
        <div className="form-row">
          <span className="form-row-label" />
          <div className="video-actions">
            {job ? (
              <>
                <span className="video-progress" role="status">
                  <SpinnerGap className="spin" size={16} />
                  <span>{jobLabel(job)}</span>
                  <small>{elapsed(job.startedAt, now)}</small>
                </span>
                <button className="button secondary" onClick={() => void cancelAiRequest(job.requestId)}>Cancel</button>
              </>
            ) : (
              <>
                <button className="button primary" disabled={Boolean(blocked) || !prompt.trim()} onClick={() => void make()}>
                  <FilmStrip size={17} weight="bold" /> {clip ? "Make again" : "Make video"}
                </button>
                {clip && (
                  <button className="button secondary" onClick={() => void saveClip()}>
                    <FloppyDisk size={16} /> Save…
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {job && (
          <div className="about-update-progress video-bar"><i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></div>
        )}
        {!job && blocked && (
          <div className="settings-check error" role="status"><WarningCircle size={16} weight="fill" /><span>{blocked}</span></div>
        )}
        {!job && note && (
          <div className={`settings-check ${note.tone}`} role="status">
            {note.tone === "success" ? <CheckCircle size={16} weight="fill" /> : <WarningCircle size={16} weight="fill" />}
            <span>{note.message}</span>
          </div>
        )}
        {!blocked && (
          <small className="settings-help">
            {fromPicture
              ? "The video starts from the layer's picture. "
              : "The video comes from the prompt alone; the layer gives only the shape and the starting prompt. "}
            Wan 2.2 runs on this computer. A large or long video can take many minutes.
          </small>
        )}
      </div>

      {closePrompt && (
        <div className="confirm-overlay" role="presentation" onPointerDown={() => { if (!closePrompt.final) setClosePrompt(null); }}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="close-video-title" onPointerDown={(event) => event.stopPropagation()}>
            <div className="confirm-icon"><WarningCircle size={22} weight="fill" /></div>
            <div className="confirm-copy">
              <h2 id="close-video-title">Save this video?</h2>
              <p>The video is not saved. Image Sage keeps no copy of it after this window closes.</p>
            </div>
            <div className="confirm-actions">
              {!closePrompt.final && (
                <button className="button secondary" onClick={() => setClosePrompt(null)}>Cancel</button>
              )}
              <button className="button danger" onClick={() => void getCurrentWindow().destroy()}>Close without saving</button>
              <button autoFocus className="button primary" onClick={() => void saveAndClose()}>Save and close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
