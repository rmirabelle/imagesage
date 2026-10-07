import { invoke } from "@tauri-apps/api/core";
import {
  ArrowArcLeft,
  Camera,
  Check,
  Lasso,
  MagicWand,
  Minus,
  Plus,
  SpinnerGap,
  StopCircle,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  buildWholeUpload,
  canvasFromDataUrl,
  canvasToDataUrl,
  applyMaskStroke,
  cloneCanvas,
  context2d,
  createCanvas,
  drawFlatLayers,
  drawLayer,
  drawLayers,
  drawMaskGradient,
  flattenLayers,
  scaledCanvas,
  opaqueBounds,
  loadImage,
  navigateSurface,
  layerThumbnail,
  thumbnailOf,
  type AdjustCanvases,
  type FlatLayers,
  type LayerCanvases
} from "../editor/canvas";
import type { ImageDocument } from "../editor/imageDocument";
import { ADJUSTMENT_FIELDS, ADJUSTMENT_LABELS, adjustList, newAdjustmentId, toggleAllAdjustments, adjustmentFilter, adjustmentOpacity, adjustSignature, findAdjustment, hasAdjustments, maskSignature, moveLayer, newAdjustment, replaceAdjustment, resetAdjustment, type AdjustmentField } from "../editor/layers";
import {
  wholeImageSize
} from "../editor/region";
import type { Adjustment, BlendMode, EditStep, LayerAdjust, LayerPart, MaskImage, Point, Rect, SentRegion } from "../editor/types";
import {
  CANCELLED_MESSAGE,
  canAbort,
  canCancel,
  cancelAiRequest,
  IMAGE_MODELS,
  editWholeImage,
  generateImage,
  qualitiesFor,
  stageLabel,
  type AiProgress,
  type AiSettings,
  type AiStage
} from "../lib/ai";
import {
  estimateOpenAiImage,
  estimateWholeEdit,
  formatUsd,
  learnWholeEditInput,
  openAiActualCost,
  recordSpend,
  usePrices
} from "../lib/pricing";
import { modelStatus, type ModelId } from "../lib/models";
import { samEncode, samMask, type SamPoint } from "../lib/sam";
import { ModelDownloadDialog } from "./ModelDownloadDialog";
import { OpenDialog } from "./OpenDialog";
import { slideshowDuration, slideshowSegments, videoSize } from "../editor/slideshow";
import { encodeSlideshow, type SlideshowOptions } from "../lib/slideshowVideo";
import { SlideshowDialog } from "./SlideshowDialog";
import { SaveDialog, type SaveFormat, type SaveSettings } from "./SaveDialog";
import { StepsPanel, stepKey, type PartAction } from "./StepsPanel";

type Corner = "nw" | "ne" | "sw" | "se";
/** "mask" paints the selected layer's mask; "whole" is no tool. */
type Tool = "whole" | "mask";
/** A mask: the painted area (a PNG data URL), and whether that area is hidden; no `mask` means no mask. */
type MaskState = { mask?: string; hides?: boolean };
/** The owner of a mask: a step id, or `BASE_OWNER` for the original image. */
const BASE_OWNER = "";
/**
 * The copied mask, shared by every open image: its PNG, whether it hides,
 * and the size of the image it came from. The event tells every editor that
 * it changed, so their menus can offer Paste.
 */
let maskClipboard: { mask: string; hides: boolean; width: number; height: number } | null = null;
const MASK_CLIPBOARD_EVENT = "imagesage-mask-clipboard";
/** The model name of a layer imported from a file; the layers list shows it under the layer name. */
const IMPORTED_MODEL = "Imported image";
/** The model name of a layer copied from the original image. Like an imported layer, it cannot be regenerated. */
const ORIGINAL_COPY_MODEL = "Copy of the original";
/** The name the bottom layer gets: an opened image, or the first image generated in a new document. */
const ORIGINAL_LAYER_NAME = "Original image";
/**
 * The original image of a document as a normal bottom layer. A generated
 * original keeps its prompt and model, so it can be regenerated; its cost
 * stays on the document's origin, so it is not counted twice.
 */
const originalLayer = (doc: ImageDocument, layer: string): EditStep => {
  const area: Rect = { x: 0, y: 0, width: doc.surface.width, height: doc.surface.height };
  const { origin } = doc;
  return {
    id: crypto.randomUUID(),
    name: ORIGINAL_LAYER_NAME,
    prompt: origin.kind === "generated" ? origin.prompt : origin.fileName || "Opened image",
    model: origin.kind === "generated" ? origin.model : IMPORTED_MODEL,
    quality: origin.kind === "generated" ? origin.quality : "",
    createdAt: doc.createdAt,
    selection: { x: 0, y: 0, size: Math.min(area.width, area.height) },
    area,
    sent: { ...area, margin: 0, requestWidth: area.width, requestHeight: area.height },
    layer,
    ...(doc.baseAdjust ? { adjust: doc.baseAdjust } : {})
  };
};
/** Set when the user checks "Don't show again" in the Regenerate confirmation. */
const SKIP_REGEN_CONFIRM_KEY = "imagesage.skip-regenerate-confirm";
const skipRegenConfirm = () => {
  try { return localStorage.getItem(SKIP_REGEN_CONFIRM_KEY) === "1"; } catch { return false; }
};
/** A layer counts as showing at a point when its opacity there is above this (of 255). */
const PICK_ALPHA = 24;
/** One mask change, for Ctrl+Z and Ctrl+Y: the layer mask or an adjustment mask of one layer. */
type MaskChange = { owner: string; part: LayerPart; before: MaskState; after: MaskState };
/** One adjustment of a prepared layer: its filter (null when it changes nothing), its opacity (for opacity adjustments), and its mask. */
type PrepAdjustment = { id: string; filter: string | null; opacity: number | null; mask: HTMLCanvasElement | null; hides: boolean };
/**
 * What mask painting needs, prepared when the Mask tool is on: the selected
 * layer's image, its layer mask, its adjustments and their masks, which mask
 * is painted (`part`), and the layers below and above it.
 */
type MaskPrep = {
  owner: string;
  part: LayerPart;
  image: HTMLCanvasElement;
  layerMask: HTMLCanvasElement | null;
  layerHides: boolean;
  blend?: BlendMode;
  adjustments: PrepAdjustment[];
  below: HTMLCanvasElement;
  above: FlatLayers;
};
/** A mask brush stroke in progress. The stroke is drawn at full strength on `stroke`, then laid on `base` (the mask before the stroke) at `opacity`. */
type MaskBrushStroke = { prep: MaskPrep; last: Point; add: boolean; before: MaskState; base: HTMLCanvasElement; stroke: HTMLCanvasElement; opacity: number; frame: number | null };
/** A mask gradient being dragged on the image. */
type GradientDrag = { prep: MaskPrep; kind: "linear" | "radial"; from: Point; to: Point; before: MaskState; base: HTMLCanvasElement; created: boolean; opacity: number; frame: number | null };

/**
 * A layer's transform so far: a point (px, py) of the layer moves to
 * (a·px − b·py + x, b·px + a·py + y). a and b hold the scale and the rotation
 * (a = scale·cos, b = scale·sin), so the layer keeps its proportions.
 */
type LayerTransform = { a: number; b: number; x: number; y: number };
const IDENTITY: LayerTransform = { a: 1, b: 0, x: 0, y: 0 };
/**
 * A layer being transformed with handles on its bounds: the drawn layer, the
 * combined layers below and above it, the bounds before the transform, and
 * the transform so far.
 */
type ResizeSession = { owner: string; bounds: Rect; rendered: HTMLCanvasElement; below: HTMLCanvasElement; above: FlatLayers; transform: LayerTransform; frame: number | null; blend?: BlendMode };
/**
 * One drag during Transform, with the transform when the drag started:
 * a corner handle scales around the fixed opposite corner, the inside moves,
 * and the area just outside a corner rotates around the center.
 */
type ResizeDrag =
  | { kind: "scale"; pointerId: number; anchor: Point; corner: Point; start: LayerTransform }
  | { kind: "move"; pointerId: number; from: Point; start: LayerTransform }
  | { kind: "rotate"; pointerId: number; center: Point; angle: number; start: LayerTransform };
/** What a pointer position does during Transform. */
type TransformZone = { kind: "scale"; corner: Corner } | { kind: "rotate"; corner: Corner } | { kind: "move" } | null;
const applyTransform = (t: LayerTransform, p: Point): Point => ({ x: t.a * p.x - t.b * p.y + t.x, y: t.b * p.x + t.a * p.y + t.y });
/** The layer point that `transform` moves to `p`. */
const invertTransform = (t: LayerTransform, p: Point): Point => {
  const dx = p.x - t.x;
  const dy = p.y - t.y;
  const det = t.a * t.a + t.b * t.b;
  return { x: (t.a * dx + t.b * dy) / det, y: (-t.b * dx + t.a * dy) / det };
};
/** The transform followed by a scale of `factor` and a turn of `angle` radians around `center`. */
const aroundPoint = (t: LayerTransform, center: Point, factor: number, angle: number): LayerTransform => {
  const cos = Math.cos(angle) * factor;
  const sin = Math.sin(angle) * factor;
  const dx = t.x - center.x;
  const dy = t.y - center.y;
  return { a: cos * t.a - sin * t.b, b: sin * t.a + cos * t.b, x: center.x + cos * dx - sin * dy, y: center.y + sin * dx + cos * dy };
};
const rectCorner = (rect: Rect, corner: Corner): Point => ({
  x: corner.endsWith("e") ? rect.x + rect.width : rect.x,
  y: corner.startsWith("s") ? rect.y + rect.height : rect.y
});
/** Distance from a corner handle, in screen pixels, that still grabs the handle. */
const HANDLE_REACH = 8;
/** Distance outside a corner, in screen pixels, where a drag rotates the layer. */
const ROTATE_REACH = 36;
/**
 * A rotate cursor: a curved arrow with a head at each end. The arrow bends
 * around a top-left corner; `flipX` and `flipY` mirror it for the other corners.
 */
const rotateCursor = (flipX: boolean, flipY: boolean) => `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>"
  + `<g transform='translate(${flipX ? 24 : 0} ${flipY ? 24 : 0}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})'>`
  + "<g fill='none' stroke-linecap='round'><path d='M6 18 A12 12 0 0 1 18 6' stroke='#000' stroke-width='4'/><path d='M6 18 A12 12 0 0 1 18 6' stroke='#fff' stroke-width='2'/></g>"
  + "<path d='M2.5 15 L9.5 15 L6 21.5 Z M15 2.5 L15 9.5 L21.5 6 Z' fill='#fff' stroke='#000' stroke-width='1.2' stroke-linejoin='round'/>"
  + "</g></svg>"
)}") 12 12, crosshair`;
const ROTATE_CURSORS = [rotateCursor(false, false), rotateCursor(true, false), rotateCursor(false, true), rotateCursor(true, true)];

/** The adjustments of a node; the original image (node 0) keeps its own on the document. */
const adjustOf = (doc: ImageDocument, node: number): LayerAdjust | undefined => {
  const adjust = node > 0 ? doc.history[node - 1]?.adjust : doc.baseAdjust;
  return adjust && adjustList(adjust).length ? adjust : undefined;
};
/** The node of a mask owner, or -1 when the layer is gone. */
const nodeOfOwner = (doc: ImageDocument, owner: string) => {
  if (owner === BASE_OWNER) return 0;
  const index = doc.history.findIndex((step) => step.id === owner);
  return index < 0 ? -1 : index + 1;
};
/** The stored mask of one part of a layer. */
const partMaskState = (doc: ImageDocument, node: number, part: LayerPart): MaskState => {
  if (part === "mask") {
    const step = doc.history[node - 1];
    return step?.layerMask ? { mask: step.layerMask, hides: step.maskHides === true } : {};
  }
  const adjustment = findAdjustment(adjustOf(doc, node), part);
  return adjustment?.mask ? { mask: adjustment.mask, hides: adjustment.maskHides === true } : {};
};
/** The decode-cache key of an adjustment's mask; `ownerKey` is the step id, or `base:<document id>`. */
const adjustMaskKey = (ownerKey: string, id: string) => `${ownerKey}:adjust-${id}-mask`;
/** The decode-cache key of one part's mask. */
const maskCacheKey = (doc: ImageDocument, node: number, part: LayerPart) => {
  const ownerKey = node > 0 ? doc.history[node - 1].id : `base:${doc.id}`;
  return part === "mask" ? `${ownerKey}:mask` : adjustMaskKey(ownerKey, part);
};
/** The mask a prepared layer paints into. */
const prepTarget = (prep: MaskPrep) => {
  if (prep.part === "mask") return { mask: prep.layerMask, hides: prep.layerHides };
  const adjustment = prep.adjustments.find((item) => item.id === prep.part);
  return { mask: adjustment?.mask ?? null, hides: adjustment?.hides ?? false };
};
const setPrepTarget = (prep: MaskPrep, mask: HTMLCanvasElement | null, hides: boolean) => {
  if (prep.part === "mask") {
    prep.layerMask = mask;
    prep.layerHides = hides;
    return;
  }
  const adjustment = prep.adjustments.find((item) => item.id === prep.part);
  if (adjustment) {
    adjustment.mask = mask;
    adjustment.hides = hides;
  }
};
/** Largest side of the small copy that `maskCoverage` reads. */
const COVERAGE_PROBE_SIDE = 256;
/**
 * Whether a mask shows its whole layer, hides all of it, or neither. It reads
 * a small copy of the mask, so it stays fast for large images. With `hides`,
 * the painted area is the hidden one.
 */
const maskCoverage = (mask: HTMLCanvasElement, hides: boolean): "shows-all" | "hides-all" | "mixed" => {
  const scale = Math.min(1, COVERAGE_PROBE_SIDE / Math.max(mask.width, mask.height));
  const probe = createCanvas(Math.max(1, Math.round(mask.width * scale)), Math.max(1, Math.round(mask.height * scale)));
  const context = probe.getContext("2d", { willReadFrequently: true })!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(mask, 0, 0, probe.width, probe.height);
  const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
  let lowest = 255;
  let highest = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    lowest = Math.min(lowest, pixels[index]);
    highest = Math.max(highest, pixels[index]);
    if (lowest < 255 && highest > 0) return "mixed";
  }
  /** Fully painted, or not painted at all. */
  if (lowest === 255) return hides ? "hides-all" : "shows-all";
  return hides ? "shows-all" : "hides-all";
};
/**
 * The brush mode that can change a mask: Hide when the mask shows its whole
 * layer, Show when it hides all of it, else null (both modes can change it).
 * A part without a mask gets one from the first stroke, so it has no forced mode.
 */
const forcedMaskMode = (prep: MaskPrep): boolean | null => {
  const { mask, hides } = prepTarget(prep);
  if (!mask) return null;
  const coverage = maskCoverage(mask, hides);
  return coverage === "shows-all" ? false : coverage === "hides-all" ? true : null;
};
/** The prepared layer, ready to draw. */
const prepLayer = (prep: MaskPrep): LayerCanvases => ({
  image: prep.image,
  mask: prep.layerMask,
  maskHides: prep.layerHides,
  ...(prep.blend ? { blend: prep.blend } : {}),
  adjustments: prep.adjustments.flatMap(({ filter, opacity, mask, hides }) => filter ? [{ filter, mask, hides, ...(opacity !== null ? { opacity } : {}) }] : [])
});
/** The layer has a layer mask or adjustments, which a regenerate removes. */
const hasMaskOrAdjust = (step: EditStep) => Boolean(step.layerMask) || adjustList(step.adjust).length > 0;
/** A step with its `hidden` flag set or removed. */
const withHidden = (step: EditStep, hidden: boolean): EditStep => {
  const { hidden: _hidden, ...rest } = step;
  return hidden ? { ...rest, hidden: true } : rest;
};
/** A GPU-backed copy of a canvas, for drawing only. */
const drawingCopy = (source: HTMLCanvasElement) => {
  const copy = createCanvas(source.width, source.height);
  copy.getContext("2d")!.drawImage(source, 0, 0);
  return copy;
};
type PanState = { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number };
type EditJob = {
  requestId: string;
  /** Where the progress overlay sits: the whole image. */
  frame: Rect;
  sent: SentRegion;
  /** "Local" is work that runs on this PC: click to select and the video slideshow. */
  service: "OpenAI" | "Local";
  stage: AiStage | null;
  progress: number | null;
  partialDataUrl: string | null;
  startedAt: number;
  /** The prompt, for the waiting row in the layers list. */
  prompt: string;
  /** The layer a retry replaces, if any. */
  replaceId?: string;
  /** The GPT Image model and quality, for a snapshot layer of a partial preview. */
  model?: string;
  quality?: string;
  /** The partial preview already saved as a snapshot layer. */
  snapped?: string;
};
/**
 * Click to select in progress: what it fills, the prepared image (`key`),
 * the clicks so far and the mask they make. The image is prepared at most
 * 2048 px wide or tall, so clicks and the mask use that size (`scale` maps
 * image pixels to it).
 */
type ClickSelect = {
  target: { owner: string; part: LayerPart };
  key: string;
  scale: number;
  width: number;
  height: number;
  points: SamPoint[];
  mask: MaskImage | null;
  busy: boolean;
};
/** Click to select prepares an image at most this size. */
const CLICK_SELECT_MAX_SIDE = 2048;
/**
 * A message for the user; `action` adds a button to it, such as Undo. Success
 * and warning messages close by themselves; errors stay until the user closes them.
 */
/**
 * A message at the bottom of the window. `file` follows the message as a link
 * that opens its folder; a `sticky` message stays until a button closes it,
 * and `actions` add buttons that run and then close it, unless `keepOpen`.
 */
export type Notice = {
  tone: "success" | "warning" | "error";
  message: string;
  action?: { label: string; run: () => void };
  file?: string;
  sticky?: boolean;
  actions?: { label: string; run: () => void; keepOpen?: boolean }[];
  /** The image the message is about: it shows only while that image is selected. */
  documentId?: string;
} | null;

interface Props {
  document: ImageDocument;
  active: boolean;
  settings: AiSettings;
  /** OpenAI is connected; every edit needs it. */
  openaiConnected: boolean;
  onRequestOpenAiSettings: () => void;
  onSettingsChange: (settings: AiSettings) => void;
  onCommit: (id: string, patch: Partial<Pick<ImageDocument, "base" | "baseAdjust" | "history" | "historyIndex">>, markDirty?: boolean) => void;
  onBusyChange: (id: string, busy: boolean) => void;
  /** Saves to the document's file; `saveAs` asks for a file first. */
  onSave: (id: string, saveAs?: boolean) => Promise<boolean>;
  onExport: (id: string, dataUrl: string, format: SaveFormat) => Promise<boolean>;
  /** Asks where to save the video slideshow and writes it; false when the user cancels. */
  onExportVideo: (id: string, video: Blob) => Promise<boolean>;
  onNotice: (notice: Notice) => void;
  /** Shows the file loader with `label` while `work` runs. */
  onFileTask: <T>(label: string, work: () => Promise<T>) => Promise<T>;
  /** A File menu command for this editor, or null; only the active editor gets one. */
  command?: EditorCommand | null;
}

