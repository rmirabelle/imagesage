import { invoke } from "@tauri-apps/api/core";
import {
  ArrowArcLeft,
  ArrowsLeftRight,
  Camera,
  Check,
  CircleDashed,
  Selection,
  Eraser,
  Cursor,
  MagicWand,
  Minus,
  PaintBrush,
  PencilSimple,
  Plus,
  SpinnerGap,
  StopCircle,
  Trash,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import {
  Fragment,
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
  drawPaintGradient,
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
import { ADJUSTMENT_LABELS, adjustList, adjustmentFields, setColorize, newAdjustmentId, toggleAllAdjustments, adjustmentFilter, adjustmentOpacity, adjustSignature, findAdjustment, hasAdjustments, maskSignature, moveLayer, moveLayers, newAdjustment, replaceAdjustment, resetAdjustment, type AdjustmentField } from "../editor/layers";
import {
  wholeImageSize
} from "../editor/region";
import { localImageSize } from "../editor/localSize";
import type { Adjustment, BlendMode, EditStep, LayerAdjust, LayerPart, MaskImage, Point, Rect, SentRegion, TransformSource } from "../editor/types";
import {
  CANCELLED_MESSAGE,
  canAbort,
  cancelAiRequest,
  IMAGE_MODELS,
  isLocalModel,
  jobCanCancel,
  localEdits,
  LOCAL_MODELS,
  LOCAL_STEPS,
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
import { verticalPictureSize, videoSize } from "../editor/slideshow";
import { encodeSlideshow, type SlideshowOptions } from "../lib/slideshowVideo";
import { SlideshowDialog } from "./SlideshowDialog";
import { SaveDialog, type SaveFormat, type SaveSettings } from "./SaveDialog";
import { ColorPicker } from "./ColorPicker";
import { CanvasSizeDialog, type CanvasChange } from "./CanvasSizeDialog";
import { sharpenPixels } from "../editor/resample";
import { confirms, setConfirms } from "../lib/confirmations";
import { LinearGradientIcon } from "./LinearGradientIcon";
import { RadialGradientIcon } from "./RadialGradientIcon";
import { combineSelection, DEFAULT_WAND_TOLERANCE, featherSelection, marqueeBox, invertSelection, selectedHalf, selectionBounds, selectionContours, simplifyLoop, smoothEdge, wandArea, type SelectMode, type WandClick } from "../editor/magicWand";
import {
  clampMiddleOffset,
  DEFAULT_MASK_STOPS,
  DEFAULT_PAINT_STOPS,
  grayLevel,
  pointOnLine,
  projectOnLine,
  resolveClearStops,
  reverseStops,
  stopAt,
  stopCss,
  type GradientStop
} from "../editor/gradient";
import { PolygonLassoIcon } from "./PolygonLassoIcon";
import { rgbToHex } from "../editor/color";
import { StepsPanel, stepKey, type PartAction } from "./StepsPanel";

type Corner = "nw" | "ne" | "sw" | "se";
/** "mask" paints the selected layer's mask; "paint" paints color into the selected layer's pixels; "whole" is no tool. */
type Tool = "whole" | "mask" | "paint";
/**
 * A mask: the painted area (a PNG data URL), whether that area is hidden, and
 * its link id when it is a linked copy; no `mask` means no mask.
 */
type MaskState = { mask?: string; hides?: boolean; link?: string };
/** One mask of a document: the owner (a step id, or `BASE_OWNER`) and the part. */
type MaskRef = { owner: string; part: LayerPart };
/** The owner of a mask: a step id, or `BASE_OWNER` for the original image. */
const BASE_OWNER = "";
/**
 * The copied mask, shared by every open image: its PNG, whether it hides,
 * and the size of the image it came from. The event tells every editor that
 * it changed, so their menus can offer Paste.
 */
/** The pasted pixels on a canvas of this image's size; from an image of another size, they keep their place from the top left. */
const pastedCanvas = (pixels: HTMLCanvasElement, width: number, height: number) => {
  if (pixels.width === width && pixels.height === height) return pixels;
  const canvas = createCanvas(width, height);
  canvas.getContext("2d")!.drawImage(pixels, 0, 0);
  return canvas;
};
/**
 * Pixels cut or copied from a selection (Ctrl+X, Ctrl+C), shared by every
 * open image: a canvas of the image size, clear outside the selection, so
 * Ctrl+V puts them back at the same place.
 */
let pixelClipboard: HTMLCanvasElement | null = null;
let maskClipboard: { mask: string; hides: boolean; width: number; height: number; documentId: string; source: MaskRef } | null = null;
const MASK_CLIPBOARD_EVENT = "imagesage-mask-clipboard";
/** The model name of a layer imported from a file; the layers list shows it under the layer name. */
const IMPORTED_MODEL = "Imported image";
/** The model name of a layer copied from the original image. Like an imported layer, it cannot be regenerated. */
const ORIGINAL_COPY_MODEL = "Copy of the original";
/** The model of a snapshot layer: all visible layers combined, made without AI. */
const SNAPSHOT_MODEL = "Snapshot";
/** The model of a new empty layer: a transparent canvas, made without AI. */
const BLANK_MODEL = "Blank layer";
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
/** A layer counts as showing at a point when its opacity there is above this (of 255). */
const PICK_ALPHA = 24;
/** One mask change, for Ctrl+Z and Ctrl+Y: the layer mask or an adjustment mask of one layer. */
type MaskChange = { owner: string; part: LayerPart; before: MaskState; after: MaskState };
/** All the adjustments of one layer, before and after a change such as Delete all adjustments. */
type AdjustChange = { kind: "adjust"; owner: string; before: LayerAdjust | undefined; after: LayerAdjust | undefined };
/** A layer's pixels before and after paint (PNG data URLs). */
type PixelsChange = { kind: "pixels"; owner: string; before: string; after: string };
/**
 * A pixel selection, shown as marching ants: `levels` says how much each
 * pixel of a grid at most 2048 px wide or tall is selected, 0 to 255
 * (`scale` maps image pixels to the grid); a lasso's slanted edges are
 * partly selected, so fills there are smooth. `outline` is the edge of the
 * pixels at least half selected, as closed loops (see `selectionContours`),
 * and `canvas` the mask at grid size: white, as clear as it is unselected.
 */
type PixelSelection = { width: number; height: number; scale: number; levels: Uint8Array; outline: number[][]; canvas: HTMLCanvasElement };
/** The selection before and after a change, so Ctrl+Z takes selection changes back in order with paint. */
type SelectionChange = { kind: "selection"; before: PixelSelection | null; after: PixelSelection | null };
/** Several layers' pixels before and after one change, such as Ctrl+Shift+X (PNG data URLs). */
type PixelsManyChange = { kind: "pixels-many"; changes: { owner: string; before: string; after: string }[] };
/** A whole layer before and after a change of its pixels and masks together, such as Transform. */
type LayerChange = { kind: "layer"; before: EditStep; after: EditStep };
/** Layers deleted together, each with its node (1-based place in the list) at the time. */
type DeleteChange = { kind: "delete-layers"; removed: { step: EditStep; node: number }[] };
/** Layers added (new layer, paste, duplicate, Snapshot), each with its node after it was added. */
type AddChange = { kind: "add-layers"; added: { step: EditStep; node: number }[] };
/** The document before and after a new canvas size: its surface (of the size), its layers, and the selected layer. */
type CanvasState = { surface: HTMLCanvasElement; history: EditStep[]; historyIndex: number; base?: string; baseAdjust?: LayerAdjust };
type CanvasSizeChange = { kind: "canvas"; before: CanvasState; after: CanvasState };
/** One step for Ctrl+Z and Ctrl+Y. */
type UndoEntry = MaskChange | AdjustChange | PixelsChange | SelectionChange | PixelsManyChange | LayerChange | DeleteChange | AddChange | CanvasSizeChange;
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
type MaskBrushStroke = {
  prep: MaskPrep;
  last: Point;
  add: boolean;
  before: MaskState;
  base: HTMLCanvasElement;
  stroke: HTMLCanvasElement;
  opacity: number;
  frame: number | null;
  /** Inside a selection: the selection's mask (stretched over the image) and a canvas to cut the stroke in. */
  clip?: { mask: HTMLCanvasElement; scratch: HTMLCanvasElement };
};
/**
 * A paint brush stroke in progress. The stroke is drawn in the paint color at
 * full strength on `stroke`, then laid on `base` (the layer before the stroke)
 * at `opacity`; the result goes into the prepared layer image.
 */
type PaintStroke = {
  prep: MaskPrep;
  last: Point;
  base: HTMLCanvasElement;
  stroke: HTMLCanvasElement;
  opacity: number;
  color: string;
  frame: number | null;
  /** Inside a selection: the selection's mask (stretched over the image) and a canvas to cut the stroke in. */
  clip?: { mask: HTMLCanvasElement; scratch: HTMLCanvasElement };
  /** The eraser: the stroke takes pixels away instead of painting the color. */
  erase?: boolean;
};
/** What is being dragged on a gradient that is being edited: an end, or a stop (by its index in the stops). */
type GradientGrab = { what: "from" | "to" | "stop"; index: number; startX: number; startY: number; moved: boolean; away: boolean };
/**
 * A gradient on the image, into a mask or (`target` "paint") a layer's
 * pixels. It is first dragged; after the drag it stays `editing`: its ends
 * and stops can be moved until it is applied or canceled.
 */
type GradientDrag = {
  prep: MaskPrep;
  target: "mask" | "paint";
  kind: "linear" | "radial";
  from: Point;
  to: Point;
  before: MaskState;
  base: HTMLCanvasElement;
  created: boolean;
  frame: number | null;
  editing: boolean;
  grab: GradientGrab | null;
  /** A paint gradient inside a selection: the selection's mask and a canvas to draw in. */
  clip?: { mask: HTMLCanvasElement; scratch: HTMLCanvasElement };
};
/** How far, in screen pixels, a stop is dragged from the line before it is removed. */
const STOP_REMOVE_DISTANCE = 40;
/** How far past the gradient's end point, in screen pixels, the Apply check sits. */
const GRADIENT_APPLY_GAP = 28;

/**
 * A layer's transform so far: a point (px, py) of the layer moves to
 * (a·px − b·py + x, b·px + a·py + y). a and b hold the scale and the rotation
 * (a = scale·cos, b = scale·sin), so the layer keeps its proportions.
 */
type LayerTransform = { a: number; b: number; x: number; y: number };
const IDENTITY: LayerTransform = { a: 1, b: 0, x: 0, y: 0 };
const sameTransform = (one: LayerTransform, two: LayerTransform) => one.a === two.a && one.b === two.b && one.x === two.x && one.y === two.y;
/** A short fingerprint of a layer's pixels and masks: a transform source is used only while the layer still matches what its transform made. */
const transformMade = (step: EditStep) => [maskSignature(step.layer), maskSignature(step.layerMask), ...adjustList(step.adjust).map((item) => `${item.id}=${maskSignature(item.mask)}`)].join("|");
/** The layer as its transform source holds it: the source pixels and masks, under its own decode-cache keys. */
const sourceStepOf = (step: EditStep, source: TransformSource): EditStep => {
  const { layerMask: _mask, ...rest } = step;
  return {
    ...rest,
    id: `${step.id}:source`,
    layer: source.layer,
    ...(source.layerMask ? { layerMask: source.layerMask } : {}),
    ...(step.adjust ? { adjust: adjustList(step.adjust).map((item) => item.mask ? { ...item, mask: source.adjustMasks?.[item.id] ?? item.mask } : item) } : {})
  };
};
/**
 * A layer being transformed with handles on its bounds: the drawn layer, the
 * combined layers below and above it, the bounds before the transform, and
 * the transform so far. With a transform source, the drawn layer is the
 * source and `start` its total transform, so pixels moved past the image edge
 * before can come back.
 */
type ResizeSession = {
  owner: string;
  bounds: Rect;
  rendered: HTMLCanvasElement;
  below: HTMLCanvasElement;
  above: FlatLayers;
  transform: LayerTransform;
  start: LayerTransform;
  source: TransformSource | null;
  frame: number | null;
  blend?: BlendMode;
};
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
/** An eyedropper cursor, for picking a color while the color picker is open; its tip is the bottom left. */
const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round'>"
  + "<g stroke='#000'><path d='M4 20L13 11' stroke-width='4.5'/><path d='M10.5 8.5l5 5' stroke-width='4.5'/><path d='M15 9l3.5-3.5' stroke-width='8'/></g>"
  + "<g stroke='#fff'><path d='M4 20L13 11' stroke-width='2.5'/><path d='M10.5 8.5l5 5' stroke-width='2.5'/><path d='M15 9l3.5-3.5' stroke-width='6'/></g>"
  + "</svg>"
)}") 3 21, crosshair`;
/**
 * The Magic Wand cursor, as in Photoshop: a wand pointing to the top left,
 * with a white tip edged in black, a black handle edged in white, and a
 * sparkle at its tip, and with `sign` a small + or − at the bottom right.
 * The tip is the click point.
 */
const wandCursor = (sign: "" | "+" | "-") => `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round'>"
  + "<g stroke='#000'><path d='M7 7L10 10' stroke-width='5'/><path d='M4 1v2M1 4h2M7 1.5L6 2.5M1.5 7l1-1' stroke-width='3'/></g>"
  + "<path d='M10 10L16 16' stroke='#fff' stroke-width='5'/>"
  + "<g stroke='#fff'><path d='M7 7L10 10' stroke-width='3'/><path d='M4 1v2M1 4h2M7 1.5L6 2.5M1.5 7l1-1' stroke-width='1.2'/></g>"
  + "<path d='M10 10L16 16' stroke='#000' stroke-width='3'/>"
  /** The sign at the bottom right: + adds to the selection, − takes from it. */
  + (sign ? `<path d='M16 20.5h6${sign === "+" ? "M19 17.5v6" : ""}' stroke='#000' stroke-width='3.5'/><path d='M16 20.5h6${sign === "+" ? "M19 17.5v6" : ""}' stroke='#fff' stroke-width='1.5'/>` : "")
  + "</svg>"
)}") 4 4, crosshair`;
const WAND_CURSOR = wandCursor("");
/** The Magic Wand with Shift held: a click adds to the selection. */
const WAND_ADD_CURSOR = wandCursor("+");
/** The Magic Wand with Alt held: a click takes from the selection. */
const WAND_SUBTRACT_CURSOR = wandCursor("-");
/** A trash can cursor, for Ctrl over a lasso corner: a click there deletes the corner. */
const TRASH_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>"
  + "<g stroke='#000' stroke-width='4'><path d='M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5l1 14h10l1-14'/></g>"
  + "<g stroke='#fff' stroke-width='2'><path d='M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5l1 14h10l1-14M10 10.5v6M14 10.5v6'/></g>"
  + "</svg>"
)}") 12 12, not-allowed`;

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
    return step?.layerMask ? { mask: step.layerMask, hides: step.maskHides === true, ...(step.maskLink ? { link: step.maskLink } : {}) } : {};
  }
  const adjustment = findAdjustment(adjustOf(doc, node), part);
  return adjustment?.mask ? { mask: adjustment.mask, hides: adjustment.maskHides === true, ...(adjustment.maskLink ? { link: adjustment.maskLink } : {}) } : {};
};
/** Every mask in the document with the link id `link`. */
const linkedMasks = (doc: ImageDocument, link: string): MaskRef[] => {
  const found: MaskRef[] = [];
  const fromAdjust = (owner: string, adjust: LayerAdjust | undefined) => {
    for (const adjustment of adjustList(adjust)) if (adjustment.mask && adjustment.maskLink === link) found.push({ owner, part: adjustment.id });
  };
  fromAdjust(BASE_OWNER, doc.baseAdjust);
  for (const step of doc.history) {
    if (step.layerMask && step.maskLink === link) found.push({ owner: step.id, part: "mask" });
    fromAdjust(step.id, step.adjust);
  }
  return found;
};
/** A new link id for masks pasted as linked copies. */
const newMaskLink = () => `link-${crypto.randomUUID().slice(0, 8)}`;
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
  /** The user hid the layer while it runs: no progress box on the image, and the layer arrives hidden. */
  hidden?: boolean;
};
/**
 * Click to select in progress: what it fills, the prepared image (`key`),
 * the clicks so far and the mask they make. The image is prepared at most
 * 2048 px wide or tall, so clicks and the mask use that size (`scale` maps
 * image pixels to it). `engine` is "wand" for the Magic Wand, which matches
 * colors in `pixels` at once, or "sam" for Object, the local AI model.
 */
