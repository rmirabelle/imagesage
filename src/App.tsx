import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowClockwise, ArrowCounterClockwise, CheckCircle, DownloadSimple, FilmStrip, FloppyDisk, FolderOpen, GearSix, ImageSquare, Info, Keyboard, MagicWand, SpinnerGap, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { AboutDialog } from "./components/AboutDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { ConnectDialog, type SettingsSection } from "./components/ConnectDialog";
import { Editor, type EditorCommand, type Notice } from "./components/Editor";
import { NewImageDialog, type NewImageRequest } from "./components/NewImageDialog";
import { OpenDialog } from "./components/OpenDialog";
import { Tooltips } from "./components/Tooltips";
import type { SaveFormat } from "./components/SaveDialog";
import { MenuBar, type Menu } from "./components/MenuBar";
import { TitleBar } from "./components/TitleBar";
import { canvasFromDataUrl, canvasToDataUrl, createCanvas, scaledCanvas } from "./editor/canvas";
import { exceedsWholeImageLimits, fitWithinWholeImageLimits } from "./editor/region";
import { createManifest, parseManifest, type HistoryTile } from "./editor/document";
import { documentSpend, isDocumentDirty, type ImageDocument } from "./editor/imageDocument";
import type { DocumentOrigin } from "./editor/types";
import {
  DISCONNECTED,
  apiKeyStatus,
  loadAiSettings,
  storeAiSettings,
  type AiSettings,
  type ApiKeyStatus,
  type KeyStatuses,
  type Provider
} from "./lib/ai";
import { formatUsd, loadSpend, refreshPrices, spendTotals, usePrices } from "./lib/pricing";
import { listRecovery, removeRecovery, saveDocumentFile, saveRecovery } from "./lib/recovery";
import { checkForUpdate, getAppVersion, type UpdateInfo } from "./lib/updater";

type OpenedImageFile = {
  kind: "document" | "image";
  dataUrl: string;
  width: number;
  height: number;
  manifestJson: string | null;
  historyTiles: HistoryTile[];
};