/**
 * File menu commands that open one of the editor's dialogs, for the document
 * `documentId`. `nonce` changes each time, so the same command can run again,
 * and an editor runs each nonce only once.
 */
export type EditorCommand = { name: "export-image" | "export-video" | "import-image" | "undo" | "redo"; documentId: string; nonce: number };

/** Ctrl+wheel zoom: the scale changes by exp(-deltaY × this); one wheel notch (100) is about 5%. */
const WHEEL_ZOOM_RATE = 0.0005;
const ZOOM_LEVELS = [0.05, 0.067, 0.1, 0.125, 0.16, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const SAVE_FORMAT_KEY = "imagesage.save-format";
const SAVE_MAX_WIDTH_KEY = "imagesage.save-max-width";
const SAVE_MAX_HEIGHT_KEY = "imagesage.save-max-height";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const BRUSH_RADIUS_KEY = "imagesage.brush-radius";
const BRUSH_PRECISE_KEY = "imagesage.brush-precise";
/** The soft edge of a precise brush, in image pixels, at every brush size; a soft brush blurs by 30% of its radius. */
const PRECISE_BRUSH_BLUR = 1.5;
const MASK_COLOR = "#ff3366";
/** Space above the image, for the layer name and the image size (matches `.canvas-scroll-area`). */
const CANVAS_TOP_SPACE = 46;
/** Space below the image for the mask shortcut tips and a margin under them. */
const MASK_TIPS_SPACE = 230;
/** Screen pixels around the first lasso corner where a click closes the shape. */
const LASSO_CLOSE_REACH = 8;
/** Panning stops when this much of the image (in screen pixels) is still in view at the window's edge. */
const PAN_KEEP_VISIBLE = 80;
/** Largest side of the mask preview canvas, in device pixels; it is redrawn when zoom changes. */
const MASK_PREVIEW_MAX = 4096;

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Export preferences are a convenience only. */
  }
};

const formatElapsed = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const oppositeCorner: Record<Corner, Corner> = { nw: "se", ne: "sw", sw: "ne", se: "nw" };