type ClickSelect = {
  engine: "wand" | "sam";
  pixels?: ImageData;
  /**
   * The Magic Wand's last click, how it changed the selection, and the
   * selection before it: a new Tolerance or Contiguous makes that click again.
   */
  last?: { click: WandClick; mode: SelectMode; before: PixelSelection | null };
  target: { owner: string; part: LayerPart };
  key: string;
  scale: number;
  width: number;
  height: number;
  /** Object's clicks; the Magic Wand changes the editor's selection instead. */
  points: WandClick[];
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
  /** The local models whose files are set, with the engine installed. */
  readyLocalModels: string[];
  onRequestLocalSettings: () => void;
  onSettingsChange: (settings: AiSettings) => void;
  onCommit: (id: string, patch: Partial<Pick<ImageDocument, "base" | "baseAdjust" | "history" | "historyIndex" | "surface">>, markDirty?: boolean) => void;
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
export type EditorCommand = { name: "export-image" | "export-video" | "import-image" | "undo" | "redo" | "snapshot" | "canvas-size" | "image-size"; documentId: string; nonce: number };

/** Ctrl+wheel zoom: the scale changes by exp(-deltaY × this); one wheel notch (100) is about 5%. */
const WHEEL_ZOOM_RATE = 0.0005;
const ZOOM_LEVELS = [0.05, 0.067, 0.1, 0.125, 0.16, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const SAVE_FORMAT_KEY = "imagesage.save-format";
const SAVE_MAX_WIDTH_KEY = "imagesage.save-max-width";
const SAVE_MAX_HEIGHT_KEY = "imagesage.save-max-height";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const BRUSH_RADIUS_KEY = "imagesage.brush-radius";
const BRUSH_PRECISE_KEY = "imagesage.brush-precise";
const PAINT_COLOR_KEY = "imagesage.paint-color";
const WAND_TOLERANCE_KEY = "imagesage.wand-tolerance";
const WAND_CONTIGUOUS_KEY = "imagesage.wand-contiguous";
const WAND_FEATHER_KEY = "imagesage.wand-feather";
/** The largest Magic Wand feather, in image pixels. */
const MAX_WAND_FEATHER = 250;
/** The `part` of a layer prepared for the Paint tool: the layer's own pixels, not a mask. */
const PAINT_PART = "paint-pixels";
/** The soft edge of a precise brush, in image pixels, at every brush size; a soft brush blurs by 30% of its radius. */
const PRECISE_BRUSH_BLUR = 1.5;
const MASK_COLOR = "#ff3366";
/** Space above the image, for the layer name and the image size (matches `.canvas-scroll-area`). */
const CANVAS_TOP_SPACE = 46;
/** Space below the image for the mask shortcut tips and a margin under them. */
const MASK_TIPS_SPACE = 230;
/** Screen pixels around the first lasso corner where a click closes the shape. */
const LASSO_CLOSE_REACH = 8;
/** Screen pixels around a placed lasso corner where the pointer can grab it. */
const LASSO_GRAB_REACH = 7;
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
  readyLocalModels,
  onRequestLocalSettings,
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
  /** Shift is held: the Magic Wand shows its + cursor, as a click then adds to the selection. */
  const [shiftHeld, setShiftHeld] = useState(false);
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
  /** The Canvas Size or Image Size dialog that is open, or null. */
  const [canvasDialog, setCanvasDialog] = useState<"canvas" | "image" | null>(null);
  /** The layer waiting for the user to confirm Delete. */
  const [confirmDelete, setConfirmDelete] = useState<number[] | null>(null);
  /**
   * Layers selected together (by step id), with Ctrl+click and Shift+click in
   * the layers list, for Delete and drag. It always holds the selected layer;
   * empty means only the selected layer.
   */
  const [multiIds, setMultiIds] = useState<string[]>([]);
  /** The adjustment being renamed in the Rename dialog, with the name typed so far. */
  const [renameAdjust, setRenameAdjust] = useState<{ node: number; id: string; draft: string } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  /** Regenerate waiting for the user to confirm: the layer, and the prompt to run. */
  const [confirmRegen, setConfirmRegen] = useState<{ stepId: string; instruction: string } | null>(null);
  const [regenDontAsk, setRegenDontAsk] = useState(false);
  /** "Don't show again" in the Delete confirmation. */
  const [deleteDontAsk, setDeleteDontAsk] = useState(false);
  /** Which mask of the selected layer the Mask tool paints: "mask" for the layer mask, or an adjustment id. */
  const [maskPart, setMaskPart] = useState<LayerPart>("mask");
  /** The mask brush shows (true) or hides (false) what it paints; holding Alt does the other one. */
  const [maskShows, setMaskShows] = useState(true);
  /** Opacity of mask brush strokes and gradients, 1 to 100 percent. */
  const [maskOpacity, setMaskOpacityState] = useState(100);
  const setMaskOpacity = (next: number) => setMaskOpacityState(Math.max(1, Math.min(100, Math.round(next))));
  /** The paint color, as "#rrggbb"; it is remembered for the next session. */
  const [paintColor, setPaintColorState] = useState(() => {
    const stored = readStored(PAINT_COLOR_KEY);
    return stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored : "#000000";
  });
  const setPaintColor = useCallback((color: string) => {
    setPaintColorState(color);
    writeStored(PAINT_COLOR_KEY, color);
  }, []);
  /** The color picker is open: over the image the pointer is an eyedropper, and a click picks the color under it. */
  const [pickingColor, setPickingColor] = useState(false);
  /** The circle next to the eyedropper that shows the color under the pointer. */
  const colorProbeRef = useRef<HTMLDivElement>(null);
  /** A paint brush stroke in progress; while it runs, it draws the surface itself. */
  const paintStrokeRef = useRef<PaintStroke | null>(null);
  /** While the Mask tool is on, red shows where the target mask hides (or does not apply). */
  const [maskOverlay, setMaskOverlay] = useState(true);
  /** A gradient waiting to be dragged on the image, or null. */
  const [gradient, setGradient] = useState<"linear" | "radial" | null>(null);
  /** The stops of mask gradients: grays only. */
  const [maskStops, setMaskStops] = useState<GradientStop[]>(DEFAULT_MASK_STOPS);
  /** The stops of paint gradients. The first stop's color is always the paint color. */
  const [paintStops, setPaintStops] = useState<GradientStop[]>(DEFAULT_PAINT_STOPS);
  const paintGradientStops = useMemo(() => paintStops.map((stop, index) => index === 0 ? { ...stop, color: paintColor } : stop), [paintStops, paintColor]);
  /** The stops as the last render left them, for drawing between renders. */
  const gradientStopsRef = useRef({ mask: maskStops, paint: paintGradientStops });
  gradientStopsRef.current = { mask: maskStops, paint: paintGradientStops };
  /** The gradient being edited on the image, as drawn: its ends, and the stop dragged away to be removed. */
  const [gradientEdit, setGradientEdit] = useState<{ from: Point; to: Point; kind: "linear" | "radial"; target: "mask" | "paint"; awayIndex: number | null } | null>(null);
  /** The stop of the edited gradient whose color picker is open, by index. */
  const [stopPicker, setStopPicker] = useState<number | null>(null);
  /** The open color picker of a gradient end in the toolbar (the paint start uses the paint color picker). */
  const [swatchPicker, setSwatchPicker] = useState<"start" | "end" | null>(null);
  /** The polygon lasso is on: clicks add corners of a shape, and closing the shape fills it in the mask. */
  const [lasso, setLassoState] = useState(false);
  /** A marquee select tool is on: a drag draws a rectangle or an ellipse that becomes the selection. */
  const [marquee, setMarquee] = useState<"rect" | "ellipse" | null>(null);
  /**
   * Every tool change sets the lasso, so setting it also turns the marquee
   * and the eraser off; picking one of them turns it on after that.
   */
  /** The Paint tool's eraser is on: brush strokes take pixels away from the layer. */
  const [eraser, setEraser] = useState(false);
  const setLasso = useCallback((next: boolean | ((on: boolean) => boolean)) => {
    setMarquee(null);
    setEraser(false);
    setLassoState(next);
  }, []);
  /** A marquee being dragged: its shape, where it started and is now, how it changes the selection, and where the press was on screen. */
  const marqueeDragRef = useRef<{ shape: "rect" | "ellipse"; start: Point; current: Point; even: boolean; centered: boolean; startX: number; startY: number } | null>(null);
  /** The marquee being dragged, in image pixels, for its marching ants. */
  const [marqueeDrag, setMarqueeDrag] = useState<(Rect & { shape: "rect" | "ellipse" }) | null>(null);
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
  const lassoRubberRef = useRef<SVGGElement>(null);
  /**
   * A press on a placed corner: it moves the corner once the pointer moves a
   * few pixels; a press without movement is an ordinary lasso click.
   */
  const lassoDragRef = useRef<{ index: number; point: Point; startX: number; startY: number; moved: boolean; reverse: boolean; add: boolean } | null>(null);
  /** The corner just placed cannot be grabbed until the pointer leaves it, so a double-click still closes the shape. */
  const lassoFreshRef = useRef<number | null>(null);
  /** The corner under the pointer that it can grab, or null. */
  const lassoHoverCornerRef = useRef<number | null>(null);
  /** The hand cursor over a corner that can be moved, and while one moves. */
  const [lassoCursor, setLassoCursor] = useState<"grab" | "grabbing" | null>(null);
  /** The pointer is over any placed corner, the one just placed too: with Ctrl held, a click deletes it. */
  const [lassoOverCorner, setLassoOverCorner] = useState(false);
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
  /**
   * The selection of the Mask and Paint tools, made by the Magic Wand or the
   * polygon lasso, or Ctrl+A. While it is there, brushes, gradients and
   * Alt+Backspace change only the pixels inside it. It stays while tools
   * change, and ends with Ctrl+D or a new image size.
   */
  const [selection, setSelectionState] = useState<PixelSelection | null>(null);
  const selectionRef = useRef<PixelSelection | null>(null);
  const setSelection = useCallback((next: PixelSelection | null) => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  /** The Magic Wand's settings: how far a color may be from the clicked one (0 to 255), and whether the area must touch the click. */
  const [wandTolerance, setWandToleranceState] = useState(() => {
    const stored = Number(readStored(WAND_TOLERANCE_KEY));
    return readStored(WAND_TOLERANCE_KEY) !== null && Number.isFinite(stored) ? Math.max(0, Math.min(255, Math.round(stored))) : DEFAULT_WAND_TOLERANCE;
  });
  const setWandTolerance = (next: number) => {
    const value = Math.max(0, Math.min(255, Math.round(next)));
    setWandToleranceState(value);
    writeStored(WAND_TOLERANCE_KEY, String(value));
  };
  const [wandContiguous, setWandContiguousState] = useState(() => readStored(WAND_CONTIGUOUS_KEY) !== "0");
  const setWandContiguous = (next: boolean) => {
    setWandContiguousState(next);
    writeStored(WAND_CONTIGUOUS_KEY, next ? "1" : "0");
  };
  /** How many image pixels the edge of each new wand area fades over; 0 keeps a sharp edge. */
  const [wandFeather, setWandFeatherState] = useState(() => {
    const stored = Number(readStored(WAND_FEATHER_KEY));
    return Number.isFinite(stored) ? Math.max(0, Math.min(MAX_WAND_FEATHER, Math.round(stored))) : 0;
  });
  const setWandFeather = (next: number) => {
    const value = Math.max(0, Math.min(MAX_WAND_FEATHER, Math.round(next)));
    setWandFeatherState(value);
    writeStored(WAND_FEATHER_KEY, String(value));
  };
  const wandSettingsRef = useRef({ tolerance: wandTolerance, contiguous: wandContiguous, feather: wandFeather });
  wandSettingsRef.current = { tolerance: wandTolerance, contiguous: wandContiguous, feather: wandFeather };
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
  /** Running edits the user hid, read when the result arrives. */
  const hiddenJobsRef = useRef(new Set<string>());
  const setJobHidden = useCallback((requestId: string, hidden: boolean) => {
    if (hidden) hiddenJobsRef.current.add(requestId);
    else hiddenJobsRef.current.delete(requestId);
    updateJob(requestId, (existing) => ({ ...existing, hidden }));
  }, [updateJob]);
  const toggleJobHidden = useCallback((requestId: string) => {
    setJobHidden(requestId, !hiddenJobsRef.current.has(requestId));
  }, [setJobHidden]);
  const endJob = useCallback((documentId: string, requestId: string) => {
    hiddenJobsRef.current.delete(requestId);
    runningRef.current = Math.max(0, runningRef.current - 1);
    setJobs((list) => list.filter((item) => item.requestId !== requestId));
    onBusyChange(documentId, runningRef.current > 0);
  }, [onBusyChange]);
  const localChosen = isLocalModel(settings.wholeModel);
  const wholeSize = localChosen ? localImageSize(width, height) : wholeImageSize(width, height);
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
    if (doc.base === undefined || maskStrokeRef.current || gradientRef.current || paintStrokeRef.current || resizeRef.current) return;
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
      if (!masked(step)) return `${step.id}|raw|${maskSignature(step.layer)}`;
      const mask = step.layerMask && !step.maskOff ? step.layerMask : "";
      return `${step.id}|${maskSignature(step.layer)}|${maskSignature(mask)}|${step.maskHides ? "hides" : "shows"}|${adjustSignature(step.adjust)}`;
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
    if (node < 0 || node > current.history.length) return;
    /** The prompt loads even for the layer already selected, for example after a running edit's row was selected. */
    const layerPrompt = node > 0 ? current.history[node - 1].prompt : current.origin.kind === "generated" ? current.origin.prompt : null;
    if (layerPrompt !== null) setPrompt(layerPrompt);
    if (node === current.historyIndex) return;
    onCommit(current.id, { historyIndex: node }, false);
    /** The Mask tool belongs to the layer it was turned on for; picking a mask chip turns it on again for the new layer. */
    setTool((active) => active === "mask" ? "whole" : active);
    setGradient(null);
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
      /** A new top layer has no mask, so it is the whole visible image. A hidden one leaves the image as it is. */
      if (!step.hidden) context2d(latest.surface).drawImage(image, 0, 0);
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

  /** Mask changes, and adjustment changes such as Delete all adjustments, for Ctrl+Z and Ctrl+Y. */
  const maskUndoRef = useRef<UndoEntry[]>([]);
  const maskRedoRef = useRef<UndoEntry[]>([]);

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

  /**
   * Sets or removes the mask of one part of a layer and selects that layer.
   * A mask with a link id also sets every linked copy, and the masks in
   * `linkWith`, which join the link; all of it is one change. Removing a mask
   * leaves its linked copies alone. False when the layer or the adjustment is gone.
   */
  const setPartMask = useCallback((owner: string, part: LayerPart, state: MaskState, canvas?: HTMLCanvasElement, linkWith: MaskRef[] = []) => {
    const current = documentRef.current;
    const node = nodeOfOwner(current, owner);
    if (node < 0 || (part === "mask" && node === 0)) return false;
    if (part !== "mask" && !findAdjustment(adjustOf(current, node), part)) return false;
    const key = maskCacheKey(current, node, part);
    if (state.mask && canvas) layerCacheRef.current.set(key, { src: state.mask, canvas });
    if (!state.mask) layerCacheRef.current.delete(key);
    /**
     * A state without a `link` key (a brush stroke, a gradient, a fill) keeps
     * the mask's link; a `link` key, even undefined, sets it. A removed mask has no link.
     */
    const link = !state.mask ? undefined : "link" in state ? state.link : partMaskState(current, node, part).link;
    const targets: MaskRef[] = [{ owner, part }, ...(state.mask && link ? [...linkedMasks(current, link), ...linkWith] : [])];
    const isTarget = (ownerId: string, partId: LayerPart) => targets.some((target) => target.owner === ownerId && target.part === partId);
    /** Changing a mask turns it back on; its linked copies keep their own on or off. */
    const keepsOff = (ownerId: string, partId: LayerPart, off: boolean | undefined) => off === true && (ownerId !== owner || partId !== part);
    const fields = <T,>(off: boolean | undefined, ownerId: string, partId: LayerPart, maskKey: "mask" | "layerMask") => (state.mask ? {
      [maskKey]: state.mask,
      ...(state.hides ? { maskHides: true } : {}),
      ...(link ? { maskLink: link } : {}),
      ...(keepsOff(ownerId, partId, off) ? { maskOff: true } : {})
    } : {}) as Partial<T>;
    const adjustWith = (ownerId: string, adjust: LayerAdjust | undefined) => adjust && adjustList(adjust).some((adjustment) => isTarget(ownerId, adjustment.id))
      ? adjustList(adjust).map((adjustment) => {
        if (!isTarget(ownerId, adjustment.id)) return adjustment;
        const { mask: _mask, maskHides: _hides, maskOff, maskLink: _link, ...rest } = adjustment;
        return { ...rest, ...fields<Adjustment>(maskOff, ownerId, adjustment.id, "mask") };
      })
      : adjust;
    const history = current.history.map((step) => {
      let next = step;
      if (isTarget(step.id, "mask")) {
        const { layerMask: _mask, maskHides: _hides, maskOff, maskLink: _link, ...rest } = step;
        next = { ...rest, ...fields<EditStep>(maskOff, step.id, "mask", "layerMask") };
      }
      const adjust = adjustWith(step.id, step.adjust);
      return adjust === step.adjust ? next : { ...next, adjust };
    });
    const baseAdjust = adjustWith(BASE_OWNER, current.baseAdjust);
    onCommit(current.id, { history, ...(baseAdjust !== current.baseAdjust ? { baseAdjust } : {}), historyIndex: node });
    return true;
  }, [onCommit]);

  const recordMaskChange = useCallback((change: MaskChange, canvas?: HTMLCanvasElement, linkWith: MaskRef[] = []) => {
    maskUndoRef.current.push(change);
    maskRedoRef.current = [];
    setPartMask(change.owner, change.part, change.after, canvas, linkWith);
  }, [setPartMask]);

  /** Puts back one side of a change; false when its layer (or adjustment) is gone. */
  const applyUndoEntry = useCallback((entry: UndoEntry, side: "before" | "after") => {
    if ("kind" in entry && entry.kind === "canvas") {
      const state = entry[side];
      onCommit(documentRef.current.id, { surface: state.surface, history: state.history, historyIndex: state.historyIndex, base: state.base, baseAdjust: state.baseAdjust });
      return true;
    }
    if ("kind" in entry && entry.kind === "selection") {
      setSelection(entry[side]);
      /** The Magic Wand's last click no longer made this selection, so a new Tolerance leaves it alone. */
      const session = clickSelectRef.current;
      if (session?.last) setClickSelect({ ...session, last: undefined });
      return true;
    }
    if ("kind" in entry && (entry.kind === "delete-layers" || entry.kind === "add-layers")) {
      const current = documentRef.current;
      const layers = entry.kind === "delete-layers" ? entry.removed : entry.added;
      /** Undoing a delete, or redoing an add, puts the layers back. */
      const putBack = (entry.kind === "delete-layers") === (side === "before");
      if (putBack) {
        /** The layers go back at their nodes, bottom first; the top one is selected. */
        if (layers.some(({ step }) => current.history.some((item) => item.id === step.id))) return false;
        const history = [...current.history];
        for (const { step, node } of [...layers].sort((a, b) => a.node - b.node)) history.splice(Math.min(node, history.length + 1) - 1, 0, step);
        const top = Math.max(...layers.map(({ step }) => history.indexOf(step) + 1));
        onCommit(current.id, { history, historyIndex: top });
        return true;
      }
      /** The layers go, and the layer below the lowest is selected. */
      const ids = new Set(layers.map(({ step }) => step.id));
      if (!current.history.some((step) => ids.has(step.id))) return false;
      const lowest = Math.min(...layers.map(({ node }) => node));
      const history = current.history.filter((step) => !ids.has(step.id));
      onCommit(current.id, { history, historyIndex: current.base ? lowest - 1 : Math.max(lowest - 1, Math.min(1, history.length)) });
      return true;
    }
    if ("kind" in entry && entry.kind === "layer") {
      const current = documentRef.current;
      const at = current.history.findIndex((item) => item.id === entry[side].id);
      if (at < 0) return false;
      onCommit(current.id, { history: current.history.map((item, index) => index === at ? entry[side] : item), historyIndex: at + 1 });
      return true;
    }
    if ("kind" in entry && entry.kind === "pixels-many") {
      const current = documentRef.current;
      const layers = new Map(entry.changes.map((change) => [change.owner, change[side]]));
      if (!current.history.some((step) => layers.has(step.id))) return false;
      onCommit(current.id, { history: current.history.map((step) => layers.has(step.id) ? { ...step, layer: layers.get(step.id)! } : step) });
      return true;
    }
    if ("kind" in entry && entry.kind === "pixels") {
      const current = documentRef.current;
      const node = nodeOfOwner(current, entry.owner);
      if (node < 1) return false;
      onCommit(current.id, { history: current.history.map((step, index) => index === node - 1 ? { ...step, layer: entry[side] } : step), historyIndex: node });
      return true;
    }
    if ("kind" in entry) {
      const current = documentRef.current;
      const node = nodeOfOwner(current, entry.owner);
      if (node < 0) return false;
      commitAdjust(current, node, entry[side]);
      return true;
    }
    return setPartMask(entry.owner, entry.part, entry[side]);
  }, [commitAdjust, onCommit, setClickSelect, setPartMask, setSelection]);

  const undoMask = useCallback(() => {
    const change = maskUndoRef.current.pop();
    if (change && applyUndoEntry(change, "before")) maskRedoRef.current.push(change);
  }, [applyUndoEntry]);

  const redoMask = useCallback(() => {
    const change = maskRedoRef.current.pop();
    if (change && applyUndoEntry(change, "after")) maskUndoRef.current.push(change);
  }, [applyUndoEntry]);

  const isMaskTool = tool === "mask";
  const isPaintTool = tool === "paint";
  /** The mask brush hides now: its mode, reversed while Alt is held. */
  const brushHides = isMaskTool && maskShows === erasing;
  /** The mask and paint brushes show the round brush cursor and use the brush size; a waiting gradient and the lasso use a crosshair instead. */
  const brushLike = (isMaskTool || isPaintTool) && !gradient && !lasso && !marquee && !clickSelect;
  /** Alt held with the paint brush: the pointer is the eyedropper, with the color preview, and Alt+click picks the color. */
  const altPicking = isPaintTool && brushLike && !eraser && erasing && !pickingColor;
  /** The image point under the pointer while it is over the image or the work area, or null; Alt shows the eyedropper there at once. */
  const hoverPointRef = useRef<Point | null>(null);
  /**
   * The lasso and the gradients work with the Mask and Paint tools.
   * Whoever switches between those two tools sets both.
   */
  useEffect(() => {
    if (tool !== "whole") return;
    setGradient(null);
    setLasso(false);
  }, [tool]);
  /** A shape in progress belongs to one mask; it is dropped when the lasso turns off or another mask is picked. */
  useEffect(() => {
    setLassoPoints([]);
    lassoClickRef.current = null;
    lassoDragRef.current = null;
    lassoFreshRef.current = null;
    lassoHoverCornerRef.current = null;
  }, [lasso, tool, targetPart, imageDocument.historyIndex, setLassoPoints]);

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
  /** Changes one gradient stop. The paint start's color is the paint color. Ends stay at the ends. */
  const changeStop = (target: "mask" | "paint", index: number, patch: Partial<GradientStop>) => {
    if (target === "paint" && index === 0 && patch.color !== undefined) setPaintColor(patch.color);
    const update = (stops: GradientStop[]) => stops.map((stop, at) => at === index
      ? { ...stop, ...patch, ...(at === 0 ? { offset: 0 } : at === stops.length - 1 ? { offset: 1 } : {}) }
      : stop);
    if (target === "mask") setMaskStops(update);
    else setPaintStops(update);
  };
  /** Adds a middle stop; it goes just before the end stop, so its index is the old number of stops − 1. */
  const addStop = (target: "mask" | "paint", stop: GradientStop) => {
    const update = (stops: GradientStop[]) => [...stops.slice(0, -1), stop, stops[stops.length - 1]];
    if (target === "mask") setMaskStops(update);
    else setPaintStops(update);
  };
  /** Removes a middle stop; the ends cannot be removed. */
  const removeStop = (target: "mask" | "paint", index: number) => {
    const update = (stops: GradientStop[]) => index > 0 && index < stops.length - 1 ? stops.filter((_, at) => at !== index) : stops;
    if (target === "mask") setMaskStops(update);
    else setPaintStops(update);
  };
  /** Swaps the start and end of the gradient. */
  const swapStops = (target: "mask" | "paint") => {
    if (target === "mask") {
      setMaskStops(reverseStops);
      return;
    }
    const reversed = reverseStops(paintGradientStops);
    setPaintColor(reversed[0].color);
    setPaintStops(reversed);
  };
  /**
   * A gradient being edited is applied when the tool, the layer or the mask
   * changes. This runs before the layer is prepared again below, which
   * waits while a gradient is open.
   */
  useEffect(() => {
    if (gradientRef.current?.editing) finishGradientDrag(true);
  }, [tool, gradient, imageDocument.id, imageDocument.historyIndex, targetPart]);
  /** New stops redraw the gradient being edited. */
  useEffect(() => {
    const drag = gradientRef.current;
    if (drag?.editing) drawGradientDrag(drag);
  }, [maskStops, paintGradientStops]);
  const maskPrepKeyRef = useRef("");
  useEffect(() => {
    const doc = imageDocument;
    const node = doc.historyIndex;
    /** The Paint tool prepares the selected layer's own pixels; the original image of an older document cannot be painted. */
    const part = isPaintTool ? (node > 0 ? PAINT_PART : null) : isMaskTool ? targetPart : null;
    if (!part || doc.base === undefined || (node === 0 && !doc.base)) {
      maskPrepRef.current = null;
      maskPrepKeyRef.current = "";
      return;
    }
    const step = node > 0 ? doc.history[node - 1] : null;
    const ownerKey = step ? step.id : `base:${doc.id}`;
    const adjust = adjustOf(doc, node) ?? [];
    const key = [doc.id, doc.surface.width, doc.surface.height, maskSignature(doc.base), node, node > 0 ? adjustSignature(doc.baseAdjust) : "", ...doc.history.map((item, index) => index === node - 1
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
        if (cancelled || maskStrokeRef.current || gradientRef.current || paintStrokeRef.current) return;
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
  }, [compositeOf, decodeLayer, imageDocument.base, imageDocument.baseAdjust, imageDocument.history, imageDocument.historyIndex, imageDocument.id, imageDocument.surface, isMaskTool, isPaintTool, layerCanvases, targetPart]);

  /**
   * Edits the whole image with GPT Image (the visible layers, or `from`); the
   * result is a new top layer, or replaces layer `replaceId`. On an empty
   * canvas, GPT Image generates the image from the prompt alone. A local model
   * always generates from the prompt alone, never edits. `choice` overrides
   * the model and quality of the prompt bar.
   */
  const runWholeEdit = useCallback(async (instruction: string, from?: HTMLCanvasElement, replaceId?: string, choice?: { model: string; quality: string }, editLayer = false) => {
    const current = documentRef.current;
    if (!instruction.trim() || applyingRef.current) return;
    if (resizeRef.current) {
      onNotice({ tone: "error", message: "Apply (Enter) or cancel (Esc) the transform first." });
      return;
    }
    const model = choice?.model ?? settings.wholeModel;
    const quality = choice?.quality ?? settings.wholeQuality;
    const local = isLocalModel(model);
    if (local ? !readyLocalModels.includes(model) : !openaiConnected) {
      if (local) onRequestLocalSettings();
      else onRequestOpenAiSettings();
      return;
    }
    const imageWidth = current.surface.width;
    const imageHeight = current.surface.height;
    const size = local ? localImageSize(imageWidth, imageHeight) : wholeImageSize(imageWidth, imageHeight);
    if (!size) {
      onNotice({ tone: "error", message: local ? "A local model cannot make an image wider or taller than 4:1." : "GPT Image cannot edit an image wider or taller than 3:1." });
      return;
    }
    const area: Rect = { x: 0, y: 0, width: imageWidth, height: imageHeight };
    const sent: SentRegion = { ...area, margin: 0, requestWidth: size.width, requestHeight: size.height };
    const sizeText = `${size.width}x${size.height}`;
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    setNow(startedAt);
    startJob(current.id, { requestId, frame: area, sent, service: local ? "Local" : "OpenAI", stage: null, progress: null, partialDataUrl: null, startedAt, prompt: instruction.trim(), replaceId, model, quality });
    onNotice(null);
    try {
      await composeRef.current;
      const work = cloneCanvas(from ?? current.surface);
      /**
       * A local model makes a new image from the prompt alone, as a new layer
       * over the image, unless it edits a layer (`editLayer`, Regenerate with
       * Qwen-Image-2.1). An empty image is always made from the prompt alone.
       */
      const generate = (local && !(editLayer && localEdits(model))) || opaqueBounds(work) === null;
      const onProgress = (progress: AiProgress) => {
        updateJob(requestId, (existing) => ({
          ...existing,
          stage: progress.stage,
          progress: progress.progress ?? existing.progress,
          partialDataUrl: progress.partialDataUrl ?? existing.partialDataUrl
        }));
      };
      const result = generate
        ? await generateImage(requestId, { prompt: instruction.trim(), model, quality, size: sizeText }, onProgress)
        : await editWholeImage(requestId, { prompt: instruction.trim(), model, quality, size: sizeText, imagePng: await buildWholeUpload(work, size.width, size.height) }, onProgress);
      const resultImage = await loadImage(result.dataUrl);
      const workContext = context2d(work);
      workContext.imageSmoothingEnabled = true;
      workContext.imageSmoothingQuality = "high";
      workContext.clearRect(0, 0, imageWidth, imageHeight);
      workContext.drawImage(resultImage, 0, 0, imageWidth, imageHeight);
      const cost = local ? null : openAiActualCost(result.usage, model);
      if (!local) recordSpend(cost);
      if (!generate && !local) learnWholeEditInput(result.usage, model, sizeText);
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
        ...(hiddenJobsRef.current.has(requestId) ? { hidden: true } : {}),
        /** The first image in an empty document is its original. */
        ...(!replaceId && documentRef.current.base === "" && !documentRef.current.history.length ? { name: ORIGINAL_LAYER_NAME } : {})
      };
      const replaced = appendStep(step, work, replaceId);
      const costText = local
        ? `Made on this computer in ${Math.round((Date.now() - startedAt) / 1000)} s.`
        : cost !== null ? `Charged ${formatUsd(cost)}.` : `Estimated cost ${formatUsd(estimateOpenAiImage(model, quality, sizeText, instruction.length))}.`;
      onNotice({
        tone: "success",
        message: `${replaced ? `Layer replaced${hasMaskOrAdjust(replaced) ? "; its mask and adjustments were removed" : ""}.` : generate ? "Image generated." : "Whole image edited."} ${costText}`,
        ...(replaced ? { action: { label: "Undo", run: () => undoReplace(replaced, step.id) } } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== CANCELLED_MESSAGE) onNotice({ tone: "error", message });
    } finally {
      endJob(current.id, requestId);
    }
  }, [appendStep, endJob, readyLocalModels, onCommit, onNotice, onRequestLocalSettings, onRequestOpenAiSettings, openaiConnected, settings, startJob, undoReplace, updateJob]);

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
      setGradient(null);
      setLasso(false);
      setClickSelect({ engine: "sam", target, key, scale, width: source.width, height: source.height, points: [], mask: null, busy: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== CANCELLED_MESSAGE) onNotice({ tone: "error", message });
    } finally {
      endJob(current.id, requestId);
    }
  };

  /** The grid of a selection for this image: at most 2048 px wide or tall. */
  const selectionGrid = () => {
    const scale = Math.min(1, CLICK_SELECT_MAX_SIDE / Math.max(width, height));
    return { scale, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  };

  /** A selection from its levels on the selection grid, with its outline and mask; null when nothing is selected. */
  const makeSelection = (levels: Uint8Array): PixelSelection | null => {
    const grid = selectionGrid();
    if (!selectionBounds(levels, grid.width, grid.height)) return null;
    const pixels = new ImageData(grid.width, grid.height);
    for (let index = 0; index < levels.length; index++) {
      if (!levels[index]) continue;
      pixels.data.fill(255, index * 4, index * 4 + 3);
      pixels.data[index * 4 + 3] = levels[index];
    }
    const canvas = createCanvas(grid.width, grid.height);
    canvas.getContext("2d")!.putImageData(pixels, 0, 0);
    return { ...grid, levels, outline: selectionContours(selectedHalf(levels), grid.width, grid.height), canvas };
  };

  /** Records added layers as one step for Ctrl+Z, which removes them again. */
  const recordAdded = (added: { step: EditStep; node: number }[]) => {
    maskUndoRef.current.push({ kind: "add-layers", added });
    maskRedoRef.current = [];
  };

  /** Changes the selection as one step for Ctrl+Z. */
  const changeSelection = (next: PixelSelection | null) => {
    const before = selectionRef.current;
    if (before === next) return;
    maskUndoRef.current.push({ kind: "selection", before, after: next });
    maskRedoRef.current = [];
    setSelection(next);
  };

  /**
   * Starts the Magic Wand on `source`, the image as it shows. It reads the
   * pixels once, at the selection grid size; each click then selects at
   * once, with no model.
   */
  const startWandSelect = (target: ClickSelect["target"], source: HTMLCanvasElement) => {
    if (applyingRef.current || resizeRef.current || clickSelectRef.current) return;
    const grid = selectionGrid();
    const sample = grid.scale < 1 ? scaledCanvas(source, grid.width, grid.height) : source;
    const pixels = sample.getContext("2d")!.getImageData(0, 0, grid.width, grid.height);
    setGradient(null);
    setLasso(false);
    onNotice(null);
    setClickSelect({ engine: "wand", pixels, target, key: crypto.randomUUID(), scale: grid.scale, width, height, points: [], mask: null, busy: false });
  };

  /** The selection after a Magic Wand click in `mode`, with the current Tolerance, Contiguous and Feather. */
  const wandResult = (pixels: ImageData, click: WandClick, mode: SelectMode, before: PixelSelection | null) => {
    const { tolerance, contiguous, feather } = wandSettingsRef.current;
    /** The wand selects whole pixels; their edge is then smoothed, as Photoshop's Anti-alias does, and softened by Feather. */
    const smooth = smoothEdge(wandArea(pixels.data, pixels.width, pixels.height, click.x, click.y, tolerance, contiguous).map((bit) => bit ? 255 : 0), pixels.width, pixels.height);
    const area = feather ? featherSelection(smooth, pixels.width, pixels.height, feather * selectionGrid().scale) : smooth;
    return makeSelection(combineSelection(before?.levels ?? null, area, mode));
  };

  /** A Magic Wand click: a new selection, or (`mode`) added to or taken from the selection. */
  const wandClick = (point: Point, mode: SelectMode) => {
    const session = clickSelectRef.current;
    if (!session?.pixels) return;
    const click = { x: point.x * session.scale, y: point.y * session.scale, include: mode !== "subtract" };
    const before = selectionRef.current;
    changeSelection(wandResult(session.pixels, click, mode, before));
    setClickSelect({ ...session, last: { click, mode, before } });
  };

  /** A new Tolerance, Contiguous or Feather makes the Magic Wand's last click again. */
  useEffect(() => {
    const session = clickSelectRef.current;
    if (session?.engine !== "wand" || !session.pixels || !session.last) return;
    const next = wandResult(session.pixels, session.last.click, session.last.mode, session.last.before);
    const top = maskUndoRef.current[maskUndoRef.current.length - 1];
    if (top && "kind" in top && top.kind === "selection") top.after = next;
    setSelection(next);
  }, [wandTolerance, wandContiguous, wandFeather]);

  /** Asks the model for the mask of Object's clicks and shows it. */
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

  /** An Object click adds the area under it; Alt+click removes it. */
  const addClickPoint = (point: Point, include: boolean) => {
    const session = clickSelectRef.current;
    if (!session) return;
    void updateClickMask(session, [...session.points, { x: point.x * session.scale, y: point.y * session.scale, include }]);
  };

  /** Ctrl+Z in Object removes its last click. */
  const undoClickPoint = () => {
    const session = clickSelectRef.current;
    if (session?.points.length) void updateClickMask(session, session.points.slice(0, -1));
  };

  const cancelClickSelect = () => {
    clickSeqRef.current += 1;
    setClickSelect(null);
  };
  /**
   * A click selection belongs to one tool and layer: in the Mask tool, to the
   * mask being painted; in the Paint tool, to the layer's pixels. Leaving
   * that tool, or picking another layer or mask, ends it without applying it.
   */
  useEffect(() => {
    const session = clickSelectRef.current;
    if (!session) return;
    const doc = documentRef.current;
    const owner = doc.historyIndex > 0 ? doc.history[doc.historyIndex - 1]?.id : BASE_OWNER;
    const kept = session.target.part === PAINT_PART
      ? isPaintTool && session.target.owner === owner
      : isMaskTool && session.target.owner === owner && session.target.part === targetPart;
    if (!kept) cancelClickSelect();
  }, [clickSelect, imageDocument.historyIndex, isMaskTool, isPaintTool, targetPart]);

  /** A new image size (crop or canvas size) ends the selection; it was made for the old size. */
  useEffect(() => {
    if (selectionRef.current) setSelection(null);
  }, [width, height, setSelection]);

  /** Writes the mask into its target, a layer or adjustment mask; Ctrl+Z undoes it. A paint selection has no mask to set. */
  const applyClickSelect = async () => {
    const session = clickSelectRef.current;
    if (!session || session.target.part === PAINT_PART) return;
    if (session.engine === "wand") {
      const chosen = selectionRef.current;
      if (!chosen) {
        onNotice({ tone: "warning", message: "Click to select an area for the mask first, or press Esc to cancel." });
        return;
      }
      const src = await canvasToDataUrl(chosen.scale !== 1 ? scaledCanvas(chosen.canvas, width, height) : chosen.canvas);
      cancelClickSelect();
      setSelection(null);
      const { owner, part } = session.target;
      const doc = documentRef.current;
      const node = nodeOfOwner(doc, owner);
      if (node < 0) return;
      const before = partMaskState(doc, node, part);
      const after: MaskState = { mask: src };
      recordMaskChange({ owner, part, before, after });
      return;
    }
    if (!session.mask) {
      onNotice({ tone: "warning", message: "Click to select an area for the mask first, or press Esc to cancel." });
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
  };

  /** The selected layer alone, as it shows (mask and adjustments applied), even while it is hidden. */
  const selectedLayerImage = async (doc: ImageDocument) => {
    const target = createCanvas(doc.surface.width, doc.surface.height);
    const step = doc.historyIndex > 0 ? doc.history[doc.historyIndex - 1] : undefined;
    if (step) drawLayers(target, null, await layerCanvases([withHidden(step, false)]));
    else drawLayers(target, await baseCanvases(doc), []);
    return target;
  };

  const submit = () => {
    void runWholeEdit(prompt);
  };

  /** Regenerate with a local model that edits: the selected layer alone, with the edit, becomes a new layer; the layer stays. */
  const editSelectedLayer = () => {
    selectedLayerImage(documentRef.current)
      .then((layer) => runWholeEdit(prompt, layer, undefined, undefined, true))
      .catch((error) => onNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) }));
  };

  /** Delete asks first; the message after it has an Undo button. */
  /** The nodes of the layers selected together, bottom first; empty when only one layer is selected. */
  const multiNodes = (current: ImageDocument, ids = multiIds) => ids.length > 1
    ? current.history.map((step, index) => ids.includes(step.id) ? index + 1 : 0).filter(Boolean)
    : [];

  /** Asks before deleting a layer, or every layer selected together when the layer is one of them. */
  const requestDelete = (node: number) => {
    const current = documentRef.current;
    if (node < 1 || node > current.history.length || applyingRef.current) return;
    const group = multiNodes(current);
    const nodes = group.includes(node) ? group : [node];
    /** Without the confirmation (Settings, or "Don't show again"), the layers go at once; the message after it can undo it. */
    if (!confirms("delete")) {
      deleteLayers(nodes);
      return;
    }
    setDeleteDontAsk(false);
    setConfirmDelete(nodes);
  };
  /** Deletes the layers the confirmation asked about, and remembers "Don't show again". */
  const confirmDeleteLayers = (nodes: number[]) => {
    if (deleteDontAsk) setConfirms("delete", false);
    deleteLayers(nodes);
  };

  /**
   * Removes layers and selects the one below the lowest; Ctrl+Z puts them
   * back. For one layer, its prompt comes back so the edit can be tried again.
   */
  const deleteLayers = (nodes: number[]) => {
    setConfirmDelete(null);
    const current = documentRef.current;
    const removed = nodes.map((node) => ({ step: current.history[node - 1], node })).filter((item) => item.step);
    if (!removed.length) return;
    const lowest = Math.min(...removed.map(({ node }) => node));
    const history = current.history.filter((step) => !removed.some((item) => item.step === step));
    /** Without a separate original image, node 0 is no layer, so the layer above is selected instead. */
    onCommit(current.id, { history, historyIndex: current.base ? lowest - 1 : Math.max(lowest - 1, Math.min(1, history.length)) });
    setMultiIds([]);
    if (removed.length === 1) setPrompt(removed[0].step.prompt);
    maskUndoRef.current.push({ kind: "delete-layers", removed });
    maskRedoRef.current = [];
  };

  /**
   * Ctrl+click adds a layer to the layers selected together, or takes it out;
   * the clicked layer becomes the selected one. Shift+click selects every
   * layer from the selected one to the clicked one; the selected one stays.
   * The original image is never part of a group.
   */
  const selectMany = (node: number, mode: "toggle" | "range") => {
    const current = documentRef.current;
    const step = current.history[node - 1];
    const primary = current.history[current.historyIndex - 1];
    if (!step || applyingRef.current) return;
    const base = multiIds.length ? multiIds : primary ? [primary.id] : [];
    if (mode === "range") {
      const from = Math.max(1, current.historyIndex);
      const [low, high] = from < node ? [from, node] : [node, from];
      setMultiIds(current.history.slice(low - 1, high).map((item) => item.id));
      if (!primary) selectLayer(node);
      return;
    }
    if (!base.includes(step.id)) {
      setMultiIds([...base, step.id]);
      selectLayer(node);
      return;
    }
    const left = base.filter((id) => id !== step.id);
    setMultiIds(left.length > 1 ? left : []);
    /** Taking out the selected layer selects the last one still in the group. */
    if (step === primary && left.length) selectLayer(current.history.findIndex((item) => item.id === left[left.length - 1]) + 1);
  };

  /** The group shrinks when its layers go away, and ends when the selected layer is no longer in it. */
  useEffect(() => {
    if (!multiIds.length) return;
    const primary = imageDocument.history[imageDocument.historyIndex - 1];
    const left = multiIds.filter((id) => imageDocument.history.some((step) => step.id === id));
    if (!primary || !left.includes(primary.id) || left.length < 2) setMultiIds([]);
    else if (left.length !== multiIds.length) setMultiIds(left);
  }, [imageDocument.history, imageDocument.historyIndex, multiIds]);

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
    recordAdded([{ step: copy, node: node + 1 }]);
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
    recordAdded([{ step: copy, node: 1 }]);
  };

  /**
   * Adds a snapshot of all visible layers, combined as they show, as a new top
   * layer and selects it (Photoshop calls this Stamp Visible). Hidden layers
   * are left out; the layers themselves do not change.
   */
  const snapshotVisible = async () => {
    const current = documentRef.current;
    if (current.base === undefined || applyingRef.current || resizeRef.current || clickSelectRef.current) return;
    const image = await compositeOf(current, current.history);
    const { width, height } = current.surface;
    const area: Rect = { x: 0, y: 0, width, height };
    const count = current.history.filter((step) => step.model === SNAPSHOT_MODEL).length + 1;
    const step: EditStep = {
      id: crypto.randomUUID(),
      name: `Snapshot ${count}`,
      prompt: "Snapshot of the visible layers",
      model: SNAPSHOT_MODEL,
      quality: "",
      createdAt: new Date().toISOString(),
      selection: { x: 0, y: 0, size: Math.min(width, height) },
      area,
      sent: { ...area, margin: 0, requestWidth: width, requestHeight: height },
      layer: await canvasToDataUrl(image)
    };
    const top = documentRef.current.history.length + 1;
    appendStep(step, image);
    recordAdded([{ step, node: top }]);
  };

  /**
   * Adds an empty, transparent layer the size of the image directly above the
   * selected layer, and selects it. Its name is the first free "Layer N".
   * With `pixels` (Ctrl+V), the layer holds them, at the same place.
   */
  const addBlankLayer = async (pixels?: HTMLCanvasElement) => {
    const current = documentRef.current;
    if (applyingRef.current || resizeRef.current || (clickSelectRef.current && !pixels)) return;
    const { width, height } = current.surface;
    const area: Rect = { x: 0, y: 0, width, height };
    const names = new Set(current.history.map((step, index) => step.name || `Layer ${index + 1}`));
    let number = 1;
    while (names.has(`Layer ${number}`)) number += 1;
    const step: EditStep = {
      id: crypto.randomUUID(),
      name: `Layer ${number}`,
      prompt: pixels ? "Pasted pixels" : "Empty layer",
      model: BLANK_MODEL,
      quality: "",
      createdAt: new Date().toISOString(),
      selection: { x: 0, y: 0, size: Math.min(width, height) },
      area,
      sent: { ...area, margin: 0, requestWidth: width, requestHeight: height },
      layer: await canvasToDataUrl(pixels ? pastedCanvas(pixels, width, height) : createCanvas(width, height))
    };
    /** The selected layer may change while the PNG is made; read it again. */
    const latest = documentRef.current;
    const at = Math.min(latest.historyIndex, latest.history.length);
    const history = [...latest.history.slice(0, at), step, ...latest.history.slice(at)];
    setMultiIds([]);
    onCommit(latest.id, { history, historyIndex: at + 1 });
    recordAdded([{ step, node: at + 1 }]);
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
      const size = options.vertical ? verticalPictureSize(width, height) : videoSize(width, height);
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

  /** Moves a layer in the stack and keeps it selected; a layer of the group selected together moves with the whole group. */
  const moveLayerTo = (from: number, to: number, above: boolean) => {
    const current = documentRef.current;
    const group = multiNodes(current);
    if (group.includes(from)) {
      const movedGroup = moveLayers(current.history, group, to, above);
      if (movedGroup.history === current.history) return;
      const primary = movedGroup.history.findIndex((step) => step.id === current.history[current.historyIndex - 1]?.id) + 1;
      onCommit(current.id, { history: movedGroup.history, historyIndex: primary > 0 ? primary : movedGroup.nodes[movedGroup.nodes.length - 1] });
      return;
    }
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
      /** A paint gradient does not carry into the Mask tool; the gradient actions below set their own. */
      if (!isMaskTool) setGradient(null);
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
      case "add-opacity":
      case "add-sharpen": {
        /** A layer can have several adjustments, even of the same kind, each with its own mask. */
        const added = newAdjustment(action === "add-brightness" ? "brightness" : action === "add-contrast" ? "contrast" : action === "add-blur" ? "blur" : action === "add-opacity" ? "opacity" : action === "add-sharpen" ? "sharpen" : "hueSaturation");
        commitAdjust(current, node, [...(adjust ?? []), added]);
        /** The new adjustment has no mask, so the Mask tool turns off; Add mask in its menu starts one. */
        if (node !== current.historyIndex) selectLayer(node);
        if (isMaskTool) setTool("whole");
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
        maskClipboard = { mask: state.mask, hides: state.hides === true, width, height, documentId: current.id, source: { owner, part } };
        window.dispatchEvent(new Event(MASK_CLIPBOARD_EVENT));
        onNotice({ tone: "success", message: "Mask copied." });
        return;
      }
      case "mask-paste": {
        /** The pasted mask replaces this one (Ctrl+Z undoes it); a mask from an image of another size is scaled to fit. */
        const copied = maskClipboard;
        if (!copied || (part === "mask" && node === 0)) return;
        /**
         * In the same image, the paste is a linked copy of the copied mask, as
         * it is now: a change to either changes both. The copied mask joins the
         * link too. Unlink in the mask menu makes a copy independent again.
         */
        const sourceNode = copied.documentId === current.id ? nodeOfOwner(current, copied.source.owner) : -1;
        const sourceState = sourceNode >= 0 ? partMaskState(current, sourceNode, copied.source.part) : {};
        const isSelf = copied.source.owner === owner && copied.source.part === part;
        if (sourceState.mask && !isSelf) {
          const link = sourceState.link ?? newMaskLink();
          /** The `link` key is always set, so an undo also puts back the old link (or none). */
          const old = partMaskState(current, node, part);
          const before: MaskState = { ...old, link: old.link };
          recordMaskChange({ owner, part, before, after: { mask: sourceState.mask, ...(sourceState.hides ? { hides: true } : {}), link } }, undefined, [copied.source]);
          onNotice({ tone: "success", message: "Mask pasted as a linked copy: a change to one changes all its copies." });
          return;
        }
        let mask = copied.mask;
        if (copied.width !== width || copied.height !== height) {
          mask = await canvasToDataUrl(scaledCanvas(await canvasFromDataUrl(copied.mask), width, height));
        }
        const before = partMaskState(current, node, part);
        recordMaskChange({ owner, part, before, after: { mask, ...(copied.hides ? { hides: true } : {}) } });
        /** Ctrl+Z undoes a paste, so only a paste that was scaled says so. */
        if (copied.width !== width || copied.height !== height) onNotice({ tone: "success", message: "Mask pasted and scaled to this image." });
        return;
      }
      case "mask-unlink": {
        /**
         * The mask becomes independent of its linked copies. Its older undo
         * steps are dropped, so an undo cannot link it again.
         */
        if (!partMaskState(current, node, part).link) return;
        const notThis = (change: UndoEntry) => "kind" in change || change.owner !== owner || change.part !== part;
        maskUndoRef.current = maskUndoRef.current.filter(notThis);
        maskRedoRef.current = maskRedoRef.current.filter(notThis);
        if (part === "mask") {
          if (!step) return;
          const { maskLink: _link, ...rest } = step;
          onCommit(current.id, { history: current.history.map((item, index) => index === node - 1 ? rest : item) });
        } else if (adjustment) {
          const { maskLink: _link, ...rest } = adjustment;
          update(rest);
        }
        onNotice({ tone: "success", message: "Mask unlinked: it no longer changes with its copies." });
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
      case "select-pixels":
      case "select-pixels-add":
      case "select-pixels-subtract": {
        /** Ctrl+click on a layer thumbnail: the layer's pixels, as much as each shows, become the selection. */
        if (!step?.layer) return;
        const image = await decodeLayer(`${step.id}:image`, await latestPixels(step.id));
        const grid = selectionGrid();
        const sample = grid.scale < 1 ? scaledCanvas(image, grid.width, grid.height) : image;
        const alpha = sample.getContext("2d")!.getImageData(0, 0, grid.width, grid.height).data;
        const levels = new Uint8Array(grid.width * grid.height);
        for (let index = 0; index < levels.length; index++) levels[index] = alpha[index * 4 + 3];
        const before = selectionRef.current;
        changeSelection(makeSelection(combineSelection(before?.levels ?? null, levels, action === "select-pixels-add" ? "add" : action === "select-pixels-subtract" ? "subtract" : "replace")));
        return;
      }
      case "wand-select":
        /** The Magic Wand reads the image as it shows, all visible layers together. */
        await composeRef.current;
        startWandSelect({ owner, part }, surface);
        return;
      case "blend-normal":
      case "blend-screen":
      case "blend-overlay": {
        if (!step) return;
        const { blend: _blend, ...rest } = step;
        const next = action === "blend-normal" ? rest : { ...rest, blend: action === "blend-screen" ? "screen" as const : "overlay" as const };
        onCommit(current.id, { history: current.history.map((item) => item.id === step.id ? next : item) });
        return;
      }
      case "adjust-duplicate": {
        /**
         * A copy of the adjustment, with its values, goes right after it on
         * the same layer. Its mask, if any, is a linked copy: the original
         * keeps its link id or gets a new one, which the copy shares. Ctrl+Z
         * removes the copy and puts back the original's old link.
         */
        if (!adjustment) return;
        const link = adjustment.mask ? adjustment.maskLink ?? newMaskLink() : undefined;
        const original: Adjustment = link ? { ...adjustment, maskLink: link } : adjustment;
        const copy: Adjustment = { ...original, id: newAdjustmentId(), ...(adjustment.label ? { label: `${adjustment.label} copy` } : {}) };
        const list = adjustList(adjust);
        const at = list.findIndex((item) => item.id === adjustment.id);
        const after = [...list.slice(0, at), original, copy, ...list.slice(at + 1)];
        maskUndoRef.current.push({ kind: "adjust", owner, before: adjust, after });
        maskRedoRef.current = [];
        commitAdjust(current, node, after);
        return;
      }
      case "delete":
        if (!adjustment) return;
        if (node === current.historyIndex && maskPart === part) setMaskPart("mask");
        deleteAdjustments(replaceAdjustment(adjust, part, undefined));
        return;
      case "delete-all":
        if (!adjust?.length) return;
        if (node === current.historyIndex && maskPart !== "mask") setMaskPart("mask");
        deleteAdjustments(undefined);
        return;
    }
    /** Deletes one or all adjustments of this layer; Ctrl+Z puts them back. */
    function deleteAdjustments(after: LayerAdjust | undefined) {
      const change: AdjustChange = { kind: "adjust", owner, before: adjust, after };
      maskUndoRef.current.push(change);
      maskRedoRef.current = [];
      commitAdjust(current, node, after);
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
    /** A transform source that still matches the layer is drawn instead, with its total transform as the start. */
    const source = step.transformSource && step.transformSource.made === transformMade(step) ? step.transformSource : null;
    const [layer] = await layerCanvases([{ ...(source ? sourceStepOf(step, source) : step), hidden: false }]);
    const rendered = createCanvas(width, height);
    drawLayer(context2d(rendered), layer);
    const bounds = opaqueBounds(rendered) ?? { x: 0, y: 0, width, height };
    const [below, layersAbove] = await Promise.all([
      compositeOf(current, current.history.slice(0, node - 1)),
      layerCanvases(current.history.slice(node))
    ]);
    const above = flattenLayers(width, height, layersAbove);
    const transform = source ? source.transform : IDENTITY;
    resizeRef.current = { owner: step.id, bounds, rendered, below, above, transform, start: transform, source, frame: null, ...(step.blend ? { blend: step.blend } : {}) };
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

  /** Enter: the layer and its masks are drawn again with the new transform; Ctrl+Z undoes it. */
  const commitResize = async () => {
    const session = stopResize();
    if (!session) return;
    const transform = session.transform;
    const current = documentRef.current;
    const node = nodeOfOwner(current, session.owner);
    if (node < 1 || sameTransform(transform, session.start)) {
      setComposeTick((tick) => tick + 1);
      return;
    }
    const step = current.history[node - 1];
    /**
     * The layer is drawn again from its source with the total transform, so
     * pixels past the image edge come back when moved into view and the
     * layer does not soften with each transform. The first time, the layer
     * itself becomes the source.
     */
    const origin = session.source ? sourceStepOf(step, session.source) : step;
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
        { key: `${origin.id}:image`, src: origin.layer ?? "", out: `${step.id}:image` },
        ...(origin.layerMask ? [{ key: `${origin.id}:mask`, src: origin.layerMask, out: `${step.id}:mask` }] : []),
        ...adjustList(origin.adjust).flatMap((item) => item.mask ? [{ key: adjustMaskKey(origin.id, item.id), src: item.mask, out: adjustMaskKey(step.id, item.id) }] : [])
      ];
      const urls = new Map<string, string>();
      await Promise.all(sources.map(async ({ key, src, out }) => {
        const canvas = scaled(await decodeLayer(key, src));
        const url = await canvasToDataUrl(canvas);
        layerCacheRef.current.set(out, { src: url, canvas });
        urls.set(out, url);
      }));
      const drawn: EditStep = {
        ...step,
        layer: urls.get(`${step.id}:image`),
        ...(step.layerMask ? { layerMask: urls.get(`${step.id}:mask`) } : {}),
        ...(step.adjust ? { adjust: adjustList(step.adjust).map((item) => item.mask ? { ...item, mask: urls.get(adjustMaskKey(step.id, item.id)) } : item) } : {})
      };
      const adjustMasks = Object.fromEntries(adjustList(origin.adjust).flatMap((item) => item.mask ? [[item.id, item.mask]] : []));
      const resized: EditStep = {
        ...drawn,
        transformSource: {
          layer: origin.layer ?? "",
          ...(origin.layerMask ? { layerMask: origin.layerMask } : {}),
          ...(Object.keys(adjustMasks).length ? { adjustMasks } : {}),
          transform,
          made: transformMade(drawn)
        }
      };
      const latest = documentRef.current;
      const index = latest.history.findIndex((item) => item.id === step.id);
      if (index < 0) return;
      onCommit(latest.id, { history: latest.history.map((item, at) => at === index ? resized : item), historyIndex: index + 1 });
      /** Ctrl+Z puts the layer back as it was; no message. */
      maskUndoRef.current.push({ kind: "layer", before: step, after: resized });
      maskRedoRef.current = [];
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
      const range = adjustment && adjustmentFields(adjustment).find((item) => item.field === pending.field);
      if (!adjustment || !range) return;
      const next = Math.round(Math.max(range.min, Math.min(range.max, pending.value)));
      if ((adjustment[pending.field] ?? 0) === next) return;
      commitAdjust(current, pending.node, replaceAdjustment(adjust, pending.id, { ...adjustment, [pending.field]: next }));
    });
  };

  /** Gives an adjustment of a layer its own name; an empty name removes it, so the chip shows the numbers again. */
  const setAdjustmentLabel = (node: number, id: string, label: string) => {
    const current = documentRef.current;
    if (node > current.history.length) return;
    const adjust = adjustOf(current, node);
    const adjustment = findAdjustment(adjust, id);
    const trimmed = label.trim();
    if (!adjustment || (adjustment.label ?? "") === trimmed) return;
    const { label: _label, ...rest } = adjustment;
    commitAdjust(current, node, replaceAdjustment(adjust, id, trimmed ? { ...rest, label: trimmed } : rest));
  };

  /** Opens the Rename dialog for an adjustment, with its current name. */
  const requestAdjustRename = (node: number, id: string) => {
    const adjustment = findAdjustment(adjustOf(documentRef.current, node), id);
    if (adjustment) setRenameAdjust({ node, id, draft: adjustment.label ?? "" });
  };

  /** Sets whether a Sharpen adjustment sharpens brightness only (the default) or each color. */
  const setSharpenBrightnessOnly = (node: number, id: string, brightnessOnly: boolean) => {
    const current = documentRef.current;
    if (node > current.history.length) return;
    const adjust = adjustOf(current, node);
    const adjustment = findAdjustment(adjust, id);
    if (!adjustment || adjustment.kind !== "sharpen" || !adjustment.colorSharpen === brightnessOnly) return;
    const { colorSharpen: _color, ...rest } = adjustment;
    commitAdjust(current, node, replaceAdjustment(adjust, id, brightnessOnly ? rest : { ...rest, colorSharpen: true }));
  };

  /** Turns Motion on or off for a Blur adjustment; the angle is kept, so it comes back with Motion. */
  const setBlurMotion = (node: number, id: string, motion: boolean) => {
    const current = documentRef.current;
    if (node > current.history.length) return;
    const adjust = adjustOf(current, node);
    const adjustment = findAdjustment(adjust, id);
    if (!adjustment || adjustment.kind !== "blur" || Boolean(adjustment.motion) === motion) return;
    const { motion: _motion, ...rest } = adjustment;
    commitAdjust(current, node, replaceAdjustment(adjust, id, motion ? { ...rest, motion: true } : rest));
  };

  /** Turns Colorize on or off for a Hue/Saturation adjustment of a layer, the original image included. */
  const setAdjustmentColorize = (node: number, id: string, colorize: boolean) => {
    const current = documentRef.current;
    if (node > current.history.length) return;
    const adjust = adjustOf(current, node);
    const adjustment = findAdjustment(adjust, id);
    if (!adjustment || adjustment.kind !== "hueSaturation" || Boolean(adjustment.colorize) === colorize) return;
    commitAdjust(current, node, replaceAdjustment(adjust, id, setColorize(adjustment, colorize)));
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
   * which always shows). Running AI edits are hidden too, so their progress
   * does not cover the layer and their results arrive hidden. Ctrl+click again
   * on the same layer, while it is still the only one shown, brings back the
   * visibility from before.
   */
  const soloLayer = (node: number) => {
    const current = documentRef.current;
    const step = current.history[node - 1];
    if (!step) return;
    const solo = soloRef.current;
    const layerJobs = jobs.filter((job) => job.model);
    const soloed = !step.hidden && current.history.every((item) => item.id === step.id || item.hidden) && layerJobs.every((job) => job.hidden);
    if (soloed && solo && solo.documentId === current.id && solo.owner === step.id) {
      soloRef.current = null;
      onCommit(current.id, { history: current.history.map((item) => withHidden(item, solo.hidden.get(item.id) ?? false)) }, false);
      for (const job of layerJobs) setJobHidden(job.requestId, solo.hidden.get(job.requestId) ?? false);
      return;
    }
    soloRef.current = {
      documentId: current.id,
      owner: step.id,
      hidden: new Map([...current.history.map((item) => [item.id, item.hidden === true] as const), ...layerJobs.map((job) => [job.requestId, Boolean(job.hidden)] as const)])
    };
    onCommit(current.id, { history: current.history.map((item) => withHidden(item, item.id !== step.id)) }, false);
    for (const job of layerJobs) setJobHidden(job.requestId, true);
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
      /**
       * Alt alone would open the window's system menu when let go, and that
       * menu holds the mouse until a click; the app uses Alt itself.
       */
      if (event.key === "Alt") {
        event.preventDefault();
        setErasing(true);
      }
      if (event.key === "Shift") setShiftHeld(true);
      setZoomKeys(event.ctrlKey ? (event.altKey ? "out" : "in") : null);
      if (window.document.querySelector(".save-dialog-overlay, .open-dialog-overlay, .confirm-overlay, .about-dialog-overlay")) return;
      /** Ctrl+A selects the whole image, as in Photoshop, in any tool. */
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a" && !typing && !resizeRef.current) {
        event.preventDefault();
        const grid = selectionGrid();
        changeSelection(makeSelection(new Uint8Array(grid.width * grid.height).fill(255)));
        return;
      }
      /**
       * Space held turns a left drag into panning (and with Ctrl, a click
       * into zooming) in every tool, also during the Magic Wand and
       * Transform; it must not press a focused button.
       */
      if (event.code === "Space" && !typing) {
        event.preventDefault();
        if (!event.repeat) setSpaceHeld(true);
        return;
      }
      /** Ctrl+V pastes cut or copied pixels into a new layer above the selected one, at the same place. */
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v" && !typing && !resizeRef.current && pixelClipboard) {
        event.preventDefault();
        if (!event.repeat) void addBlankLayer(pixelClipboard);
        return;
      }
      /**
       * With a selection, as in Photoshop: Ctrl+X and Ctrl+C cut and copy,
       * Ctrl+D drops it, Ctrl+I (or Ctrl+Shift+I) inverts it, and
       * Alt+Backspace fills it: showing or hiding in the Mask tool, or else
       * with the paint color.
       */
      const chosen = selectionRef.current;
      if (chosen && !typing && !resizeRef.current) {
        /** Ctrl+C copies what shows in the selection; Ctrl+X cuts from the selected layer; Ctrl+Shift+X cuts from every visible layer. */
        if (event.ctrlKey && !event.altKey && (event.key.toLowerCase() === "x" || (event.key.toLowerCase() === "c" && !event.shiftKey))) {
          event.preventDefault();
          if (!event.repeat) void copySelectedPixels(chosen, event.key.toLowerCase() === "c" ? null : event.shiftKey ? "all" : "layer");
          return;
        }
        if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "d") {
          event.preventDefault();
          changeSelection(null);
          return;
        }
        if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "i") {
          event.preventDefault();
          changeSelection(makeSelection(invertSelection(chosen.levels)));
          return;
        }
        if (event.altKey && !event.ctrlKey && event.key === "Backspace") {
          event.preventDefault();
          if (!event.repeat) {
            if (isMaskTool) fillMaskSelection(chosen);
            else void fillWithColor(chosen);
          }
          return;
        }
      }
      /** During click to select, Enter applies, Esc ends it and Ctrl+Z undoes; other keys wait. */
      if (clickSelectRef.current && !typing) {
        const session = clickSelectRef.current;
        if (event.key === "Enter") {
          event.preventDefault();
          void applyClickSelect();
        } else if (event.key === "Escape") {
          event.preventDefault();
          /**
           * With pixels selected, the Magic Wand's Esc deselects them and the
           * wand stays on. With nothing selected, Esc ends the wand: in the
           * Paint tool it goes back to Select.
           */
          if (session.engine === "wand" && selectionRef.current) {
            changeSelection(null);
          } else {
            cancelClickSelect();
            if (session.target.part === PAINT_PART) setTool("whole");
          }
        } else if (event.ctrlKey && event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (session.engine === "wand") {
            if (event.shiftKey) redoMask();
            else undoMask();
          } else {
            undoClickPoint();
          }
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
      /** Ctrl+Alt+S, or Photoshop's Ctrl+Shift+Alt+E, adds a snapshot of the visible layers. */
      if (event.ctrlKey && event.altKey && !typing && (event.code === "KeyS" || (event.shiftKey && event.code === "KeyE"))) {
        event.preventDefault();
        if (!event.repeat) void snapshotVisible();
      } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave(documentRef.current.id, event.shiftKey);
      }
      if (event.key === "Escape" && !typing) {
        /** Esc first drops work in progress; then, in the Paint tool, it goes straight back to Select. */
        if (gradientRef.current) cancelGradientDrag();
        else if (gradient && isMaskTool) setGradient(null);
        else if (marqueeDragRef.current) {
          marqueeDragRef.current = null;
          setMarqueeDrag(null);
        } else if (lassoPointsRef.current.length) setLassoPoints([]);
        else if (lasso && isMaskTool) setLasso(false);
        else if (marquee && isMaskTool) setMarquee(null);
        else if (isMaskTool || isPaintTool) setTool("whole");
      }
      /** Without a selection, Alt+Backspace fills the whole selected layer with the paint color, as in Photoshop, or the whole mask in the Mask tool. */
      if (event.altKey && !event.ctrlKey && event.key === "Backspace" && !typing) {
        event.preventDefault();
        /** In the Mask tool it fills the whole mask: white (shows all) or black (hides all), as the brush paints. */
        if (!event.repeat) {
          if (isMaskTool) fillMaskSelection(null);
          else void fillWithColor(null);
        }
      }
      if (event.key === "Enter" && !typing && gradientRef.current?.editing) {
        event.preventDefault();
        finishGradientDrag(true);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "z" && !typing) {
        event.preventDefault();
        /** Ctrl+Z on a gradient that is not applied yet removes it. */
        if (gradientRef.current) cancelGradientDrag();
        else if (event.shiftKey) redoMask();
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
      if (event.key.toLowerCase() === "m" && targetPart) {
        if (isPaintTool) {
          setLasso(false);
          setGradient(null);
        }
        toggleTool("mask");
      }
      /**
       * Mask brush keys: 1 to 9 set 10% to 90% opacity, 0 sets 100%, and + and −
       * on the number row change it by 10%; X swaps Show and Hide; R shows or
       * hides the red view.
       */
      if ((isMaskTool || isPaintTool) && /^[0-9]$/.test(event.key)) {
        event.preventDefault();
        setMaskOpacity(event.key === "0" ? 100 : Number(event.key) * 10);
      }
      if ((isMaskTool || isPaintTool) && (event.code === "Equal" || event.code === "Minus")) {
        event.preventDefault();
        setMaskOpacity(maskOpacity + (event.code === "Equal" ? 10 : -10));
      }
      if (isMaskTool && event.key.toLowerCase() === "x") setMaskShows((shows) => !shows);
      if (isMaskTool && event.key.toLowerCase() === "r") setMaskOverlay((shown) => !shown);
      if ((isMaskTool || isPaintTool) && event.key.toLowerCase() === "p") toggleBrushPrecise();
      /** L turns the polygon lasso on or off; Enter fills the shape, and Backspace removes its last corner. */
      if (isMaskTool && targetPart && event.key.toLowerCase() === "l") {
        setGradient(null);
        setLasso((on) => !on);
      }
      /** B goes back to the brush from the polygon lasso or a gradient. */
      if (isMaskTool && event.key.toLowerCase() === "b") {
        setLasso(false);
        setGradient(null);
      }
      /** Outside the Mask tool, B starts the paint brush and L the paint lasso; in the Paint tool, L switches between them. */
      if (!isMaskTool && event.key.toLowerCase() === "b") {
        setTool("paint");
        setGradient(null);
        setLasso(false);
      }
      /** E starts the eraser, as in Photoshop. */
      if (!isMaskTool && event.key.toLowerCase() === "e") {
        if (clickSelectRef.current) cancelClickSelect();
        setTool("paint");
        setGradient(null);
        setLasso(false);
        setEraser(true);
      }
      /** W starts the Magic Wand, as in Photoshop: in the Mask tool for the mask being painted, or else in the Paint tool. */
      if (event.key.toLowerCase() === "w") {
        if (isMaskTool) {
          if (targetPart) void partAction(documentRef.current.historyIndex, targetPart, "wand-select");
        } else if (!paintWandOn) {
          void togglePaintWand();
        }
      }
      if (!isMaskTool && event.key.toLowerCase() === "l") {
        setTool("paint");
        setGradient(null);
        setLasso((on) => isPaintTool ? !on : true);
      }
      if (lasso && event.key === "Enter" && lassoPointsRef.current.length >= 3) {
        event.preventDefault();
        selectLasso(lassoPointsRef.current, event.altKey, event.shiftKey);
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
      if (event.key === "Alt") {
        event.preventDefault();
        setErasing(false);
      }
      if (event.key === "Shift") setShiftHeld(false);
      if (event.code === "Space") setSpaceHeld(false);
      setZoomKeys(event.ctrlKey ? (event.altKey ? "out" : "in") : null);
    };
    const onBlur = () => {
      setErasing(false);
      setShiftHeld(false);
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

  /**
   * The image point under the pointer. With `clamp` false, a point outside
   * the image stays outside it (negative, or past the width or height), so
   * the lasso, gradients and brushes can have points in the work area.
   */
  const pointFromEvent = (event: { clientX: number; clientY: number }, clamp = true): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    return clamp ? { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) } : { x, y };
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
    applyMaskStroke(mask, stroke.base, clipToSelection(stroke.stroke, stroke.clip), stroke.opacity, stroke.add);
    redrawPrepared(stroke.prep);
  };

  /** Draws one piece of a brush stroke on `canvas` in `color`, with the brush size and edge. */
  const drawBrushSegment = (canvas: HTMLCanvasElement, from: Point, to: Point, color: string) => {
    const context = canvas.getContext("2d")!;
    context.save();
    context.filter = `blur(${brushPrecise ? PRECISE_BRUSH_BLUR : Math.max(0.5, brushRadius * 0.3)}px)`;
    context.strokeStyle = color;
    context.fillStyle = color;
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
  };

  /** Paints one piece of a mask stroke and redraws the surface on the next frame. */
  const paintMaskSegment = (from: Point, to: Point) => {
    const stroke = maskStrokeRef.current;
    if (!stroke) return;
    drawBrushSegment(stroke.stroke, from, to, "#fff");
    if (stroke.frame !== null) return;
    stroke.frame = requestAnimationFrame(() => {
      stroke.frame = null;
      flushMaskStroke(stroke);
    });
  };

  /** Lays the paint stroke so far on the layer and redraws the surface. */
  const flushPaintStroke = (stroke: PaintStroke) => {
    if (stroke.frame !== null) cancelAnimationFrame(stroke.frame);
    stroke.frame = null;
    const context = stroke.prep.image.getContext("2d")!;
    context.save();
    context.globalCompositeOperation = "copy";
    context.drawImage(stroke.base, 0, 0);
    /** The eraser takes the stroke's shape out of the layer; the brush lays the color on. */
    context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    context.globalAlpha = stroke.opacity;
    context.drawImage(clipToSelection(stroke.stroke, stroke.clip), 0, 0);
    context.restore();
    redrawPrepared(stroke.prep);
  };

  /** `canvas` cut to the selection: only the part inside it, drawn in the clip's own canvas. Without a clip, `canvas` itself. */
  const clipToSelection = (canvas: HTMLCanvasElement, clip?: { mask: HTMLCanvasElement; scratch: HTMLCanvasElement }) => {
    if (!clip) return canvas;
    const context = clip.scratch.getContext("2d")!;
    context.save();
    context.globalCompositeOperation = "copy";
    context.drawImage(canvas, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.imageSmoothingEnabled = true;
    context.drawImage(clip.mask, 0, 0, canvas.width, canvas.height);
    context.restore();
    return clip.scratch;
  };
  /** The selection's clip for a canvas of the image size, or none without a selection. */
  const selectionClip = () => {
    const mask = selectionRef.current?.canvas;
    return mask ? { mask, scratch: createCanvas(width, height) } : undefined;
  };

  /** Paints one piece of a paint stroke and redraws the surface on the next frame. */
  const paintColorSegment = (from: Point, to: Point) => {
    const stroke = paintStrokeRef.current;
    if (!stroke) return;
    drawBrushSegment(stroke.stroke, from, to, stroke.color);
    if (stroke.frame !== null) return;
    stroke.frame = requestAnimationFrame(() => {
      stroke.frame = null;
      flushPaintStroke(stroke);
    });
  };

  /**
   * Paint changes a layer's decoded image in place; saving it as a PNG takes
   * a moment. Saves run in order (`pixelsChainRef`), and a paint that starts
   * while one is saving takes that save as its "before" (`pixelsPendingRef`).
   */
  const pixelsChainRef = useRef<Promise<void>>(Promise.resolve());
  const pixelsPendingRef = useRef(new Map<string, Promise<string>>());
  /** The layer's pixels as the last paint left them (a PNG data URL). */
  const latestPixels = (owner: string) =>
    pixelsPendingRef.current.get(owner) ?? Promise.resolve(documentRef.current.history.find((step) => step.id === owner)?.layer ?? "");

  /** Saves a painted layer image and records the change for Ctrl+Z. */
  const commitPixels = (owner: string, before: Promise<string>, image: HTMLCanvasElement) => {
    const encoded = canvasToDataUrl(image);
    pixelsPendingRef.current.set(owner, encoded);
    pixelsChainRef.current = pixelsChainRef.current.then(async () => {
      const [from, url] = await Promise.all([before, encoded]);
      const current = documentRef.current;
      const node = nodeOfOwner(current, owner);
      if (node > 0) {
        layerCacheRef.current.set(`${owner}:image`, { src: url, canvas: image });
        maskUndoRef.current.push({ kind: "pixels", owner, before: from, after: url });
        maskRedoRef.current = [];
        onCommit(current.id, { history: current.history.map((step, index) => index === node - 1 ? { ...step, layer: url } : step), historyIndex: node });
      }
      /** The document shows the new pixels after the next render. */
      requestAnimationFrame(() => {
        if (pixelsPendingRef.current.get(owner) === encoded) pixelsPendingRef.current.delete(owner);
      });
    }).catch((error) => onNotice({ tone: "error", message: `Could not save the paint: ${error instanceof Error ? error.message : String(error)}` }));
  };

  /** The selected layer for paint, or null after telling the user why it cannot be painted. */
  const paintTarget = () => {
    const doc = documentRef.current;
    const step = doc.historyIndex > 0 ? doc.history[doc.historyIndex - 1] : null;
    if (!step) {
      onNotice({ tone: "error", message: "Select a layer to paint on first." });
      return null;
    }
    if (step.hidden) {
      onNotice({ tone: "warning", message: `${step.name || `Layer ${doc.historyIndex}`} is hidden. Show it to paint on it.` });
      return null;
    }
    return step;
  };

  /**
   * Fills the selection, or the whole selected layer for null, with the
   * paint color at the brush opacity (Alt+Backspace).
   */
  const fillWithColor = async (chosen: PixelSelection | null) => {
    if (applyingRef.current || resizeRef.current || paintStrokeRef.current) return;
    const step = paintTarget();
    if (!step) return;
    await pixelsChainRef.current;
    const before = await latestPixels(step.id);
    const image = await decodeLayer(`${step.id}:image`, before);
    const context = image.getContext("2d")!;
    context.save();
    context.globalAlpha = maskOpacity / 100;
    if (chosen) {
      /** The selection's mask, at the layer size, filled with the paint color. */
      const area = createCanvas(image.width, image.height);
      const areaContext = area.getContext("2d")!;
      areaContext.imageSmoothingEnabled = true;
      areaContext.drawImage(chosen.canvas, 0, 0, image.width, image.height);
      areaContext.globalCompositeOperation = "source-in";
      areaContext.fillStyle = paintColor;
      areaContext.fillRect(0, 0, image.width, image.height);
      context.drawImage(area, 0, 0);
    } else {
      context.fillStyle = paintColor;
      context.fillRect(0, 0, image.width, image.height);
    }
    context.restore();
    const prep = maskPrepRef.current;
    if (prep && prep.part === PAINT_PART && prep.owner === step.id && prep.image === image) redrawPrepared(prep);
    else setComposeTick((tick) => tick + 1);
    commitPixels(step.id, Promise.resolve(before), image);
  };

  /**
   * Copies what shows inside the selection, all visible layers together, to
   * the pixel clipboard (Ctrl+C). With `cut` "layer" (Ctrl+X), it takes the
   * selected layer's own pixels instead and removes them from the layer.
   * With `cut` "all" (Ctrl+Shift+X), it copies what shows and removes it
   * from every visible layer. Each cut is one step for Ctrl+Z.
   */
  const copySelectedPixels = async (chosen: PixelSelection, cut: "layer" | "all" | null) => {
    if (applyingRef.current || resizeRef.current || paintStrokeRef.current) return;
    /** The selection's mask over `source`, on a new canvas of the image size. */
    const insideSelection = (source: HTMLCanvasElement) => {
      const piece = createCanvas(source.width, source.height);
      const pieceContext = piece.getContext("2d")!;
      pieceContext.drawImage(source, 0, 0);
      pieceContext.globalCompositeOperation = "destination-in";
      pieceContext.imageSmoothingEnabled = true;
      pieceContext.drawImage(chosen.canvas, 0, 0, source.width, source.height);
      return piece;
    };
    /** Removes the selection from `image`, in place. */
    const eraseSelection = (image: HTMLCanvasElement) => {
      const context = image.getContext("2d")!;
      context.save();
      context.globalCompositeOperation = "destination-out";
      context.imageSmoothingEnabled = true;
      context.drawImage(chosen.canvas, 0, 0, image.width, image.height);
      context.restore();
    };
    if (cut !== "layer") {
      await composeRef.current;
      pixelClipboard = insideSelection(surface);
      if (!cut) return;
      /** Every visible layer loses the selected pixels; one Ctrl+Z puts them all back. */
      await pixelsChainRef.current;
      const visible = documentRef.current.history.filter((step) => !step.hidden && step.layer);
      if (!visible.length) return;
      const changes = await Promise.all(visible.map(async (step) => {
        const before = await latestPixels(step.id);
        const image = await decodeLayer(`${step.id}:image`, before);
        eraseSelection(image);
        const after = await canvasToDataUrl(image);
        layerCacheRef.current.set(`${step.id}:image`, { src: after, canvas: image });
        return { owner: step.id, before, after };
      }));
      maskUndoRef.current.push({ kind: "pixels-many", changes });
      maskRedoRef.current = [];
      const current = documentRef.current;
      const layers = new Map(changes.map((change) => [change.owner, change.after]));
      onCommit(current.id, { history: current.history.map((step) => layers.has(step.id) ? { ...step, layer: layers.get(step.id)! } : step) });
      const prep = maskPrepRef.current;
      if (prep && prep.part === PAINT_PART && layers.has(prep.owner)) redrawPrepared(prep);
      return;
    }
    const doc = documentRef.current;
    const step = doc.historyIndex > 0 ? doc.history[doc.historyIndex - 1] : null;
    if (!step) {
      onNotice({ tone: "error", message: "Select a layer to cut from first." });
      return;
    }
    await pixelsChainRef.current;
    const before = await latestPixels(step.id);
    const image = await decodeLayer(`${step.id}:image`, before);
    pixelClipboard = insideSelection(image);
    eraseSelection(image);
    const prep = maskPrepRef.current;
    if (prep && prep.part === PAINT_PART && prep.owner === step.id && prep.image === image) redrawPrepared(prep);
    else setComposeTick((tick) => tick + 1);
    commitPixels(step.id, Promise.resolve(before), image);
  };

  /**
   * A new canvas size (Canvas Size, Image Size): every layer, mask,
   * adjustment mask and transform source is drawn again on a canvas of the
   * new size, with the old top left at (`x`, `y`); space outside the old
   * image is transparent, and what falls outside the new canvas is cut off.
   * With `scaleX` and `scaleY`, the image is also resized by those factors
   * (smooth resampling); with `sharpen`, layer images are then lightly
   * sharpened. A transform source survives only an even scale; an uneven
   * one makes the layer's pixels final.
   * The edits' recorded areas move with it. One Ctrl+Z puts it all back.
   * Returns the new surface, or null when it could not start.
   */
  const resizeCanvas = async (change: CanvasChange & { scaleX?: number; scaleY?: number; sharpen?: boolean }): Promise<HTMLCanvasElement | null> => {
    if (applyingRef.current || resizeRef.current || gradientRef.current || clickSelectRef.current || paintStrokeRef.current) return null;
    await pixelsChainRef.current;
    await composeRef.current;
    const current = documentRef.current;
    const { x: dx, y: dy } = change;
    const scaleX = change.scaleX ?? 1;
    const scaleY = change.scaleY ?? 1;
    /** A point of the old image on the new canvas. */
    const moveX = (x: number) => x * scaleX + dx;
    const moveY = (y: number) => y * scaleY + dy;
    /**
     * An image (by decode key and data) on the new canvas, moved by the
     * offset and enlarged by the scale; with `still`, as it is (a transform
     * source keeps its own place and size). `sharp` sharpens it after.
     */
    const redraw = async (key: string, src: string, still = false, sharp = false) => {
      const image = await decodeLayer(key, src);
      const canvas = createCanvas(change.width, change.height);
      const context = canvas.getContext("2d")!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (still) context.drawImage(image, 0, 0);
      else context.drawImage(image, dx, dy, image.width * scaleX, image.height * scaleY);
      if (sharp && change.sharpen) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        sharpenPixels(pixels.data, canvas.width, canvas.height, 0.5);
        context.putImageData(pixels, 0, 0);
      }
      return canvasToDataUrl(canvas);
    };
    const moveAdjust = async (ownerKey: string, adjust: LayerAdjust | undefined) => adjust
      ? Promise.all(adjustList(adjust).map(async (item) => item.mask ? { ...item, mask: await redraw(adjustMaskKey(ownerKey, item.id), item.mask) } : item))
      : undefined;
    const history = await Promise.all(current.history.map(async (step): Promise<EditStep> => {
      const next: EditStep = {
        ...step,
        selection: { ...step.selection, x: moveX(step.selection.x), y: moveY(step.selection.y), size: step.selection.size * scaleX },
        sent: { ...step.sent, x: moveX(step.sent.x), y: moveY(step.sent.y), width: step.sent.width * scaleX, height: step.sent.height * scaleY },
        ...(step.area ? { area: { x: moveX(step.area.x), y: moveY(step.area.y), width: step.area.width * scaleX, height: step.area.height * scaleY } } : {}),
        ...(step.target ? { target: { ...step.target, x: moveX(step.target.x), y: moveY(step.target.y), size: step.target.size * scaleX } } : {})
      };
      if (step.layer) next.layer = await redraw(`${step.id}:image`, step.layer, false, true);
      if (step.layerMask) next.layerMask = await redraw(`${step.id}:mask`, step.layerMask);
      if (step.adjust) next.adjust = await moveAdjust(step.id, step.adjust);
      /** A transform source keeps its pixels in place; its transform moves with the canvas. */
      const source = step.transformSource;
      if (source && scaleX !== scaleY) delete next.transformSource;
      if (source && scaleX === scaleY) {
        const sourceKey = `${step.id}:source`;
        next.transformSource = {
          layer: await redraw(`${sourceKey}:image`, source.layer, true),
          ...(source.layerMask ? { layerMask: await redraw(`${sourceKey}:mask`, source.layerMask, true) } : {}),
          ...(source.adjustMasks
            ? { adjustMasks: Object.fromEntries(await Promise.all(Object.entries(source.adjustMasks).map(async ([id, mask]) => [id, await redraw(adjustMaskKey(sourceKey, id), mask, true)] as const))) }
            : {}),
          transform: { a: source.transform.a * scaleX, b: source.transform.b * scaleX, x: moveX(source.transform.x), y: moveY(source.transform.y) },
          made: ""
        };
        next.transformSource.made = transformMade(next);
      }
      return next;
    }));
    const base = current.base ? await redraw(`base:${current.id}`, current.base, false, true) : current.base;
    const baseAdjust = await moveAdjust(`base:${current.id}`, current.baseAdjust);
    const surfaceNext = createCanvas(change.width, change.height);
    const before: CanvasState = { surface: current.surface, history: current.history, historyIndex: current.historyIndex, base: current.base, baseAdjust: current.baseAdjust };
    const after: CanvasState = { surface: surfaceNext, history, historyIndex: current.historyIndex, base, baseAdjust };
    maskUndoRef.current.push({ kind: "canvas", before, after });
    maskRedoRef.current = [];
    onCommit(current.id, { surface: surfaceNext, history, base, baseAdjust });
    return surfaceNext;
  };

  /** Makes the color of the visible image at `point` the paint color (the eyedropper). */
  const colorAt = (point: Point) => {
    const x = Math.min(width - 1, Math.floor(point.x));
    const y = Math.min(height - 1, Math.floor(point.y));
    return surface.getContext("2d")!.getImageData(x, y, 1, 1).data;
  };
  /** False when no layer shows at `point`. */
  const pickColorAt = (point: Point) => {
    const [r, g, b, a] = colorAt(point);
    if (a === 0) {
      onNotice({ tone: "warning", message: "No layer shows there, so there is no color to pick." });
      return false;
    }
    setPaintColor(rgbToHex(r, g, b));
    return true;
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

  /** Draws the gradient into the mask or the layer's pixels, and redraws the surface. A stop dragged away to be removed is left out. */
  const paintGradientNow = (drag: GradientDrag) => {
    const away = drag.grab?.what === "stop" && drag.grab.away ? drag.grab.index : -1;
    const stops = gradientStopsRef.current[drag.target].filter((_, index) => index !== away);
    if (drag.target === "paint") {
      drawPaintGradient(drag.prep.image, drag.base, drag.kind, drag.from, drag.to, resolveClearStops(stops).map((stop) => ({ offset: stop.offset, color: stopCss(stop) })), 1, drag.clip);
    } else {
      const { mask, hides } = prepTarget(drag.prep);
      if (!mask) return;
      drawMaskGradient(mask, drag.base, drag.kind, drag.from, drag.to, stops.map((stop) => ({ offset: stop.offset, shows: grayLevel(stop.color) })), 1, hides);
      /** Inside a selection, the mask keeps its old values outside it. */
      if (drag.clip) {
        const outside = drag.clip.scratch.getContext("2d")!;
        outside.save();
        outside.globalCompositeOperation = "copy";
        outside.drawImage(drag.base, 0, 0);
        outside.globalCompositeOperation = "destination-out";
        outside.imageSmoothingEnabled = true;
        outside.drawImage(drag.clip.mask, 0, 0, mask.width, mask.height);
        outside.restore();
        const context = mask.getContext("2d")!;
        context.save();
        context.globalCompositeOperation = "destination-in";
        context.imageSmoothingEnabled = true;
        context.drawImage(drag.clip.mask, 0, 0, mask.width, mask.height);
        context.globalCompositeOperation = "source-over";
        context.drawImage(drag.clip.scratch, 0, 0);
        context.restore();
      }
    }
    redrawPrepared(drag.prep);
  };

  /** Draws the gradient on the next frame. */
  const drawGradientDrag = (drag: GradientDrag) => {
    if (drag.frame !== null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      paintGradientNow(drag);
    });
  };

  /** The gradient as the overlay draws it. */
  const showGradientEdit = (drag: GradientDrag) => setGradientEdit({
    from: drag.from,
    to: drag.to,
    kind: drag.kind,
    target: drag.target,
    awayIndex: drag.grab?.what === "stop" && drag.grab.away ? drag.grab.index : null
  });

  /**
   * What is under `point` on the gradient being edited: a middle stop, an
   * end, or the line between the ends (with the offset there), or null.
   */
  const gradientHit = (drag: GradientDrag, point: Point) => {
    const stops = gradientStopsRef.current[drag.target];
    const screenDistance = (target: Point) => Math.hypot(target.x - point.x, target.y - point.y) * cssScale;
    for (let index = stops.length - 2; index >= 1; index--) {
      if (screenDistance(pointOnLine(drag.from, drag.to, stops[index].offset)) <= 8) return { what: "stop" as const, index };
    }
    if (screenDistance(drag.to) <= 10) return { what: "to" as const, index: stops.length - 1 };
    if (screenDistance(drag.from) <= 10) return { what: "from" as const, index: 0 };
    const { offset, distance } = projectOnLine(drag.from, drag.to, point);
    if (offset > 0 && offset < 1 && distance * cssScale <= 6) return { what: "line" as const, offset };
    return null;
  };

  /** Ends a gradient: applies it, or puts the mask or pixels back. A gradient too short to set a direction changes nothing. */
  const finishGradientDrag = (commit: boolean) => {
    const drag = gradientRef.current;
    if (!drag) return;
    gradientRef.current = null;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    moveGradientLine(null);
    setGradientEdit(null);
    setStopPicker(null);
    const moved = Math.hypot(drag.to.x - drag.from.x, drag.to.y - drag.from.y) * cssScale >= 3;
    if (drag.target === "paint") {
      drag.grab = null;
      if (!commit || !moved) {
        const context = drag.prep.image.getContext("2d")!;
        context.save();
        context.globalCompositeOperation = "copy";
        context.drawImage(drag.base, 0, 0);
        context.restore();
        redrawPrepared(drag.prep);
        return;
      }
      paintGradientNow(drag);
      commitPixels(drag.prep.owner, latestPixels(drag.prep.owner), drag.prep.image);
      return;
    }
    const { mask, hides } = prepTarget(drag.prep);
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
    /** The gradient tool stays on for the next drag, until another tool is picked. */
    drag.grab = null;
    paintGradientNow(drag);
    void canvasToDataUrl(mask).then((url) => recordMaskChange({ owner: drag.prep.owner, part: drag.prep.part, before: drag.before, after: { mask: url, hides } }, mask));
  };
  const cancelGradientDrag = () => finishGradientDrag(false);

  /** Moves the line from the last lasso corner to the pointer. */
  const moveLassoRubber = () => {
    const group = lassoRubberRef.current;
    const last = lassoPointsRef.current.at(-1);
    const hover = lassoHoverRef.current;
    if (!group) return;
    const hoverCorner = lassoHoverCornerRef.current;
    if (!last || !hover || lassoDragRef.current?.moved || (hoverCorner !== null && hoverCorner > 0)) {
      group.style.display = "none";
      return;
    }
    group.style.display = "";
    /** Two lines: a solid base and the marching ants on top. */
    for (const line of Array.from(group.children)) {
      line.setAttribute("x1", String(last.x * cssScale));
      line.setAttribute("y1", String(last.y * cssScale));
      line.setAttribute("x2", String(hover.x * cssScale));
      line.setAttribute("y2", String(hover.y * cssScale));
    }
  };
  useLayoutEffect(moveLassoRubber);

  /**
   * The closed lasso shape becomes the selection: a new one, or with Shift
   * added to it, or with Alt taken from it. Nothing is filled; Alt+Backspace
   * fills the selection.
   */
  const selectLasso = (points: Point[], subtract: boolean, add: boolean) => {
    setLassoPoints([]);
    lassoClickRef.current = null;
    if (points.length < 3) return;
    selectShape((context) => {
      points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.closePath();
    }, subtract ? "subtract" : add ? "add" : "replace");
  };

  /**
   * A shape, traced in image pixels by `trace`, becomes the selection in
   * `mode`. The canvas draws it smooth, so pixels on a slanted or curved
   * edge are partly selected.
   */
  const selectShape = (trace: (context: CanvasRenderingContext2D) => void, mode: SelectMode) => {
    const grid = selectionGrid();
    const shape = createCanvas(grid.width, grid.height);
    const context = shape.getContext("2d")!;
    context.scale(grid.scale, grid.scale);
    context.fillStyle = "#fff";
    context.beginPath();
    trace(context);
    context.fill();
    /** The canvas draws the shape smooth: pixels on a slanted edge are partly covered, and keep that level. */
    const alpha = context.getImageData(0, 0, grid.width, grid.height).data;
    const area = new Uint8Array(grid.width * grid.height);
    for (let index = 0; index < area.length; index++) area[index] = alpha[index * 4 + 3];
    const before = selectionRef.current;
    changeSelection(makeSelection(combineSelection(before?.levels ?? null, area, mode)));
  };

  /**
   * Fills the selection in the target mask, like one brush stroke: it shows
   * or hides (as the brush does) at the brush opacity (Alt+Backspace).
   */
  const fillMaskSelection = (chosen: PixelSelection | null) => {
    const prep = maskPrepRef.current;
    const doc = documentRef.current;
    const node = doc.historyIndex;
    if (!targetPart || !prep || prep.part !== targetPart || prep.owner !== (node > 0 ? doc.history[node - 1].id : BASE_OWNER)) return;
    const before = partMaskState(doc, node, targetPart);
    let { mask, hides } = prepTarget(prep);
    let shows = maskShows;
    /**
     * As with the brush, a mask that shows (or hides) everything can only be
     * changed the other way. A fill of the whole mask keeps the mode asked for.
     */
    const forced = chosen ? forcedMaskMode(prep) : null;
    if (forced !== null && forced !== shows) {
      shows = forced;
      setMaskShows(forced);
    }
    if (!mask) {
      mask = createCanvas(width, height);
      hides = !shows;
      setPrepTarget(prep, mask, hides);
    }
    /** The area to fill: the selection, or with none, the whole mask (white to show all, black to hide all). */
    const shape = createCanvas(width, height);
    const context = shape.getContext("2d")!;
    if (chosen) {
      context.imageSmoothingEnabled = true;
      context.drawImage(chosen.canvas, 0, 0, width, height);
    } else {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }
    applyMaskStroke(mask, drawingCopy(mask), shape, maskOpacity / 100, shows !== hides);
    redrawPrepared(prep);
    const filled = mask;
    const filledHides = hides;
    void canvasToDataUrl(filled).then((url) => recordMaskChange({ owner: prep.owner, part: prep.part, before, after: { mask: url, hides: filledHides } }, filled));
  };

  /**
   * A lasso click adds a corner. With three corners or more, a click on the
   * first corner or a double-click closes the shape and selects it (Shift
   * adds to the selection, Alt takes from it).
   */
  const lassoClick = (point: Point, reverse: boolean, add: boolean) => {
    const points = lassoPointsRef.current;
    const now = performance.now();
    const last = lassoClickRef.current;
    lassoClickRef.current = { time: now, point };
    const near = (a: Point, b: Point, reach: number) => Math.hypot(a.x - b.x, a.y - b.y) * cssScale <= reach;
    if (points.length >= 3 && near(point, points[0], LASSO_CLOSE_REACH)) {
      selectLasso(points, reverse, add);
      return;
    }
    if (points.length >= 3 && last && now - last.time < 400 && near(point, last.point, 4)) {
      selectLasso(points, reverse, add);
      return;
    }
    setLassoPoints([...points, point]);
    lassoFreshRef.current = points.length;
  };

  /** The placed corner under `point` that the pointer can grab, or null. The corner just placed is left out unless `withFresh`. */
  const lassoCornerAt = (point: Point, withFresh = false) => {
    let found: number | null = null;
    let best = LASSO_GRAB_REACH;
    lassoPointsRef.current.forEach((corner, index) => {
      if (index === lassoFreshRef.current && !withFresh) return;
      const distance = Math.hypot(point.x - corner.x, point.y - corner.y) * cssScale;
      if (distance <= best) {
        best = distance;
        found = index;
      }
    });
    return found;
  };

  /**
   * The pointer moves over the lasso without a press: it shows the hand over a
   * corner that can be moved. Over any corner but the first, the line to the
   * pointer hides, so the corner is easy to see.
   */
  const hoverLasso = (point: Point) => {
    const corner = lassoCornerAt(point);
    lassoHoverRef.current = point;
    lassoHoverCornerRef.current = corner;
    moveLassoRubber();
    setLassoCursor(corner === null ? null : "grab");
    setLassoOverCorner(lassoCornerAt(point, true) !== null);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || resizeRef.current) return;
    if (clickSelectRef.current) {
      /** The Magic Wand: a click starts a new selection, Shift or Ctrl+click adds to it, and Alt+click takes away from it. */
      const point = pointFromEvent(event);
      if (clickSelectRef.current.engine === "wand") wandClick(point, event.altKey ? "subtract" : event.shiftKey || event.ctrlKey ? "add" : "replace");
      else addClickPoint(point, !event.altKey);
      return;
    }
    /** A color picked with the color picker open closes the picker and starts the paint brush. */
    if (pickingColor) {
      if (pickColorAt(pointFromEvent(event))) {
        setPickingColor(false);
        moveColorProbe(null);
        if (clickSelect) cancelClickSelect();
        setTool("paint");
        setGradient(null);
        setLasso(false);
      }
      return;
    }
    if (isMaskTool || isPaintTool) {
      /** Alt + click with the paint brush picks the color under the pointer. */
      if (isPaintTool && brushLike && !eraser && event.altKey) {
        pickColorAt(pointFromEvent(event));
        return;
      }
      if (isPaintTool && !paintTarget()) return;
      const part = isPaintTool ? PAINT_PART : targetPart;
      if (!part) {
        onNotice({ tone: "error", message: documentRef.current.base
          ? "The original image is the bottom layer, so it cannot have a layer mask. Add an adjustment to it to paint where the adjustment applies."
          : "Select a layer first." });
        return;
      }
      const prep = maskPrepRef.current;
      const doc = documentRef.current;
      const node = doc.historyIndex;
      if (!prep || prep.part !== part || prep.owner !== (node > 0 ? doc.history[node - 1].id : BASE_OWNER)) return;
      /** Rectangle and ellipse select: a drag draws the shape; Shift or Alt when letting go adds to the selection or takes from it. */
      if (marquee) {
        const point = pointFromEvent(event, false);
        event.currentTarget.setPointerCapture(event.pointerId);
        marqueeDragRef.current = { shape: marquee, start: point, current: point, even: false, centered: false, startX: event.clientX, startY: event.clientY };
        setMarqueeDrag(null);
        return;
      }
      if (lasso) {
        const point = pointFromEvent(event, false);
        /** Ctrl+click on a corner deletes it; the next corner takes its place in the shape. */
        if (event.ctrlKey) {
          const doomed = lassoCornerAt(point, true);
          if (doomed !== null) {
            setLassoPoints(lassoPointsRef.current.filter((_, index) => index !== doomed));
            lassoFreshRef.current = null;
            lassoClickRef.current = null;
            hoverLasso(point);
          }
          return;
        }
        const corner = lassoCornerAt(point);
        if (corner !== null) {
          lassoDragRef.current = { index: corner, point, startX: event.clientX, startY: event.clientY, moved: false, reverse: event.altKey, add: event.shiftKey };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        lassoClick(point, event.altKey, event.shiftKey);
        return;
      }
      const point = pointFromEvent(event, false);
      event.currentTarget.setPointerCapture(event.pointerId);
      if (gradient) {
        const open = gradientRef.current;
        /**
         * On a gradient being edited, a press grabs an end or a stop, or adds
         * a stop on the line. A press anywhere else applies the gradient.
         */
        if (open?.editing) {
          const hit = gradientHit(open, point);
          setStopPicker(null);
          if (!hit) {
            finishGradientDrag(true);
            return;
          }
          if (hit.what === "line") {
            const stops = gradientStopsRef.current[open.target];
            const offset = clampMiddleOffset(hit.offset);
            addStop(open.target, stopAt(resolveClearStops(stops), offset));
            open.grab = { what: "stop", index: stops.length - 1, startX: event.clientX, startY: event.clientY, moved: true, away: false };
          } else {
            open.grab = { what: hit.what, index: hit.index, startX: event.clientX, startY: event.clientY, moved: false, away: false };
          }
          return;
        }
        if (isPaintTool) {
          const clip = selectionClip();
          gradientRef.current = { prep, target: "paint", kind: gradient, from: point, to: point, before: {}, base: drawingCopy(prep.image), created: false, frame: null, editing: false, grab: null, clip };
          moveGradientLine(point, point);
          return;
        }
      }
      if (isPaintTool) {
        paintStrokeRef.current = {
          prep,
          last: point,
          base: drawingCopy(prep.image),
          stroke: createCanvas(width, height),
          opacity: maskOpacity / 100,
          color: paintColor,
          frame: null,
          clip: selectionClip(),
          erase: eraser
        };
        paintColorSegment(point, point);
        return;
      }
      const before = partMaskState(doc, node, part);
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
        gradientRef.current = { prep, target: "mask", kind: gradient, from: point, to: point, before, base: drawingCopy(mask), created, frame: null, editing: false, grab: null, clip: selectionClip() };
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
        frame: null,
        clip: selectionClip()
      };
      paintMaskSegment(point, point);
      return;
    }
    /** In Select, Ctrl+click selects the layer under the pointer, as in Photoshop; a plain click does nothing. */
    if (!event.ctrlKey) return;
    pickLayerAt(pointFromEvent(event), event.clientX, event.clientY).catch((error) => onNotice({ tone: "error", message: `Could not find the layer at that point: ${String(error)}` }));
  };

  /** Moves the color circle to the right of the eyedropper and fills it with the color under `point`; null hides it. */
  const moveColorProbe = (point: Point | null) => {
    const probe = colorProbeRef.current;
    if (!probe) return;
    if (!point) {
      probe.style.display = "none";
      return;
    }
    const [r, g, b, a] = colorAt(point);
    probe.style.display = "";
    probe.style.transform = `translate(${point.x * cssScale + 24}px, ${point.y * cssScale - 50}px)`;
    probe.classList.toggle("empty", a === 0);
    probe.style.backgroundColor = a === 0 ? "" : `rgb(${r}, ${g}, ${b})`;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    hoverPointRef.current = pointFromEvent(event, false);
    /** The eyedropper reads the image, so its point stays on the image; a stroke in progress keeps painting. */
    const eyedropper = pickingColor || (altPicking && !paintStrokeRef.current);
    const point = pointFromEvent(event, eyedropper);
    if (eyedropper) {
      moveBrushCursor(null);
      moveColorProbe(point);
      return;
    }
    const marqueeMove = marqueeDragRef.current;
    if (marqueeMove && event.currentTarget.hasPointerCapture(event.pointerId)) {
      /**
       * While dragging, Ctrl+Shift makes a square or circle and Ctrl+Alt
       * draws from the center; Shift and Alt alone wait for the release.
       */
      marqueeMove.current = point;
      marqueeMove.even = event.ctrlKey && event.shiftKey;
      marqueeMove.centered = event.ctrlKey && event.altKey;
      setMarqueeDrag({ ...marqueeBox(marqueeMove.start, point, marqueeMove.even, marqueeMove.centered), shape: marqueeMove.shape });
      return;
    }
    if (isMaskTool || isPaintTool) {
      const drag = gradientRef.current;
      if (drag) {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const grab = drag.grab;
        if (drag.editing) {
          if (!grab) return;
          /** A few pixels of movement turn the press into a drag. */
          if (!grab.moved && Math.hypot(event.clientX - grab.startX, event.clientY - grab.startY) < 3) return;
          grab.moved = true;
          if (grab.what === "from") drag.from = point;
          else if (grab.what === "to") drag.to = point;
          else {
            const { offset, distance } = projectOnLine(drag.from, drag.to, point);
            grab.away = distance * cssScale > STOP_REMOVE_DISTANCE;
            changeStop(drag.target, grab.index, { offset: clampMiddleOffset(offset) });
          }
          showGradientEdit(drag);
          drawGradientDrag(drag);
          return;
        }
        drag.to = point;
        moveGradientLine(drag.from, point);
        drawGradientDrag(drag);
        return;
      }
      if (lasso) {
        const lassoDrag = lassoDragRef.current;
        if (lassoDrag) {
          const points = lassoPointsRef.current;
          if (lassoDrag.index >= points.length) {
            lassoDragRef.current = null;
          } else {
            /** A few pixels of movement turn the press into a drag of the corner. */
            if (!lassoDrag.moved && Math.hypot(event.clientX - lassoDrag.startX, event.clientY - lassoDrag.startY) < 3) return;
            lassoDrag.moved = true;
            setLassoCursor("grabbing");
            moveLassoRubber();
            setLassoPoints(points.map((corner, index) => index === lassoDrag.index ? point : corner));
            return;
          }
        }
        const fresh = lassoFreshRef.current;
        const freshCorner = fresh === null ? undefined : lassoPointsRef.current[fresh];
        if (freshCorner && Math.hypot(point.x - freshCorner.x, point.y - freshCorner.y) * cssScale > LASSO_GRAB_REACH) lassoFreshRef.current = null;
        hoverLasso(point);
      }
      moveBrushCursor(gradient || lasso || marquee ? null : point);
      const paintStroke = paintStrokeRef.current;
      if (paintStroke) {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        if (Math.hypot(point.x - paintStroke.last.x, point.y - paintStroke.last.y) < Math.max(1, brushRadius * 0.15)) return;
        paintColorSegment(paintStroke.last, point);
        paintStroke.last = point;
        return;
      }
      const stroke = maskStrokeRef.current;
      if (!stroke || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      if (Math.hypot(point.x - stroke.last.x, point.y - stroke.last.y) < Math.max(1, brushRadius * 0.15)) return;
      paintMaskSegment(stroke.last, point);
      stroke.last = point;
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const marqueeEnd = marqueeDragRef.current;
    if (marqueeEnd) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      marqueeDragRef.current = null;
      setMarqueeDrag(null);
      if (event.type !== "pointerup") return;
      const box = marqueeBox(marqueeEnd.start, marqueeEnd.current, marqueeEnd.even, marqueeEnd.centered);
      /** The keys held when letting go decide: Shift adds to the selection, Alt takes from it; with Ctrl they shaped the drag instead. */
      const mode: SelectMode = event.ctrlKey ? "replace" : event.altKey ? "subtract" : event.shiftKey ? "add" : "replace";
      /** A click without a drag drops the selection, as in Photoshop. */
      if (Math.hypot(event.clientX - marqueeEnd.startX, event.clientY - marqueeEnd.startY) < 3 || box.width < 1 || box.height < 1) {
        if (mode === "replace") changeSelection(null);
        return;
      }
      selectShape((context) => {
        if (marqueeEnd.shape === "rect") context.rect(box.x, box.y, box.width, box.height);
        else context.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
      }, mode);
      return;
    }
    const lassoDrag = lassoDragRef.current;
    if (lassoDrag) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      lassoDragRef.current = null;
      /** A press without movement is a click; after a drag, drawing goes on from the last corner. */
      if (!lassoDrag.moved) {
        if (event.type === "pointerup") lassoClick(lassoDrag.point, lassoDrag.reverse, lassoDrag.add);
      } else {
        lassoClickRef.current = null;
      }
      hoverLasso(pointFromEvent(event, false));
      return;
    }
    const gradientDrag = gradientRef.current;
    if (gradientDrag) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (gradientDrag.editing) {
        const grab = gradientDrag.grab;
        gradientDrag.grab = null;
        if (!grab) return;
        /** A stop let go far from the line is removed; a click on a stop or an end opens its color. */
        if (grab.what === "stop" && grab.away) removeStop(gradientDrag.target, grab.index);
        else if (!grab.moved && event.type === "pointerup") setStopPicker(grab.index);
        showGradientEdit(gradientDrag);
        drawGradientDrag(gradientDrag);
        return;
      }
      /** After the drag, the gradient stays open, so its ends and stops can change. */
      const moved = Math.hypot(gradientDrag.to.x - gradientDrag.from.x, gradientDrag.to.y - gradientDrag.from.y) * cssScale >= 3;
      if (event.type !== "pointerup" || !moved) {
        finishGradientDrag(false);
        return;
      }
      gradientDrag.editing = true;
      moveGradientLine(null);
      showGradientEdit(gradientDrag);
      return;
    }
    const paintStroke = paintStrokeRef.current;
    if (paintStroke) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      flushPaintStroke(paintStroke);
      paintStrokeRef.current = null;
      commitPixels(paintStroke.prep.owner, latestPixels(paintStroke.prep.owner), paintStroke.prep.image);
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
  /**
   * Presses, moves and releases in the empty work area around the image go
   * to the lasso, gradient and brush tools too, so their points can lie
   * outside the image. Events from the image itself are handled there; here
   * they only bubble past, so they are left alone.
   */
  const reachesTool = (isMaskTool || isPaintTool) && !clickSelect && !pickingColor;
  const onAreaPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (reachesTool && event.target === event.currentTarget) onPointerDown(event);
  };
  const onAreaPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (reachesTool && (event.currentTarget.hasPointerCapture(event.pointerId) || event.target === event.currentTarget)) onPointerMove(event);
  };
  const onAreaPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) onPointerUp(event);
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
    } else if (command.name === "snapshot") {
      void snapshotVisible();
    } else if (command.name === "canvas-size" || command.name === "image-size") {
      if (resizeRef.current || clickSelectRef.current || gradientRef.current) {
        onNotice({ tone: "error", message: "Apply or cancel the current tool (Enter or Esc) first." });
        return;
      }
      setCanvasDialog(command.name === "image-size" ? "image" : "canvas");
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
  const panelActionsRef = useRef({ selectLayer, selectMany, toggleLayerVisible, setAllLayersVisible, snapshotVisible, addBlankLayer, requestDelete, renameLayer, moveLayerTo, partAction, setAdjustmentValue, setAdjustmentColorize, setAdjustmentLabel, requestAdjustRename, setSharpenBrightnessOnly, setBlurMotion });
  panelActionsRef.current = { selectLayer, selectMany, toggleLayerVisible, setAllLayersVisible, snapshotVisible, addBlankLayer, requestDelete, renameLayer, moveLayerTo, partAction, setAdjustmentValue, setAdjustmentColorize, setAdjustmentLabel, requestAdjustRename, setSharpenBrightnessOnly, setBlurMotion };
  const panelHandlers = useMemo(() => ({
    /** A plain click in the layers list selects one layer and ends a group. */
    onSelect: (node: number) => {
      setMultiIds([]);
      panelActionsRef.current.selectLayer(node);
    },
    onSelectMany: (node: number, mode: "toggle" | "range") => panelActionsRef.current.selectMany(node, mode),
    onToggleVisible: (node: number, solo: boolean) => panelActionsRef.current.toggleLayerVisible(node, solo),
    onShowAll: (visible: boolean) => panelActionsRef.current.setAllLayersVisible(visible),
    onSnapshot: () => void panelActionsRef.current.snapshotVisible(),
    onNewLayer: () => void panelActionsRef.current.addBlankLayer(),
    onDelete: (node: number) => panelActionsRef.current.requestDelete(node),
    onRename: (node: number, name: string) => panelActionsRef.current.renameLayer(node, name),
    onMove: (from: number, to: number, above: boolean) => panelActionsRef.current.moveLayerTo(from, to, above),
    onPartAction: (node: number, part: LayerPart, action: PartAction) => void panelActionsRef.current.partAction(node, part, action),
    onAdjustValue: (node: number, id: string, field: AdjustmentField, value: number) => panelActionsRef.current.setAdjustmentValue(node, id, field, value),
    onAdjustColorize: (node: number, id: string, colorize: boolean) => panelActionsRef.current.setAdjustmentColorize(node, id, colorize),
    onSharpenBrightnessOnly: (node: number, id: string, brightnessOnly: boolean) => panelActionsRef.current.setSharpenBrightnessOnly(node, id, brightnessOnly),
    onBlurMotion: (node: number, id: string, motion: boolean) => panelActionsRef.current.setBlurMotion(node, id, motion),
    onAdjustRename: (node: number, id: string) => panelActionsRef.current.requestAdjustRename(node, id),
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
  const regenStep = lastStep && lastStep.model !== IMPORTED_MODEL && lastStep.model !== ORIGINAL_COPY_MODEL && lastStep.model !== SNAPSHOT_MODEL && lastStep.model !== BLANK_MODEL ? lastStep : undefined;
  const regenName = lastStep ? lastStep.name || `Layer ${imageDocument.historyIndex}` : "the original image";
  /** Qwen-Image-2.1 edits any layer, the original image and imported photos included. */
  const layerEdit = localEdits(settings.wholeModel);
  const canEditLayer = Boolean(lastStep || imageDocument.base);
  const regenerate = () => {
    if (layerEdit) {
      if (canEditLayer && prompt.trim()) editSelectedLayer();
      return;
    }
    if (localChosen || !regenStep || !prompt.trim()) return;
    if (!confirms("regenerate")) void retryLayer(regenStep.id, prompt);
    else {
      setRegenDontAsk(false);
      setConfirmRegen({ stepId: regenStep.id, instruction: prompt });
    }
  };
  const confirmRegenerate = () => {
    if (!confirmRegen) return;
    if (regenDontAsk) setConfirms("regenerate", false);
    setConfirmRegen(null);
    void retryLayer(confirmRegen.stepId, confirmRegen.instruction);
  };
  const confirmRegenStep = confirmRegen ? imageDocument.history.find((item) => item.id === confirmRegen.stepId) : undefined;
  /**
   * Models in the prompt bar: the GPT Image 2.5 models (plus the current one if
   * it is older), and each local model whose files are set.
   */
  const editModels = [
    ...IMAGE_MODELS.filter((model) => model.id.startsWith("gpt-image-2.5") || model.id === settings.wholeModel),
    ...LOCAL_MODELS.filter((model) => readyLocalModels.includes(model.id) || model.id === settings.wholeModel)
  ];

  /**
   * A toolbar tool button acts when the mouse button goes down, so the tool
   * shows as picked at once; Enter or Space (a click with no mouse) still works.
   */
  const onPress = (run: () => void) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button === 0) run();
    },
    onClick: (event: { detail: number }) => {
      if (event.detail === 0) run();
    }
  });
  /** The Mask tool in use: the brush, the polygon lasso, rectangle or ellipse select, or a gradient. */
  const maskToolKind: "brush" | "lasso" | "rect" | "ellipse" | "linear" | "radial" = lasso ? "lasso" : marquee ?? gradient ?? "brush";
  const selectMaskTool = (kind: typeof maskToolKind) => {
    setLasso(kind === "lasso");
    setGradient(kind === "linear" || kind === "radial" ? kind : null);
    setMarquee(kind === "rect" || kind === "ellipse" ? kind : null);
  };
  /** The Mask tools, in toolbar order, after the Magic Wand. Toolbar buttons have no tooltips; the tips below the image explain the tool in use. */
  const maskTools = [
    { kind: "rect", label: "Rectangle select", icon: <Selection size={16} /> },
    { kind: "ellipse", label: "Ellipse select", icon: <CircleDashed size={16} /> },
    { kind: "lasso", label: "Polygon lasso", icon: <PolygonLassoIcon /> },
    { kind: "brush", label: "Brush", icon: <PaintBrush size={16} /> },
    { kind: "linear", label: "Linear gradient", icon: <LinearGradientIcon /> },
    { kind: "radial", label: "Radial gradient", icon: <RadialGradientIcon /> }
  ] as const;

  /** The Paint tool in use: the brush, the eraser, the polygon lasso, rectangle or ellipse select, or a gradient. */
  const paintKind: "brush" | "eraser" | "lasso" | "rect" | "ellipse" | "linear" | "radial" = lasso ? "lasso" : marquee ?? gradient ?? (eraser ? "eraser" : "brush");
  /** Picks a Paint tool; a click on the one in use turns the Paint tool off. */
  const selectPaintTool = (kind: typeof paintKind) => {
    if (isPaintTool && paintKind === kind && !clickSelect) {
      setTool("whole");
      return;
    }
    /** Leaving the Magic Wand for another paint tool keeps its selection. */
    if (clickSelectRef.current) cancelClickSelect();
    setTool("paint");
    setGradient(kind === "linear" || kind === "radial" ? kind : null);
    setLasso(kind === "lasso");
    setMarquee(kind === "rect" || kind === "ellipse" ? kind : null);
    setEraser(kind === "eraser");
  };
  /** The Paint tools in toolbar order, after Select and the Magic Wand. */
  const paintTools = [
    { kind: "rect", label: "Rectangle select", icon: <Selection size={16} /> },
    { kind: "ellipse", label: "Ellipse select", icon: <CircleDashed size={16} /> },
    { kind: "lasso", label: "Paint lasso", icon: <PolygonLassoIcon /> },
    { kind: "brush", label: "Paint brush", icon: <PaintBrush size={16} /> },
    { kind: "eraser", label: "Eraser", icon: <Eraser size={16} /> },
    { kind: "linear", label: "Linear gradient", icon: <LinearGradientIcon /> },
    { kind: "radial", label: "Radial gradient", icon: <RadialGradientIcon /> }
  ] as const;
  /**
   * The Magic Wand in the Paint tool selects pixels of a like color in the
   * image as it shows; Alt+Backspace fills the selection on the selected
   * layer. A click on it while it is in use turns the Paint tool off.
   */
  const paintWandOn = isPaintTool && clickSelect?.engine === "wand";
  const togglePaintWand = async () => {
    if (paintWandOn) {
      cancelClickSelect();
      setTool("whole");
      return;
    }
    if (clickSelectRef.current) cancelClickSelect();
    const step = paintTarget();
    if (!step) return;
    setTool("paint");
    await composeRef.current;
    startWandSelect({ owner: step.id, part: PAINT_PART }, surface);
  };
  /**
   * The start and end colors of the gradient in use, with a button that
   * swaps them. Their space is always kept, invisible while no gradient is
   * in use, so the centered tools do not move when a gradient is picked.
   */
  const gradientTarget: "mask" | "paint" = isMaskTool ? "mask" : "paint";
  const renderGradientEnds = (shown: boolean) => {
    const stops = gradientTarget === "mask" ? maskStops : paintGradientStops;
    const last = stops.length - 1;
    return (
      <span className={`gradient-ends ${shown ? "" : "reserved"}`} aria-hidden={!shown}>
        {gradientTarget === "mask" && <span className="swatch-label" aria-hidden="true"><span>Start/End Colors</span></span>}
        {gradientTarget === "mask" && (
          <ColorPicker grays label="Gradient start" pickFromImage={false} color={stops[0].color} onChange={(color) => changeStop("mask", 0, { color })} open={shown && swatchPicker === "start"} onOpenChange={(open) => setSwatchPicker(open ? "start" : null)} />
        )}
        <button className="gradient-swap" onClick={() => swapStops(gradientTarget)} aria-label="Swap start and end">
          <ArrowsLeftRight size={14} weight="bold" />
        </button>
        <ColorPicker
          grays={gradientTarget === "mask"}
          label="Gradient end"
          pickFromImage={false}
          transparent={gradientTarget === "paint" && stops[last].alpha === 0}
          onTransparentChange={gradientTarget === "paint" ? (transparent) => changeStop("paint", last, { alpha: transparent ? 0 : 1 }) : undefined}
          alpha={gradientTarget === "paint" ? Math.round(stops[last].alpha * 100) : undefined}
          onAlphaChange={gradientTarget === "paint" ? (alpha) => changeStop("paint", last, { alpha: alpha / 100 }) : undefined}
          color={stops[last].color}
          onChange={(color) => changeStop(gradientTarget, last, { color })}
          open={shown && swatchPicker === "end"}
          onOpenChange={(open) => setSwatchPicker(open ? "end" : null)}
        />
      </span>
    );
  };

  /** A drag on the Magic Wand's tolerance: where it started and the tolerance then. Up raises it; 2 px is 1. */
  const toleranceDragRef = useRef<{ pointerId: number; startY: number; startTolerance: number } | null>(null);
  const featherDragRef = useRef<{ pointerId: number; startY: number; startFeather: number } | null>(null);
  /** A drag on the opacity: where it started and the opacity then. Up raises it; 2 px is 1%. */
  const opacityDragRef = useRef<{ pointerId: number; startY: number; startOpacity: number } | null>(null);
  /** A drag on the brush size: where it started and the radius then. Up makes the brush larger; 80 px doubles it. */
  const brushSizeDragRef = useRef<{ pointerId: number; startY: number; startRadius: number } | null>(null);
  /**
   * While the brush size is dragged, the brush ring shows at its real size
   * just below the settings panel, under the size value (`anchor`). Its top
   * stays in place while `radius` (image pixels) changes.
   */
  const previewBrushSize = (anchor: Element, radius: number) => {
    const panel = (anchor.closest(".tool-settings") ?? anchor).getBoundingClientRect();
    const value = anchor.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || !stage.width || !stage.height) return;
    const screenRadius = radius * cssScale;
    const x = ((value.left + value.width / 2 - stage.left) / stage.width) * width;
    const y = ((panel.bottom + 12 + screenRadius - stage.top) / stage.height) * height;
    moveBrushCursor({ x, y });
  };

  /**
   * The settings of the brush or lasso in use, one per row with its
   * label before it: Size (brushes only), Opacity, then Tip (brushes only).
   * Brush Size and Opacity change by a drag up or down on their value.
   */
  const brushSettings = (
    <div className="brush-settings">
      {brushLike && (
        <>
          <span className="brush-setting-label">Size:</span>
          <span
            className="brush-size-value"
            role="slider"
            aria-label="Brush size"
            aria-valuemin={4}
            aria-valuemax={2000}
            aria-valuenow={brushRadius * 2}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              brushSizeDragRef.current = { pointerId: event.pointerId, startY: event.clientY, startRadius: brushRadius };
              previewBrushSize(event.currentTarget, brushRadius);
            }}
            onPointerMove={(event) => {
              const drag = brushSizeDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const radius = Math.max(2, Math.min(1000, Math.round(drag.startRadius * 2 ** ((drag.startY - event.clientY) / 80))));
              changeBrushRadius(radius);
              previewBrushSize(event.currentTarget, radius);
            }}
            onPointerUp={() => {
              brushSizeDragRef.current = null;
              moveBrushCursor(null);
            }}
            onPointerCancel={() => {
              brushSizeDragRef.current = null;
              moveBrushCursor(null);
            }}
          >
            {brushRadius * 2} px
          </span>
        </>
      )}
      <span className="brush-setting-label">Opacity:</span>
      <span
        className="brush-size-value"
        role="slider"
        aria-label="Brush opacity"
        aria-valuemin={1}
        aria-valuemax={100}
        aria-valuenow={maskOpacity}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          opacityDragRef.current = { pointerId: event.pointerId, startY: event.clientY, startOpacity: maskOpacity };
        }}
        onPointerMove={(event) => {
          const drag = opacityDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setMaskOpacity(drag.startOpacity + (drag.startY - event.clientY) / 2);
        }}
        onPointerUp={() => { opacityDragRef.current = null; }}
        onPointerCancel={() => { opacityDragRef.current = null; }}
      >
        {maskOpacity} %
      </span>
      {brushLike && (
        <>
          <span className="brush-setting-label">Tip:</span>
          <span className="split-button brush-tip" role="radiogroup" aria-label="Brush tip">
            <button role="radio" aria-checked={!brushPrecise} className={brushPrecise ? "" : "active"} onClick={() => { if (brushPrecise) toggleBrushPrecise(); }}>
              Soft
            </button>
            <button role="radio" aria-checked={brushPrecise} className={brushPrecise ? "active" : ""} onClick={() => { if (!brushPrecise) toggleBrushPrecise(); }}>
              Precise
            </button>
          </span>
        </>
      )}
    </div>
  );

  /** The Magic Wand's outline as an SVG path in screen pixels; it follows the zoom. */
  const wandOutline = selection?.outline;
  const wandScale = selection ? cssScale / selection.scale : 1;
  /**
   * Each loop is one closed path, so its dashes flow without a break. Steps
   * smaller than a screen pixel are smoothed, so a slanted edge is one line.
   */
  const wandOutlinePath = useMemo(() => {
    if (!wandOutline?.length) return "";
    return wandOutline.map((loop) => {
      const points = simplifyLoop(loop.map((value) => value * wandScale), 0.75);
      let path = "";
      for (let index = 0; index < points.length; index += 2) path += `${index ? "L" : "M"}${Math.round(points[index] * 10) / 10} ${Math.round(points[index + 1] * 10) / 10}`;
      return `${path}Z`;
    }).join("");
  }, [wandOutline, wandScale]);
  /** The Selection tips card: shown in the Mask, Paint and Select tips only while there is a selection. */
  const selectionCard = selection ? (
    <section className="shortcut-card">
      <div className="shortcut-card-head">Selection</div>
      <ul>
        {isMaskTool && <li><kbd>alt</kbd> + <kbd>backspace</kbd> {brushHides ? "hide" : "show"} the selection</li>}
        <li><kbd>CTRL</kbd> + <kbd>d</kbd> deselect</li>
        <li><kbd>CTRL</kbd> + <kbd>i</kbd> invert</li>
        <li><kbd>CTRL</kbd> + <kbd>x</kbd> cut (+ <kbd>shift</kbd>: all layers)</li>
        <li><kbd>CTRL</kbd> + <kbd>c</kbd> copy, <kbd>CTRL</kbd> + <kbd>v</kbd> paste as a layer</li>
      </ul>
    </section>
  ) : null;
  /** The Mask tool has only grays, so it never samples colors: an open paint color picker closes. */
  useEffect(() => {
    if (isMaskTool && pickingColor) setPickingColor(false);
  }, [isMaskTool, pickingColor]);
  /** Pressing Alt shows the color preview where the pointer is; letting go brings the brush ring back there. */
  useEffect(() => {
    const point = hoverPointRef.current;
    if (!point) return;
    if (altPicking) {
      moveBrushCursor(null);
      moveColorProbe({ x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) });
    } else if (brushLike && !pickingColor) {
      moveBrushCursor(point);
    }
  }, [altPicking]);
  /**
   * The tool settings drop-down sits centered under the button of the tool
   * in use, kept inside the toolbar. It is measured after each render, and
   * again when the window changes size.
   */
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolSettingsRef = useRef<HTMLDivElement>(null);
  const [settingsLeft, setSettingsLeft] = useState<number | null>(null);
  const [, setLayoutTick] = useState(0);
  useEffect(() => {
    const onResize = () => setLayoutTick((tick) => tick + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useLayoutEffect(() => {
    const bar = toolbarRef.current;
    const panel = toolSettingsRef.current;
    const active = bar?.querySelector<HTMLElement>(".tool-group button.active");
    if (!bar || !panel || !active) {
      if (settingsLeft !== null) setSettingsLeft(null);
      return;
    }
    const barBox = bar.getBoundingClientRect();
    const button = active.getBoundingClientRect();
    const half = panel.offsetWidth / 2;
    const left = Math.round(Math.min(barBox.width - half - 4, Math.max(half + 4, button.left + button.width / 2 - barBox.left)));
    if (left !== settingsLeft) setSettingsLeft(left);
  });
  /** The pointer over the image, and over the work area while a tool can use it. */
  const canvasCursor = pickingColor || altPicking ? EYEDROPPER_CURSOR : clickSelect ? (clickSelect.engine === "wand" ? (erasing ? WAND_SUBTRACT_CURSOR : shiftHeld ? WAND_ADD_CURSOR : WAND_CURSOR) : "crosshair") : brushLike ? "none" : isMaskTool || isPaintTool ? (lasso && lassoPoints.length && (zoomKeys && lassoOverCorner && !lassoDragRef.current ? TRASH_CURSOR : lassoCursor)) || "crosshair" : "default";

  return (
    <section className="editor-shell">
      <div className="editor-toolbar" ref={toolbarRef}>
        {/* Two halves: the tools end at the middle of the toolbar, and the colors start there, so neither moves the other. */}
        <div className="toolbar-side left">
          {isMaskTool && (
            <div className="tool-section" role="group" aria-label="Mask tools">
              <div className="tool-group icon-buttons mask-tool-picker" role="radiogroup" aria-label="Mask tool">
                <span className="tool-group-label" aria-hidden="true">Select</span>
                {/**
                  * The Magic Wand selects pixels of a like color by clicks on the image, for the mask being painted;
                  * a second click on it cancels it. Object (the local AI model, action "click-select") is hidden for now.
                  */}
                {targetPart && ([
                  { engine: "wand", label: "Magic wand", action: "wand-select", icon: <MagicWand size={16} /> }
                ] as const).map(({ engine, label, action, icon }) => (
                  <button
                    key={engine}
                    role="radio"
                    aria-checked={clickSelect?.engine === engine}
                    aria-label={label}
                    className={clickSelect?.engine === engine ? "active" : ""}
                    disabled={resize !== null}
                    {...onPress(() => {
                      const running = clickSelectRef.current;
                      if (running) cancelClickSelect();
                      if (running?.engine !== engine) void partAction(imageDocument.historyIndex, targetPart, action);
                    })}
                  >
                    {icon}
                  </button>
                ))}
                {maskTools.map(({ kind, label, icon }) => (
                  <Fragment key={kind}>
                    {kind === "brush" && <span className="tool-group-label draw" aria-hidden="true">Draw</span>}
                    <button
                      role="radio"
                      aria-checked={maskToolKind === kind && !clickSelect}
                      aria-label={label}
                      className={maskToolKind === kind && !clickSelect ? "active" : ""}
                      {...onPress(() => {
                        if (clickSelect) cancelClickSelect();
                        selectMaskTool(kind);
                      })}
                    >
                      {icon}
                    </button>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
          {/* The Paint tools change a layer's pixels, so they hide while a mask is painted. */}
          {!isMaskTool && (
            <div className="tool-section" role="group" aria-label="Paint">
              <div className="tool-group icon-buttons paint-tool-picker" role="radiogroup" aria-label="Tool">
                <span className="tool-group-label" aria-hidden="true">Select</span>
                {/* Select: no tool, so Ctrl+click on the image selects the layer under it. */}
                <button
                  role="radio"
                  aria-checked={tool === "whole"}
                  aria-label="Select"
                  className={tool === "whole" ? "active" : ""}
                  {...onPress(() => setTool("whole"))}
                >
                  <Cursor size={16} />
                </button>
                <button
                  role="radio"
                  aria-checked={paintWandOn}
                  aria-label="Magic wand"
                  className={paintWandOn ? "active" : ""}
                  disabled={resize !== null}
                  {...onPress(() => void togglePaintWand())}
                >
                  <MagicWand size={16} />
                </button>
                {paintTools.map(({ kind, label, icon }) => (
                  <Fragment key={kind}>
                    {kind === "brush" && <span className="tool-group-label draw" aria-hidden="true">Draw</span>}
                    <button
                      role="radio"
                      aria-checked={isPaintTool && paintKind === kind && !clickSelect}
                      aria-label={label}
                      className={isPaintTool && paintKind === kind && !clickSelect ? "active" : ""}
                      disabled={resize !== null}
                      {...onPress(() => selectPaintTool(kind))}
                    >
                      {icon}
                    </button>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="toolbar-side right">
          {isMaskTool && (
            <div className="tool-section" role="group" aria-label="Mask gradient colors">
              {renderGradientEnds(gradient !== null && !clickSelect)}
            </div>
          )}
          {!isMaskTool && (
            <div className="tool-section" role="group" aria-label="Paint color">
              {/* Both labels share one place; the one not in use is invisible, so its width is kept. */}
              <span className="swatch-label" aria-hidden="true">
                <span className={isPaintTool && gradient ? "hidden" : ""}>Color</span>
                <span className={isPaintTool && gradient ? "" : "hidden"}>Start/End Colors</span>
              </span>
              <ColorPicker
                color={paintColor}
                onChange={setPaintColor}
                open={pickingColor}
                onOpenChange={setPickingColor}
                label={isPaintTool && gradient ? "Gradient start" : "Paint color"}
                transparent={isPaintTool && gradient !== null && paintStops[0].alpha === 0}
                onTransparentChange={isPaintTool && gradient ? (transparent) => changeStop("paint", 0, { alpha: transparent ? 0 : 1 }) : undefined}
                alpha={isPaintTool && gradient ? Math.round(paintStops[0].alpha * 100) : maskOpacity}
                onAlphaChange={isPaintTool && gradient ? (alpha) => changeStop("paint", 0, { alpha: alpha / 100 }) : setMaskOpacity}
                minAlpha={isPaintTool && gradient ? 0 : 1}
              />
              {renderGradientEnds(isPaintTool && gradient !== null)}
            </div>
          )}
        </div>
        {/* The settings of the tool in use drop down below the toolbar, so the tool buttons never move. */}
        {/* Gradients have no settings here: each stop sets its own color and opacity. */}
        {(isMaskTool || isPaintTool) && (!gradient || clickSelect) && (
          <div className="tool-settings" ref={toolSettingsRef} style={settingsLeft !== null ? { left: settingsLeft } : undefined} role="group" aria-label={isMaskTool ? "Mask tool settings" : "Paint tool settings"}>
            {clickSelect ? (
              /** Magic: click the image to select an area, then apply it to the mask; Cancel goes back to the mask brush. */
              <div className="click-select-settings">
                {clickSelect.busy ? <SpinnerGap className="spin" size={15} /> : null}
                {clickSelect.engine === "wand" && (
                  <div className="brush-settings">
                    <span className="brush-setting-label">Tolerance:</span>
                    <span
                      className="brush-size-value"
                      role="slider"
                      aria-label="Tolerance"
                      aria-valuemin={0}
                      aria-valuemax={255}
                      aria-valuenow={wandTolerance}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        toleranceDragRef.current = { pointerId: event.pointerId, startY: event.clientY, startTolerance: wandTolerance };
                      }}
                      onPointerMove={(event) => {
                        const drag = toleranceDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        setWandTolerance(drag.startTolerance + (drag.startY - event.clientY) / 2);
                      }}
                      onPointerUp={() => { toleranceDragRef.current = null; }}
                      onPointerCancel={() => { toleranceDragRef.current = null; }}
                    >
                      {wandTolerance}
                    </span>
                    <span className="brush-setting-label">Feather:</span>
                    <span
                      className="brush-size-value"
                      role="slider"
                      aria-label="Feather"
                      aria-valuemin={0}
                      aria-valuemax={MAX_WAND_FEATHER}
                      aria-valuenow={wandFeather}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        featherDragRef.current = { pointerId: event.pointerId, startY: event.clientY, startFeather: wandFeather };
                      }}
                      onPointerMove={(event) => {
                        const drag = featherDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        setWandFeather(drag.startFeather + (drag.startY - event.clientY) / 2);
                      }}
                      onPointerUp={() => { featherDragRef.current = null; }}
                      onPointerCancel={() => { featherDragRef.current = null; }}
                    >
                      {wandFeather} px
                    </span>
                    <label className="wand-contiguous">
                      <input type="checkbox" checked={wandContiguous} onChange={(event) => setWandContiguous(event.target.checked)} />
                      Contiguous
                    </label>
                  </div>
                )}
                {/* A paint selection has no buttons here: Ctrl+D deselects and Esc exits. */}
                {clickSelect.target.part !== PAINT_PART && (
                  <>
                    <button className="click-select-apply" disabled={clickSelect.engine === "wand" ? !selection : !clickSelect.mask} onClick={() => void applyClickSelect()}>
                      <Check size={15} weight="bold" /> Apply
                    </button>
                    <button onClick={cancelClickSelect}>
                      <X size={15} weight="bold" /> Cancel
                    </button>
                  </>
                )}
              </div>
            ) : brushSettings}
          </div>
        )}
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
          <div
            className="canvas-scroll-area"
            style={{ padding: `${panSpaceTop}px ${panSpaceX}px ${panSpaceBottom}px`, ...(reachesTool ? { cursor: canvasCursor } : {}) }}
            onPointerDown={onAreaPointerDown}
            onPointerMove={onAreaPointerMove}
            onPointerUp={onAreaPointerUp}
            onPointerCancel={onAreaPointerUp}
            onPointerLeave={() => {
              hoverPointRef.current = null;
              moveBrushCursor(null);
            }}
          >
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
              {isMaskTool && targetPart && !clickSelect && (
                <div className="mask-shortcuts cards" role="group" aria-label="Mask shortcuts">
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">
                      Mask:
                      <span className={`shortcut-card-status ${brushHides ? "hiding" : "showing"}`}>Painting <strong>{brushHides ? "HIDES" : "SHOWS"}</strong> current {targetPart === "mask" ? "layer" : "adjustment"}</span>                    </div>
                    <ul>
                      <li><kbd>x</kbd> Paint to {brushHides ? "show" : "hide"} current {targetPart === "mask" ? "layer" : "adjustment"}</li>
                      {!selection && <li><kbd>alt</kbd> + <kbd>backspace</kbd> fill with {brushHides ? "black (hide all)" : "white (show all)"}</li>}
                      <li><kbd>esc</kbd> Exit mask</li>
                      <li className={maskOverlay ? "red-on" : ""}>Red mask: <strong>{maskOverlay ? "ON" : "OFF"}</strong> <kbd>r</kbd> {maskOverlay ? "Off" : "On"}</li>
                    </ul>
                  </section>
                  {/* The tool card: the brush or the polygon lasso, its keys, and the key to the other tool. */}
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">
                      Tool:
                      <span className={`shortcut-card-status ${maskToolKind !== "brush" || brushPrecise ? "precise-on" : ""}`}><strong>{maskToolKind === "lasso" ? "LASSO" : maskToolKind === "rect" ? "RECTANGLE SELECT" : maskToolKind === "ellipse" ? "ELLIPSE SELECT" : maskToolKind === "linear" ? "LINEAR GRADIENT" : maskToolKind === "radial" ? "RADIAL GRADIENT" : `${brushPrecise ? "PRECISE" : "SOFT"} BRUSH`}</strong></span>
                    </div>
                    {gradient ? (
                      <ul>
                        {gradientEdit ? (
                          <>
                            <li><kbd>click</kbd> the line to add a stop, a stop to set its gray</li>
                            <li><kbd>drag</kbd> a stop off the line to remove it</li>
                            <li><kbd>enter</kbd>, the check, or a <kbd>click</kbd> away to apply, <kbd>esc</kbd> to cancel</li>
                          </>
                        ) : <li><kbd>drag</kbd> draw the gradient</li>}
                        <li><kbd>b</kbd> Switch to Brush tool</li>
                      </ul>
                    ) : marquee ? (
                      <ul>
                        <li><kbd>drag</kbd> draw {marquee === "rect" ? "a rectangle" : "an ellipse"}: new selection</li>
                        <li><kbd>CTRL</kbd> + <kbd>SHIFT</kbd> (while dragging) {marquee === "rect" ? "square" : "circle"}</li>
                        <li><kbd>CTRL</kbd> + <kbd>ALT</kbd> (while dragging) from the center</li>
                        <li><kbd>SHIFT</kbd> (when letting go) add to selection</li>
                        <li><kbd>ALT</kbd> (when letting go) subtract from selection</li>
                        <li><kbd>click</kbd> deselect, <kbd>CTRL</kbd> + <kbd>z</kbd> undo last selection</li>
                      </ul>
                    ) : lasso ? (
                      <ul>
                        <li><kbd>click</kbd> add a point or close shape</li>
                        <li><kbd>SHIFT</kbd> (when closing) add to selection</li>
                        <li><kbd>ALT</kbd> (when closing) subtract from selection</li>
                        <li><kbd>CTRL</kbd> + <kbd>z</kbd> undo last selection</li>
                        <li><kbd>drag</kbd> move a point</li>
                        <li><kbd>CTRL</kbd> + <kbd>click</kbd> delete a point</li>
                        <li><kbd>B</kbd> switch to Brush tool</li>
                      </ul>
                    ) : (
                      <ul>
                        <li><kbd>p</kbd> {brushPrecise ? "Soft" : "Precise"}</li>
                        <li><kbd>[</kbd> <kbd>]</kbd> size</li>
                        <li><kbd>1-9</kbd> opacity, <kbd>0</kbd> for 100%</li>
                        <li><kbd>l</kbd> Switch to Lasso tool</li>
                        <li><kbd>W</kbd> switch to Magic Wand</li>
                      </ul>
                    )}
                  </section>
                  {selectionCard}
                </div>
              )}
              {clickSelect && ((isMaskTool && targetPart) || isPaintTool) && (
                <div className="mask-shortcuts cards" role="group" aria-label="Magic shortcuts">
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">
                      Tool:
                      <span className="shortcut-card-status precise-on"><strong>{clickSelect.engine === "wand" ? "MAGIC WAND" : "OBJECT (AI)"}</strong></span>
                    </div>
                    <ul>
                      {clickSelect.engine === "wand" ? (
                        <>
                          <li><kbd>click</kbd> new selection</li>
                          <li><kbd>SHIFT</kbd> + <kbd>click</kbd> add to selection</li>
                          <li><kbd>ALT</kbd> + <kbd>click</kbd> subtract from selection</li>
                          <li><kbd>CTRL</kbd> + <kbd>z</kbd> undo last selection</li>
                          <li><kbd>CTRL</kbd> + <kbd>d</kbd> deselect all</li>
                          <li><kbd>CTRL</kbd> + <kbd>i</kbd> invert the selection</li>
                          {clickSelect.target.part === PAINT_PART ? (
                            <>
                              <li><kbd>ALT</kbd> + <kbd>BACKSPACE</kbd> fill selection with color</li>
                              <li><kbd>ESC</kbd> {selection ? "deselect" : "exit to pointer"}</li>
                            </>
                          ) : (
                            <>
                              <li><kbd>ENTER</kbd> set the mask to the selection</li>
                              <li><kbd>ESC</kbd> {selection ? "deselect" : "cancel"}</li>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <li><kbd>click</kbd> add an area</li>
                          <li><kbd>alt</kbd> + <kbd>click</kbd> remove an area</li>
                          <li><kbd>CTRL</kbd> + <kbd>z</kbd> undo a click</li>
                          <li><kbd>enter</kbd> apply, <kbd>esc</kbd> cancel</li>
                        </>
                      )}
                    </ul>
                  </section>
                  {clickSelect.engine === "wand" && (
                    <section className="shortcut-card">
                      <div className="shortcut-card-head">Tips</div>
                      <ul>
                        <li>Adjust tolerance after selecting to fine-tune</li>
                      </ul>
                    </section>
                  )}
                </div>
              )}
              {isPaintTool && !clickSelect && (
                <div className="mask-shortcuts cards" role="group" aria-label="Paint shortcuts">
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">
                      Tool:
                      <span className={`shortcut-card-status ${lasso || marquee || gradient || brushPrecise ? "precise-on" : ""}`}><strong>{lasso ? "LASSO" : marquee === "rect" ? "RECTANGLE SELECT" : marquee ? "ELLIPSE SELECT" : gradient === "radial" ? "RADIAL GRADIENT" : gradient ? "LINEAR GRADIENT" : `${brushPrecise ? "PRECISE" : "SOFT"} ${eraser ? "ERASER" : "BRUSH"}`}</strong></span>
                    </div>
                    {gradient ? (
                      <ul>
                        {gradientEdit ? (
                          <>
                            <li><kbd>click</kbd> the line to add a stop, a stop to set its color</li>
                            <li><kbd>drag</kbd> a stop off the line to remove it</li>
                            <li><kbd>enter</kbd>, the check, or a <kbd>click</kbd> away to apply, <kbd>esc</kbd> to cancel</li>
                          </>
                        ) : <li><kbd>drag</kbd> draw the gradient</li>}
                        <li><kbd>b</kbd> Switch to Brush tool</li>
                      </ul>
                    ) : marquee ? (
                      <ul>
                        <li><kbd>drag</kbd> draw {marquee === "rect" ? "a rectangle" : "an ellipse"}: new selection</li>
                        <li><kbd>CTRL</kbd> + <kbd>SHIFT</kbd> (while dragging) {marquee === "rect" ? "square" : "circle"}</li>
                        <li><kbd>CTRL</kbd> + <kbd>ALT</kbd> (while dragging) from the center</li>
                        <li><kbd>SHIFT</kbd> (when letting go) add to selection</li>
                        <li><kbd>ALT</kbd> (when letting go) subtract from selection</li>
                        <li><kbd>click</kbd> deselect, <kbd>CTRL</kbd> + <kbd>z</kbd> undo last selection</li>
                      </ul>
                    ) : lasso ? (
                      <ul>
                        <li><kbd>click</kbd> add a point or close shape</li>
                        <li><kbd>SHIFT</kbd> (when closing) add to selection</li>
                        <li><kbd>ALT</kbd> (when closing) subtract from selection</li>
                        <li><kbd>CTRL</kbd> + <kbd>z</kbd> undo last selection</li>
                        <li><kbd>drag</kbd> move a point</li>
                        <li><kbd>CTRL</kbd> + <kbd>click</kbd> delete a point</li>
                        <li><kbd>B</kbd> switch to Brush tool</li>
                      </ul>
                    ) : (
                      <ul>
                        <li><kbd>p</kbd> {brushPrecise ? "Soft" : "Precise"}</li>
                        <li><kbd>[</kbd> <kbd>]</kbd> size</li>
                        <li><kbd>1-9</kbd> opacity, <kbd>0</kbd> for 100%</li>
                        <li><kbd>l</kbd> Switch to Lasso tool</li>
                        <li><kbd>W</kbd> switch to Magic Wand</li>
                      </ul>
                    )}
                  </section>
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">Paint</div>
                    <ul>
                      <li><kbd>alt</kbd> + <kbd>backspace</kbd> fill with color</li>
                      {!selection && <li><kbd>CTRL</kbd> + <kbd>a</kbd> select all</li>}
                      {brushLike && !eraser && <li><kbd>alt</kbd> + <kbd>click</kbd> pick a color</li>}
                      <li><kbd>esc</kbd> Exit paint</li>
                    </ul>
                  </section>
                  {selectionCard}
                </div>
              )}
              {resize && (
                <div className="mask-shortcuts cards" role="group" aria-label="Transform shortcuts">
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">Transform</div>
                    <ul>
                      <li><kbd>drag</kbd> inside to move</li>
                      <li><kbd>drag</kbd> a corner to scale</li>
                      <li><kbd>drag</kbd> just outside a corner to rotate</li>
                      <li><kbd>shift</kbd> rotate in 15° steps</li>
                      <li><kbd>enter</kbd> apply, <kbd>esc</kbd> cancel</li>
                    </ul>
                  </section>
                </div>
              )}
              {!(isMaskTool && targetPart) && !isPaintTool && !resize && !clickSelect && (
                <div className="mask-shortcuts cards" role="group" aria-label="Canvas shortcuts">
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">Viewport</div>
                    <ul>
                      <li><kbd>space</kbd> pan</li>
                      <li><kbd>CTRL</kbd> + <kbd>mouse</kbd> zoom</li>
                    </ul>
                  </section>
                  <section className="shortcut-card">
                    <div className="shortcut-card-head">Layer</div>
                    <ul>
                      <li><kbd>CTRL</kbd> + <kbd>click</kbd> select a layer</li>
                      {!selection && <li><kbd>CTRL</kbd> + <kbd>a</kbd> select all</li>}
                      <li><kbd>W</kbd> Magic Wand</li>
                      <li><kbd>m</kbd> Mask (add/edit)</li>
                      <li><kbd>CTRL</kbd> + <kbd>T</kbd> transform</li>
                      <li><kbd>CTRL</kbd> + <kbd>J</kbd> duplicate</li>
                      <li><kbd>del</kbd> delete</li>
                    </ul>
                  </section>
                  {selectionCard}
                </div>
              )}
              <canvas ref={layerMaskCanvasRef} className={`mask-preview ${isMaskTool ? "" : "hidden"}`} aria-hidden="true" />
              {/* The rectangle or ellipse being dragged, as marching ants. */}
              {marqueeDrag && (
                <svg className="lasso-shape" width={width * cssScale} height={height * cssScale} aria-hidden="true">
                  {(["lasso-edge-shadow", "lasso-edge"] as const).map((className) => marqueeDrag.shape === "rect"
                    ? <rect key={className} className={className} x={marqueeDrag.x * cssScale} y={marqueeDrag.y * cssScale} width={marqueeDrag.width * cssScale} height={marqueeDrag.height * cssScale} />
                    : <ellipse key={className} className={className} cx={(marqueeDrag.x + marqueeDrag.width / 2) * cssScale} cy={(marqueeDrag.y + marqueeDrag.height / 2) * cssScale} rx={(marqueeDrag.width / 2) * cssScale} ry={(marqueeDrag.height / 2) * cssScale} />)}
                </svg>
              )}
              {/* The lasso shape so far: its edges, a line to the pointer, and its corners; the first corner is larger, as the place to close it. */}
              {(isMaskTool || isPaintTool) && lasso && lassoPoints.length > 0 && (
                <svg className="lasso-shape" width={width * cssScale} height={height * cssScale} aria-hidden="true">
                  <polyline className="lasso-edge-shadow" points={lassoPoints.map((point) => `${point.x * cssScale},${point.y * cssScale}`).join(" ")} />
                  <polyline className="lasso-edge" points={lassoPoints.map((point) => `${point.x * cssScale},${point.y * cssScale}`).join(" ")} />
                  <g ref={lassoRubberRef}>
                    <line className="lasso-edge-shadow" />
                    <line className="lasso-edge" />
                  </g>
                  {lassoPoints.map((point, index) => (
                    <circle key={index} className={index === 0 ? "lasso-start" : "lasso-corner"} cx={point.x * cssScale} cy={point.y * cssScale} r={index === 0 ? 4 : 3} />
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
              {gradientEdit && (() => {
                const stops = gradientEdit.target === "mask" ? maskStops : paintGradientStops;
                const last = stops.length - 1;
                const at = (point: Point) => ({ x: point.x * cssScale, y: point.y * cssScale });
                const start = at(gradientEdit.from);
                const end = at(gradientEdit.to);
                const place = (index: number) => at(pointOnLine(gradientEdit.from, gradientEdit.to, index === 0 ? 0 : index === last ? 1 : stops[index].offset));
                const pickerStop = stopPicker !== null ? stops[stopPicker] : undefined;
                const pickerAt = stopPicker !== null && pickerStop ? place(stopPicker) : null;
                return (
                  <>
                    <svg className="gradient-edit" width={width * cssScale} height={height * cssScale} aria-hidden="true">
                      {gradientEdit.kind === "radial" && <circle className="gradient-line-ring" cx={start.x} cy={start.y} r={Math.hypot(end.x - start.x, end.y - start.y)} />}
                      <line className="gradient-line-shadow" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
                      <line className="gradient-line-main" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
                      {stops.map((stop, index) => {
                        const point = place(index);
                        const isEnd = index === 0 || index === last;
                        const className = `gradient-stop ${isEnd ? "end" : ""} ${gradientEdit.awayIndex === index ? "away" : ""} ${stopPicker === index ? "selected" : ""}`;
                        return (
                          <g key={index} className={className}>
                            {isEnd
                              ? <rect x={point.x - 7} y={point.y - 7} width={14} height={14} rx={3} fill={stop.color} />
                              : <circle cx={point.x} cy={point.y} r={6} fill={stop.color} />}
                            {stop.alpha === 0 && <line className="gradient-stop-clear" x1={point.x - 5} y1={point.y + 5} x2={point.x + 5} y2={point.y - 5} />}
                          </g>
                        );
                      })}
                    </svg>
                    {/**
                      * The check near the end point applies the gradient; it reminds that the gradient is not applied yet.
                      * It sits past the end point, or beside it (either side), or before it: the first place inside the image.
                      */}
                    {(() => {
                      const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
                      const dx = (end.x - start.x) / length;
                      const dy = (end.y - start.y) / length;
                      const margin = GRADIENT_APPLY_GAP / 2 + 4;
                      const imageWidth = width * cssScale;
                      const imageHeight = height * cssScale;
                      const inside = (point: Point) => point.x >= margin && point.x <= imageWidth - margin && point.y >= margin && point.y <= imageHeight - margin;
                      const places = [[dx, dy], [-dy, dx], [dy, -dx], [-dx, -dy]].map(([x, y]) => ({ x: end.x + x * GRADIENT_APPLY_GAP, y: end.y + y * GRADIENT_APPLY_GAP }));
                      const place = places.find(inside) ?? places[0];
                      const left = Math.min(imageWidth - margin, Math.max(margin, place.x));
                      const top = Math.min(imageHeight - margin, Math.max(margin, place.y));
                      return (
                        <button className="gradient-apply" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()} onClick={() => finishGradientDrag(true)} aria-label="Apply gradient" data-help="Apply the gradient (Enter)">
                          <Check size={16} weight="bold" />
                        </button>
                      );
                    })()}
                    {pickerStop && pickerAt && stopPicker !== null && (
                      <div className="gradient-stop-picker" style={{ left: pickerAt.x, top: pickerAt.y + 10 }} onPointerDown={(event) => event.stopPropagation()}>
                        <ColorPicker
                          hideSwatch
                          grays={gradientEdit.target === "mask"}
                          label="Gradient stop"
                          pickFromImage={false}
                          color={pickerStop.color}
                          onChange={(color) => changeStop(gradientEdit.target, stopPicker, { color })}
                          open
                          onOpenChange={(open) => { if (!open) setStopPicker(null); }}
                          transparent={gradientEdit.target === "paint" && pickerStop.alpha === 0}
                          onTransparentChange={gradientEdit.target === "paint" ? (transparent) => changeStop("paint", stopPicker, { alpha: transparent ? 0 : 1 }) : undefined}
                          alpha={gradientEdit.target === "paint" ? Math.round(pickerStop.alpha * 100) : undefined}
                          onAlphaChange={gradientEdit.target === "paint" ? (alpha) => changeStop("paint", stopPicker, { alpha: alpha / 100 }) : undefined}
                        >
                          {stopPicker > 0 && stopPicker < last && (
                            <button className="color-remove" onClick={() => { removeStop(gradientEdit.target, stopPicker); setStopPicker(null); }}>Remove stop</button>
                          )}
                        </ColorPicker>
                      </div>
                    )}
                  </>
                );
              })()}
              {/* The selection's marching ants, in every tool. */}
              {selection && (
                <div className="click-select-layer" aria-hidden="true">
                  <svg className="wand-outline" width={width * cssScale} height={height * cssScale}>
                    <path className="lasso-edge-shadow" d={wandOutlinePath} />
                    <path className="lasso-edge" d={wandOutlinePath} />
                  </svg>
                </div>
              )}
              {clickSelect && (
                <div className="click-select-layer" aria-hidden="true">
                  {/* Object shows its area in red; the Magic Wand's selection shows as marching ants above. */}
                  {clickSelect.engine === "sam" && clickSelect.mask && (
                    <div className="click-select-mask" style={{ WebkitMaskImage: `url(${clickSelect.mask.src})`, maskImage: `url(${clickSelect.mask.src})` }} />
                  )}
                  {clickSelect.engine === "sam" && clickSelect.points.map((point, index) => (
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
              {jobs.filter((job) => job.requestId === selectedJob && !job.hidden).map((job) => (
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
                      <div className="partial-actions">
                        <button
                          className="partial-capture"
                          disabled={job.snapped === job.partialDataUrl}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => void snapshotPartial(job)}
                          data-help="Save this preview as a new layer before GPT Image replaces it"
                        >
                          <Camera size={15} weight="bold" /> {job.snapped === job.partialDataUrl ? "Captured" : "Capture"}
                        </button>
                        {(jobCanCancel(job.stage, job.service) || canAbort(job.stage)) && (
                          <button
                            className="button secondary"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => cancelJob(job.requestId)}
                            data-help={jobCanCancel(job.stage, job.service) ? undefined : "Stop waiting and discard this image. OpenAI still charges for it."}
                          >
                            <StopCircle size={15} weight="bold" /> {jobCanCancel(job.stage, job.service) ? "Cancel" : "Abort"}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="selection-frame working" style={frameStyle(job.frame)}>
                    {!job.partialDataUrl && <div className="selection-progress" role="status">
                      <SpinnerGap className="spin" size={22} />
                      <strong>
                        {stageLabel(job.stage, job.service)}
                        {job.progress !== null && (job.stage === "generating" || job.stage === "encoding") && ` ${Math.round(job.progress * 100)}%`}
                      </strong>
                      <span>{formatElapsed(now - job.startedAt)}</span>
                      {(jobCanCancel(job.stage, job.service) || canAbort(job.stage)) && (
                        <button
                          className="button secondary"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => cancelJob(job.requestId)}
                          data-help={jobCanCancel(job.stage, job.service) ? undefined : "Stop waiting and discard this image. OpenAI still charges for it."}
                        >
                          <StopCircle size={15} weight="bold" /> {jobCanCancel(job.stage, job.service) ? "Cancel" : "Abort"}
                        </button>
                      )}
                    </div>}
                  </div>
                </div>
              ))}
              {brushLike && (
                <div
                  ref={brushCursorRef}
                  className={`brush-cursor ${brushHides || (isPaintTool && eraser) ? "erasing" : ""} ${spaceHeld || panning || altPicking ? "pan-hidden" : ""}`}
                  aria-hidden="true"
                  style={{ left: 0, top: 0, width: brushDiameter, height: brushDiameter }}
                />
              )}
              {(pickingColor || altPicking) && <div ref={colorProbeRef} className="color-probe" style={{ display: "none" }} aria-hidden="true" />}
              <div
                className="interaction-layer"
                style={{ cursor: canvasCursor }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={() => {
                  hoverPointRef.current = null;
                  moveBrushCursor(null);
                  moveColorProbe(null);
                }}
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
            onCancel: jobCanCancel(job.stage, job.service) || canAbort(job.stage) ? () => cancelJob(job.requestId) : undefined,
            aborts: !jobCanCancel(job.stage, job.service),
            selected: job.requestId === selectedJob,
            onSelect: () => {
              setSelectedJob(job.requestId);
              /** Only an AI edit's row holds a prompt; other running jobs show a label. */
              if (job.model) setPrompt(job.prompt);
            },
            /** Only an AI edit makes a layer that can be hidden. */
            ...(job.model ? { hidden: Boolean(job.hidden), onToggleHidden: () => toggleJobHidden(job.requestId) } : {}),
            ...(job.replaceId ? { replaces: job.replaceId } : {})
          };
        })}
        thumbnails={thumbnails}
        groupIds={multiIds}
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
              data-help="The model for the prompt. GPT Image edits the whole image or makes a new one. The local models make new images; Regenerate with Qwen-Image-2.1 edits the selected layer into a new layer. Local models run on this computer, for free."
              value={settings.wholeModel}
             
              onChange={(event) => {
                const wholeModel = event.target.value;
                const wholeQuality = qualitiesFor(wholeModel).includes(settings.wholeQuality) ? settings.wholeQuality : "high";
                onSettingsChange({ ...settings, wholeModel, wholeQuality });
              }}
            >
              {editModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
              <select
                aria-label="Quality"
                data-help={localChosen ? "More steps take longer and add detail." : "Higher quality costs more and takes longer."}
                value={qualitiesFor(settings.wholeModel).includes(settings.wholeQuality) ? settings.wholeQuality : "high"}
               
                onChange={(event) => onSettingsChange({ ...settings, wholeQuality: event.target.value })}
              >
                {qualitiesFor(settings.wholeModel).map((quality) => {
                  if (localChosen) return <option key={quality} value={quality}>{quality} · {LOCAL_STEPS[settings.wholeModel]?.[quality]} steps</option>;
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
              data-help={localChosen ? "Make a new image on this computer. The result is a new layer (Ctrl+Enter)" : "Send the image to GPT Image. The result is a new layer (Ctrl+Enter)"}
            >
              <MagicWand size={17} weight="bold" /> Generate
            </button>
            <button
              className="primary-action regenerate-action"
              disabled={(layerEdit ? !canEditLayer : localChosen || !regenStep) || !wholeSize || !prompt.trim()}
              onClick={regenerate}
              data-help={layerEdit
                ? `Edit ${regenName} with this prompt on this computer (Ctrl+Shift+Enter). The result is a new layer; ${regenName} stays as it is.`
                : localChosen
                ? "Chroma1-HD only adds new layers. Choose GPT Image or Qwen-Image-2.1 to regenerate a layer."
                : regenStep
                ? `Regenerate ${regenName} with this prompt (Ctrl+Shift+Enter). The result replaces the layer and keeps its name; its mask and adjustments are removed. The old layer comes back if it fails or you cancel.`
                : `Select a layer made by AI to regenerate it. ${lastStep ? `${regenName} was not made by AI.` : ""}`}
            >
              <ArrowArcLeft size={17} weight="bold" /> Regenerate
            </button>
          </div>
        </div>
      </div>      {renameAdjust && (() => {
        const adjustment = findAdjustment(adjustOf(imageDocument, renameAdjust.node), renameAdjust.id);
        if (!adjustment) return null;
        const save = () => {
          setAdjustmentLabel(renameAdjust.node, renameAdjust.id, renameAdjust.draft);
          setRenameAdjust(null);
        };
        return (
          <div className="confirm-overlay" role="presentation" onPointerDown={() => setRenameAdjust(null)}>
            <div
              className="confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rename-adjustment-title"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => { if (event.key === "Escape") setRenameAdjust(null); }}
            >
              <div className="confirm-icon"><PencilSimple size={22} weight="bold" /></div>
              <div className="confirm-copy">
                <h2 id="rename-adjustment-title">Rename {ADJUSTMENT_LABELS[adjustment.kind]}</h2>
                <p>The chip shows the label in place of the numbers. Leave it empty to show the numbers again.</p>
              </div>
              <label className="form-row rename-row">
                <span className="form-row-label">Label</span>
                <input
                  className="settings-input"
                  value={renameAdjust.draft}
                  placeholder={ADJUSTMENT_LABELS[adjustment.kind]}
                  maxLength={40}
                  autoFocus
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenameAdjust({ ...renameAdjust, draft: event.target.value })}
                  onKeyDown={(event) => { if (event.key === "Enter") save(); }}
                />
              </label>
              <div className="confirm-actions">
                <button className="button secondary" onClick={() => setRenameAdjust(null)}>Cancel</button>
                <button className="button primary" onClick={save}>Rename</button>
              </div>
            </div>
          </div>
        );
      })()}
      {confirmDelete !== null && confirmDelete.length > 1 && (
        <div className="confirm-overlay" role="presentation" onPointerDown={() => setConfirmDelete(null)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-steps-title"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setConfirmDelete(null); }}
          >
            <div className="confirm-icon"><WarningCircle size={22} weight="fill" /></div>
            <div className="confirm-copy">
              <h2 id="discard-steps-title">Delete {confirmDelete.length} Layers?</h2>
              <p>Delete layers <strong>{confirmDelete.map((node) => imageDocument.history[node - 1]?.name || `Layer ${node}`).join(", ")}</strong>?</p>
              <p>You can undo this if needed.</p>
              <label className="confirm-check">
                <input type="checkbox" checked={deleteDontAsk} onChange={(event) => setDeleteDontAsk(event.target.checked)} />
                Don't show again
              </label>
            </div>
            <div className="confirm-actions">
              <button autoFocus className="button secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="button destructive" onClick={() => confirmDeleteLayers(confirmDelete)}><Trash size={16} weight="bold" /> Delete {confirmDelete.length} layers</button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete !== null && confirmDelete.length === 1 && imageDocument.history[confirmDelete[0] - 1] && (
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
              <h2 id="discard-step-title">Delete Layer?</h2>
              <p>Delete layer <strong>{imageDocument.history[confirmDelete[0] - 1].name || `Layer ${confirmDelete[0]}`}</strong>?</p>
              <p>You can undo this if needed.</p>
              <label className="confirm-check">
                <input type="checkbox" checked={deleteDontAsk} onChange={(event) => setDeleteDontAsk(event.target.checked)} />
                Don't show again
              </label>
            </div>
            <div className="confirm-actions">
              <button autoFocus className="button secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="button destructive" onClick={() => confirmDeleteLayers(confirmDelete)}><Trash size={16} weight="bold" /> Delete layer</button>
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
              <p className="confirm-name">{confirmRegenStep.name || confirmRegenStep.prompt}</p>
              <p>This layer is replaced by a new GPT Image result. The old layer comes back if it fails or you cancel.</p>
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
                onClick={(event) => {
                  setLayerPick(null);
                  selectLayer(node);
                  /** Ctrl+click also selects the layer's pixels, as Ctrl+click on its thumbnail in the layers panel does. */
                  if (event.ctrlKey && node > 0) void partAction(node, "mask", "select-pixels");
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
          stages={imageDocument.history.filter((step) => !step.hidden).length + 1}
          imageKeys={imageDocument.path ? [`path:${imageDocument.path}`, `id:${imageDocument.id}`] : [`id:${imageDocument.id}`]}
          onCancel={() => setSlideshowDialogOpen(false)}
          onExport={(options) => void exportSlideshow(options)}
        />
      )}
      {canvasDialog && (
        <CanvasSizeDialog
          mode={canvasDialog}
          width={width}
          height={height}
          onCancel={() => setCanvasDialog(null)}
          onApply={(change) => {
            const resample = canvasDialog === "image";
            setCanvasDialog(null);
            /** Image Size resamples every layer; a larger image is then lightly sharpened, as bicubic sharper does. */
            void resizeCanvas(resample
              ? { width: change.width, height: change.height, x: 0, y: 0, scaleX: change.width / width, scaleY: change.height / height, sharpen: change.width * change.height > width * height }
              : change);
          }}
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