type NewDocument = Pick<ImageDocument, "name" | "path" | "suggestedPath" | "createdAt" | "origin" | "surface" | "base" | "baseAdjust" | "history" | "historyIndex" | "startGeneration"> & {
  /** Generated images cost money, so they start unsaved; imported files start clean. */
  startsDirty: boolean;
  /** Keeps a recovered document's id, so its recovery file is reused. */
  id?: string;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** An opened image too large for GPT Image, waiting for the user to choose whether to scale it down. */
type PendingImport = { path: string; surface: HTMLCanvasElement; target: { width: number; height: number } };
const documentNameFor = (path: string) => `${fileName(path).replace(/\.[^.]+$/, "") || "Untitled"}.imagesage`;
const SAVE_SEQUENCE_KEY = "imagesage.export-sequence";

type DocumentPanelProps = {
  document: ImageDocument;
  active: boolean;
  settings: AiSettings;
  openaiConnected: boolean;
  onRequestOpenAiSettings: () => void;
  onSettingsChange: (settings: AiSettings) => void;
  onCommit: (id: string, patch: Partial<Pick<ImageDocument, "base" | "baseAdjust" | "history" | "historyIndex">>, markDirty?: boolean) => void;
  onBusyChange: (id: string, busy: boolean) => void;
  /** Saves to the document's file; `saveAs` (or a document never saved) asks for a file first. */
  onSave: (id: string, saveAs?: boolean) => Promise<boolean>;
  onExport: (id: string, dataUrl: string, format: SaveFormat) => Promise<boolean>;
  onExportVideo: (id: string, video: Blob) => Promise<boolean>;
  onNotice: (notice: Notice) => void;
  onFileTask: <T>(label: string, work: () => Promise<T>) => Promise<T>;
  command: EditorCommand | null;
};

const DocumentPanel = memo(function DocumentPanel(props: DocumentPanelProps) {
  return (
    <section
      id={`image-panel-${props.document.id}`}
      className={`image-document ${props.active ? "active" : ""}`}
      role="tabpanel"
      aria-labelledby={`image-tab-${props.document.id}`}
      aria-hidden={!props.active}
    >
      <Editor {...props} />
    </section>
  );
});

export default function App() {
  const [documents, setDocuments] = useState<ImageDocument[]>([]);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AiSettings>(loadAiSettings);
  const [keyStatuses, setKeyStatuses] = useState<KeyStatuses>({ openai: DISCONNECTED });
  const openaiReady = keyStatuses.openai.connected;
  /** Re-renders when prices or the spend record change. */
  usePrices();
  const spend = spendTotals();
  const setKeyStatus = useCallback((provider: Provider, status: ApiKeyStatus) => {
    setKeyStatuses((current) => ({ ...current, [provider]: status }));
  }, []);
  const [storedNotice, setNotice] = useState<Notice>(null);
  /** A message about one image shows only while that image is selected; it waits, without closing, while another is. */
  const notice = storedNotice && (!storedNotice.documentId || storedNotice.documentId === activeDocumentId) ? storedNotice : null;
  /** A message about an image that was closed is dropped. */
  useEffect(() => {
    if (storedNotice?.documentId && !documents.some((document) => document.id === storedNotice.documentId)) setNotice(null);
  }, [documents, storedNotice]);
  /**
   * Where messages show: centered across the image, about 30px below its top
   * (or below the top of the work area when the image is scrolled up past it).
   * Null centers them in the window.
   */
  const [noticeCenter, setNoticeCenter] = useState<{ left: number; top: number; transform: string } | null>(null);
  useLayoutEffect(() => {
    if (!notice) return;
    const observer = new ResizeObserver(() => place());
    let observed: HTMLElement[] = [];
    let frame = 0;
    let tries = 0;
    function place() {
      const panel = activeDocumentId ? window.document.querySelector<HTMLElement>(`#image-panel-${CSS.escape(activeDocumentId)}`) : null;
      const areaElement = panel?.querySelector<HTMLElement>(".editor-workspace");
      const imageElement = panel?.querySelector<HTMLElement>(".canvas-stage");
      const area = areaElement?.getBoundingClientRect();
      const image = imageElement?.getBoundingClientRect();
      if (!areaElement || !imageElement || !area || !image || area.width === 0 || area.height === 0 || image.width === 0) {
        setNoticeCenter(null);
        /**
         * A newly opened image is not laid out yet when its notice appears.
         * Try again on the next frames until its panel has a size.
         */
        if (activeDocumentId && tries++ < 60) frame = requestAnimationFrame(place);
        return;
      }
      if (observed[0] !== areaElement || observed[1] !== imageElement) {
        observer.disconnect();
        observed = [areaElement, imageElement];
        observed.forEach((element) => observer.observe(element));
      }
      const left = (Math.max(area.left, image.left) + Math.min(area.right, image.right)) / 2;
      setNoticeCenter({ left, top: Math.max(area.top, image.top) + 30, transform: "translateX(-50%)" });
    }
    place();
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [notice, activeDocumentId]);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [openDialogOpen, setOpenDialogOpen] = useState(false);
  const [newImageOpen, setNewImageOpen] = useState(false);
  const [connectSection, setConnectSection] = useState<SettingsSection | null>(null);
  const [opening, setOpening] = useState(false);
  const [pendingCloseDocumentId, setPendingCloseDocumentId] = useState<string | null>(null);
  const [quitPending, setQuitPending] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  /** The revision of each document last written to the recovery folder. */
  const recoveryWrittenRef = useRef(new Map<string, number>());
  const recoveryCheckedRef = useRef(false);
  const [appVersion, setAppVersion] = useState("");
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfo | null>(null);
  const pendingCloseDocument = documents.find((document) => document.id === pendingCloseDocumentId) ?? null;

  const showNotice = useCallback((next: Notice) => setNotice(next), []);
  /** Labels of the file reads and writes now running; the loader shows the newest. */
  const [fileTasks, setFileTasks] = useState<{ id: number; label: string }[]>([]);
  const fileTaskIdRef = useRef(0);
  const runFileTask = useCallback(async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
    const id = ++fileTaskIdRef.current;
    setFileTasks((current) => [...current, { id, label }]);
    try {
      return await work();
    } finally {
      setFileTasks((current) => current.filter((task) => task.id !== id));
    }
  }, []);
  /** The pointer is over the notice; it does not close by itself meanwhile. */
  const [noticeHovered, setNoticeHovered] = useState(false);
  /** Success and warning messages close by themselves; errors stay until closed. */
  useEffect(() => {
    if (!notice || notice.tone === "error" || notice.sticky || noticeHovered) return;
    const delay = notice.tone === "warning" ? 8000 : notice.action ? 10000 : 3200;
    const timer = window.setTimeout(() => setNotice(null), delay);
    return () => window.clearTimeout(timer);
  }, [notice, noticeHovered]);
  useEffect(() => setNoticeHovered(false), [notice]);

  const setSettings = useCallback((next: AiSettings) => {
    setSettingsState(next);
    storeAiSettings(next);
  }, []);

  const mutateDocuments = useCallback((transform: (current: ImageDocument[]) => ImageDocument[]) => {
    setDocuments((current) => {
      const next = transform(current);
      documentsRef.current = next;
      return next;
    });
  }, []);

  const updateDocument = useCallback((id: string, patch: Partial<ImageDocument>) => {
    mutateDocuments((current) => current.map((document) => document.id === id ? { ...document, ...patch } : document));
  }, [mutateDocuments]);

  const addDocument = useCallback(({ startsDirty, id, ...initial }: NewDocument) => {
    const document: ImageDocument = {
      ...initial,
      id: id ?? crypto.randomUUID(),
      revision: 1,
      savedRevision: startsDirty ? 0 : 1,
      saving: false,
      busy: false
    };
    mutateDocuments((current) => [...current, document]);
    setActiveDocumentId(document.id);
  }, [mutateDocuments]);

  const removeDocument = useCallback((id: string) => {
    const current = documentsRef.current;
    const index = current.findIndex((document) => document.id === id);
    if (index < 0) return;
    const nextActiveId = current[index + 1]?.id ?? current[index - 1]?.id ?? null;
    mutateDocuments((items) => items.filter((document) => document.id !== id));
    setActiveDocumentId((activeId) => activeId === id ? nextActiveId : activeId);
    recoveryWrittenRef.current.delete(id);
    if (isTauri()) void removeRecovery(id).catch(() => {});
  }, [mutateDocuments]);

  /** True while a mouse button or pen is pressed anywhere, so recovery waits until painting or dragging ends. */
  const pointerPressedRef = useRef(false);
  useEffect(() => {
    const down = () => { pointerPressedRef.current = true; };
    const up = () => { pointerPressedRef.current = false; };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  /**
   * Automatic recovery: two seconds after the last change, when no pointer is
   * pressed and the app is idle, each image with unsaved work is copied to the
   * recovery folder; a saved image's copy is removed. A copy sends only new
   * layers and masks and is written on a worker thread (see `lib/recovery.ts`).
   */
  useEffect(() => {
    if (!isTauri()) return;
    let idle: number | null = null;
    let timer = 0;
    const writeCopies = () => {
      for (const document of documentsRef.current) {
        const written = recoveryWrittenRef.current.get(document.id);
        if (isDocumentDirty(document)) {
          if (written === document.revision) continue;
          recoveryWrittenRef.current.set(document.id, document.revision);
          saveRecovery(document).catch(() => recoveryWrittenRef.current.delete(document.id));
        } else if (written !== undefined) {
          recoveryWrittenRef.current.delete(document.id);
          void removeRecovery(document.id).catch(() => {});
        }
      }
    };
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        if (pointerPressedRef.current) {
          schedule(1500);
          return;
        }
        idle = window.requestIdleCallback(writeCopies, { timeout: 4000 });
      }, delay);
    };
    schedule(2000);
    return () => {
      window.clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback(idle);
    };
  }, [documents]);

  /** `markDirty` false keeps the document clean, for changes that are not edits (such as picking a layer). */
  const commitHistory = useCallback((id: string, patch: Partial<Pick<ImageDocument, "base" | "baseAdjust" | "history" | "historyIndex">>, markDirty = true) => {
    mutateDocuments((current) => current.map((document) => document.id === id
      ? { ...document, ...patch, revision: document.revision + (markDirty ? 1 : 0) }
      : document));
  }, [mutateDocuments]);

  const setBusy = useCallback((id: string, busy: boolean) => updateDocument(id, { busy }), [updateDocument]);

  const restoreMainWindow = useCallback(async () => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    try { await appWindow.unminimize(); } catch { /* The window may not be minimized. */ }
    try { await appWindow.setFocus(); } catch { /* Windows can deny foreground focus. */ }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    apiKeyStatus("openai").then((status) => { if (!cancelled) setKeyStatus("openai", status); }).catch(() => {});
    void refreshPrices();
    void loadSpend();
    getAppVersion().then((version) => { if (!cancelled) setAppVersion(version); }).catch(() => {});
    checkForUpdate().then((info) => { if (!cancelled && info) setStartupUpdate(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, [setKeyStatus]);

  const addImportedImage = useCallback((path: string, surface: HTMLCanvasElement) => {
    addDocument({
      name: documentNameFor(path),
      path: null,
      suggestedPath: path.replace(/[^\\/]*$/, documentNameFor(path)),
      createdAt: new Date().toISOString(),
      origin: { kind: "imported", fileName: fileName(path) },
      surface,
      history: [],
      historyIndex: 0,
      startsDirty: false
    });
  }, [addDocument]);

  const finishImport = useCallback((scale: boolean) => {
    if (!pendingImport) return;
    const { path, surface, target } = pendingImport;
    setPendingImport(null);
    addImportedImage(path, scale ? scaledCanvas(surface, target.width, target.height) : surface);
  }, [addImportedImage, pendingImport]);

  const openPath = useCallback(async (path: string) => {
    setOpening(true);
    try {
      const { opened, surface } = await runFileTask(`Opening ${fileName(path)}…`, async () => {
        const opened = await invoke<OpenedImageFile>("open_image_file", { path, includeHistory: true });
        return { opened, surface: await canvasFromDataUrl(opened.dataUrl) };
      });
      if (opened.kind === "document") {
        if (!opened.manifestJson) throw new Error("The Image Sage document has no manifest.");
        const restored = parseManifest(opened.manifestJson, opened.historyTiles);
        addDocument({
          name: fileName(path),
          path,
          createdAt: restored.createdAt,
          origin: restored.origin,
          surface,
          base: restored.base,
          baseAdjust: restored.baseAdjust,
          history: restored.history,
          historyIndex: restored.historyIndex,
          startsDirty: false
        });
      } else if (exceedsWholeImageLimits(surface.width, surface.height)) {
        setPendingImport({ path, surface, target: fitWithinWholeImageLimits(surface.width, surface.height) });
      } else {
        addImportedImage(path, surface);
      }
    } catch (error) {
      showNotice({ tone: "error", message: String(error) });
    } finally {
      setOpening(false);
      await restoreMainWindow();
    }
  }, [addDocument, addImportedImage, restoreMainWindow, runFileTask, showNotice]);

  /** Reopens unsaved images left in the recovery folder by a crash or restart. */
  useEffect(() => {
    if (!isTauri() || recoveryCheckedRef.current) return;
    recoveryCheckedRef.current = true;
    void (async () => {
      const paths = await listRecovery().catch(() => [] as string[]);
      let recovered = 0;
      for (const recoveryPath of paths) {
        try {
          const opened = await invoke<OpenedImageFile>("open_image_file", { path: recoveryPath, includeHistory: true });
          if (!opened.manifestJson) continue;
          const restored = parseManifest(opened.manifestJson, opened.historyTiles);
          addDocument({
            id: fileName(recoveryPath).replace(/\.imagesage$/i, ""),
            name: restored.recovery?.name ?? "Recovered.imagesage",
            path: restored.recovery?.path ?? null,
            createdAt: restored.createdAt,
            origin: restored.origin,
            surface: await canvasFromDataUrl(opened.dataUrl),
            base: restored.base,
            baseAdjust: restored.baseAdjust,
            history: restored.history,
            historyIndex: restored.historyIndex,
            startsDirty: true
          });
          recovered++;
        } catch {
          /* An unreadable copy stays in the folder; it does not block the others. */
        }
      }
      if (recovered) {
        showNotice({
          tone: "success",
          message: `Recovered ${recovered === 1 ? "1 unsaved image" : `${recovered} unsaved images`} from the last session.`
        });
      }
    })();
  }, [addDocument, showNotice]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let stopListening: (() => void) | undefined;
    void (async () => {
      const stop = await listen<string>("open-document-requested", (event) => {
        void openPath(event.payload);
      });
      if (!active) {
        stop();
        return;
      }
      stopListening = stop;
      const pending = await invoke<string | null>("take_pending_open_document");
      if (active && pending) await openPath(pending);
    })();
    return () => {
      active = false;
      stopListening?.();
    };
  }, [openPath]);

  /**
   * The webview reloads the whole app on F5 and Ctrl+R, as a browser would,
   * which could lose unsaved work. Both are blocked here; the editor uses
   * Ctrl+R as Redo.
   */
  useEffect(() => {
    const blockReload = (event: KeyboardEvent) => {
      if (event.key === "F5" || (event.ctrlKey && event.key.toLowerCase() === "r")) event.preventDefault();
    };
    window.addEventListener("keydown", blockReload, true);
    return () => window.removeEventListener("keydown", blockReload, true);
  }, []);

  /** Closing the window quits Image Sage, so ask first when work is unsaved. */
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (documentsRef.current.some((document) => isDocumentDirty(document) || document.busy)) {
        event.preventDefault();
        setQuitPending(true);
      }
    }).then((unlisten) => { stop = unlisten; });
    return () => stop?.();
  }, []);

  /**
   * Opens a new tab with an empty canvas of the chosen size. The editor then
   * generates the image there as the first layer, with the same previews,
   * Capture and Cancel as an edit.
   */
  const startGenerated = useCallback((request: NewImageRequest) => {
    const [width, height] = request.size.split("x").map(Number);
    const origin: DocumentOrigin = {
      kind: "generated",
      prompt: request.prompt,
      model: request.model,
      quality: request.quality,
      size: request.size
    };
    addDocument({
      name: "Untitled.imagesage",
      path: null,
      createdAt: new Date().toISOString(),
      origin,
      surface: createCanvas(width, height),
      history: [],
      historyIndex: 0,
      startGeneration: { prompt: request.prompt, model: request.model, quality: request.quality },
      startsDirty: true
    });
    setNewImageOpen(false);
  }, [addDocument]);

  /**
   * Save writes over the document's own file. Save As, and the first save of a
   * new document, show the save dialog first: at the document's file, or for a
   * new document beside the image it came from. True when the file was saved.
   */
  const saveDocument = useCallback(async (documentId: string, saveAs = false): Promise<boolean> => {
    const document = documentsRef.current.find((candidate) => candidate.id === documentId);
    if (!document || !isTauri()) {
      showNotice({ tone: "error", message: "Saving documents is available in the Image Sage desktop app." });
      return false;
    }
    /** Saving works while AI edits run; a result that arrives later marks the document changed again. */
    if (document.saving) return false;
    updateDocument(documentId, { saving: true });
    try {
      const chosenPath = !saveAs && document.path ? document.path : await save({
        title: saveAs ? "Save Image Sage document as" : "Save Image Sage document",
        defaultPath: document.path ?? document.suggestedPath ?? document.name,
        filters: [{ name: "Image Sage document", extensions: ["imagesage"] }]
      });
      if (!chosenPath) return false;
      const path = chosenPath.toLowerCase().endsWith(".imagesage") ? chosenPath : `${chosenPath}.imagesage`;
      const revision = document.revision;
      await runFileTask(`Saving ${fileName(path)}…`, async () => {
        const { manifest, tiles } = createManifest(
          document.surface.width,
          document.surface.height,
          document.origin,
          document.history,
          document.historyIndex,
          document.createdAt,
          { base: document.base, baseAdjust: document.baseAdjust }
        );
        const imageDataUrl = await canvasToDataUrl(document.surface);
        /** Layers go to the app one at a time; older documents that are not all layers yet go in one message. */
        if (!await saveDocumentFile(document, path, imageDataUrl)) {
          await invoke("save_imagesage_document", {
            path,
            manifestJson: JSON.stringify(manifest),
            dataUrl: imageDataUrl,
            historyTiles: tiles
          });
        }
      });
      updateDocument(documentId, { path, name: fileName(path), savedRevision: revision });
      return true;
    } catch (error) {
      showNotice({ tone: "error", message: String(error) });
      return false;
    } finally {
      updateDocument(documentId, { saving: false });
    }
  }, [runFileTask, showNotice, updateDocument]);

  /** Saves a video slideshow as an MP4 file next to where images are exported. */
  const exportVideo = useCallback(async (documentId: string, video: Blob) => {
    if (!isTauri()) {
      showNotice({ tone: "error", message: "Exporting is available in the Image Sage desktop app." });
      return false;
    }
    const document = documentsRef.current.find((candidate) => candidate.id === documentId);
    if (!document) return false;
    const chosenPath = await save({
      title: "Export video slideshow",
      defaultPath: `${document.name.replace(/\.[^.]+$/, "")} slideshow.mp4`,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }]
    });
    if (!chosenPath) return false;
    const path = chosenPath.toLowerCase().endsWith(".mp4") ? chosenPath : `${chosenPath}.mp4`;
    await runFileTask(`Exporting ${fileName(path)}…`, async () => {
      /** The video goes to Rust as a data URL; the file reader makes it without a slow loop over the bytes. */
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the video."));
        reader.readAsDataURL(video);
      });
      await invoke("save_image", { path, dataUrl });
    });
    showNotice({
      tone: "success",
      message: "Exported",
      file: path,
      sticky: true,
      documentId,
      actions: [
        { label: "Play", keepOpen: true, run: () => void invoke("play_video", { path }).catch((error) => showNotice({ tone: "error", message: String(error) })) },
        { label: "OK", run: () => {} }
      ]
    });
    return true;
  }, [runFileTask, showNotice]);

  const exportImage = useCallback(async (documentId: string, dataUrl: string, format: SaveFormat) => {
    const extension = format === "png" ? "png" : "jpg";
    if (!isTauri()) {
      showNotice({ tone: "error", message: "Exporting is available in the Image Sage desktop app." });
      return false;
    }
    const document = documentsRef.current.find((candidate) => candidate.id === documentId);
    if (!document) return false;
    let sequence = 1;
    try {
      const stored = Number.parseInt(localStorage.getItem(SAVE_SEQUENCE_KEY) || "1", 10);
      if (Number.isFinite(stored) && stored > 0) sequence = stored;
    } catch {
      /* The counter only suggests a default file name. */
    }
    const defaultPath = document.path
      ? document.path.replace(/\.imagesage$/i, `.${extension}`)
      : `Image Sage ${sequence}.${extension}`;
    const chosenPath = await save({
      title: "Export image",
      defaultPath,
      filters: [format === "png"
        ? { name: "PNG image", extensions: ["png"] }
        : { name: "JPEG image", extensions: ["jpg", "jpeg"] }]
    });
    if (!chosenPath) return false;
    const path = /\.[a-z0-9]+$/i.test(chosenPath) ? chosenPath : `${chosenPath}.${extension}`;
    await runFileTask(`Exporting ${fileName(path)}…`, () => invoke("save_image", { path, dataUrl }));
    try { localStorage.setItem(SAVE_SEQUENCE_KEY, String(sequence + 1)); } catch { /* See above. */ }
    showNotice({ tone: "success", message: `Exported ${path}`, documentId });
    return true;
  }, [runFileTask, showNotice]);

  const requestCloseDocument = useCallback((documentId: string) => {
    const document = documentsRef.current.find((candidate) => candidate.id === documentId);
    if (!document) return;
    if (document.saving) {
      showNotice({ tone: "error", message: `Wait for ${document.name} to finish saving before closing it.` });
      return;
    }
    if (isDocumentDirty(document) || document.busy) {
      setPendingCloseDocumentId(documentId);
      return;
    }
    removeDocument(documentId);
  }, [removeDocument, showNotice]);

  const confirmCloseDocument = useCallback(() => {
    const documentId = pendingCloseDocumentId;
    setPendingCloseDocumentId(null);
    if (documentId) removeDocument(documentId);
  }, [pendingCloseDocumentId, removeDocument]);

  /** Save in the close dialog: the image closes only when its save finishes; Cancel in the save dialog keeps it open. */
  const saveAndCloseDocument = useCallback(async () => {
    const documentId = pendingCloseDocumentId;
    setPendingCloseDocumentId(null);
    if (documentId && await saveDocument(documentId)) removeDocument(documentId);
  }, [pendingCloseDocumentId, removeDocument, saveDocument]);

  /** The user chose to discard unsaved work, so its recovery copies go too. */
  const quitWithoutSaving = useCallback(async () => {
    await Promise.all(documentsRef.current.map((document) => removeRecovery(document.id).catch(() => {})));
    await getCurrentWindow().destroy();
  }, []);

  /**
   * Save all in the quit dialog: each image with unsaved changes is shown and
   * saved in turn. A cancelled or failed save stops the quit, so nothing is lost.
   */
  const saveAllAndQuit = useCallback(async () => {
    setQuitPending(false);
    for (const document of documentsRef.current.filter(isDocumentDirty)) {
      setActiveDocumentId(document.id);
      if (!await saveDocument(document.id)) return;
    }
    await quitWithoutSaving();
  }, [quitWithoutSaving, saveDocument]);

  const openFile = useCallback(() => {
    if (!isTauri()) {
      showNotice({ tone: "error", message: "Opening files is available in the Image Sage desktop app." });
      return;
    }
    setOpenDialogOpen(true);
  }, [showNotice]);

  /** Browser-only layout development: lets the console load a test image without the desktop shell. */
  useEffect(() => {
    if (!import.meta.env.DEV || isTauri()) return;
    const devWindow = window as unknown as { imagesageDevOpen?: (dataUrl: string) => Promise<void> };
    devWindow.imagesageDevOpen = async (dataUrl: string) => {
      addDocument({
        name: "Dev.imagesage",
        path: null,
        createdAt: new Date().toISOString(),
        origin: { kind: "imported", fileName: "dev.png" },
        surface: await canvasFromDataUrl(dataUrl),
        history: [],
        historyIndex: 0,
        startsDirty: false
      });
    };
    return () => { delete devWindow.imagesageDevOpen; };
  }, [addDocument]);

  const openConnect = useCallback(() => setConnectSection("new"), []);
  const dirtyCount = documents.filter(isDocumentDirty).length;

  /** A File menu command for the active editor; only that editor receives it. */
  const [editorCommand, setEditorCommand] = useState<EditorCommand | null>(null);
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const sendCommand = (name: EditorCommand["name"]) => {
    if (activeDocument) setEditorCommand({ name, documentId: activeDocument.id, nonce: Date.now() });
  };
  const menus: Menu[] = [
    {
      id: "file",
      label: "File",
      items: [
        { label: "New from prompt…", icon: <MagicWand size={15} />, run: () => setNewImageOpen(true) },
        { label: "Open…", icon: <FolderOpen size={15} />, disabled: opening, run: () => void openFile() },
        "separator",
        { label: "Save", icon: <FloppyDisk size={15} />, shortcut: "Ctrl+S", disabled: !activeDocument || activeDocument.saving, run: () => activeDocument && void saveDocument(activeDocument.id) },
        { label: "Save As…", shortcut: "Ctrl+Shift+S", disabled: !activeDocument || activeDocument.saving, run: () => activeDocument && void saveDocument(activeDocument.id, true) },
        "separator",
        { label: "Import Image…", icon: <DownloadSimple size={15} />, disabled: !activeDocument, run: () => sendCommand("import-image") },
        { label: "Export Image…", icon: <ImageSquare size={15} />, disabled: !activeDocument, run: () => sendCommand("export-image") },
        { label: "Export Video Slideshow…", icon: <FilmStrip size={15} />, disabled: !activeDocument, run: () => sendCommand("export-video") },
        "separator",
        { label: "Settings…", icon: <GearSix size={15} />, run: openConnect }
      ]
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { label: "Undo", icon: <ArrowCounterClockwise size={15} />, shortcut: "Ctrl+Z", disabled: !activeDocument, run: () => sendCommand("undo") },
        { label: "Redo", icon: <ArrowClockwise size={15} />, shortcut: "Ctrl+Y", disabled: !activeDocument, run: () => sendCommand("redo") }
      ]
    },
    {
      id: "help",
      label: "Help",
      items: [
        { label: "Keyboard shortcuts", icon: <Keyboard size={15} />, run: () => setShortcutsOpen(true) },
        { label: "About Image Sage", icon: <Info size={15} />, run: () => setAboutOpen(true) }
      ]
    }
  ];

  return (
    <main className="app-shell">
      <TitleBar
        updateAvailable={startupUpdate !== null}
        onAbout={() => setAboutOpen(true)}
        end={(
          <button
            className="ai-status"
            type="button"
            onClick={openConnect}
            data-help={`Settings: OpenAI API key. Charged through Image Sage today: ${formatUsd(spend.today)}. This month: ${formatUsd(spend.month)}. Use in other apps is not counted.`}
          >
            <span className="ai-status-dots">
              <span className={openaiReady ? "connected" : ""}><i aria-hidden="true" /> OpenAI</span>
            </span>
            {spend.month > 0 && <span className="ai-status-spend">{formatUsd(spend.month)} this month</span>}
          </button>
        )}
      />
      <MenuBar menus={menus} />

      {documents.length > 0 && (
        <div className="doc-tabs" role="tablist" aria-label="Open images">
          {documents.map((document) => {
            const active = document.id === activeDocumentId;
            const dirty = isDocumentDirty(document);
            const label = document.path ? document.name.replace(/\.imagesage$/i, "") : document.origin.kind === "imported" ? document.origin.fileName : "New Image";
            const spent = documentSpend(document);
            return (
              <div className={`doc-tab ${active ? "active" : ""}`} key={document.id}>
                <button
                  id={`image-tab-${document.id}`}
                  type="button"
                  className="doc-tab-select"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`image-panel-${document.id}`}
                  aria-label={dirty ? `${label}, unsaved changes` : label}
                  data-help={document.path ?? label}
                  onClick={() => setActiveDocumentId(document.id)}
                >
                  {document.busy && <SpinnerGap className="spin doc-tab-busy" size={13} />}
                  <span>
                    <strong className="doc-tab-name">{label}</strong>
                    {dirty && <i className="doc-tab-dirty" aria-hidden="true">*</i>}
                    {spent > 0 && <span className="doc-tab-spend"> ({formatUsd(spent)})</span>}
                  </span>
                </button>
                <button
                  type="button"
                  className="doc-tab-close"
                  aria-label={`Close ${label}`}
                  data-help={document.saving ? "Saving…" : `Close ${label}`}
                  disabled={document.saving}
                  onClick={() => requestCloseDocument(document.id)}
                >
                  {document.saving ? <SpinnerGap className="spin" size={13} /> : <X size={13} weight="bold" />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="app-content">
        {documents.length === 0 && (
          <section className="empty-state">
            <div className="empty-glow" />
            <div className="empty-icon"><img src="/app-icon.png" alt="" /></div>
            <h1>Prompt. Refine. Repeat.</h1>
            <p className="empty-copy">Open or generate images in layers. Edit using professional-grade tools. Export images and slideshows.</p>
            <div className="empty-actions">
              <button className="button primary large" onClick={() => setNewImageOpen(true)}>
                <MagicWand size={19} weight="bold" /> New from prompt
              </button>
              <button className="button secondary large" onClick={openFile}>
                <FolderOpen size={19} weight="bold" /> Open image
              </button>
            </div>
            {!openaiReady && isTauri() && (
              <button className="empty-connect" onClick={openConnect}>
                Add your OpenAI API key to start
              </button>
            )}
          </section>
        )}
        {documents.map((document) => (
          <DocumentPanel
            key={document.id}
            document={document}
            active={document.id === activeDocumentId}
            settings={settings}
            openaiConnected={keyStatuses.openai.connected}
            onRequestOpenAiSettings={openConnect}
            onSettingsChange={setSettings}
            onCommit={commitHistory}
            onBusyChange={setBusy}
            onSave={saveDocument}
            onExport={exportImage}
            onExportVideo={exportVideo}
            onNotice={showNotice}
            onFileTask={runFileTask}
            command={editorCommand?.documentId === document.id ? editorCommand : null}
          />
        ))}
      </div>

      {notice && (
        <div className={`notice ${notice.tone}`} style={noticeCenter ?? undefined} onPointerEnter={() => setNoticeHovered(true)} onPointerLeave={() => setNoticeHovered(false)}>
          {notice.tone === "success" ? <CheckCircle size={19} weight="fill" /> : notice.tone === "warning" ? <Warning size={19} weight="fill" /> : <WarningCircle size={19} weight="fill" />}
          <span>
            {notice.message}
            {notice.file && (
              <>
                {" "}
                <button
                  className="notice-file"
                  onClick={() => void invoke("reveal_file", { path: notice.file }).catch((error) => showNotice({ tone: "error", message: String(error) }))}
                  data-help="Open the folder in File Explorer"
                >
                  {notice.file}
                </button>
              </>
            )}
          </span>
          {notice.actions?.map((item) => (
            <button
              key={item.label}
              className="notice-action"
              onClick={() => {
                item.run();
                if (!item.keepOpen) setNotice(null);
              }}
            >
              {item.label}
            </button>
          ))}
          {notice.action && (
            <button
              className="notice-action"
              onClick={() => {
                notice.action!.run();
                setNotice(null);
              }}
            >
              {notice.action.label}
            </button>
          )}
          <button onClick={() => setNotice(null)} aria-label="Dismiss" data-help="Close">×</button>
        </div>
      )}

      {fileTasks.length > 0 && (
        <div className="file-task-overlay" role="status" aria-live="polite">
          <div className="file-task-card">
            <SpinnerGap className="spin" size={22} />
            <span>{fileTasks[fileTasks.length - 1].label}</span>
          </div>
        </div>
      )}


      {(pendingCloseDocument || quitPending) && (
        <div
          className="confirm-overlay"
          role="presentation"
          onPointerDown={() => { setPendingCloseDocumentId(null); setQuitPending(false); }}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-image-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="confirm-icon"><WarningCircle size={22} weight="fill" /></div>
            <div className="confirm-copy">
              {quitPending ? (
                <>
                  <h2 id="close-image-title">Quit Image Sage?</h2>
                  <p>{dirtyCount === 1 ? "One image has" : `${dirtyCount} images have`} unsaved changes or a running AI edit. Quitting discards them.</p>
                </>
              ) : (
                <>
                  <h2 id="close-image-title">Close {pendingCloseDocument?.path ? pendingCloseDocument.name : "this image"}?</h2>
                  <p>{pendingCloseDocument?.busy ? "An AI edit is still running. " : ""}Unsaved changes will be lost.</p>
                </>
              )}
            </div>
            <div className="confirm-actions">
              <button autoFocus className="button secondary" onClick={() => { setPendingCloseDocumentId(null); setQuitPending(false); }}>
                Cancel
              </button>
              <button
                className="button danger"
                onClick={() => quitPending ? void quitWithoutSaving() : confirmCloseDocument()}
              >
                {quitPending ? "Quit without saving" : "Close without saving"}
              </button>
              {(quitPending ? dirtyCount > 0 : pendingCloseDocument !== null && isDocumentDirty(pendingCloseDocument)) && (
                <button
                  className="button primary"
                  onClick={() => quitPending ? void saveAllAndQuit() : void saveAndCloseDocument()}
                  data-help={quitPending ? "Save each image with unsaved changes, then quit" : "Save the image, then close it"}
                >
                  {quitPending ? (dirtyCount === 1 ? "Save and quit" : "Save all and quit") : "Save and close"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {pendingImport && (
        <div className="confirm-overlay" role="presentation">
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="scale-image-title">
            <div className="confirm-icon"><WarningCircle size={22} weight="fill" /></div>
            <div className="confirm-copy">
              <h2 id="scale-image-title">Scale down {fileName(pendingImport.path)}?</h2>
              <p>
                The image is {pendingImport.surface.width} × {pendingImport.surface.height}. GPT Image can edit a whole image of up to
                3840 px per side and about 8.3 megapixels. Scale it down to {pendingImport.target.width} × {pendingImport.target.height}?
                If you keep the full size, edits are sent at a smaller size and come back softer.
              </p>
            </div>
            <div className="confirm-actions">
              <button className="button secondary" onClick={() => finishImport(false)}>Keep full size</button>
              <button autoFocus className="button primary" onClick={() => finishImport(true)}>
                Scale down to {pendingImport.target.width} × {pendingImport.target.height}
              </button>
            </div>
          </div>
        </div>
      )}

      {newImageOpen && (
        <NewImageDialog
          settings={settings}
          connected={openaiReady}
          onRequestConnect={openConnect}
          onSettingsChange={setSettings}
          onCancel={() => setNewImageOpen(false)}
          onStart={startGenerated}
        />
      )}
      {connectSection && (
        <ConnectDialog
          initialSection={connectSection}
          statuses={keyStatuses}
          generateModel={settings.generateModel}
          onStatusChange={setKeyStatus}
          onClose={() => setConnectSection(null)}
        />
      )}
      {openDialogOpen && (
        <OpenDialog
          onCancel={() => setOpenDialogOpen(false)}
          onOpen={(path) => {
            setOpenDialogOpen(false);
            void openPath(path);
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {aboutOpen && (
        <AboutDialog version={appVersion} initialUpdateInfo={startupUpdate} onClose={() => setAboutOpen(false)} />
      )}
      <Tooltips />
    </main>
  );
}