export function Editor({
  document: imageDocument,
  active,
  settings,
  openaiConnected,
  onRequestOpenAiSettings,
  onSettingsChange,
  onCommit,
  onBusyChange,
  onSave,
  onExport,
  onExportVideo,
  onNotice,
  onFileTask,
  command
}: Props) {
  usePrices();
  const { surface } = imageDocument;
  const width = surface.width;
  const height = surface.height;
  const documentRef = useRef(imageDocument);
  documentRef.current = imageDocument;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const surfaceHostRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<PanState | null>(null);
  const applyingRef = useRef(false);
  /** Shows the selected layer's painted mask area while the Mask tool is on. */
  const layerMaskCanvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("whole");
  /** The Mask tool is a toggle. */
  const toggleTool = (next: Exclude<Tool, "whole">) => setTool((current) => current === next ? "whole" : next);
  const [brushRadius, setBrushRadius] = useState(() => {
    const stored = Number(readStored(BRUSH_RADIUS_KEY));
    return Number.isFinite(stored) && stored >= 2 ? stored : 40;
  });
  /** A precise brush has a thin soft edge at every size; otherwise the edge is soft. */
  const [brushPrecise, setBrushPrecise] = useState(() => readStored(BRUSH_PRECISE_KEY) === "1");
  const toggleBrushPrecise = useCallback(() => {
    setBrushPrecise((precise) => {
      writeStored(BRUSH_PRECISE_KEY, precise ? "" : "1");
      return !precise;
    });
  }, []);
  /** The brush cursor follows the pointer by direct style changes, so painting does not render the editor on every move. */
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const brushPointRef = useRef<Point | null>(null);
  const [erasing, setErasing] = useState(false);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 900, height: 600 });
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** With Space held, Ctrl makes a click zoom in, and Ctrl+Alt makes it zoom out (as in Photoshop). */
  const [zoomKeys, setZoomKeys] = useState<"in" | "out" | null>(null);
  const spaceHeldRef = useRef(false);
  spaceHeldRef.current = spaceHeld;
  const stageRef = useRef<HTMLDivElement>(null);
  /** The image point under the pointer when Ctrl+wheel zooms, kept under the pointer after the zoom. */
  const zoomAnchorRef = useRef<{ clientX: number; clientY: number; imageX: number; imageY: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  /** AI edits that are running. Several can run at once; each shows its own progress box on the image. */
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [format, setFormat] = useState<SaveFormat>(() => readStored(SAVE_FORMAT_KEY) === "jpeg" ? "jpeg" : "png");
  const [maxWidthInput, setMaxWidthInput] = useState(() => readStored(SAVE_MAX_WIDTH_KEY) ?? "");
  const [maxHeightInput, setMaxHeightInput] = useState(() => readStored(SAVE_MAX_HEIGHT_KEY) ?? "");
  const [exporting, setExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  /** The layer waiting for the user to confirm Delete. */
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  /** Regenerate waiting for the user to confirm: the layer, and the prompt to run. */
  const [confirmRegen, setConfirmRegen] = useState<{ stepId: string; instruction: string } | null>(null);
  const [regenDontAsk, setRegenDontAsk] = useState(false);
  /** Which mask of the selected layer the Mask tool paints: "mask" for the layer mask, or an adjustment id. */
  const [maskPart, setMaskPart] = useState<LayerPart>("mask");
  /** The mask brush shows (true) or hides (false) what it paints; holding Alt does the other one. */
  const [maskShows, setMaskShows] = useState(true);
  /** Opacity of mask brush strokes and gradients, 1 to 100 percent. */
  const [maskOpacity, setMaskOpacityState] = useState(100);
  const setMaskOpacity = (next: number) => setMaskOpacityState(Math.max(1, Math.min(100, Math.round(next))));
  /** The opacity box's text while the user types in it; null shows the current opacity. */
  const [opacityDraft, setOpacityDraft] = useState<string | null>(null);
  /** While the Mask tool is on, red shows where the target mask hides (or does not apply). */
  const [maskOverlay, setMaskOverlay] = useState(true);
  /** A gradient waiting to be dragged on the image, or null. */
  const [gradient, setGradient] = useState<"linear" | "radial" | null>(null);
  /** The polygon lasso is on: clicks add corners of a shape, and closing the shape fills it in the mask. */
  const [lasso, setLasso] = useState(false);
  /** The corners placed so far, in image pixels. */
  const [lassoPoints, setLassoPointsState] = useState<Point[]>([]);
  const lassoPointsRef = useRef<Point[]>([]);
  const setLassoPoints = useCallback((points: Point[]) => {
    lassoPointsRef.current = points;
    setLassoPointsState(points);
  }, []);
  /** The time and place of the last lasso click, to find a double-click. */
  const lassoClickRef = useRef<{ time: number; point: Point } | null>(null);
  /** The pointer's place, for the line from the last corner to the pointer. */
  const lassoHoverRef = useRef<Point | null>(null);
  const lassoRubberRef = useRef<SVGLineElement>(null);
  /** The layer being resized: its bounds before resizing and the resize so far, for the handles. */
  const [resize, setResize] = useState<{ bounds: Rect; transform: LayerTransform } | null>(null);
  const resizeRef = useRef<ResizeSession | null>(null);
  const resizeDragRef = useRef<ResizeDrag | null>(null);
  /** Changing it draws the layers again, for example after a cancelled resize. */
  const [composeTick, setComposeTick] = useState(0);
  const [clickSelect, setClickSelectState] = useState<ClickSelect | null>(null);
  const clickSelectRef = useRef<ClickSelect | null>(null);
  const setClickSelect = useCallback((next: ClickSelect | null) => {
    clickSelectRef.current = next;
    setClickSelectState(next);
  }, []);
  /** Only the newest click's mask is shown, when masks come back out of order. */
  const clickSeqRef = useRef(0);
  /** A mask has been copied, so the mask menus offer Paste. */
  const [canPasteMask, setCanPasteMask] = useState(() => maskClipboard !== null);
  useEffect(() => {
    const onCopied = () => setCanPasteMask(maskClipboard !== null);
    window.addEventListener(MASK_CLIPBOARD_EVENT, onCopied);
    return () => window.removeEventListener(MASK_CLIPBOARD_EVENT, onCopied);
  }, []);
  /** The video slideshow settings dialog is open. */
  const [slideshowDialogOpen, setSlideshowDialogOpen] = useState(false);
  /** The file dialog for importing an image as a new layer is open. */
  const [importLayerOpen, setImportLayerOpen] = useState(false);
  /** The layers under a click, to pick from, where the menu opens, and each listed layer's visible pixels (`bounds`, by node). */
  const [layerPick, setLayerPick] = useState<{ x: number; y: number; nodes: number[]; bounds: Record<number, Rect | null> } | null>(null);
  /** The pick menu's layer under the pointer: the image marks its visible pixels with a box. */
  const [layerPickHover, setLayerPickHover] = useState<number | null>(null);
  /** The one-time click-to-select model download dialog; `resolve` gets true when the model is ready. */
  const [modelPrompt, setModelPrompt] = useState<{ model: ModelId; sizeBytes: number; resolve: (installed: boolean) => void } | null>(null);

  /** When the image fits the window, it leaves room for the layer name above it and the mask shortcut tips below it. */
  const fitScale = Math.min(
    Math.max(0.05, ((workspaceSize.width - 48) * pixelRatio) / width),
    Math.max(0.05, ((workspaceSize.height - CANVAS_TOP_SPACE - MASK_TIPS_SPACE) * pixelRatio) / height),
    1
  );
  /**
   * The image can be panned at every zoom: the space around it is almost a
   * window wide and tall, so it can move until only an edge of it shows.
   */
  const panSpaceX = Math.max(24, Math.round(workspaceSize.width - PAN_KEEP_VISIBLE));
  const panSpaceTop = Math.max(CANVAS_TOP_SPACE, Math.round(workspaceSize.height - PAN_KEEP_VISIBLE));
  const panSpaceBottom = Math.max(MASK_TIPS_SPACE, Math.round(workspaceSize.height - PAN_KEEP_VISIBLE));
  const displayScale = zoom ?? fitScale;
  const displayScaleRef = useRef(displayScale);
  displayScaleRef.current = displayScale;
  const cssScale = displayScale / pixelRatio;
  /** How many AI edits run for this document; the tab shows a spinner while any run. */
  const runningRef = useRef(0);
  /**
   * The running edit whose waiting row is selected in the layers list. Only
   * that edit shows its progress box on the image. A new edit is selected
   * when it starts; selecting a layer clears it.
   */
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const startJob = useCallback((documentId: string, started: EditJob) => {
    runningRef.current += 1;
    onBusyChange(documentId, true);
    setJobs((list) => [...list, started]);
    setSelectedJob(started.requestId);
  }, [onBusyChange]);
  const updateJob = useCallback((requestId: string, change: (existing: EditJob) => EditJob) => {
    setJobs((list) => list.map((item) => item.requestId === requestId ? change(item) : item));
  }, []);
  const endJob = useCallback((documentId: string, requestId: string) => {
    runningRef.current = Math.max(0, runningRef.current - 1);
    setJobs((list) => list.filter((item) => item.requestId !== requestId));
    onBusyChange(documentId, runningRef.current > 0);
  }, [onBusyChange]);
  const wholeSize = wholeImageSize(width, height);
  const lastStep = imageDocument.historyIndex > 0 ? imageDocument.history[imageDocument.historyIndex - 1] : null;
  /** The selected layer's adjustments; the original image keeps its own on the document. */
  const selectedAdjust = lastStep ? lastStep.adjust : imageDocument.baseAdjust;
  /**
   * The mask the Mask tool paints on the selected layer. The original image
   * has no layer mask, so there only an adjustment's mask can be painted.
   */
  const targetPart: LayerPart | null = maskPart !== "mask" && findAdjustment(selectedAdjust, maskPart)
    ? maskPart
    : lastStep ? "mask" : selectedAdjust?.[0]?.id ?? null;

  /** The surface canvas belongs to the document; the editor only hosts it. */
  useLayoutEffect(() => {
    const host = surfaceHostRef.current;
    if (!host) return;
    surface.className = "editor-surface";
    host.appendChild(surface);
    return () => {
      if (surface.parentElement === host) host.removeChild(surface);
    };
  }, [surface]);

  const changeBrushRadius = useCallback((next: number) => {
    const radius = Math.max(2, Math.min(1000, Math.round(next)));
    setBrushRadius(radius);
    try { localStorage.setItem(BRUSH_RADIUS_KEY, String(radius)); } catch { /* A remembered size is a convenience only. */ }
  }, []);

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWorkspaceSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      setPixelRatio(window.devicePixelRatio || 1);
    });
    const onWindowResize = () => setPixelRatio(window.devicePixelRatio || 1);
    observer.observe(element);
    window.addEventListener("resize", onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

  const anyJob = jobs.length > 0;
  /** GPT Image is making the layer selected in the layers list (its waiting row); the image gets a moving border. */
  const generating = jobs.some((job) => job.service === "OpenAI" && job.requestId === selectedJob);
  useEffect(() => {
    if (!anyJob) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [anyJob]);

  /** Decoded layer images and masks by key; an entry is reused while its data URL is unchanged. */
  const layerCacheRef = useRef(new Map<string, { src: string; canvas: HTMLCanvasElement }>());
  const decodeLayer = useCallback(async (key: string, src: string) => {
    const hit = layerCacheRef.current.get(key);
    if (hit && hit.src === src) return hit.canvas;
    const canvas = await canvasFromDataUrl(src);
    layerCacheRef.current.set(key, { src, canvas });
    return canvas;
  }, []);
  /** A layer's adjustments, decoded; `ownerKey` is the step id, or `base:<document id>` for the original image. */
  const adjustCanvases = useCallback(async (ownerKey: string, adjust?: LayerAdjust): Promise<AdjustCanvases[]> => {
    const list = await Promise.all(adjustList(adjust).map(async (adjustment) => {
      const filter = adjustmentFilter(adjustment);
      if (!filter) return null;
      const mask = adjustment.mask && !adjustment.maskOff ? await decodeLayer(adjustMaskKey(ownerKey, adjustment.id), adjustment.mask) : null;
      const opacity = adjustmentOpacity(adjustment);
      return { filter, mask, hides: adjustment.maskHides === true, ...(opacity !== null ? { opacity } : {}) };
    }));
    return list.filter((item): item is AdjustCanvases => item !== null);
  }, [decodeLayer]);
  /** The visible layers among `steps`, decoded; hidden layers are left out. */
  const layerCanvases = useCallback((steps: EditStep[]): Promise<LayerCanvases[]> => Promise.all(steps.filter((step) => !step.hidden).map(async (step) => ({
    image: await decodeLayer(`${step.id}:image`, step.layer ?? ""),
    mask: step.layerMask && !step.maskOff ? await decodeLayer(`${step.id}:mask`, step.layerMask) : null,
    maskHides: step.maskHides === true,
    adjustments: await adjustCanvases(step.id, step.adjust),
    ...(step.blend ? { blend: step.blend } : {})
  }))), [adjustCanvases, decodeLayer]);
  /** The original image with its adjustments, decoded, or null before the document has a base image. */
  const baseCanvases = useCallback(async (doc: Pick<ImageDocument, "id" | "base" | "baseAdjust">): Promise<LayerCanvases | null> => !doc.base ? null : {
    image: await decodeLayer(`base:${doc.id}`, doc.base),
    mask: null,
    maskHides: false,
    adjustments: await adjustCanvases(`base:${doc.id}`, doc.baseAdjust)
  }, [adjustCanvases, decodeLayer]);
  /** The combined image of the original and the given layers, on a new canvas. */
  const compositeOf = useCallback(async (doc: ImageDocument, steps: EditStep[]) => {
    const target = createCanvas(doc.surface.width, doc.surface.height);
    drawLayers(target, await baseCanvases(doc), await layerCanvases(steps));
    return target;
  }, [baseCanvases, layerCanvases]);

  /** A mask stroke in progress; while it runs, it draws the surface itself. */
  const maskStrokeRef = useRef<MaskBrushStroke | null>(null);
  /** A mask gradient being dragged; while it runs, it draws the surface itself. */
  const gradientRef = useRef<GradientDrag | null>(null);
  /** Settles when the surface shows the current layers; edits wait for it before they read the surface. */
  const composeRef = useRef<Promise<void>>(Promise.resolve());

  /** The surface shows all layers combined. */
  useEffect(() => {
    const doc = imageDocument;
    if (doc.base === undefined || maskStrokeRef.current || gradientRef.current || resizeRef.current) return;
    let cancelled = false;
    composeRef.current = (async () => {
      const base = await baseCanvases(doc);
      const layers = await layerCanvases(doc.history);
      if (!cancelled) drawLayers(doc.surface, base, layers);
    })().catch((error) => onNotice({ tone: "error", message: `Could not draw the layers: ${error instanceof Error ? error.message : String(error)}` }));
    return () => { cancelled = true; };
  }, [baseCanvases, composeTick, imageDocument.base, imageDocument.baseAdjust, imageDocument.history, imageDocument.id, imageDocument.surface, layerCanvases, onNotice]);

  /**
   * Every layer lives in the history, the original image included, so it gets
   * the same tools as any other layer. A new document, or one saved before
   * layers, has no base yet: each older before/after step becomes a full
   * layer, rendered by walking the old step tree on a copy of the surface.
   * A separate original image (from version 2 documents) becomes the bottom
   * layer. An empty original, such as the blank canvas of an image generated
   * from a prompt, is left out.
   */
  useEffect(() => {
    const doc = imageDocument;
    if (doc.base === "") return;
    let cancelled = false;
    void (async () => {
      let original = doc.base;
      let history = doc.history;
      if (original === undefined) {
        const copy = cloneCanvas(doc.surface);
        let at = doc.historyIndex;
        const images: string[] = [];
        for (let node = 0; node <= doc.history.length; node++) {
          await navigateSurface(copy, doc.history, at, node);
          at = node;
          images.push(await canvasToDataUrl(copy));
          if (cancelled) return;
        }
        original = images[0];
        history = doc.history.map(({ before: _before, after: _after, parent: _parent, ...step }, index) => ({ ...step, layer: images[index + 1] }));
      }
      const empty = opaqueBounds(await canvasFromDataUrl(original)) === null;
      if (cancelled) return;
      if (!empty) history = [originalLayer(doc, original), ...history];
      const historyIndex = empty ? Math.max(doc.historyIndex, Math.min(1, history.length)) : doc.historyIndex + 1;
      onCommit(doc.id, { base: "", baseAdjust: undefined, history, historyIndex }, false);
    })().catch((error) => onNotice({ tone: "error", message: `Could not prepare the layers: ${error instanceof Error ? error.message : String(error)}` }));
    return () => { cancelled = true; };
  }, [imageDocument, onCommit, onNotice]);

  /**
   * Layer previews by `stepKey`. A layer with a mask in use shows the masked
   * result (see-through where hidden), so each preview is cached under a
   * signature of the mask too.
   */
  const previewCacheRef = useRef(new Map<string, string>());
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  useEffect(() => {
    const { id, base, baseAdjust, history } = imageDocument;
    if (base === undefined) return;
    /** Layers with a mask in use or an adjustment get a drawn preview; the others use their own image. */
    const masked = (step: EditStep) => Boolean(step.layerMask && !step.maskOff) || hasAdjustments(step.adjust);
    const signature = (node: number) => {
      const step = history[node - 1];
      if (!step) return `${stepKey(id, history, 0)}|${adjustSignature(baseAdjust) || "raw"}`;
      if (!masked(step)) return `${step.id}|raw`;
      const mask = step.layerMask && !step.maskOff ? step.layerMask : "";
      return `${step.id}|${maskSignature(mask)}|${step.maskHides ? "hides" : "shows"}|${adjustSignature(step.adjust)}`;
    };
    const signatures = Array.from({ length: history.length + 1 }, (_, node) => signature(node));
    const publish = () => setThumbnails(Object.fromEntries(signatures.flatMap((key, node) => {
      const url = previewCacheRef.current.get(key);
      return url ? [[stepKey(id, history, node), url]] : [];
    })));
    publish();
    /** Without a separate original image, node 0 has no preview. */
    const missing = signatures.flatMap((key, node) => previewCacheRef.current.has(key) || (node === 0 && !base) ? [] : [node]);
    if (!missing.length) return;
    let cancelled = false;
    void (async () => {
      for (const node of missing) {
        const step = history[node - 1];
        let preview: HTMLCanvasElement;
        if (!step && hasAdjustments(baseAdjust)) {
          const layer = await baseCanvases({ id, base, baseAdjust });
          if (cancelled || !layer) return;
          previewCacheRef.current.set(signatures[node], layerThumbnail(layer));
          publish();
          continue;
        }
        if (!step) preview = await decodeLayer(`base:${id}`, base);
        else if (!masked(step)) preview = await decodeLayer(`${step.id}:image`, step.layer ?? "");
        else {
          const [layer] = await layerCanvases([{ ...step, hidden: false }]);
          if (cancelled) return;
          previewCacheRef.current.set(signatures[node], layerThumbnail(layer));
          publish();
          continue;
        }
        if (cancelled) return;
        previewCacheRef.current.set(signatures[node], thumbnailOf(preview));
        publish();
      }
    })().catch(() => { /* Previews are a convenience; the layers still work without them. */ });
    return () => { cancelled = true; };
  }, [baseCanvases, decodeLayer, imageDocument.base, imageDocument.baseAdjust, imageDocument.history, imageDocument.id, layerCanvases]);

  /**
   * Picks the layer that mask painting and Retry and Discard act on, and puts
   * its prompt in the prompt box. It does not change the image.
   */
  const selectLayer = useCallback((node: number) => {
    const current = documentRef.current;
    setSelectedJob(null);
    if (node < 0 || node > current.history.length || node === current.historyIndex) return;
    onCommit(current.id, { historyIndex: node }, false);
    /** The Mask tool belongs to the layer it was turned on for; picking a mask chip turns it on again for the new layer. */
    setTool((active) => active === "mask" ? "whole" : active);
    setGradient(null);
    const layerPrompt = node > 0 ? current.history[node - 1].prompt : current.origin.kind === "generated" ? current.origin.prompt : null;
    if (layerPrompt !== null) setPrompt(layerPrompt);
  }, [onCommit]);

  /** Layers hidden while a retry runs, with whether each was hidden before the retry. */
  const retryHiddenRef = useRef(new Map<string, boolean>());

  /**
   * Adds a finished edit as the top layer and selects it. `image` is the layer,
   * already drawn. With `replaceId` (a retry), the edit takes that layer's place
   * instead, keeps its name, and is shown, even if the old layer was hidden.
   * Its masks and adjustments are dropped, because they were made for the old
   * image. The replaced layer is returned, so the change can be undone.
   */
  const appendStep = useCallback((step: EditStep, image: HTMLCanvasElement, replaceId?: string): EditStep | null => {
    const latest = documentRef.current;
    layerCacheRef.current.set(`${step.id}:image`, { src: step.layer ?? "", canvas: image });
    const index = replaceId ? latest.history.findIndex((item) => item.id === replaceId) : -1;
    if (index < 0) {
      /** A new top layer has no mask, so it is the whole visible image. */
      context2d(latest.surface).drawImage(image, 0, 0);
      const history = [...latest.history, step];
      onCommit(latest.id, { history, historyIndex: history.length });
      return null;
    }
    /** A retry hid the old layer while it ran; Undo brings it back with the visibility from before the retry. */
    const wasHidden = retryHiddenRef.current.get(latest.history[index].id);
    retryHiddenRef.current.delete(latest.history[index].id);
    const old: EditStep = wasHidden === undefined ? latest.history[index] : withHidden(latest.history[index], wasHidden);
    const replaced: EditStep = old.name === undefined ? step : { ...step, name: old.name };
    onCommit(latest.id, { history: latest.history.map((item, at) => at === index ? replaced : item), historyIndex: index + 1 });
    return old;
  }, [onCommit]);

  /** Puts back a layer that a retry replaced. */
  const undoReplace = useCallback((old: EditStep, newId: string) => {
    const current = documentRef.current;
    const index = current.history.findIndex((item) => item.id === newId);
    if (index < 0) return;
    onCommit(current.id, { history: current.history.map((item, at) => at === index ? old : item), historyIndex: index + 1 });
  }, [onCommit]);

  /** Mask changes for Ctrl+Z and Ctrl+Y. */
  const maskUndoRef = useRef<MaskChange[]>([]);
  const maskRedoRef = useRef<MaskChange[]>([]);

  /**
   * Writes a layer's adjustments (node 0 is the original image) and selects
   * that layer. `markDirty` false keeps the document clean, for turning
   * adjustments on or off.
   */
  const commitAdjust = useCallback((doc: ImageDocument, node: number, adjust: LayerAdjust | undefined, markDirty = true) => {
    if (node === 0) {
      onCommit(doc.id, { baseAdjust: adjust, historyIndex: 0 }, markDirty);
      return;
    }
    const history = doc.history.map((step, index) => {
      if (index !== node - 1) return step;
      const { adjust: _adjust, ...rest } = step;
      return adjust ? { ...rest, adjust } : rest;
    });
    onCommit(doc.id, { history, historyIndex: node }, markDirty);
  }, [onCommit]);

  /** Sets or removes the mask of one part of a layer and selects that layer. False when the layer or the adjustment is gone. */
  const setPartMask = useCallback((owner: string, part: LayerPart, state: MaskState, canvas?: HTMLCanvasElement) => {
    const current = documentRef.current;
    const node = nodeOfOwner(current, owner);
    if (node < 0 || (part === "mask" && node === 0)) return false;
    const adjust = adjustOf(current, node);
    const adjustment = part === "mask" ? undefined : findAdjustment(adjust, part);
    if (part !== "mask" && !adjustment) return false;
    const key = maskCacheKey(current, node, part);
    if (state.mask && canvas) layerCacheRef.current.set(key, { src: state.mask, canvas });
    if (!state.mask) layerCacheRef.current.delete(key);
    /** Changing a mask turns it back on. */
    if (adjustment) {
      const { mask: _mask, maskHides: _hides, maskOff: _off, ...rest } = adjustment;
      const next: Adjustment = state.mask ? { ...rest, mask: state.mask, ...(state.hides ? { maskHides: true } : {}) } : rest;
      commitAdjust(current, node, replaceAdjustment(adjust, part, next));
      return true;
    }
    const history = current.history.map((step) => {
      if (step.id !== owner) return step;
      const { layerMask: _mask, maskHides: _hides, maskOff: _off, ...rest } = step;
      return state.mask ? { ...rest, layerMask: state.mask, ...(state.hides ? { maskHides: true } : {}) } : rest;
    });
    onCommit(current.id, { history, historyIndex: node });
    return true;
  }, [commitAdjust, onCommit]);

  const recordMaskChange = useCallback((change: MaskChange, canvas?: HTMLCanvasElement) => {
    maskUndoRef.current.push(change);
    maskRedoRef.current = [];
    setPartMask(change.owner, change.part, change.after, canvas);
  }, [setPartMask]);

  const undoMask = useCallback(() => {
    const change = maskUndoRef.current.pop();
    if (change && setPartMask(change.owner, change.part, change.before)) maskRedoRef.current.push(change);
  }, [setPartMask]);

  const redoMask = useCallback(() => {
    const change = maskRedoRef.current.pop();
    if (change && setPartMask(change.owner, change.part, change.after)) maskUndoRef.current.push(change);
  }, [setPartMask]);

  const isMaskTool = tool === "mask";
  /** The mask brush hides now: its mode, reversed while Alt is held. */
  const brushHides = maskShows === erasing;
  /** The mask brush shows the round brush cursor and uses the brush size; a waiting gradient and the lasso use a crosshair instead. */
  const brushLike = isMaskTool && !gradient && !lasso;
  /** A gradient and the lasso work only while the Mask tool is on. */
  useEffect(() => {
    if (isMaskTool) return;
    setGradient(null);
    setLasso(false);
  }, [isMaskTool]);
  /** A shape in progress belongs to one mask; it is dropped when the lasso turns off or another mask is picked. */
  useEffect(() => {
    setLassoPoints([]);
    lassoClickRef.current = null;
  }, [lasso, targetPart, imageDocument.historyIndex, setLassoPoints]);

  /** While a mask tool is on, the selected layer and the combined layers below and above it are ready for fast painting. */
  const maskPrepRef = useRef<MaskPrep | null>(null);

  /** Redraws the red view of where the target mask hides (empty when the Mask tool or the red view is off). */
  const redrawLayerMask = useCallback(() => {
    const canvas = layerMaskCanvasRef.current;
    if (!canvas) return;
    const scale = Math.min(cssScale * pixelRatio, MASK_PREVIEW_MAX / Math.max(width, height));
    const canvasWidth = Math.max(1, Math.round(width * scale));
    const canvasHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const prep = maskStrokeRef.current?.prep ?? gradientRef.current?.prep ?? maskPrepRef.current;
    if (!isMaskTool || !maskOverlay || !prep) return;
    /** No mask means the whole layer shows, so nothing is red. */
    const { mask, hides } = prepTarget(prep);
    if (!mask) return;
    if (hides) {
      context.drawImage(mask, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-in";
      context.fillStyle = MASK_COLOR;
      context.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      context.fillStyle = MASK_COLOR;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "destination-out";
      context.drawImage(mask, 0, 0, canvas.width, canvas.height);
    }
    context.globalCompositeOperation = "source-over";
  }, [cssScale, height, isMaskTool, maskOverlay, pixelRatio, width]);
  const redrawLayerMaskRef = useRef(redrawLayerMask);
  redrawLayerMaskRef.current = redrawLayerMask;
  useEffect(() => {
    redrawLayerMask();
  }, [redrawLayerMask]);
  /**
   * The layers below and above the selected one are combined once. A mask
   * stroke, a gradient, or a menu action changes only the selected layer, so
   * then only the selected layer's image and masks are refreshed from the cache.
   */
  const maskPrepKeyRef = useRef("");
  useEffect(() => {
    const doc = imageDocument;
    const node = doc.historyIndex;
    const part = targetPart;
    if (!isMaskTool || !part || doc.base === undefined || (node === 0 && !doc.base)) {
      maskPrepRef.current = null;
      maskPrepKeyRef.current = "";
      return;
    }
    const step = node > 0 ? doc.history[node - 1] : null;
    const ownerKey = step ? step.id : `base:${doc.id}`;
    const adjust = adjustOf(doc, node) ?? [];
    const key = [doc.id, maskSignature(doc.base), node, node > 0 ? adjustSignature(doc.baseAdjust) : "", ...doc.history.map((item, index) => index === node - 1
      ? item.id
      : [item.id, item.layer?.length, item.hidden, item.blend, item.maskOff, item.maskHides, maskSignature(item.layerMask), adjustSignature(item.adjust)].join(":"))].join("|");
    /** The target mask is used even while it is turned off; painting turns it on again. */
    const selectedParts = async () => ({
      owner: step ? step.id : BASE_OWNER,
      part,
      image: step ? await decodeLayer(`${step.id}:image`, step.layer ?? "") : await decodeLayer(`base:${doc.id}`, doc.base ?? ""),
      layerMask: step?.layerMask && (part === "mask" || !step.maskOff) ? await decodeLayer(`${step.id}:mask`, step.layerMask) : null,
      layerHides: step?.maskHides === true,
      ...(step?.blend ? { blend: step.blend } : {}),
      adjustments: await Promise.all(adjust.map(async (adjustment): Promise<PrepAdjustment> => ({
        id: adjustment.id,
        filter: adjustmentFilter(adjustment),
        opacity: adjustmentOpacity(adjustment),
        mask: adjustment.mask && (part === adjustment.id || !adjustment.maskOff) ? await decodeLayer(adjustMaskKey(ownerKey, adjustment.id), adjustment.mask) : null,
        hides: adjustment.maskHides === true
      })))
    });
    let cancelled = false;
    const prepared = maskPrepRef.current;
    if (key === maskPrepKeyRef.current && prepared) {
      void (async () => {
        const parts = await selectedParts();
        if (cancelled || maskStrokeRef.current || gradientRef.current) return;
        Object.assign(prepared, parts);
        redrawLayerMaskRef.current();
        const forced = forcedMaskMode(prepared);
        if (forced !== null) setMaskShows(forced);
      })().catch(() => { /* Painting waits until the mask is ready. */ });
      return () => { cancelled = true; };
    }
    maskPrepRef.current = null;
    maskPrepKeyRef.current = key;
    void (async () => {
      const [parts, below, layersAbove] = await Promise.all([
        selectedParts(),
        node > 0 ? compositeOf(doc, doc.history.slice(0, node - 1)) : Promise.resolve(createCanvas(doc.surface.width, doc.surface.height)),
        layerCanvases(doc.history.slice(node))
      ]);
      if (cancelled) return;
      const above = flattenLayers(doc.surface.width, doc.surface.height, layersAbove);
      maskPrepRef.current = { ...parts, below, above };
      redrawLayerMaskRef.current();
      const forced = forcedMaskMode(maskPrepRef.current);
      if (forced !== null) setMaskShows(forced);
    })().catch(() => { /* Painting waits until the layers are ready. */ });
    return () => { cancelled = true; };
  }, [compositeOf, decodeLayer, imageDocument.base, imageDocument.baseAdjust, imageDocument.history, imageDocument.historyIndex, imageDocument.id, imageDocument.surface, isMaskTool, layerCanvases, targetPart]);

  /**
   * Edits the whole image with GPT Image (the visible layers, or `from`); the
   * result is a new top layer, or replaces layer `replaceId`. On an empty
   * canvas, GPT Image generates the image from the prompt alone. `choice`
   * overrides the model and quality of the prompt bar.
   */
  const runWholeEdit = useCallback(async (instruction: string, from?: HTMLCanvasElement, replaceId?: string, choice?: { model: string; quality: string }) => {
    const current = documentRef.current;
    if (!instruction.trim() || applyingRef.current) return;
    if (resizeRef.current) {
      onNotice({ tone: "error", message: "Apply (Enter) or cancel (Esc) the transform first." });
      return;
    }
    if (!openaiConnected) {
      onRequestOpenAiSettings();
      return;
    }
    const imageWidth = current.surface.width;
    const imageHeight = current.surface.height;
    const size = wholeImageSize(imageWidth, imageHeight);
    if (!size) {
      onNotice({ tone: "error", message: "GPT Image cannot edit an image wider or taller than 3:1." });
      return;
    }
    const area: Rect = { x: 0, y: 0, width: imageWidth, height: imageHeight };
    const sent: SentRegion = { ...area, margin: 0, requestWidth: size.width, requestHeight: size.height };
    const sizeText = `${size.width}x${size.height}`;
    const model = choice?.model ?? settings.wholeModel;
    const quality = choice?.quality ?? settings.wholeQuality;
    const requestId = crypto.randomUUID();
    setNow(Date.now());
    startJob(current.id, { requestId, frame: area, sent, service: "OpenAI", stage: null, progress: null, partialDataUrl: null, startedAt: Date.now(), prompt: instruction.trim(), replaceId, model, quality });
    onNotice(null);
    try {
      await composeRef.current;
      const work = cloneCanvas(from ?? current.surface);
      const empty = opaqueBounds(work) === null;
      const onProgress = (progress: AiProgress) => {
        updateJob(requestId, (existing) => ({ ...existing, stage: progress.stage, partialDataUrl: progress.partialDataUrl ?? existing.partialDataUrl }));
      };
      const result = empty
        ? await generateImage(requestId, { prompt: instruction.trim(), model, quality, size: sizeText }, onProgress)
        : await editWholeImage(requestId, { prompt: instruction.trim(), model, quality, size: sizeText, imagePng: await buildWholeUpload(work, size.width, size.height) }, onProgress);
      const resultImage = await loadImage(result.dataUrl);
      const workContext = context2d(work);
      workContext.imageSmoothingEnabled = true;
      workContext.imageSmoothingQuality = "high";
      workContext.clearRect(0, 0, imageWidth, imageHeight);
      workContext.drawImage(resultImage, 0, 0, imageWidth, imageHeight);
      const cost = openAiActualCost(result.usage, model);
      recordSpend(cost);
      if (!empty) learnWholeEditInput(result.usage, model, sizeText);
      const step: EditStep = {
        id: requestId,
        prompt: instruction.trim(),
        model,
        quality,
        createdAt: new Date().toISOString(),
        selection: { x: 0, y: 0, size: Math.min(imageWidth, imageHeight) },
        area,
        sent,
        layer: await canvasToDataUrl(work),
        ...(cost !== null ? { cost } : {}),
        /** The first image in an empty document is its original. */
        ...(!replaceId && documentRef.current.base === "" && !documentRef.current.history.length ? { name: ORIGINAL_LAYER_NAME } : {})
      };
      const replaced = appendStep(step, work, replaceId);
      const estimateText = formatUsd(estimateOpenAiImage(model, quality, sizeText, instruction.length));
      onNotice({
        tone: "success",
        message: `${replaced ? `Layer replaced${hasMaskOrAdjust(replaced) ? "; its mask and adjustments were removed" : ""}.` : empty ? "Image generated." : "Whole image edited."} ${cost !== null ? `Charged ${formatUsd(cost)}.` : `Estimated cost ${estimateText}.`}`,
        ...(replaced ? { action: { label: "Undo", run: () => undoReplace(replaced, step.id) } } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== CANCELLED_MESSAGE) onNotice({ tone: "error", message });
    } finally {
      endJob(current.id, requestId);
    }
  }, [appendStep, endJob, onNotice, onRequestOpenAiSettings, openaiConnected, settings, startJob, undoReplace, updateJob]);

  /** A new image from a prompt: generate it once, as the first layer, when the tab opens. */
  const startedGenerationRef = useRef(false);
  useEffect(() => {
    const start = imageDocument.startGeneration;
    if (!start || startedGenerationRef.current) return;
    startedGenerationRef.current = true;
    setPrompt(start.prompt);
    void runWholeEdit(start.prompt, undefined, undefined, { model: start.model, quality: start.quality });
  }, [imageDocument.startGeneration, runWholeEdit]);

  /**
   * Saves the partial preview that GPT Image streams before its final image
   * as a new top layer. The finished edit lands above it later.
   */
  const snapshotPartial = useCallback(async (job: EditJob) => {
    const partial = job.partialDataUrl;
    if (!partial || job.snapped === partial) return;
    if (resizeRef.current) {
      onNotice({ tone: "error", message: "Apply (Enter) or cancel (Esc) the transform first." });
      return;
    }
    try {
      const current = documentRef.current;
      const image = await loadImage(partial);
      const layer = createCanvas(current.surface.width, current.surface.height);
      const layerContext = context2d(layer);
      layerContext.imageSmoothingEnabled = true;
      layerContext.imageSmoothingQuality = "high";
      layerContext.beginPath();
      layerContext.rect(job.frame.x, job.frame.y, job.frame.width, job.frame.height);
      layerContext.clip();
      layerContext.drawImage(image, job.sent.x, job.sent.y, job.sent.width, job.sent.height);
      const step: EditStep = {
        id: crypto.randomUUID(),
        prompt: job.prompt,
        name: "Preview snapshot",
        model: job.model ?? "",
        quality: job.quality ?? "",
        createdAt: new Date().toISOString(),
        selection: { x: job.frame.x, y: job.frame.y, size: Math.min(job.frame.width, job.frame.height) },
        area: job.frame,
        sent: job.sent,
        layer: await canvasToDataUrl(layer)
      };
      appendStep(step, layer);
      updateJob(job.requestId, (existing) => ({ ...existing, snapped: partial }));
      onNotice({ tone: "success", message: "Preview saved as a new layer." });
    } catch (error) {
      onNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [appendStep, onNotice, updateJob]);

  /** True when the model is on this PC; the first time, a dialog asks to download it. */
  const ensureModel = useCallback(async (model: ModelId) => {
    const status = await modelStatus(model);
    if (status.installed) return true;
    return new Promise<boolean>((resolve) => setModelPrompt({ model, sizeBytes: status.sizeBytes, resolve }));
  }, []);

  /**
   * Starts click to select on `source`, the layer's own image, for a mask.
   * The slow step, preparing the image, runs once; each click after that
   * updates the mask almost at once.
   */
  const startClickSelect = async (target: ClickSelect["target"], source: HTMLCanvasElement, label: string) => {
    if (applyingRef.current || resizeRef.current || clickSelectRef.current) return;
    try {
      if (!(await ensureModel("sam2"))) return;
    } catch (error) {
      onNotice({ tone: "error", message: String(error) });
      return;
    }
    const current = documentRef.current;
    const scale = Math.min(1, CLICK_SELECT_MAX_SIDE / Math.max(source.width, source.height));
    const upload = scale < 1 ? scaledCanvas(source, Math.round(source.width * scale), Math.round(source.height * scale)) : source;
    const requestId = crypto.randomUUID();
    const key = crypto.randomUUID();
    const frame = { x: 0, y: 0, width: source.width, height: source.height };
    setNow(Date.now());
    startJob(current.id, { requestId, frame, sent: { ...frame, margin: 0, requestWidth: frame.width, requestHeight: frame.height }, service: "Local", stage: null, progress: null, partialDataUrl: null, startedAt: Date.now(), prompt: label });
    onNotice(null);
    try {
      await samEncode(requestId, await canvasToDataUrl(upload), key, (progress) => {
        updateJob(requestId, (existing) => ({ ...existing, stage: progress.stage }));
      });
      setTool("whole");
      setGradient(null);
      setClickSelect({ target, key, scale, width: source.width, height: source.height, points: [], mask: null, busy: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== CANCELLED_MESSAGE) onNotice({ tone: "error", message });
    } finally {
      endJob(current.id, requestId);
    }
  };

  /** Asks for the mask of these clicks and shows it. */
  const updateClickMask = async (session: ClickSelect, points: SamPoint[]) => {
    const seq = ++clickSeqRef.current;
    setClickSelect({ ...session, points, busy: true });
    try {
      const result = points.length ? await samMask(session.key, points) : null;
      const latest = clickSelectRef.current;
      if (seq !== clickSeqRef.current || latest?.key !== session.key) return;
      setClickSelect({ ...latest, points, mask: result?.bounds ? { src: result.maskDataUrl, bounds: result.bounds } : null, busy: false });
    } catch (error) {
      const latest = clickSelectRef.current;
      if (latest?.key === session.key) setClickSelect({ ...latest, busy: false });
      onNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  /** A click adds the area under it; Alt+click removes it. */
  const addClickPoint = (point: Point, include: boolean) => {
    const session = clickSelectRef.current;
    if (!session) return;
    void updateClickMask(session, [...session.points, { x: point.x * session.scale, y: point.y * session.scale, include }]);
  };

  const undoClickPoint = () => {
    const session = clickSelectRef.current;
    if (session?.points.length) void updateClickMask(session, session.points.slice(0, -1));
  };

  const cancelClickSelect = () => {
    clickSeqRef.current += 1;
    setClickSelect(null);
  };

  /** Writes the mask into its target, a layer or adjustment mask; Ctrl+Z undoes it. */
  const applyClickSelect = async () => {
    const session = clickSelectRef.current;
    if (!session) return;
    if (!session.mask) {
      onNotice({ tone: "warning", message: "Click on the image to select an area first, or press Esc to cancel." });
      return;
    }
    let { src, bounds } = session.mask;
    if (session.scale !== 1) {
      src = await canvasToDataUrl(scaledCanvas(await canvasFromDataUrl(src), session.width, session.height));
      const x = Math.max(0, Math.floor(bounds.x / session.scale));
      const y = Math.max(0, Math.floor(bounds.y / session.scale));
      bounds = {
        x,
        y,
        width: Math.min(session.width, Math.ceil((bounds.x + bounds.width) / session.scale)) - x,
        height: Math.min(session.height, Math.ceil((bounds.y + bounds.height) / session.scale)) - y
      };
    }
    cancelClickSelect();
    const { owner, part } = session.target;
    const doc = documentRef.current;
    const node = nodeOfOwner(doc, owner);
    if (node < 0) return;
    const before = partMaskState(doc, node, part);
    const after: MaskState = { mask: src };
    recordMaskChange({ owner, part, before, after });
    onNotice({ tone: "success", message: "Mask set to the selected area.", action: { label: "Undo", run: () => recordMaskChange({ owner, part, before: after, after: before }) } });
  };

  const submit = () => {
    void runWholeEdit(prompt);
  };

  /** Delete asks first; the message after it has an Undo button. */
  const requestDelete = (node: number) => {
    if (node < 1 || node > documentRef.current.history.length || applyingRef.current) return;
    setConfirmDelete(node);
  };

  /** Puts a deleted layer back at its old place in the list and selects it. */
  const undoDelete = useCallback((step: EditStep, node: number) => {
    const current = documentRef.current;
    const at = Math.min(node, current.history.length + 1);
    const history = [...current.history.slice(0, at - 1), step, ...current.history.slice(at - 1)];
    onCommit(current.id, { history, historyIndex: at });
    onNotice({ tone: "success", message: "Layer restored." });
  }, [onCommit, onNotice]);

  /** Removes a layer, selects the one below it, and brings back its prompt so the edit can be tried again. */
  const deleteLayer = (node: number) => {
    setConfirmDelete(null);
    const current = documentRef.current;
    const step = current.history[node - 1];
    if (!step) return;
    const history = current.history.filter((_, index) => index !== node - 1);
    /** Without a separate original image, node 0 is no layer, so the layer above is selected instead. */
    onCommit(current.id, { history, historyIndex: current.base ? node - 1 : Math.max(node - 1, Math.min(1, history.length)) });
    setPrompt(step.prompt);
    onNotice({ tone: "success", message: `Layer ${node + 1} deleted.`, action: { label: "Undo", run: () => undoDelete(step, node) } });
  };

  /**
   * Runs `instruction` on the layers below a layer, as a whole-image edit. The
   * result replaces that layer. Layers made from a square or a painted area in
   * older versions are regenerated from the whole image too.
   */
  const retryLayer = async (stepId: string, instruction: string) => {
    const current = documentRef.current;
    const node = current.history.findIndex((item) => item.id === stepId) + 1;
    const step = current.history[node - 1];
    if (!step || !instruction.trim() || applyingRef.current) return;
    if (retryHiddenRef.current.has(step.id)) {
      onNotice({ tone: "error", message: "This layer is already being regenerated. Wait for that to finish." });
      return;
    }
    const below = await compositeOf(current, current.history.slice(0, node - 1));
    setPrompt(instruction);
    /** The old layer is hidden while the retry runs. If the retry fails or is cancelled, it shows again. */
    retryHiddenRef.current.set(step.id, step.hidden === true);
    setStepHidden(step.id, true);
    try {
      await runWholeEdit(instruction, below, step.id);
    } finally {
      /** A successful retry removes the entry when it replaces the layer; otherwise the old layer comes back. */
      const wasHidden = retryHiddenRef.current.get(step.id);
      if (wasHidden !== undefined) {
        retryHiddenRef.current.delete(step.id);
        setStepHidden(step.id, wasHidden);
      }
    }
  };

  /** Shows or hides one layer by its id, if it still exists. */
  const setStepHidden = (stepId: string, hidden: boolean) => {
    const latest = documentRef.current;
    if (!latest.history.some((item) => item.id === stepId)) return;
    onCommit(latest.id, { history: latest.history.map((item) => item.id === stepId ? withHidden(item, hidden) : item) }, false);
  };

  /**
   * Puts a copy of a layer directly above it and selects the copy. The copy
   * gets new ids for itself and its adjustments, and no cost, so the money
   * spent on the image is not counted twice.
   */
  const duplicateLayer = (node: number) => {
    const current = documentRef.current;
    if (node === 0) {
      duplicateOriginal();
      return;
    }
    const step = current.history[node - 1];
    if (!step || applyingRef.current || resizeRef.current) return;
    const { cost: _cost, parent: _parent, ...rest } = step;
    const copy: EditStep = {
      ...rest,
      id: crypto.randomUUID(),
      name: `${step.name || `Layer ${node}`} copy`,
      createdAt: new Date().toISOString(),
      ...(step.adjust ? { adjust: adjustList(step.adjust).map((adjustment) => ({ ...adjustment, id: newAdjustmentId() })) } : {})
    };
    const history = [...current.history.slice(0, node), copy, ...current.history.slice(node)];
    onCommit(current.id, { history, historyIndex: node + 1 });
    onNotice({ tone: "success", message: `Duplicated ${step.name || `Layer ${node}`}.` });
  };

  /**
   * Puts a copy of the original image, with copies of its adjustments, just
   * above it as a normal layer, and selects the copy.
   */
  const duplicateOriginal = () => {
    const current = documentRef.current;
    if (current.base === undefined || applyingRef.current || resizeRef.current) return;
    const area: Rect = { x: 0, y: 0, width: current.surface.width, height: current.surface.height };
    const copy: EditStep = {
      id: crypto.randomUUID(),
      name: "Original copy",
      prompt: current.origin.kind === "generated" ? current.origin.prompt : "Copy of the original image",
      model: ORIGINAL_COPY_MODEL,
      quality: "",
      createdAt: new Date().toISOString(),
      selection: { x: 0, y: 0, size: Math.min(area.width, area.height) },
      area,
      sent: { ...area, margin: 0, requestWidth: area.width, requestHeight: area.height },
      layer: current.base,
      ...(current.baseAdjust ? { adjust: adjustList(current.baseAdjust).map((adjustment) => ({ ...adjustment, id: newAdjustmentId() })) } : {})
    };
    onCommit(current.id, { history: [copy, ...current.history], historyIndex: 1 });
    onNotice({ tone: "success", message: "Duplicated the original image." });
  };

  /**
   * Exports a video slideshow: the original image, then each visible layer
   * fading in with its name, then a long hold on the final image and a fade
   * to black (timing in `editor/slideshow.ts`). The pictures are drawn at
   * video size first, so the encoder only mixes them.
   */
  const exportSlideshow = async (options: SlideshowOptions) => {
    setSlideshowDialogOpen(false);
    const doc = documentRef.current;
    if (exporting || applyingRef.current || resizeRef.current || clickSelectRef.current) return;
    setExporting(true);
    const requestId = crypto.randomUUID();
    const frame = { x: 0, y: 0, width, height };
    setNow(Date.now());
    startJob(doc.id, { requestId, frame, sent: { ...frame, margin: 0, requestWidth: width, requestHeight: height }, service: "Local", stage: "encoding", progress: 0, partialDataUrl: null, startedAt: Date.now(), prompt: "Video slideshow" });
    try {
      await composeRef.current;
      const visible = doc.history.map((step, index) => ({ step, node: index + 1 })).filter(({ step }) => !step.hidden);
      const [base, layers] = await Promise.all([baseCanvases(doc), layerCanvases(visible.map(({ step }) => step))]);
      const size = videoSize(width, height);
      const full = createCanvas(width, height);
      const context = full.getContext("2d")!;
      /** A separate original image (older documents) is the first picture; otherwise the bottom visible layer is. */
      const stages: HTMLCanvasElement[] = [];
      if (base) {
        drawLayer(context, base);
        stages.push(scaledCanvas(full, size.width, size.height));
      }
      for (const layer of layers) {
        drawLayer(context, layer);
        stages.push(scaledCanvas(full, size.width, size.height));
      }
      if (!stages.length) throw new Error("Show at least one layer first.");
      const names = [...(base ? ["Original image"] : []), ...visible.map(({ step, node }) => step.name || `Layer ${node}`)];
      const video = await encodeSlideshow(stages, names, options, (progress) => updateJob(requestId, (existing) => ({ ...existing, progress })));
      await onExportVideo(doc.id, video);
    } catch (error) {
      onNotice({ tone: "error", message: `Could not make the video: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      endJob(doc.id, requestId);
      setExporting(false);
    }
  };

  /**
   * Adds an image file as a new top layer. An image larger than the document
   * is scaled down to fit; it is centered, and Transform starts so it can be
   * moved and scaled at once. An Image Sage document comes in as its flattened image.
   */
  const importLayer = async (path: string) => {
    setImportLayerOpen(false);
    const current = documentRef.current;
    if (applyingRef.current || resizeRef.current || clickSelectRef.current) return;
    const file = path.split(/[\\/]/).pop() ?? "image";
    try {
      const { step, layer, scale } = await onFileTask(`Importing ${file}…`, async () => {
        const opened = await invoke<{ dataUrl: string }>("open_image_file", { path, includeHistory: false });
        const image = await canvasFromDataUrl(opened.dataUrl);
        const { width: docWidth, height: docHeight } = current.surface;
        const scale = Math.min(1, docWidth / image.width, docHeight / image.height);
        const drawWidth = Math.round(image.width * scale);
        const drawHeight = Math.round(image.height * scale);
        const layer = createCanvas(docWidth, docHeight);
        const context = layer.getContext("2d")!;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, Math.round((docWidth - drawWidth) / 2), Math.round((docHeight - drawHeight) / 2), drawWidth, drawHeight);
        const area: Rect = { x: 0, y: 0, width: docWidth, height: docHeight };
        const step: EditStep = {
          id: crypto.randomUUID(),
          prompt: `Imported from ${file}`,
          model: IMPORTED_MODEL,
          quality: "",
          createdAt: new Date().toISOString(),
          selection: { x: 0, y: 0, size: Math.min(docWidth, docHeight) },
          area,
          sent: { ...area, margin: 0, requestWidth: docWidth, requestHeight: docHeight },
          layer: await canvasToDataUrl(layer),
          name: file.replace(/\.[^.]+$/, "")
        };
        return { step, layer, scale };
      });
      appendStep(step, layer);
      onNotice({ tone: "success", message: `Imported ${file} as a new layer${scale < 1 ? ", scaled down to fit" : ""}. Drag to place it; Enter applies.` });
      /** Transform starts once the new layer is in the document. */
      window.setTimeout(() => {
        const latest = documentRef.current;
        const node = latest.history.findIndex((item) => item.id === step.id) + 1;
        if (node > 0) void startResize(node);
      }, 100);
    } catch (error) {
      onNotice({ tone: "error", message: `Could not import ${path}: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  /** Names a layer; an empty name removes it, so the layer shows its prompt again. */
  const renameLayer = (node: number, name: string) => {
    const current = documentRef.current;
    const step = current.history[node - 1];
    if (!step || (step.name ?? "") === name) return;
    const { name: _old, ...rest } = step;
    const history = current.history.map((item, index) => index === node - 1 ? (name ? { ...rest, name } : rest) : item);
    onCommit(current.id, { history });
  };

  /** Moves a layer in the stack and keeps it selected. */
  const moveLayerTo = (from: number, to: number, above: boolean) => {
    const current = documentRef.current;
    const moved = moveLayer(current.history, from, to, above);
    if (moved.history === current.history) return;
    onCommit(current.id, { history: moved.history, historyIndex: moved.node });
  };

  /**
   * Runs a chip action from the layers panel on one part of layer `node` (0 is
   * the original image). Picking a chip selects its layer and makes its mask
   * the Mask tool's target.
   */
  const partAction = async (node: number, part: LayerPart, action: PartAction) => {
    const current = documentRef.current;
    if (applyingRef.current || resizeRef.current || node < 0 || node > current.history.length) return;
    const step = node > 0 ? current.history[node - 1] : null;
    const owner = step?.id ?? BASE_OWNER;
    const adjust = adjustOf(current, node);
    const adjustment = part === "mask" ? undefined : findAdjustment(adjust, part);
    /** Writes this adjustment back, changed. */
    const update = (next: Adjustment) => commitAdjust(current, node, replaceAdjustment(adjust, part, next));
    const pick = (target: LayerPart) => {
      if (node !== current.historyIndex) selectLayer(node);
      setMaskPart(target);
      setTool("mask");
    };
    switch (action) {
      case "pick":
        /** A click on the mask that is already the target deselects it: the Mask tool turns off. R still shows or hides the red view. */
        if (isMaskTool && !gradient && !lasso && node === current.historyIndex && part === targetPart) {
          setTool("whole");
          return;
        }
        /** Picking a mask always shows its red view at once. */
        pick(part);
        setMaskOverlay(true);
        setGradient(null);
        setLasso(false);
        return;
      case "linear":
      case "radial":
        pick(part);
        setLasso(false);
        setGradient(action);
        return;
      case "lasso":
        pick(part);
        setGradient(null);
        setLasso(true);
        return;
      case "add-brightness":
      case "add-contrast":
      case "add-blur":
      case "add-hue-saturation":
      case "add-opacity": {
        /** A layer can have several adjustments, even of the same kind, each with its own mask. */
        const added = newAdjustment(action === "add-brightness" ? "brightness" : action === "add-contrast" ? "contrast" : action === "add-blur" ? "blur" : action === "add-opacity" ? "opacity" : "hueSaturation");
        commitAdjust(current, node, [...(adjust ?? []), added]);
        pick(added.id);
        return;
      }
      case "add-mask": {
        /** A new layer mask is black: the layer is hidden, and painting shows it. */
        if (!step || step.layerMask) return;
        const mask = createCanvas(width, height);
        recordMaskChange({ owner, part: "mask", before: {}, after: { mask: await canvasToDataUrl(mask) } }, mask);
        pick("mask");
        return;
      }
      case "mask-add": {
        /** A new adjustment mask is black: the adjustment applies nowhere, and painting applies it. */
        if (!adjustment || adjustment.mask) return;
        const mask = createCanvas(width, height);
        recordMaskChange({ owner, part, before: {}, after: { mask: await canvasToDataUrl(mask) } }, mask);
        pick(part);
        return;
      }
      case "mask-copy": {
        const state = partMaskState(current, node, part);
        if (!state.mask) return;
        maskClipboard = { mask: state.mask, hides: state.hides === true, width, height };
        window.dispatchEvent(new Event(MASK_CLIPBOARD_EVENT));
        onNotice({ tone: "success", message: "Mask copied." });
        return;
      }
      case "mask-paste": {
        /** The pasted mask replaces this one (Ctrl+Z undoes it); a mask from an image of another size is scaled to fit. */
        const copied = maskClipboard;
        if (!copied || (part === "mask" && node === 0)) return;
        let mask = copied.mask;
        if (copied.width !== width || copied.height !== height) {
          mask = await canvasToDataUrl(scaledCanvas(await canvasFromDataUrl(copied.mask), width, height));
        }
        const before = partMaskState(current, node, part);
        recordMaskChange({ owner, part, before, after: { mask, ...(copied.hides ? { hides: true } : {}) } });
        onNotice({ tone: "success", message: copied.width !== width || copied.height !== height ? "Mask pasted and scaled to this image." : "Mask pasted." });
        return;
      }
      case "mask-invert": {
        const before = partMaskState(current, node, part);
        if (before.mask) recordMaskChange({ owner, part, before, after: { ...before, hides: !before.hides } });
        return;
      }
      case "mask-delete": {
        const before = partMaskState(current, node, part);
        if (before.mask) recordMaskChange({ owner, part, before, after: {} });
        return;
      }
      case "mask-toggle":
        /** Turning a mask on or off is checked by looking at the image, so the red view goes off. */
        setMaskOverlay(false);
        if (part === "mask") {
          if (!step?.layerMask) return;
          const { maskOff: _off, ...rest } = step;
          onCommit(current.id, { history: current.history.map((item, index) => index === node - 1 ? (step.maskOff ? rest : { ...rest, maskOff: true }) : item) });
          return;
        }
        if (!adjustment?.mask) return;
        {
          const { maskOff: _off, ...rest } = adjustment;
          update(adjustment.maskOff ? rest : { ...rest, maskOff: true });
        }
        return;
      case "toggle-all":
        /** Turning adjustments on or off does not count as an unsaved change. */
        if (adjust) commitAdjust(current, node, toggleAllAdjustments(adjust), false);
        return;
      case "toggle":
        if (!adjustment) return;
        {
          const { off: _off, offByAll: _by, ...rest } = adjustment;
          commitAdjust(current, node, replaceAdjustment(adjust, part, adjustment.off ? rest : { ...rest, off: true }), false);
        }
        return;
      case "reset":
        if (adjustment) update(resetAdjustment(adjustment));
        return;
      case "resize":
        void startResize(node);
        return;
      case "duplicate":
        duplicateLayer(node);
        return;
      case "click-select": {
        const source = step ? step.layer : current.base;
        if (!source) return;
        const image = await decodeLayer(step ? `${step.id}:image` : `base:${current.id}`, source);
        void startClickSelect({ owner, part }, image, "Click to select");
        return;
      }
      case "blend-normal":
      case "blend-screen":
      case "blend-overlay": {
        if (!step) return;
        const { blend: _blend, ...rest } = step;
        const next = action === "blend-normal" ? rest : { ...rest, blend: action === "blend-screen" ? "screen" as const : "overlay" as const };
        onCommit(current.id, { history: current.history.map((item) => item.id === step.id ? next : item) });
        return;
      }
      case "delete":
        if (!adjustment) return;
        layerCacheRef.current.delete(maskCacheKey(current, node, part));
        commitAdjust(current, node, replaceAdjustment(adjust, part, undefined));
        if (node === current.historyIndex && maskPart === part) setMaskPart("mask");
        return;
      case "delete-all":
        if (!adjust?.length) return;
        for (const item of adjust) layerCacheRef.current.delete(maskCacheKey(current, node, item.id));
        commitAdjust(current, node, undefined);
        if (node === current.historyIndex && maskPart !== "mask") setMaskPart("mask");
        return;
    }
  };

  /**
   * Starts Transform on layer `node`, with handles on its bounds: the area where
   * the layer shows, which is the mask's area when the layer has a mask.
   */
  const startResize = async (node: number) => {
    const current = documentRef.current;
    const step = current.history[node - 1];
    if (!step || applyingRef.current || resizeRef.current) return;
    if (node !== current.historyIndex) selectLayer(node);
    setTool("whole");
    await composeRef.current;
    const [layer] = await layerCanvases([{ ...step, hidden: false }]);
    const rendered = createCanvas(width, height);
    drawLayer(context2d(rendered), layer);
    const bounds = opaqueBounds(rendered) ?? { x: 0, y: 0, width, height };
    const [below, layersAbove] = await Promise.all([
      compositeOf(current, current.history.slice(0, node - 1)),
      layerCanvases(current.history.slice(node))
    ]);
    const above = flattenLayers(width, height, layersAbove);
    const transform = IDENTITY;
    resizeRef.current = { owner: step.id, bounds, rendered, below, above, transform, frame: null, ...(step.blend ? { blend: step.blend } : {}) };
    setResize({ bounds, transform });
  };

  /** Draws the layer being resized on the next frame. */
  const drawResizePreview = (session: ResizeSession) => {
    if (session.frame !== null) return;
    session.frame = requestAnimationFrame(() => {
      session.frame = null;
      if (resizeRef.current !== session) return;
      const { a, b, x, y } = session.transform;
      const context = context2d(surface);
      context.save();
      context.clearRect(0, 0, width, height);
      context.drawImage(session.below, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.setTransform(a, b, -b, a, x, y);
      context.globalCompositeOperation = session.blend ?? "source-over";
      context.drawImage(session.rendered, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.setTransform(1, 0, 0, 1, 0, 0);
      drawFlatLayers(context, session.above);
      context.restore();
    });
  };

  const stopResize = () => {
    const session = resizeRef.current;
    if (session?.frame != null) cancelAnimationFrame(session.frame);
    resizeRef.current = null;
    resizeDragRef.current = null;
    if (workspaceRef.current) workspaceRef.current.style.cursor = "";
    setResize(null);
    return session;
  };

  /** Esc: the layer goes back to its size before resizing. */
  const cancelResize = () => {
    if (!stopResize()) return;
    setComposeTick((tick) => tick + 1);
  };

  /**
   * When the layers change during Transform (for example, an AI edit that
   * finishes), the layers below and above are prepared again. If the layer
   * itself is gone or changed, Transform ends without applying it.
   */
  useEffect(() => {
    const session = resizeRef.current;
    if (!session) return;
    const doc = documentRef.current;
    const node = nodeOfOwner(doc, session.owner);
    if (node < 1 || doc.id !== imageDocument.id) {
      cancelResize();
      return;
    }
    let cancelled = false;
    void (async () => {
      const [below, layersAbove] = await Promise.all([
        compositeOf(doc, doc.history.slice(0, node - 1)),
        layerCanvases(doc.history.slice(node))
      ]);
      if (cancelled || resizeRef.current !== session) return;
      session.below = below;
      session.above = flattenLayers(width, height, layersAbove);
      drawResizePreview(session);
    })().catch(() => { /* The old preview stays until the next change. */ });
    return () => { cancelled = true; };
  }, [imageDocument.history, imageDocument.baseAdjust, imageDocument.id]);

  /** Enter: the layer and its masks are drawn again at the new size. The message that follows can undo it. */
  const commitResize = async () => {
    const session = stopResize();
    if (!session) return;
    const transform = session.transform;
    const current = documentRef.current;
    const node = nodeOfOwner(current, session.owner);
    if (node < 1 || (transform.a === 1 && !transform.b && !transform.x && !transform.y)) {
      setComposeTick((tick) => tick + 1);
      return;
    }
    const step = current.history[node - 1];
    const scaled = (source: HTMLCanvasElement) => {
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d")!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.setTransform(transform.a, transform.b, -transform.b, transform.a, transform.x, transform.y);
      context.drawImage(source, 0, 0);
      return canvas;
    };
    try {
      /** The layer image, its layer mask, and each adjustment mask are drawn again with the transform. */
      const sources = [
        { key: `${step.id}:image`, src: step.layer ?? "" },
        ...(step.layerMask ? [{ key: `${step.id}:mask`, src: step.layerMask }] : []),
        ...adjustList(step.adjust).flatMap((item) => item.mask ? [{ key: adjustMaskKey(step.id, item.id), src: item.mask }] : [])
      ];
      const urls = new Map<string, string>();
      await Promise.all(sources.map(async ({ key, src }) => {
        const canvas = scaled(await decodeLayer(key, src));
        const url = await canvasToDataUrl(canvas);
        layerCacheRef.current.set(key, { src: url, canvas });
        urls.set(key, url);
      }));
      const resized: EditStep = {
        ...step,
        layer: urls.get(`${step.id}:image`),
        ...(step.layerMask ? { layerMask: urls.get(`${step.id}:mask`) } : {}),
        ...(step.adjust ? { adjust: adjustList(step.adjust).map((item) => item.mask ? { ...item, mask: urls.get(adjustMaskKey(step.id, item.id)) } : item) } : {})
      };
      const latest = documentRef.current;
      const index = latest.history.findIndex((item) => item.id === step.id);
      if (index < 0) return;
      onCommit(latest.id, { history: latest.history.map((item, at) => at === index ? resized : item), historyIndex: index + 1 });
      onNotice({
        tone: "success",
        message: "Layer transformed.",
        action: {
          label: "Undo",
          run: () => {
            const doc = documentRef.current;
            const at = doc.history.findIndex((item) => item.id === step.id);
            if (at >= 0) onCommit(doc.id, { history: doc.history.map((item, i) => i === at ? step : item) });
          }
        }
      });
    } catch (error) {
      setComposeTick((tick) => tick + 1);
      onNotice({ tone: "error", message: `Could not resize the layer: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  /** An image point from a pointer position. */
  const imagePoint = (clientX: number, clientY: number): Point => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: ((clientX - rect.left) / rect.width) * width, y: ((clientY - rect.top) / rect.height) * height };
  };

  /** What a drag at an image point would do: scale at a corner handle, rotate just outside a corner, move inside. */
  const transformZone = (session: ResizeSession, point: Point): TransformZone => {
    const reach = HANDLE_REACH / cssScale;
    let nearest: { corner: Corner; distance: number } | null = null;
    for (const corner of CORNERS) {
      const shown = applyTransform(session.transform, rectCorner(session.bounds, corner));
      const distance = Math.hypot(point.x - shown.x, point.y - shown.y);
      if (!nearest || distance < nearest.distance) nearest = { corner, distance };
    }
    if (nearest && nearest.distance <= reach) return { kind: "scale", corner: nearest.corner };
    const local = invertTransform(session.transform, point);
    const { bounds } = session;
    if (local.x >= bounds.x && local.x <= bounds.x + bounds.width && local.y >= bounds.y && local.y <= bounds.y + bounds.height) return { kind: "move" };
    if (nearest && nearest.distance <= ROTATE_REACH / cssScale) return { kind: "rotate", corner: nearest.corner };
    return null;
  };

  /**
   * The cursor for a zone. Scale cursors follow the layer's rotation; the
   * rotate cursor bends around the corner as it shows on screen.
   */
  const zoneCursor = (session: ResizeSession, zone: TransformZone) => {
    if (!zone) return "default";
    if (zone.kind === "move") return "move";
    const center = applyTransform(session.transform, { x: session.bounds.x + session.bounds.width / 2, y: session.bounds.y + session.bounds.height / 2 });
    const corner = applyTransform(session.transform, rectCorner(session.bounds, zone.corner));
    if (zone.kind === "rotate") return ROTATE_CURSORS[(corner.x > center.x ? 1 : 0) + (corner.y > center.y ? 2 : 0)];
    const angle = ((Math.atan2(corner.y - center.y, corner.x - center.x) * 180) / Math.PI + 360) % 180;
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][Math.round(angle / 45) % 4];
  };

  /** A press during Transform starts a scale, move, or rotate drag. True when it did. */
  const startTransformDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = resizeRef.current;
    if (!session || event.button !== 0) return false;
    const point = imagePoint(event.clientX, event.clientY);
    const zone = transformZone(session, point);
    if (!zone) return true;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = session.transform;
    if (zone.kind === "move") {
      resizeDragRef.current = { kind: "move", pointerId: event.pointerId, from: point, start };
    } else if (zone.kind === "scale") {
      resizeDragRef.current = {
        kind: "scale",
        pointerId: event.pointerId,
        anchor: applyTransform(start, rectCorner(session.bounds, oppositeCorner[zone.corner])),
        corner: applyTransform(start, rectCorner(session.bounds, zone.corner)),
        start
      };
    } else {
      const center = applyTransform(start, { x: session.bounds.x + session.bounds.width / 2, y: session.bounds.y + session.bounds.height / 2 });
      resizeDragRef.current = { kind: "rotate", pointerId: event.pointerId, center, angle: Math.atan2(point.y - center.y, point.x - center.x), start };
    }
    return true;
  };

  /** Moves, scales (keeping proportions), or rotates (Shift: in 15° steps) the layer; with no drag, shows the cursor for the zone. */
  const moveTransformDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = resizeRef.current;
    if (!session) return;
    const point = imagePoint(event.clientX, event.clientY);
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      if (workspaceRef.current && !spaceHeldRef.current) workspaceRef.current.style.cursor = zoneCursor(session, transformZone(session, point));
      return;
    }
    if (drag.kind === "move") {
      session.transform = { ...drag.start, x: drag.start.x + point.x - drag.from.x, y: drag.start.y + point.y - drag.from.y };
    } else if (drag.kind === "scale") {
      const dx = drag.corner.x - drag.anchor.x;
      const dy = drag.corner.y - drag.anchor.y;
      const length = dx * dx + dy * dy;
      if (!length) return;
      /** The layer stays at least 8 image pixels on its short side. */
      const scale = Math.hypot(drag.start.a, drag.start.b);
      const smallest = 8 / (scale * Math.max(1, Math.min(session.bounds.width, session.bounds.height)));
      const factor = Math.max(smallest, ((point.x - drag.anchor.x) * dx + (point.y - drag.anchor.y) * dy) / length);
      session.transform = aroundPoint(drag.start, drag.anchor, factor, 0);
    } else {
      let turn = Math.atan2(point.y - drag.center.y, point.x - drag.center.x) - drag.angle;
      if (event.shiftKey) {
        const step = Math.PI / 12;
        const startAngle = Math.atan2(drag.start.b, drag.start.a);
        turn = Math.round((startAngle + turn) / step) * step - startAngle;
      }
      session.transform = aroundPoint(drag.start, drag.center, 1, turn);
    }
    setResize({ bounds: session.bounds, transform: session.transform });
    drawResizePreview(session);
  };

  const endTransformDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** Sets one number of one adjustment of a layer, the original image included. Changes reach the image at most once per frame. */
  const adjustFrameRef = useRef<number | null>(null);
  const adjustPendingRef = useRef<{ node: number; id: string; field: AdjustmentField; value: number } | null>(null);
  const setAdjustmentValue = (node: number, id: string, field: AdjustmentField, value: number) => {
    adjustPendingRef.current = { node, id, field, value };
    if (adjustFrameRef.current !== null) return;
    adjustFrameRef.current = requestAnimationFrame(() => {
      adjustFrameRef.current = null;
      const pending = adjustPendingRef.current;
      const current = documentRef.current;
      if (!pending || pending.node > current.history.length) return;
      const adjust = adjustOf(current, pending.node);
      const adjustment = findAdjustment(adjust, pending.id);
      const range = adjustment && ADJUSTMENT_FIELDS[adjustment.kind].find((item) => item.field === pending.field);
      if (!adjustment || !range) return;
      const next = Math.round(Math.max(range.min, Math.min(range.max, pending.value)));
      if ((adjustment[pending.field] ?? 0) === next) return;
      commitAdjust(current, pending.node, replaceAdjustment(adjust, pending.id, { ...adjustment, [pending.field]: next }));
    });
  };

  /** Shows or hides every layer at once. */
  const setAllLayersVisible = (visible: boolean) => {
    const current = documentRef.current;
    if (!current.history.length) return;
    const history = current.history.map((step) => {
      const { hidden: _hidden, ...rest } = step;
      return visible ? rest : { ...rest, hidden: true };
    });
    /** Showing or hiding layers does not count as an unsaved change. */
    onCommit(current.id, { history }, false);
  };

  /** Shows or hides a whole layer. */
  /** The visibility of each layer before a solo, so a second Ctrl+click can bring it back. */
  const soloRef = useRef<{ documentId: string; owner: string; hidden: Map<string, boolean> } | null>(null);

  /**
   * Ctrl+click on a layer's eye: shows only that layer (and the original image,
   * which always shows). Ctrl+click again on the same layer, while it is still
   * the only one shown, brings back the visibility from before.
   */
  const soloLayer = (node: number) => {
    const current = documentRef.current;
    const step = current.history[node - 1];
    if (!step) return;
    const solo = soloRef.current;
    const soloed = !step.hidden && current.history.every((item) => item.id === step.id || item.hidden);
    if (soloed && solo && solo.documentId === current.id && solo.owner === step.id) {
      soloRef.current = null;
      onCommit(current.id, { history: current.history.map((item) => withHidden(item, solo.hidden.get(item.id) ?? false)) }, false);
      return;
    }
    soloRef.current = { documentId: current.id, owner: step.id, hidden: new Map(current.history.map((item) => [item.id, item.hidden === true])) };
    onCommit(current.id, { history: current.history.map((item) => withHidden(item, item.id !== step.id)) }, false);
  };

  const toggleLayerVisible = (node: number, solo = false) => {
    const current = documentRef.current;
    if (node < 1 || node > current.history.length) return;
    if (solo) {
      soloLayer(node);
      return;
    }
    const history = current.history.map((step, index) => {
      if (index !== node - 1) return step;
      const { hidden: _hidden, ...rest } = step;
      return step.hidden ? rest : { ...rest, hidden: true };
    });
    onCommit(current.id, { history }, false);
  };

  const cancelJob = (requestId: string) => {
    void cancelAiRequest(requestId);
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT";
      if (event.key === "Alt") setErasing(true);
      setZoomKeys(event.ctrlKey ? (event.altKey ? "out" : "in") : null);
      if (window.document.querySelector(".save-dialog-overlay, .open-dialog-overlay, .confirm-overlay, .about-dialog-overlay")) return;
      /** During click to select, Enter applies, Esc cancels and Ctrl+Z removes the last click; other keys wait. */
      if (clickSelectRef.current && !typing) {
        if (event.key === "Enter") {
          event.preventDefault();
          void applyClickSelect();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelClickSelect();
        } else if (event.ctrlKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          undoClickPoint();
        }
        return;
      }
      /** While a layer is resized, Enter applies the new size and Esc cancels; other keys wait. */
      if (resizeRef.current && !typing) {
        if (event.key === "Enter") {
          event.preventDefault();
          void commitResize();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelResize();
        }
        return;
      }
      /** Space held turns a left drag into panning; it must not press a focused button. */
      if (event.code === "Space" && !typing) {
        event.preventDefault();
        if (!event.repeat) setSpaceHeld(true);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave(documentRef.current.id, event.shiftKey);
      }
      if (event.key === "Escape" && !typing) {
        if (gradientRef.current) cancelGradientDrag();
        else if (gradient) setGradient(null);
        else if (lassoPointsRef.current.length) setLassoPoints([]);
        else if (lasso) setLasso(false);
        else if (isMaskTool) setTool("whole");
      }
      if (event.ctrlKey && event.key.toLowerCase() === "z" && !typing) {
        event.preventDefault();
        if (event.shiftKey) redoMask();
        else undoMask();
      }
      /** Ctrl+R is Redo too; the app blocks the browser's reload on it. */
      if (event.ctrlKey && (event.key.toLowerCase() === "y" || event.key.toLowerCase() === "r") && !typing) {
        event.preventDefault();
        redoMask();
      }
      /** Ctrl+T transforms the selected layer, as in Photoshop; the original image cannot be transformed. */
      if (event.ctrlKey && event.key.toLowerCase() === "t" && !typing) {
        event.preventDefault();
        if (documentRef.current.historyIndex > 0) void startResize(documentRef.current.historyIndex);
      }
      /** Ctrl+I inverts the mask the Mask tool paints, as in Photoshop. */
      if (event.ctrlKey && event.key.toLowerCase() === "i" && !typing && isMaskTool && targetPart) {
        event.preventDefault();
        void partAction(documentRef.current.historyIndex, targetPart, "mask-invert");
      }
      /** Ctrl+J duplicates the selected layer, as in Photoshop. */
      if (event.ctrlKey && event.key.toLowerCase() === "j" && !typing) {
        event.preventDefault();
        duplicateLayer(documentRef.current.historyIndex);
      }
      if (typing || event.ctrlKey || event.altKey) return;
      /** Delete asks to delete the selected layer; the original image cannot be deleted. */
      if (event.key === "Delete" && documentRef.current.historyIndex > 0) {
        event.preventDefault();
        requestDelete(documentRef.current.historyIndex);
      }
      if (event.key.toLowerCase() === "m" && targetPart) toggleTool("mask");
      /**
       * Mask brush keys: 1 to 9 set 10% to 90% opacity, 0 sets 100%, and + and −
       * on the number row change it by 10%; X swaps Show and Hide; R shows or
       * hides the red view.
       */
      if (isMaskTool && /^[0-9]$/.test(event.key)) {
        event.preventDefault();
        setMaskOpacity(event.key === "0" ? 100 : Number(event.key) * 10);
      }
      if (isMaskTool && (event.code === "Equal" || event.code === "Minus")) {
        event.preventDefault();
        setMaskOpacity(maskOpacity + (event.code === "Equal" ? 10 : -10));
      }
      if (isMaskTool && event.key.toLowerCase() === "x") setMaskShows((shows) => !shows);
      if (isMaskTool && event.key.toLowerCase() === "r") setMaskOverlay((shown) => !shown);
      if (isMaskTool && event.key.toLowerCase() === "p") toggleBrushPrecise();
      /** L turns the polygon lasso on or off; Enter fills the shape, and Backspace removes its last corner. */
      if (isMaskTool && targetPart && event.key.toLowerCase() === "l") {
        setGradient(null);
        setLasso((on) => !on);
      }
      if (lasso && event.key === "Enter" && lassoPointsRef.current.length >= 3) {
        event.preventDefault();
        fillLasso(lassoPointsRef.current, false);
      }
      if (lasso && event.key === "Backspace" && lassoPointsRef.current.length) {
        event.preventDefault();
        setLassoPoints(lassoPointsRef.current.slice(0, -1));
      }
      if (brushLike && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        const step = Math.max(2, Math.round(brushRadius * 0.15));
        changeBrushRadius(brushRadius + (event.key === "]" ? step : -step));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setErasing(false);
      if (event.code === "Space") setSpaceHeld(false);
      setZoomKeys(event.ctrlKey ? (event.altKey ? "out" : "in") : null);
    };
    const onBlur = () => {
      setErasing(false);
      setSpaceHeld(false);
      setZoomKeys(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  });
  const zoomOut = () => {
    const next = [...ZOOM_LEVELS].reverse().find((level) => level < displayScale - 0.001);
    setZoom(next ?? ZOOM_LEVELS[0]);
  };

  const zoomIn = () => {
    const next = ZOOM_LEVELS.find((level) => level > displayScale + 0.001);
    setZoom(next ?? ZOOM_LEVELS.at(-1)!);
  };

  /** Zooms one step in or out and keeps the image point under the pointer in place. */
  const zoomStepAt = useCallback((clientX: number, clientY: number, zoomIn: boolean) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const scale = displayScaleRef.current;
    zoomAnchorRef.current = {
      clientX,
      clientY,
      imageX: ((clientX - rect.left) / rect.width) * width,
      imageY: ((clientY - rect.top) / rect.height) * height
    };
    setZoom(zoomIn
      ? ZOOM_LEVELS.find((level) => level > scale + 0.001) ?? ZOOM_LEVELS.at(-1)!
      : [...ZOOM_LEVELS].reverse().find((level) => level < scale - 0.001) ?? ZOOM_LEVELS[0]);
  }, [height, width]);

  /**
   * Ctrl+wheel zooms smoothly around the pointer, about 5% per wheel notch.
   * The scale is kept in the ref at once, so fast wheel turns add up before the
   * editor renders again. The listener is not passive, so the page itself does not zoom.
   */
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const scale = displayScaleRef.current;
      const next = Math.min(ZOOM_LEVELS.at(-1)!, Math.max(ZOOM_LEVELS[0], scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE)));
      if (next === scale) return;
      if (!zoomAnchorRef.current) {
        zoomAnchorRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          imageX: ((event.clientX - rect.left) / rect.width) * width,
          imageY: ((event.clientY - rect.top) / rect.height) * height
        };
      }
      displayScaleRef.current = next;
      setZoom(next);
    };
    workspace.addEventListener("wheel", onWheel, { passive: false });
    return () => workspace.removeEventListener("wheel", onWheel);
  }, [height, width]);

  /** The image point (as a fraction of the image) at the middle of the window, kept while the user pans. */
  const viewCenterRef = useRef<{ x: number; y: number } | null>(null);
  /** Counts clicks on the zoom percent (fit to window); each one centers the image. */
  const [fitRequest, setFitRequest] = useState(0);
  const centeredFitRef = useRef(-1);
  /** The middle-of-window point right after the image was centered; while the view is still there, the image stays centered. */
  const centeredViewRef = useRef<{ x: number; y: number } | null>(null);
  const rememberViewCenter = () => {
    const workspace = workspaceRef.current;
    const stage = stageRef.current;
    if (!workspace || !stage || workspace.clientWidth === 0) return;
    const view = workspace.getBoundingClientRect();
    const rect = stage.getBoundingClientRect();
    viewCenterRef.current = {
      x: (view.left + workspace.clientWidth / 2 - rect.left) / rect.width,
      y: (view.top + workspace.clientHeight / 2 - rect.top) / rect.height
    };
  };

  /**
   * After the zoom or the window size changes, scroll so the image stays where
   * the user expects it. A Ctrl+wheel or Space-click zoom keeps the image point
   * under the pointer. The image is centered only when it first shows and when
   * the user clicks the zoom percent to fit it, with room for the layer name
   * above and the mask tips below. Any other change, such as the Mask tool
   * turning on or off, keeps the image point at the middle of the window there.
   */
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const workspace = workspaceRef.current;
    const stage = stageRef.current;
    zoomAnchorRef.current = null;
    if (!workspace || !stage || workspace.clientWidth === 0) return;
    const view = workspace.getBoundingClientRect();
    const rect = stage.getBoundingClientRect();
    if (anchor) {
      workspace.scrollLeft += rect.left + (anchor.imageX / width) * rect.width - anchor.clientX;
      workspace.scrollTop += rect.top + (anchor.imageY / height) * rect.height - anchor.clientY;
    } else if (
      centeredFitRef.current !== fitRequest
      || !viewCenterRef.current
      || (zoom === null && centeredViewRef.current
        && Math.abs(centeredViewRef.current.x - viewCenterRef.current.x) < 0.001
        && Math.abs(centeredViewRef.current.y - viewCenterRef.current.y) < 0.001)
    ) {
      centeredFitRef.current = fitRequest;
      const left = view.left + (workspace.clientWidth - rect.width) / 2;
      const top = view.top + (workspace.clientHeight - rect.height - CANVAS_TOP_SPACE - MASK_TIPS_SPACE) / 2 + CANVAS_TOP_SPACE;
      workspace.scrollLeft += rect.left - left;
      workspace.scrollTop += rect.top - top;
      rememberViewCenter();
      centeredViewRef.current = viewCenterRef.current;
      return;
    } else {
      const center = viewCenterRef.current;
      workspace.scrollLeft += rect.left + center.x * rect.width - (view.left + workspace.clientWidth / 2);
      workspace.scrollTop += rect.top + center.y * rect.height - (view.top + workspace.clientHeight / 2);
    }
    rememberViewCenter();
  }, [displayScale, fitRequest, height, panSpaceBottom, panSpaceTop, panSpaceX, width, zoom]);

  /**
   * Space+drag (or a middle drag) pans. With Space held, Ctrl+click zooms in
   * and Ctrl+Alt+click zooms out, around the pointer.
   */
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    /** During Transform, a left press anywhere in the workspace (without Space) drives the transform. */
    if (resizeRef.current && event.button === 0 && !spaceHeldRef.current) {
      if (startTransformDrag(event)) event.stopPropagation();
      return;
    }
    if (event.button !== 1 && !(event.button === 0 && spaceHeldRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 0 && event.ctrlKey) {
      zoomStepAt(event.clientX, event.clientY, !event.altKey);
      return;
    }
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: workspace.scrollLeft,
      scrollTop: workspace.scrollTop
    };
    setPanning(true);
  };

  const continuePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    moveTransformDrag(event);
    const pan = panRef.current;
    const workspace = workspaceRef.current;
    if (!pan || !workspace || pan.pointerId !== event.pointerId) return;
    workspace.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    workspace.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    endTransformDrag(event);
    const pan = panRef.current;
    const workspace = workspaceRef.current;
    if (!pan || !workspace || pan.pointerId !== event.pointerId) return;
    if (workspace.hasPointerCapture(event.pointerId)) workspace.releasePointerCapture(event.pointerId);
    panRef.current = null;
    setPanning(false);
  };

  /**
   * A click on the image (with the Mask tool off) selects the layer
   * that shows at that point: the first visible layer from the top that is not
   * transparent there, after its mask and adjustments. When several layers show
   * there, a menu lists them to pick from; when none does, the original image
   * is selected.
   */
  const pickLayerAt = async (point: Point, clientX: number, clientY: number) => {
    const doc = documentRef.current;
    const x = Math.min(width - 1, Math.floor(point.x));
    const y = Math.min(height - 1, Math.floor(point.y));
    const visible = doc.history.map((step, index) => ({ step, node: index + 1 })).filter(({ step }) => !step.hidden).reverse();
    const layers = await layerCanvases(visible.map(({ step }) => step));
    const probe = context2d(createCanvas(1, 1));
    const hits = visible.filter((_, index) => {
      probe.setTransform(1, 0, 0, 1, 0, 0);
      probe.clearRect(0, 0, 1, 1);
      probe.setTransform(1, 0, 0, 1, -x, -y);
      drawLayer(probe, layers[index]);
      return probe.getImageData(0, 0, 1, 1).data[3] > PICK_ALPHA;
    }).map(({ node }) => node);
    if (documentRef.current.id !== doc.id) return;
    /** Only an older document's separate original image is node 0; otherwise the original image is a layer among the hits. */
    const nodes = doc.base ? [...hits, 0] : hits;
    if (hits.length <= 1) {
      selectLayer(hits[0] ?? 0);
      return;
    }
    /** The bounds count only clearly visible pixels, as the click does; the separate original image fills the image. */
    const rendered = createCanvas(width, height);
    const renderedContext = context2d(rendered);
    const bounds: Record<number, Rect | null> = { 0: { x: 0, y: 0, width, height } };
    visible.forEach(({ node }, index) => {
      if (!hits.includes(node)) return;
      renderedContext.clearRect(0, 0, width, height);
      drawLayer(renderedContext, layers[index]);
      bounds[node] = opaqueBounds(rendered, PICK_ALPHA);
    });
    setLayerPickHover(null);
    setLayerPick({ x: clientX, y: clientY, nodes, bounds });
  };


  /**
   * The layer pick menu closes on any outside press, Escape, or when the
   * pointer leaves it after it was over it. The press that
   * opened it can still reach the window after this listener is added, so
   * presses from before the menu opened are ignored.
   */
  useEffect(() => {
    if (!layerPick) return;
    const openedAt = performance.now();
    const close = (event?: Event) => {
      if (event && event.type === "pointerdown" && event.timeStamp <= openedAt) return;
      setLayerPick(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    /**
     * Once the pointer has been over the menu, moving off it closes the menu.
     * WebView2 can drop a menu item's pointer leave, so any move off the items
     * also removes the box.
     */
    let entered = false;
    const onPointerMove = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".layer-pick-menu button")) setLayerPickHover(null);
      if (target?.closest(".layer-pick-menu")) entered = true;
      else if (entered) close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [layerPick]);

  const pointFromEvent = (event: { currentTarget: HTMLElement; clientX: number; clientY: number }): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width)),
      y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height))
    };
  };

  /** Draws the surface from a prepared layer while a mask stroke or gradient runs. */
  const redrawPrepared = (prep: MaskPrep) => {
    const surfaceContext = context2d(surface);
    surfaceContext.clearRect(0, 0, width, height);
    surfaceContext.drawImage(prep.below, 0, 0);
    drawLayer(surfaceContext, prepLayer(prep));
    drawFlatLayers(surfaceContext, prep.above);
    redrawLayerMaskRef.current();
  };

  /** Lays the stroke so far on the mask and redraws the surface. */
  const flushMaskStroke = (stroke: MaskBrushStroke) => {
    if (stroke.frame !== null) cancelAnimationFrame(stroke.frame);
    stroke.frame = null;
    const { mask } = prepTarget(stroke.prep);
    if (!mask) return;
    applyMaskStroke(mask, stroke.base, stroke.stroke, stroke.opacity, stroke.add);
    redrawPrepared(stroke.prep);
  };

  /** Paints one piece of a mask stroke and redraws the surface on the next frame. */
  const paintMaskSegment = (from: Point, to: Point) => {
    const stroke = maskStrokeRef.current;
    if (!stroke) return;
    const context = stroke.stroke.getContext("2d")!;
    context.save();
    context.filter = `blur(${brushPrecise ? PRECISE_BRUSH_BLUR : Math.max(0.5, brushRadius * 0.3)}px)`;
    context.strokeStyle = "#fff";
    context.fillStyle = "#fff";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = brushRadius * 2;
    context.beginPath();
    if (from === to) {
      context.arc(from.x, from.y, brushRadius, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }
    context.restore();
    if (stroke.frame !== null) return;
    stroke.frame = requestAnimationFrame(() => {
      stroke.frame = null;
      flushMaskStroke(stroke);
    });
  };

  /** Shows the gradient line from `from` to `to` (image points), or hides it for null. */
  const gradientLineRef = useRef<SVGSVGElement>(null);
  const moveGradientLine = (from: Point | null, to?: Point) => {
    const svg = gradientLineRef.current;
    if (!svg) return;
    if (!from || !to) {
      svg.style.display = "none";
      return;
    }
    svg.style.display = "";
    const [line, shadow, start, end, ring] = Array.from(svg.children) as SVGElement[];
    const x1 = String(from.x * cssScale), y1 = String(from.y * cssScale), x2 = String(to.x * cssScale), y2 = String(to.y * cssScale);
    for (const element of [line, shadow]) {
      element.setAttribute("x1", x1);
      element.setAttribute("y1", y1);
      element.setAttribute("x2", x2);
      element.setAttribute("y2", y2);
    }
    start.setAttribute("cx", x1);
    start.setAttribute("cy", y1);
    end.setAttribute("cx", x2);
    end.setAttribute("cy", y2);
    ring.setAttribute("cx", x1);
    ring.setAttribute("cy", y1);
    ring.setAttribute("r", gradientRef.current?.kind === "radial" ? String(Math.hypot(to.x - from.x, to.y - from.y) * cssScale) : "0");
  };

  /** Draws the dragged gradient into the mask and redraws the surface on the next frame. */
  const drawGradientDrag = (drag: GradientDrag) => {
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      const { mask, hides } = prepTarget(drag.prep);
      if (!mask) return;
      drawMaskGradient(mask, drag.base, drag.kind, drag.from, drag.to, drag.opacity, hides);
      redrawPrepared(drag.prep);
    });
  };

  /** Ends a gradient drag. A drag too short to set a direction changes nothing. */
  const finishGradientDrag = (commit: boolean) => {
    const drag = gradientRef.current;
    if (!drag) return;
    gradientRef.current = null;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    moveGradientLine(null);
    const { mask, hides } = prepTarget(drag.prep);
    const moved = Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) * cssScale >= 3;
    if (!mask || !commit || !moved) {
      if (drag.created) setPrepTarget(drag.prep, null, hides);
      else if (mask) {
        const context = mask.getContext("2d")!;
        context.save();
        context.globalCompositeOperation = "copy";
        context.drawImage(drag.base, 0, 0);
        context.restore();
      }
      redrawPrepared(drag.prep);
      return;
    }
    drawMaskGradient(mask, drag.base, drag.kind, drag.from, drag.to, drag.opacity, hides);
    redrawPrepared(drag.prep);
    setGradient(null);
    void canvasToDataUrl(mask).then((url) => recordMaskChange({ owner: drag.prep.owner, part: drag.prep.part, before: drag.before, after: { mask: url, hides } }, mask));
  };
  const cancelGradientDrag = () => finishGradientDrag(false);

  /** Moves the line from the last lasso corner to the pointer. */
  const moveLassoRubber = () => {
    const line = lassoRubberRef.current;
    const last = lassoPointsRef.current.at(-1);
    const hover = lassoHoverRef.current;
    if (!line) return;
    if (!last || !hover) {
      line.style.display = "none";
      return;
    }
    line.style.display = "";
    line.setAttribute("x1", String(last.x * cssScale));
    line.setAttribute("y1", String(last.y * cssScale));
    line.setAttribute("x2", String(hover.x * cssScale));
    line.setAttribute("y2", String(hover.y * cssScale));
  };
  useLayoutEffect(moveLassoRubber);

  /**
   * Fills the closed lasso shape in the target mask, like one brush stroke:
   * it shows or hides (Alt or `reverse` does the other one) at the brush
   * opacity, with a clean edge.
   */
  const fillLasso = (points: Point[], reverse: boolean) => {
    setLassoPoints([]);
    lassoClickRef.current = null;
    const prep = maskPrepRef.current;
    const doc = documentRef.current;
    const node = doc.historyIndex;
    if (!targetPart || points.length < 3 || !prep || prep.part !== targetPart || prep.owner !== (node > 0 ? doc.history[node - 1].id : BASE_OWNER)) return;
    const before = partMaskState(doc, node, targetPart);
    let { mask, hides } = prepTarget(prep);
    let shows = maskShows !== reverse;
    /** As with the brush, a mask that shows (or hides) everything can only be changed the other way. */
    const forced = forcedMaskMode(prep);
    if (forced !== null && forced !== shows) {
      shows = forced;
      if (!reverse) setMaskShows(forced);
    }
    if (!mask) {
      mask = createCanvas(width, height);
      hides = !shows;
      setPrepTarget(prep, mask, hides);
    }
    const shape = createCanvas(width, height);
    const context = shape.getContext("2d")!;
    context.fillStyle = "#fff";
    context.beginPath();
    points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.closePath();
    context.fill();
    applyMaskStroke(mask, drawingCopy(mask), shape, maskOpacity / 100, shows !== hides);
    redrawPrepared(prep);
    const filled = mask;
    const filledHides = hides;
    void canvasToDataUrl(filled).then((url) => recordMaskChange({ owner: prep.owner, part: prep.part, before, after: { mask: url, hides: filledHides } }, filled));
  };

  /**
   * A lasso click adds a corner. With three corners or more, a click on the
   * first corner or a double-click closes the shape and fills it.
   */
  const lassoClick = (point: Point, reverse: boolean) => {
    const points = lassoPointsRef.current;
    const now = performance.now();
    const last = lassoClickRef.current;
    lassoClickRef.current = { time: now, point };
    const near = (a: Point, b: Point, reach: number) => Math.hypot(a.x - b.x, a.y - b.y) * cssScale <= reach;
    if (points.length >= 3 && near(point, points[0], LASSO_CLOSE_REACH)) {
      fillLasso(points, reverse);
      return;
    }
    if (points.length >= 3 && last && now - last.time < 400 && near(point, last.point, 4)) {
      fillLasso(points, reverse);
      return;
    }
    setLassoPoints([...points, point]);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || resizeRef.current) return;
    if (clickSelectRef.current) {
      addClickPoint(pointFromEvent(event), !event.altKey);
      return;
    }
    if (isMaskTool) {
      if (!targetPart) {
        onNotice({ tone: "error", message: documentRef.current.base
          ? "The original image is the bottom layer, so it cannot have a layer mask. Add an adjustment to it to paint where the adjustment applies."
          : "Select a layer first." });
        return;
      }
      const prep = maskPrepRef.current;
      const doc = documentRef.current;
      const node = doc.historyIndex;
      if (!prep || prep.part !== targetPart || prep.owner !== (node > 0 ? doc.history[node - 1].id : BASE_OWNER)) return;
      if (lasso) {
        lassoClick(pointFromEvent(event), event.altKey);
        return;
      }
      const before = partMaskState(doc, node, targetPart);
      const point = pointFromEvent(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      let { mask, hides } = prepTarget(prep);
      if (gradient) {
        /** No mask means the whole part shows; a full mask that shows looks the same, and the gradient is mixed into it. */
        const created = !mask;
        if (!mask) {
          mask = createCanvas(width, height);
          const context = mask.getContext("2d")!;
          context.fillStyle = "#fff";
          context.fillRect(0, 0, width, height);
          hides = false;
          setPrepTarget(prep, mask, hides);
        }
        gradientRef.current = { prep, kind: gradient, from: point, to: point, before, base: drawingCopy(mask), created, opacity: maskOpacity / 100, frame: null };
        moveGradientLine(point, point);
        return;
      }
      /** Alt does the other one of Show and Hide while it is held. */
      let shows = maskShows !== event.altKey;
      /**
       * A mask that shows its whole layer can only be painted to hide, and one
       * that hides all of it only to show; the mode switches by itself.
       */
      const forced = forcedMaskMode(prep);
      if (forced !== null && forced !== shows) {
        shows = forced;
        if (!event.altKey) setMaskShows(forced);
      }
      /**
       * A part without a mask gets an empty one. Painting Show then shows (or
       * applies) only what is painted; painting Hide hides only what is painted.
       */
      if (!mask) {
        mask = createCanvas(width, height);
        hides = !shows;
        setPrepTarget(prep, mask, hides);
      }
      maskStrokeRef.current = {
        prep,
        last: point,
        add: shows !== hides,
        before,
        base: drawingCopy(mask),
        stroke: createCanvas(width, height),
        opacity: maskOpacity / 100,
        frame: null
      };
      paintMaskSegment(point, point);
      return;
    }
    pickLayerAt(pointFromEvent(event), event.clientX, event.clientY).catch((error) => onNotice({ tone: "error", message: `Could not find the layer at that point: ${String(error)}` }));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointFromEvent(event);
    if (isMaskTool) {
      const drag = gradientRef.current;
      if (drag) {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        drag.to = point;
        moveGradientLine(drag.from, point);
        drawGradientDrag(drag);
        return;
      }
      if (lasso) {
        lassoHoverRef.current = point;
        moveLassoRubber();
      }
      moveBrushCursor(gradient || lasso ? null : point);
      const stroke = maskStrokeRef.current;
      if (!stroke || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      if (Math.hypot(point.x - stroke.last.x, point.y - stroke.last.y) < Math.max(1, brushRadius * 0.15)) return;
      paintMaskSegment(stroke.last, point);
      stroke.last = point;
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gradientRef.current) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      finishGradientDrag(event.type === "pointerup");
      return;
    }
    const maskStroke = maskStrokeRef.current;
    if (maskStroke) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      flushMaskStroke(maskStroke);
      maskStrokeRef.current = null;
      const { mask, hides } = prepTarget(maskStroke.prep);
      if (!mask) return;
      void canvasToDataUrl(mask).then((url) => recordMaskChange({ owner: maskStroke.prep.owner, part: maskStroke.prep.part, before: maskStroke.before, after: { mask: url, hides } }, mask));
    }
  };
  const exportImage = async (exportSettings: SaveSettings) => {
    const maxWidth = Math.max(0, Math.floor(Number(exportSettings.maxWidth) || 0));
    const maxHeight = Math.max(0, Math.floor(Number(exportSettings.maxHeight) || 0));
    const scale = Math.min(1, maxWidth > 0 ? maxWidth / width : 1, maxHeight > 0 ? maxHeight / height : 1);
    setFormat(exportSettings.format);
    setMaxWidthInput(exportSettings.maxWidth);
    setMaxHeightInput(exportSettings.maxHeight);
    writeStored(SAVE_FORMAT_KEY, exportSettings.format);
    writeStored(SAVE_MAX_WIDTH_KEY, exportSettings.maxWidth);
    writeStored(SAVE_MAX_HEIGHT_KEY, exportSettings.maxHeight);
    setExportDialogOpen(false);
    setExporting(true);
    try {
      const output = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      const context = context2d(output);
      if (exportSettings.format === "jpeg") {
        context.fillStyle = "white";
        context.fillRect(0, 0, output.width, output.height);
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(surface, 0, 0, output.width, output.height);
      const dataUrl = await canvasToDataUrl(output, exportSettings.format === "png" ? "image/png" : "image/jpeg", 0.92);
      await onExport(imageDocument.id, dataUrl, exportSettings.format);
    } catch (error) {
      onNotice({ tone: "error", message: String(error) });
    } finally {
      setExporting(false);
    }
  };

  /** Shows the brush cursor at an image point, or hides it for null. */
  function moveBrushCursor(point: Point | null) {
    brushPointRef.current = point;
    const element = brushCursorRef.current;
    if (!element) return;
    if (!point) {
      element.style.display = "none";
      return;
    }
    const diameter = brushRadius * 2 * cssScale;
    element.style.display = "";
    element.style.transform = `translate(${point.x * cssScale - diameter / 2}px, ${point.y * cssScale - diameter / 2}px)`;
  }
  /** After any render (zoom, brush size), the cursor goes back to the last pointer position. */
  useLayoutEffect(() => {
    moveBrushCursor(brushPointRef.current);
  });

  /** A File or Edit menu command; import waits while Transform or click to select runs. */
  const handledCommandRef = useRef(0);
  useEffect(() => {
    if (!command || command.documentId !== imageDocument.id || command.nonce === handledCommandRef.current) return;
    handledCommandRef.current = command.nonce;
    /** Undo and Redo do what Ctrl+Z and Ctrl+Y do: while click to select runs, Undo removes the last click. */
    if (command.name === "undo") {
      if (clickSelectRef.current) undoClickPoint();
      else undoMask();
    } else if (command.name === "redo") {
      if (!clickSelectRef.current) redoMask();
    } else if (command.name === "export-image" || command.name === "export-video") {
      if (exporting) return;
      /** A new export first removes the message of the one before. */
      onNotice(null);
      if (command.name === "export-image") setExportDialogOpen(true);
      else setSlideshowDialogOpen(true);
    } else if (resizeRef.current || clickSelectRef.current) {
      onNotice({ tone: "error", message: "Apply or cancel the current tool (Enter or Esc) before you import an image." });
    } else {
      setImportLayerOpen(true);
    }
  }, [command]);

  /** Stable handlers for the memoized layers panel; each calls the latest version of its function. */
  const panelActionsRef = useRef({ selectLayer, toggleLayerVisible, setAllLayersVisible, requestDelete, renameLayer, moveLayerTo, partAction, setAdjustmentValue });
  panelActionsRef.current = { selectLayer, toggleLayerVisible, setAllLayersVisible, requestDelete, renameLayer, moveLayerTo, partAction, setAdjustmentValue };
  const panelHandlers = useMemo(() => ({
    onSelect: (node: number) => panelActionsRef.current.selectLayer(node),
    onToggleVisible: (node: number, solo: boolean) => panelActionsRef.current.toggleLayerVisible(node, solo),
    onShowAll: (visible: boolean) => panelActionsRef.current.setAllLayersVisible(visible),
    onDelete: (node: number) => panelActionsRef.current.requestDelete(node),
    onRename: (node: number, name: string) => panelActionsRef.current.renameLayer(node, name),
    onMove: (from: number, to: number, above: boolean) => panelActionsRef.current.moveLayerTo(from, to, above),
    onPartAction: (node: number, part: LayerPart, action: PartAction) => void panelActionsRef.current.partAction(node, part, action),
    onAdjustValue: (node: number, id: string, field: AdjustmentField, value: number) => panelActionsRef.current.setAdjustmentValue(node, id, field, value),
    onMaskDeselect: () => setTool("whole")
  }), []);

  const frameStyle = (rect: Rect) => ({
    left: rect.x * cssScale,
    top: rect.y * cssScale,
    width: rect.width * cssScale,
    height: rect.height * cssScale
  });
  const brushDiameter = brushRadius * 2 * cssScale;
  /**
   * The canvas names the selected layer; while the Mask tool is on, also the
   * mask it paints, for example "Layer 7 - Brightness Mask".
   */
  const maskTargetAdjustment = targetPart && targetPart !== "mask" ? findAdjustment(selectedAdjust, targetPart) : undefined;
  const selectedLayerName = lastStep ? lastStep.name || `Layer ${imageDocument.historyIndex}` : imageDocument.base ? "Original image" : "";
  const canvasLabel = isMaskTool && targetPart
    ? `${selectedLayerName} - ${maskTargetAdjustment ? `${ADJUSTMENT_LABELS[maskTargetAdjustment.kind]} Mask` : "Layer Mask"}`
    : selectedLayerName;
  /** Regenerate replaces the selected layer; layers not made by AI cannot be regenerated. */
  const regenStep = lastStep && lastStep.model !== IMPORTED_MODEL && lastStep.model !== ORIGINAL_COPY_MODEL ? lastStep : undefined;
  const regenName = lastStep ? lastStep.name || `Layer ${imageDocument.historyIndex}` : "the original image";
  const regenerate = () => {
    if (!regenStep || !prompt.trim()) return;
    if (skipRegenConfirm()) void retryLayer(regenStep.id, prompt);
    else {
      setRegenDontAsk(false);
      setConfirmRegen({ stepId: regenStep.id, instruction: prompt });
    }
  };
  const confirmRegenerate = () => {
    if (!confirmRegen) return;
    if (regenDontAsk) {
      try { localStorage.setItem(SKIP_REGEN_CONFIRM_KEY, "1"); } catch { /* The question comes back next time. */ }
    }
    setConfirmRegen(null);
    void retryLayer(confirmRegen.stepId, confirmRegen.instruction);
  };
  const confirmRegenStep = confirmRegen ? imageDocument.history.find((item) => item.id === confirmRegen.stepId) : undefined;
  /** GPT Image models offered for edits: the 2.5 models, plus the current one if it is older. */
  const editModels = IMAGE_MODELS.filter((model) => model.id.startsWith("gpt-image-2.5") || model.id === settings.wholeModel);

  /** Brush size controls, shown in the toolbar while the mask brush is on. */
  const brushSizeControls = (
    <span className="brush-size-inline" role="group" aria-label="Brush size">
      <button onClick={() => changeBrushRadius(brushRadius - Math.max(2, Math.round(brushRadius * 0.15)))} aria-label="Smaller brush" data-help="Smaller brush ([)"><Minus size={15} /></button>
      <span data-help="Brush diameter in image pixels">{brushRadius * 2} px</span>
      <button onClick={() => changeBrushRadius(brushRadius + Math.max(2, Math.round(brushRadius * 0.15)))} aria-label="Larger brush" data-help="Larger brush (])"><Plus size={15} /></button>
      <button
        className={`brush-precise ${brushPrecise ? "active" : ""}`}
        onClick={toggleBrushPrecise}
        aria-pressed={brushPrecise}
        data-help={brushPrecise ? "Precise brush: a thin soft edge at every size. Click for a soft brush (P)" : "Soft brush. Click for a precise brush with a thin soft edge (P)"}
      >
        Precise
      </button>
    </span>
  );

  /** Writes the typed opacity; text that is not a number keeps the old opacity. */
  const commitOpacityDraft = () => {
    if (opacityDraft !== null && opacityDraft.trim() && Number.isFinite(Number(opacityDraft))) setMaskOpacity(Number(opacityDraft));
    setOpacityDraft(null);
  };
  /** The brush opacity box: type a percentage, then Enter or click away. */
  const brushOpacityControl = (
    <label className="brush-opacity" data-help="Brush opacity, 1% to 100% (+ / −)">
      <span>Opacity</span>
      <input
        type="text"
        inputMode="numeric"
        aria-label="Brush opacity in percent"
        value={opacityDraft ?? String(maskOpacity)}
        onChange={(event) => setOpacityDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={commitOpacityDraft}
        onKeyDown={(event) => {
          /** Enter and Esc leave the box, so the brush keys work again. */
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setOpacityDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      <b>%</b>
    </label>
  );

  return (
    <section className="editor-shell">
      <div className="editor-toolbar">
        <div className="toolbar-side" />
        {/* The mask brush size stays centered; the sides take the rest of the width. */}
        <div className="toolbar-center">
          {isMaskTool && !gradient && (
            <div className="tool-section" role="group" aria-label={lasso ? "Polygon lasso" : "Mask brush"}>
              <span className="tool-section-label">{lasso ? "Lasso" : "Brush"}</span>
              <div className="tool-group brush-size-group">
                {!lasso && brushSizeControls}
                {brushOpacityControl}
                <button
                  className={`brush-lasso ${lasso ? "active" : ""}`}
                  onClick={() => setLasso((on) => !on)}
                  aria-pressed={lasso}
                  aria-label="Polygon lasso"
                  data-help={lasso ? "Polygon lasso is on: click corners, then close the shape to fill it. Click to paint with the brush again (L)" : "Polygon lasso: click corners on the image, then close the shape to fill it (L)"}
                >
                  <Lasso size={15} />
                </button>
                <button className="brush-close" onClick={() => setTool("whole")} aria-label="Stop painting the mask" data-help="Stop painting the mask (Esc)">
                  <X size={13} weight="bold" />
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="toolbar-side right">
          {resize && (
            <span className="crop-size">Drag inside to move, a corner to scale, or just outside a corner to rotate (Shift: 15° steps). Enter applies; Esc cancels.</span>
          )}
          {isMaskTool && gradient && (
            <span className="crop-size">Drag on the image for the {gradient} gradient. Esc cancels.</span>
          )}
          {isMaskTool && lasso && (
            <span className="crop-size">Click to add corners. Click the first corner, double-click, or press Enter to fill. Backspace removes a corner; Esc cancels.</span>
          )}
          <div className="editor-toolbar-spacer" />
        </div>
      </div>
      <div className="editor-body">
      <div className="editor-workspace-frame">
        <div
          ref={workspaceRef}
          className={`editor-workspace ${resize ? "transforming" : ""} ${panning ? "panning" : spaceHeld ? (zoomKeys === "in" ? "zoom-in-ready" : zoomKeys === "out" ? "zoom-out-ready" : "pan-ready") : ""}`}
          onPointerDownCapture={beginPan}
          onPointerMove={continuePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onAuxClick={(event) => event.preventDefault()}
          onScroll={rememberViewCenter}
        >
          <div className="canvas-scroll-area" style={{ padding: `${panSpaceTop}px ${panSpaceX}px ${panSpaceBottom}px` }}>
            <div
              ref={stageRef}
              className={`canvas-stage ${displayScale >= 2 ? "pixelated" : ""} ${generating ? "generating" : ""} ${isMaskTool && targetPart ? `mask-editing ${brushHides ? "mask-hides" : "mask-shows"}` : ""}`}
              style={{ width: width * cssScale, height: height * cssScale }}
            >
              <div ref={surfaceHostRef} className="surface-host" />
              {canvasLabel && (
                <span className="canvas-layer-label" role="status">
                  {canvasLabel}
                </span>
              )}
              <span className="image-size">{width} × {height}</span>
              {isMaskTool && targetPart && (
                <ul className="mask-shortcuts" aria-label="Mask shortcuts">
                  <li className={brushHides ? "hiding" : "showing"}>
                    Painting <strong>{brushHides ? "HIDES" : "SHOWS"}</strong> the current {targetPart === "mask" ? "layer" : "adjustment"} (<kbd>x</kbd> to swap)
                  </li>
                  <li className={maskOverlay ? "red-on" : ""}>Red mask: <strong>{maskOverlay ? "ON" : "OFF"}</strong> (<kbd>r</kbd> to toggle)</li>
                  <li className={brushPrecise ? "precise-on" : ""}>Brush: <strong>{brushPrecise ? "PRECISE" : "SOFT"}</strong> (<kbd>p</kbd> to toggle)</li>
                  <li className={lasso ? "precise-on" : ""}>Polygon lasso: <strong>{lasso ? "ON" : "OFF"}</strong> (<kbd>l</kbd> to toggle)</li>
                  <li><kbd>[</kbd> <kbd>]</kbd> - change brush size</li>
                  <li><kbd>1-9</kbd> - brush opacity (<kbd>0</kbd> for 100%)</li>
                  <li><kbd>esc</kbd> - exit mask</li>
                </ul>
              )}
              {!(isMaskTool && targetPart) && !resize && !clickSelect && (
                <ul className="mask-shortcuts" aria-label="Canvas shortcuts">
                  <li><kbd>m</kbd> - layer mask (add/edit)</li>
                  <li><kbd>space</kbd> - pan</li>
                  <li><kbd>CTRL</kbd> + <kbd>SPACE</kbd> - zoom in</li>
                  <li><kbd>CTRL</kbd> + <kbd>ALT</kbd> + <kbd>SPACE</kbd> - zoom out</li>
                  <li><kbd>click</kbd> - select a layer</li>
                </ul>
              )}
              <canvas ref={layerMaskCanvasRef} className={`mask-preview ${isMaskTool ? "" : "hidden"}`} aria-hidden="true" />
              {/* The lasso shape so far: its edges, a line to the pointer, and its corners; the first corner is larger, as the place to close it. */}
              {isMaskTool && lasso && lassoPoints.length > 0 && (
                <svg className="lasso-shape" width={width * cssScale} height={height * cssScale} aria-hidden="true">
                  <polyline className="lasso-edge-shadow" points={lassoPoints.map((point) => `${point.x * cssScale},${point.y * cssScale}`).join(" ")} />
                  <polyline className="lasso-edge" points={lassoPoints.map((point) => `${point.x * cssScale},${point.y * cssScale}`).join(" ")} />
                  <line ref={lassoRubberRef} className="lasso-rubber" />
                  {lassoPoints.map((point, index) => (
                    <circle key={index} className={index === 0 ? "lasso-start" : "lasso-corner"} cx={point.x * cssScale} cy={point.y * cssScale} r={index === 0 ? 5 : 3} />
                  ))}
                </svg>
              )}
              {/* The gradient being dragged: a line from start (white dot) to end (black dot), and the radius of a radial gradient. */}
              <svg ref={gradientLineRef} className="gradient-line" width={width * cssScale} height={height * cssScale} style={{ display: "none" }} aria-hidden="true">
                <line className="gradient-line-shadow" />
                <line className="gradient-line-main" />
                <circle className="gradient-line-start" r={5} />
                <circle className="gradient-line-end" r={5} />
                <circle className="gradient-line-ring" />
              </svg>
              {clickSelect && (
                <div className="click-select-layer" aria-hidden="true">
                  {clickSelect.mask && (
                    <div className="click-select-mask" style={{ WebkitMaskImage: `url(${clickSelect.mask.src})`, maskImage: `url(${clickSelect.mask.src})` }} />
                  )}
                  {clickSelect.points.map((point, index) => (
                    <i
                      key={index}
                      className={`click-select-point ${point.include ? "include" : "exclude"}`}
                      style={{ left: (point.x / clickSelect.scale) * cssScale, top: (point.y / clickSelect.scale) * cssScale }}
                    />
                  ))}
                </div>
              )}
              {resize && (() => {
                /** The transformed bounds and corner handles, in screen pixels. */
                const corners = (["nw", "ne", "se", "sw"] as Corner[]).map((corner) => applyTransform(resize.transform, rectCorner(resize.bounds, corner)));
                return (
                  <svg className="transform-frame" width={width * cssScale} height={height * cssScale} aria-hidden="true">
                    <polygon className="transform-frame-shadow" points={corners.map((p) => `${p.x * cssScale},${p.y * cssScale}`).join(" ")} />
                    <polygon className="transform-frame-line" points={corners.map((p) => `${p.x * cssScale},${p.y * cssScale}`).join(" ")} />
                    {corners.map((p, index) => <rect key={index} className="transform-handle" x={p.x * cssScale - 5} y={p.y * cssScale - 5} width={10} height={10} rx={2} />)}
                  </svg>
                );
              })()}
              {resize && (() => {
                /** Apply and Cancel sit below the lower-right of the transformed box, clear of the corner handles. */
                const corners = (["nw", "ne", "se", "sw"] as Corner[]).map((corner) => applyTransform(resize.transform, rectCorner(resize.bounds, corner)));
                const right = Math.max(...corners.map((p) => p.x)) * cssScale;
                const bottom = Math.max(...corners.map((p) => p.y)) * cssScale;
                return (
                  <div className="transform-actions" style={{ left: right, top: bottom + 18 }} onPointerDown={(event) => event.stopPropagation()}>
                    <button className="transform-apply" onClick={() => void commitResize()} aria-label="Apply transform" data-help="Apply the transform (Enter)">
                      <Check size={16} weight="bold" />
                    </button>
                    <button onClick={cancelResize} aria-label="Cancel transform" data-help="Cancel the transform (Esc)">
                      <X size={16} weight="bold" />
                    </button>
                  </div>
                );
              })()}
              {jobs.filter((job) => job.requestId === selectedJob).map((job) => (
                <div key={job.requestId} className="selection-mask working">
                  {job.partialDataUrl && (
                    <div className="partial-preview" style={frameStyle(job.frame)}>
                      <img
                        src={job.partialDataUrl}
                        alt=""
                        style={{
                          left: (job.sent.x - job.frame.x) * cssScale,
                          top: (job.sent.y - job.frame.y) * cssScale,
                          width: job.sent.width * cssScale,
                          height: job.sent.height * cssScale
                        }}
                      />
                      <button
                        className="partial-capture"
                        disabled={job.snapped === job.partialDataUrl}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => void snapshotPartial(job)}
                        data-help="Save this preview as a new layer before GPT Image replaces it"
                      >
                        <Camera size={15} weight="bold" /> {job.snapped === job.partialDataUrl ? "Captured" : "Capture"}
                      </button>
                    </div>
                  )}
                  <div className="selection-margin" style={frameStyle(job.sent)} />
                  <div className="selection-frame working" style={frameStyle(job.frame)}>
                    <div className="selection-progress" role="status">
                      <SpinnerGap className="spin" size={22} />
                      <strong>
                        {stageLabel(job.stage, job.service)}
                        {job.progress !== null && (job.stage === "generating" || job.stage === "encoding") && ` ${Math.round(job.progress * 100)}%`}
                      </strong>
                      <span>{formatElapsed(now - job.startedAt)}</span>
                      {(canCancel(job.stage) || canAbort(job.stage)) && (
                        <button
                          className="button secondary"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => cancelJob(job.requestId)}
                          data-help={canCancel(job.stage) ? undefined : "Stop waiting and discard this image. OpenAI still charges for it."}
                        >
                          <StopCircle size={15} weight="bold" /> {canCancel(job.stage) ? "Cancel" : "Abort"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {brushLike && (
                <div
                  ref={brushCursorRef}
                  className={`brush-cursor ${brushHides ? "erasing" : ""} ${spaceHeld || panning ? "pan-hidden" : ""}`}
                  aria-hidden="true"
                  style={{ left: 0, top: 0, width: brushDiameter, height: brushDiameter }}
                />
              )}
              <div
                className="interaction-layer"
                style={{ cursor: clickSelect ? "crosshair" : brushLike ? "none" : isMaskTool ? "crosshair" : "default" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => moveBrushCursor(null)}
              />
              {(() => {
                /**
                 * The box around the visible pixels of the layer under the pointer
                 * in the pick menu, above everything else on the image; the rest
                 * of the image goes darker. It is placed in percent of the image.
                 */
                const box = layerPick && layerPickHover !== null ? layerPick.bounds[layerPickHover] : null;
                return box ? (
                  <div className="layer-pick-clip" aria-hidden="true">
                    <div
                      className="layer-pick-box"
                      style={{ left: `${(box.x / width) * 100}%`, top: `${(box.y / height) * 100}%`, width: `${(box.width / width) * 100}%`, height: `${(box.height / height) * 100}%` }}
                    />
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        </div>
        {clickSelect && (
          <div className="click-select-bar" role="group" aria-label="Click to select">
            {clickSelect.busy ? <SpinnerGap className="spin" size={15} /> : null}
            <span>
              Set the mask: click to add · Alt+click to remove · Ctrl+Z undoes a click
            </span>
            <button className="click-select-apply" disabled={!clickSelect.mask} onClick={() => void applyClickSelect()} data-help="Apply (Enter)">
              <Check size={15} weight="bold" /> Apply
            </button>
            <button onClick={cancelClickSelect} data-help="Cancel (Esc)">
              <X size={15} weight="bold" /> Cancel
            </button>
          </div>
        )}
        <div className="canvas-zoom-control" role="group" aria-label="Image zoom">
          <button onClick={zoomIn} data-help="Zoom in" aria-label="Zoom in"><Plus size={16} /></button>
          <button
            className={`canvas-zoom-value ${zoom === null ? "fit" : ""}`}
            onClick={() => {
              setZoom(null);
              setFitRequest((count) => count + 1);
            }}
            data-help={`Fit to window (${Math.round(fitScale * 100)}%). Hold Space and drag, or middle-drag, to pan.`}
            aria-label={`Zoom ${Math.round(displayScale * 100)} percent; click to fit`}
          >
            {Math.round(displayScale * 100)}%
          </button>
          <button onClick={zoomOut} data-help="Zoom out" aria-label="Zoom out"><Minus size={16} /></button>
        </div>
      </div>
      <StepsPanel
        documentId={imageDocument.id}
        hasBase={Boolean(imageDocument.base)}
        baseAdjust={imageDocument.baseAdjust}
        origin={imageDocument.origin}
        history={imageDocument.history}
        current={imageDocument.historyIndex}
        maskTarget={isMaskTool ? targetPart : null}
        maskRedShown={maskOverlay}
        pending={[...jobs].reverse().map((job) => {
          const replaced = job.replaceId ? imageDocument.history.find((step) => step.id === job.replaceId) : undefined;
          return {
            id: job.requestId,
            status: `${stageLabel(job.stage, job.service)}${job.progress !== null && (job.stage === "generating" || job.stage === "encoding") ? ` ${Math.round(job.progress * 100)}%` : ""}`,
            prompt: job.prompt,
            note: `${formatElapsed(now - job.startedAt)}${replaced ? ` · replaces ${replaced.name || "a layer"}` : ""}`,
            onCancel: canCancel(job.stage) || canAbort(job.stage) ? () => cancelJob(job.requestId) : undefined,
            aborts: !canCancel(job.stage),
            selected: job.requestId === selectedJob,
            onSelect: () => setSelectedJob(job.requestId),
            ...(job.replaceId ? { replaces: job.replaceId } : {})
          };
        })}
        thumbnails={thumbnails}
        canPasteMask={canPasteMask}
        disabled={resize !== null || clickSelect !== null}
        {...panelHandlers}
      />
      </div>
      <div className="prompt-bar">
        <div className="prompt-input">
        <textarea
          ref={promptRef}
          value={prompt}
          rows={2}

          placeholder="Describe the change…"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.ctrlKey && event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) regenerate();
              else submit();
            }
          }}
        />
        </div>
        <div className="prompt-controls">
          <div className="prompt-options">
            <select
              aria-label="Edit model"
              data-help="The GPT Image model that edits the whole image."
              value={settings.wholeModel}
             
              onChange={(event) => onSettingsChange({ ...settings, wholeModel: event.target.value })}
            >
              {editModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
              <select
                aria-label="GPT Image edit quality"
                data-help="Higher quality costs more and takes longer."
                value={qualitiesFor(settings.wholeModel).includes(settings.wholeQuality) ? settings.wholeQuality : "high"}
               
                onChange={(event) => onSettingsChange({ ...settings, wholeQuality: event.target.value })}
              >
                {qualitiesFor(settings.wholeModel).map((quality) => {
                  const size = wholeSize && `${wholeSize.width}x${wholeSize.height}`;
                  return (
                    <option key={quality} value={quality}>
                      {quality} · ~ {formatUsd(size ? estimateWholeEdit(settings.wholeModel, quality, size).usd : 0)}
                    </option>
                  );
                })}
              </select>
          </div>
          <div className="primary-split" role="group" aria-label="Send the prompt">
            <button
              className="primary-action"
              disabled={!wholeSize || !prompt.trim()}
              onClick={submit}
              data-help="Send the image to GPT Image. The result is a new layer (Ctrl+Enter)"
            >
              <MagicWand size={17} weight="bold" /> Generate
            </button>
            <button
              className="primary-action regenerate-action"
              disabled={!wholeSize || !regenStep || !prompt.trim()}
              onClick={regenerate}
              data-help={regenStep
                ? `Regenerate ${regenName} with this prompt (Ctrl+Shift+Enter). The result replaces the layer and keeps its name; its mask and adjustments are removed. The old layer comes back if it fails or you cancel.`
                : `Select a layer made by AI to regenerate it. ${lastStep ? `${regenName} was not made by AI.` : ""}`}
            >
              <ArrowArcLeft size={17} weight="bold" /> Regenerate
            </button>
          </div>
        </div>
      </div>      {confirmDelete !== null && imageDocument.history[confirmDelete - 1] && (
        <div className="confirm-overlay" role="presentation" onPointerDown={() => setConfirmDelete(null)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-step-title"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setConfirmDelete(null); }}
          >
            <div className="confirm-icon"><WarningCircle size={22} weight="fill" /></div>
            <div className="confirm-copy">
              <h2 id="discard-step-title">Delete layer {confirmDelete + 1}?</h2>
              <p>“{imageDocument.history[confirmDelete - 1].name || imageDocument.history[confirmDelete - 1].prompt}” is removed from the image and from the layers list. You can undo this from the message that follows.</p>
            </div>
            <div className="confirm-actions">
              <button autoFocus className="button secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="button danger" onClick={() => deleteLayer(confirmDelete)}>Delete layer</button>
            </div>
          </div>
        </div>
      )}
      {confirmRegen && confirmRegenStep && (
        <div className="confirm-overlay" role="presentation" onPointerDown={() => setConfirmRegen(null)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="regenerate-confirm-title"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setConfirmRegen(null); }}
          >
            <div className="confirm-icon"><WarningCircle size={22} weight="fill" /></div>
            <div className="confirm-copy">
              <h2 id="regenerate-confirm-title">Overwrite this layer by regenerating it from scratch?</h2>
              <p>“{confirmRegenStep.name || confirmRegenStep.prompt}” is replaced by a new GPT Image result. The old layer comes back if it fails or you cancel.</p>
              {hasMaskOrAdjust(confirmRegenStep) && <p>Its layer mask and adjustments are removed, because they were made for the old image. Undo brings them back.</p>}
              <label className="confirm-check">
                <input type="checkbox" checked={regenDontAsk} onChange={(event) => setRegenDontAsk(event.target.checked)} />
                Don't show again
              </label>
            </div>
            <div className="confirm-actions">
              <button autoFocus className="button secondary" onClick={() => setConfirmRegen(null)}>Cancel</button>
              <button className="button danger" onClick={confirmRegenerate}>Regenerate</button>
            </div>
          </div>
        </div>
      )}
      {layerPick && (
        <div
          className="steps-menu layer-pick-menu"
          role="menu"
          style={{ left: Math.min(layerPick.x, window.innerWidth - 240), top: Math.min(layerPick.y, window.innerHeight - 44 * layerPick.nodes.length - 40) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="steps-menu-head">Layers here</div>
          {layerPick.nodes.map((node) => {
            const step = node > 0 ? imageDocument.history[node - 1] : null;
            const thumbnail = thumbnails[stepKey(imageDocument.id, imageDocument.history, node)];
            return (
              <button
                key={step?.id ?? "origin"}
                role="menuitem"
                className={node === imageDocument.historyIndex ? "current" : ""}
                onPointerEnter={() => setLayerPickHover(node)}
                onPointerMove={() => setLayerPickHover(node)}
                onPointerLeave={() => setLayerPickHover((current) => current === node ? null : current)}
                onFocus={() => setLayerPickHover(node)}
                onBlur={() => setLayerPickHover((current) => current === node ? null : current)}
                onClick={() => {
                  setLayerPick(null);
                  selectLayer(node);
                }}
              >
                <span className="layer-pick-thumb">{thumbnail && <img src={thumbnail} alt="" />}</span>
                <span className="steps-menu-label">{step ? step.name || `Layer ${node}` : "Original"}</span>
              </button>
            );
          })}
        </div>
      )}
      {slideshowDialogOpen && (
        <SlideshowDialog
          defaultTitle={imageDocument.name.replace(/\.[^.]+$/, "")}
          videoSeconds={slideshowDuration(slideshowSegments(imageDocument.history.filter((step) => !step.hidden).length + 1, true))}
          imageKeys={imageDocument.path ? [`path:${imageDocument.path}`, `id:${imageDocument.id}`] : [`id:${imageDocument.id}`]}
          onCancel={() => setSlideshowDialogOpen(false)}
          onExport={(options) => void exportSlideshow(options)}
        />
      )}
      {importLayerOpen && <OpenDialog title="Import image as layer" onCancel={() => setImportLayerOpen(false)} onOpen={(path) => void importLayer(path)} />}
      {modelPrompt && (
        <ModelDownloadDialog
          model={modelPrompt.model}
          sizeBytes={modelPrompt.sizeBytes}
          onDone={(installed) => {
            modelPrompt.resolve(installed);
            setModelPrompt(null);
          }}
        />
      )}
      {exportDialogOpen && (
        <SaveDialog
          settings={{ format, maxWidth: maxWidthInput, maxHeight: maxHeightInput }}
          sourceWidth={width}
          sourceHeight={height}
          onCancel={() => setExportDialogOpen(false)}
          onSave={(next) => void exportImage(next)}
        />
      )}
    </section>
  );
}
