import { contrastFilterIds, contrastTable, parseContrastFilterId } from "./contrast";
import { pathBetween } from "./history";
import { GPT_MASK_INSET, blendMasked, blendSelection, selectionAlpha, spillAlpha, type BlendOptions } from "./region";
import type { BlendMode, EditStep, MaskStroke, Point, Rect, SentRegion, SquareSelection } from "./types";

export const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("Could not decode the image."));
  image.src = src;
});

export function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export const context2d = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create a drawing surface.");
  return context;
};

/**
 * A canvas with a decoded image. It is meant for drawing (the surface, layers,
 * masks), so it keeps the default GPU-backed context; canvases whose pixels
 * are read use `context2d`, which asks for a CPU-backed one.
 */
export async function canvasFromDataUrl(dataUrl: string) {
  const image = await loadImage(dataUrl);
  const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas;
}

export const canvasToDataUrl = (canvas: HTMLCanvasElement, type = "image/png", quality?: number) =>
  new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode the image."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not encode the image."));
      reader.readAsDataURL(blob);
    }, type, quality);
  });

/** The square sent region, resampled to its upload size, as a PNG data URL. */
export async function buildEditUpload(surface: HTMLCanvasElement, sent: SentRegion) {
  const image = createCanvas(sent.requestWidth, sent.requestHeight);
  const imageContext = context2d(image);
  imageContext.imageSmoothingEnabled = true;
  imageContext.imageSmoothingQuality = "high";
  imageContext.drawImage(surface, sent.x, sent.y, sent.width, sent.height, 0, 0, image.width, image.height);
  return canvasToDataUrl(image);
}

/**
 * Scales the model result back to the sent region, blends only the selection
 * into the surface, and returns before/after tiles of the selection for history.
 */
export async function applyEditResult(
  surface: HTMLCanvasElement,
  selection: SquareSelection,
  sent: SentRegion,
  resultDataUrl: string,
  options: BlendOptions
) {
  const resultImage = await loadImage(resultDataUrl);
  const result = createCanvas(sent.width, sent.height);
  const resultContext = context2d(result);
  resultContext.imageSmoothingEnabled = true;
  resultContext.imageSmoothingQuality = "high";
  resultContext.drawImage(resultImage, 0, 0, sent.width, sent.height);

  const surfaceContext = context2d(surface);
  const original = surfaceContext.getImageData(sent.x, sent.y, sent.width, sent.height);
  const resultPixels = resultContext.getImageData(0, 0, sent.width, sent.height);
  const inner = { x: selection.x - sent.x, y: selection.y - sent.y, width: selection.size, height: selection.size };
  const blended = blendSelection(original.data, resultPixels.data, sent.width, sent.height, inner, {
    left: selection.x === 0,
    top: selection.y === 0,
    right: selection.x + selection.size === surface.width,
    bottom: selection.y + selection.size === surface.height
  }, options);

  const before = createCanvas(selection.size, selection.size);
  context2d(before).putImageData(surfaceContext.getImageData(selection.x, selection.y, selection.size, selection.size), 0, 0);
  const after = createCanvas(selection.size, selection.size);
  context2d(after).putImageData(new ImageData(blended, selection.size, selection.size), 0, 0);
  surfaceContext.putImageData(new ImageData(blended, selection.size, selection.size), selection.x, selection.y);

  const [beforeUrl, afterUrl] = await Promise.all([canvasToDataUrl(before), canvasToDataUrl(after)]);
  return { before: beforeUrl, after: afterUrl };
}

/**
 * Lays a transparent GPT Image overlay over the selection. The result covers
 * `resultArea` of the image; only its selection part is drawn, so the rest of
 * the image keeps every pixel. Returns history tiles of the selection and the
 * share of the selection the overlay left see-through (0 means fully opaque).
 */
export async function applyOverlayResult(
  surface: HTMLCanvasElement,
  selection: SquareSelection,
  resultArea: Rect,
  resultDataUrl: string
) {
  const resultImage = await loadImage(resultDataUrl);
  const scaleX = resultImage.naturalWidth / resultArea.width;
  const scaleY = resultImage.naturalHeight / resultArea.height;
  const overlay = createCanvas(selection.size, selection.size);
  const overlayContext = context2d(overlay);
  overlayContext.imageSmoothingEnabled = true;
  overlayContext.imageSmoothingQuality = "high";
  overlayContext.drawImage(
    resultImage,
    (selection.x - resultArea.x) * scaleX,
    (selection.y - resultArea.y) * scaleY,
    selection.size * scaleX,
    selection.size * scaleY,
    0,
    0,
    selection.size,
    selection.size
  );
  const alpha = overlayContext.getImageData(0, 0, selection.size, selection.size).data;
  let clear = 0;
  for (let index = 3; index < alpha.length; index += 4) if (alpha[index] < 128) clear++;

  const surfaceContext = context2d(surface);
  const before = createCanvas(selection.size, selection.size);
  context2d(before).putImageData(surfaceContext.getImageData(selection.x, selection.y, selection.size, selection.size), 0, 0);
  surfaceContext.drawImage(overlay, selection.x, selection.y);
  const after = createCanvas(selection.size, selection.size);
  context2d(after).putImageData(surfaceContext.getImageData(selection.x, selection.y, selection.size, selection.size), 0, 0);
  const [beforeUrl, afterUrl] = await Promise.all([canvasToDataUrl(before), canvasToDataUrl(after)]);
  return { before: beforeUrl, after: afterUrl, clearShare: clear / (selection.size * selection.size) };
}

/** The area an edit step's history tiles cover. */
export const stepArea = (step: Pick<EditStep, "selection" | "area">): Rect =>
  step.area ?? { x: step.selection.x, y: step.selection.y, width: step.selection.size, height: step.selection.size };

/** Writes a history tile back into the surface (undo pastes `before`, redo pastes `after`). */
export async function pasteTile(surface: HTMLCanvasElement, area: Rect, tileDataUrl: string) {
  const tile = await loadImage(tileDataUrl);
  const context = context2d(surface);
  context.clearRect(area.x, area.y, area.width, area.height);
  context.drawImage(tile, area.x, area.y, area.width, area.height);
}

/** The whole image, resampled to the size GPT Image accepts, as a PNG data URL. */
export async function buildWholeUpload(surface: HTMLCanvasElement, width: number, height: number) {
  if (width === surface.width && height === surface.height) return canvasToDataUrl(surface);
  return canvasToDataUrl(scaledCanvas(surface, width, height));
}

/**
 * Changes a surface from showing node `from` to node `to` of a step tree made
 * of before/after tiles (documents from before layers; see `history.ts`).
 */
export async function navigateSurface(surface: HTMLCanvasElement, history: EditStep[], from: number, to: number) {
  const { up, down } = pathBetween(history, from, to);
  for (const node of up) await pasteTile(surface, stepArea(history[node - 1]), history[node - 1].before ?? "");
  for (const node of down) await pasteTile(surface, stepArea(history[node - 1]), history[node - 1].after ?? "");
}

/**
 * One adjustment to draw: its canvas filter, and its mask (alpha is where it
 * applies, or where it does not with `hides`), or null for everywhere. An
 * opacity adjustment also has `opacity` (0 to 1): through a mask it removes
 * alpha only where the mask lets it.
 */
export interface AdjustCanvases {
  filter: string;
  mask: HTMLCanvasElement | null;
  hides: boolean;
  opacity?: number;
}

/**
 * One layer to draw: its full image, and its mask (the painted area is the
 * alpha), or null when it has none. With `maskHides` the painted area is
 * hidden; otherwise only the painted area shows. `adjustments` are drawn in
 * order, each only where its own mask lets it.
 */
export interface LayerCanvases {
  image: HTMLCanvasElement;
  mask: HTMLCanvasElement | null;
  maskHides: boolean;
  adjustments: AdjustCanvases[];
  /** How the finished layer mixes with what is below it; absent is Normal. */
  blend?: BlendMode;
}

let layerScratch: HTMLCanvasElement | null = null;
let adjustScratch: HTMLCanvasElement | null = null;
const sizedScratch = (canvas: HTMLCanvasElement | null, width: number, height: number) =>
  canvas && canvas.width === width && canvas.height === height ? canvas : createCanvas(width, height);

const SVG_NS = "http://www.w3.org/2000/svg";
/** An alpha table that keeps every value except 254/255, which becomes fully opaque. */
const OPAQUE_FIX = Array.from({ length: 256 }, (_, index) => (index >= 254 ? 1 : index / 255).toFixed(4)).join(" ");
let filterHost: SVGSVGElement | null = null;

/**
 * Makes sure every contrast filter named in a canvas filter string exists in
 * the page, because a canvas can use an SVG filter only by its id. The SVG is
 * not hidden with display:none, which would turn its filters off.
 */
export function ensureSvgFilters(filter: string) {
  for (const id of contrastFilterIds(filter)) {
    if (window.document.getElementById(id)) continue;
    const params = parseContrastFilterId(id);
    if (!params) continue;
    if (!filterHost) {
      filterHost = window.document.createElementNS(SVG_NS, "svg");
      filterHost.setAttribute("aria-hidden", "true");
      filterHost.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
      window.document.body.appendChild(filterHost);
    }
    const table = contrastTable(params).map((value) => value.toFixed(4)).join(" ");
    const transfer = (input: string, result: string) => `
      <feComponentTransfer in="${input}" result="${result}">
        <feFuncR type="table" tableValues="${table}"/>
        <feFuncG type="table" tableValues="${table}"/>
        <feFuncB type="table" tableValues="${table}"/>
      </feComponentTransfer>`;
    const color = params.color.toFixed(3);
    const brightnessOnly = (1 - params.color).toFixed(3);
    /**
     * "each" applies the curve to each color. "bright" applies it to brightness
     * only: the curve of the brightness, minus the brightness, is added to every
     * color (shifted by 0.5, because filter values cannot go below 0). Then
     * the two are blended by the Color setting. The 0.5 shift leaves opaque
     * pixels at 254/255, so the last step maps that back to fully opaque.
     */
    const element = window.document.createElementNS(SVG_NS, "filter");
    element.setAttribute("id", id);
    element.setAttribute("color-interpolation-filters", "sRGB");
    element.innerHTML = `
      ${transfer("SourceGraphic", "each")}
      <feColorMatrix in="SourceGraphic" type="matrix" result="lum"
        values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0"/>
      ${transfer("lum", "curved")}
      <feComposite in="curved" in2="lum" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0.5" result="delta"/>
      <feComposite in="SourceGraphic" in2="delta" operator="arithmetic" k1="0" k2="1" k3="1" k4="-0.5" result="bright"/>
      <feComposite in="bright" in2="each" operator="arithmetic" k1="0" k2="${brightnessOnly}" k3="${color}" k4="0" result="blended"/>
      <feComponentTransfer in="blended"><feFuncA type="table" tableValues="${OPAQUE_FIX}"/></feComponentTransfer>`;
    filterHost.appendChild(element);
  }
}

/** Draws one layer onto a context: its image, its adjustments through their masks, then hidden where its mask is clear. */
export function drawLayer(context: CanvasRenderingContext2D, layer: LayerCanvases) {
  if (!layer.mask && layer.adjustments.every((adjustment) => !adjustment.mask)) {
    const filter = layer.adjustments.map((adjustment) => adjustment.filter).join(" ") || "none";
    /** The SVG filters must exist before the canvas reads the filter string. */
    ensureSvgFilters(filter);
    context.filter = filter;
    context.globalCompositeOperation = layer.blend ?? "source-over";
    context.drawImage(layer.image, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    return;
  }
  const { width, height } = layer.image;
  layerScratch = sizedScratch(layerScratch, width, height);
  const scratch = layerScratch.getContext("2d")!;
  scratch.globalCompositeOperation = "copy";
  scratch.filter = "none";
  scratch.drawImage(layer.image, 0, 0);
  for (const adjustment of layer.adjustments) {
    adjustScratch = sizedScratch(adjustScratch, width, height);
    if (adjustment.opacity !== undefined) {
      /**
       * Opacity takes alpha away: (1 − opacity) of it, where the adjustment
       * applies. The second canvas holds that "where" as alpha.
       */
      const remove = 1 - adjustment.opacity;
      const where = adjustScratch.getContext("2d")!;
      where.globalCompositeOperation = "copy";
      where.filter = "none";
      if (!adjustment.mask) {
        where.fillStyle = "#000";
        where.fillRect(0, 0, width, height);
      } else if (!adjustment.hides) {
        where.drawImage(adjustment.mask, 0, 0);
      } else {
        where.fillStyle = "#000";
        where.fillRect(0, 0, width, height);
        where.globalCompositeOperation = "destination-out";
        where.drawImage(adjustment.mask, 0, 0);
      }
      where.globalCompositeOperation = "source-over";
      scratch.globalCompositeOperation = "destination-out";
      scratch.globalAlpha = remove;
      scratch.drawImage(adjustScratch, 0, 0);
      scratch.globalAlpha = 1;
      continue;
    }
    /** A canvas cannot filter onto itself, so the adjusted copy is made on a second canvas. */
    const adjusted = adjustScratch.getContext("2d")!;
    adjusted.globalCompositeOperation = "copy";
    ensureSvgFilters(adjustment.filter);
    adjusted.filter = adjustment.filter;
    adjusted.drawImage(layerScratch, 0, 0);
    adjusted.filter = "none";
    if (adjustment.mask) {
      adjusted.globalCompositeOperation = adjustment.hides ? "destination-out" : "destination-in";
      adjusted.drawImage(adjustment.mask, 0, 0);
    }
    adjusted.globalCompositeOperation = "source-over";
    scratch.globalCompositeOperation = adjustment.mask ? "source-over" : "copy";
    scratch.drawImage(adjustScratch, 0, 0);
  }
  if (layer.mask) {
    scratch.globalCompositeOperation = layer.maskHides ? "destination-out" : "destination-in";
    scratch.drawImage(layer.mask, 0, 0);
  }
  scratch.globalCompositeOperation = "source-over";
  context.globalCompositeOperation = layer.blend ?? "source-over";
  context.drawImage(layerScratch, 0, 0);
  context.globalCompositeOperation = "source-over";
}

/**
 * Draws a stack of layers onto `target`: `base` first (when given), then each
 * layer in order, bottom to top. A layer covers everything below it, except where its mask hides it.
 */
export function drawLayers(target: HTMLCanvasElement, base: LayerCanvases | null, layers: LayerCanvases[]) {
  const context = target.getContext("2d")!;
  context.clearRect(0, 0, target.width, target.height);
  if (base) drawLayer(context, base);
  for (const layer of layers) drawLayer(context, layer);
}

/** A small PNG preview of a canvas for the layers panel; transparent areas stay transparent. */
export function thumbnailOf(source: HTMLCanvasElement, maxSide = 168) {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  return scaledCanvas(source, Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
    .toDataURL("image/png");
}

/** A small PNG preview of one layer with its mask and adjustments applied. */
export function layerThumbnail(layer: LayerCanvases, maxSide = 168) {
  const full = createCanvas(layer.image.width, layer.image.height);
  drawLayer(full.getContext("2d")!, layer);
  return thumbnailOf(full, maxSide);
}

/**
 * Writes a gradient into a mask: the part shows (or applies) fully at `from`
 * and not at all at `to`. A linear gradient runs along the line; a radial one
 * fades out from the center `from` to the radius at `to`. With `opacity`
 * below 1, the gradient is mixed with `base`, the mask before the drag. For a
 * mask that `hides`, alpha means hidden, so the gradient runs the other way.
 */
export function drawMaskGradient(
  mask: HTMLCanvasElement,
  base: HTMLCanvasElement,
  kind: "linear" | "radial",
  from: Point,
  to: Point,
  opacity: number,
  hides: boolean
) {
  const context = mask.getContext("2d")!;
  const radius = Math.hypot(to.x - from.x, to.y - from.y);
  const gradient = kind === "linear"
    ? context.createLinearGradient(from.x, from.y, to.x, to.y)
    : context.createRadialGradient(from.x, from.y, 0, from.x, from.y, Math.max(1, radius));
  gradient.addColorStop(0, hides ? "rgba(255,255,255,0)" : "#fff");
  gradient.addColorStop(1, hides ? "#fff" : "rgba(255,255,255,0)");
  context.save();
  context.globalCompositeOperation = "copy";
  context.globalAlpha = 1 - opacity;
  context.drawImage(base, 0, 0);
  /** "lighter" adds alpha, so the result is base × (1 − opacity) + gradient × opacity. */
  context.globalCompositeOperation = opacity >= 1 ? "copy" : "lighter";
  context.globalAlpha = opacity;
  context.fillStyle = gradient;
  context.fillRect(0, 0, mask.width, mask.height);
  context.restore();
}

/**
 * Sets a mask to `base` plus one brush stroke at `opacity`. The stroke is
 * painted at full strength on its own canvas, so overlapping parts of one
 * stroke never go past `opacity`. `add` paints alpha in; otherwise it takes alpha out.
 */
export function applyMaskStroke(mask: HTMLCanvasElement, base: HTMLCanvasElement, stroke: HTMLCanvasElement, opacity: number, add: boolean) {
  const context = mask.getContext("2d")!;
  context.save();
  context.globalCompositeOperation = "copy";
  context.drawImage(base, 0, 0);
  context.globalCompositeOperation = add ? "source-over" : "destination-out";
  context.globalAlpha = opacity;
  context.drawImage(stroke, 0, 0);
  context.restore();
}

/** The smallest rectangle that holds every pixel that is not fully transparent, or null when all are. */
export function opaqueBounds(canvas: HTMLCanvasElement): Rect | null {
  const { width, height } = canvas;
  const pixels = context2d(canvas).getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** A copy of a canvas at full size. */
export function cloneCanvas(source: HTMLCanvasElement) {
  const copy = createCanvas(source.width, source.height);
  context2d(copy).drawImage(source, 0, 0);
  return copy;
}

/** A scaled copy of a canvas, used for uploads and to bring a large opened image within GPT Image's limits. */
export function scaledCanvas(source: HTMLCanvasElement, width: number, height: number) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

/** Decoded subject masks by their data URL, the most recent few. `loadMaskImages` fills it; drawing needs it filled. */
const maskImages = new Map<string, HTMLCanvasElement>();
const MASK_IMAGE_CACHE = 6;
let tintScratch: HTMLCanvasElement | null = null;

/** Decodes the subject masks of these strokes, so `drawMaskStrokes` can draw them. */
export async function loadMaskImages(strokes: MaskStroke[]) {
  for (const stroke of strokes) {
    if (!stroke.image) continue;
    const { src } = stroke.image;
    const canvas = maskImages.get(src) ?? await canvasFromDataUrl(src);
    maskImages.delete(src);
    maskImages.set(src, canvas);
  }
  while (maskImages.size > MASK_IMAGE_CACHE) maskImages.delete(maskImages.keys().next().value!);
}

/** Whether every subject mask of these strokes is decoded. */
export const maskImagesLoaded = (strokes: MaskStroke[]) => strokes.every((stroke) => !stroke.image || maskImages.has(stroke.image.src));

/** A subject mask filled with one color, on a scratch canvas that the next call reuses. */
function tintedMaskImage(src: string, color: string) {
  const image = maskImages.get(src);
  if (!image) throw new Error("The subject mask is not loaded yet.");
  tintScratch = sizedScratch(tintScratch, image.width, image.height);
  const context = tintScratch.getContext("2d")!;
  context.globalCompositeOperation = "copy";
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = "source-in";
  context.fillStyle = color;
  context.fillRect(0, 0, image.width, image.height);
  context.globalCompositeOperation = "source-over";
  return tintScratch;
}

/**
 * Draws mask strokes onto a 2D context. The caller sets the transform from
 * image pixels to the target canvas. Paint is opaque here; the editor shows the
 * overlay at 50% so overlapping strokes do not get darker.
 */
export function drawMaskStrokes(context: CanvasRenderingContext2D, strokes: MaskStroke[], color: string) {
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    if (stroke.image) {
      context.drawImage(tintedMaskImage(stroke.image.src, color), 0, 0);
      continue;
    }
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = stroke.radius * 2;
    const [first, ...rest] = stroke.points;
    if (!first) continue;
    if (!rest.length) {
      context.beginPath();
      context.arc(first[0], first[1], stroke.radius, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(first[0], first[1]);
    for (const [x, y] of rest) context.lineTo(x, y);
    context.stroke();
  }
  context.globalCompositeOperation = "source-over";
}

/** The mask over the sent region as one alpha value per pixel, softened at its edge by `feather` pixels. */
export function maskAlpha(strokes: MaskStroke[], sent: SentRegion, feather: number) {
  const hard = createCanvas(sent.width, sent.height);
  const hardContext = context2d(hard);
  hardContext.translate(-sent.x, -sent.y);
  drawMaskStrokes(hardContext, strokes, "#fff");
  const soft = createCanvas(sent.width, sent.height);
  const softContext = context2d(soft);
  if (feather > 0) softContext.filter = `blur(${feather / 2}px)`;
  softContext.drawImage(hard, 0, 0);
  const pixels = softContext.getImageData(0, 0, sent.width, sent.height).data;
  const alpha = new Uint8ClampedArray(sent.width * sent.height);
  for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = pixels[pixel * 4 + 3];
  return alpha;
}

/**
 * The GPT Image mask for a region edit, at the upload size, as a PNG data URL.
 * Opaque pixels must be kept; transparent pixels (the selection, or the painted
 * strokes) may change.
 */
export function buildGptMask(sent: SentRegion, target: { selection: SquareSelection } | { strokes: MaskStroke[] }) {
  const mask = createCanvas(sent.requestWidth, sent.requestHeight);
  const context = context2d(mask);
  context.fillStyle = "#000";
  context.fillRect(0, 0, mask.width, mask.height);
  context.setTransform(mask.width / sent.width, 0, 0, mask.height / sent.height, -sent.x * mask.width / sent.width, -sent.y * mask.height / sent.height);
  /** The mask is smaller than the target by `GPT_MASK_INSET`, so overflow lands inside the target. */
  if ("selection" in target) {
    const { x, y, size } = target.selection;
    const inset = Math.round(size * GPT_MASK_INSET);
    context.clearRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
  } else {
    /** Paint strokes cut the mask; erase strokes restore it. */
    for (const stroke of target.strokes) {
      const radius = stroke.erase ? stroke.radius * (1 + GPT_MASK_INSET) : stroke.radius * (1 - GPT_MASK_INSET * 1.5);
      drawMaskStrokes(context, [{ ...stroke, radius: Math.max(1, radius), erase: !stroke.erase }], "#000");
    }
  }
  return canvasToDataUrl(mask);
}

/**
 * Scales a GPT Image result back to the sent region and blends it into the
 * surface: the target (square or painted mask) plus any new content GPT drew
 * past it that touches it (see `spillAlpha`). History tiles cover the whole
 * sent square, because the blend can reach into its margin.
 */
export async function applyGptResult(
  surface: HTMLCanvasElement,
  sent: SentRegion,
  target: { selection: SquareSelection } | { strokes: MaskStroke[] },
  resultDataUrl: string,
  options: BlendOptions
) {
  const tile: SquareSelection = { x: sent.x, y: sent.y, size: sent.width };
  return blendIntoSurface(surface, tile, sent, resultDataUrl, options, (original, result) => {
    let base: Uint8ClampedArray;
    if ("selection" in target) {
      const { x, y, size } = target.selection;
      base = selectionAlpha(sent.width, sent.height, { x: x - sent.x, y: y - sent.y, width: size, height: size }, {
        left: x === 0,
        top: y === 0,
        right: x + size === surface.width,
        bottom: y + size === surface.height
      }, options.feather);
    } else {
      base = maskAlpha(target.strokes, sent, options.feather);
    }
    return spillAlpha(original, result, sent.width, sent.height, base, Math.max(3, Math.round(sent.width / 150)));
  });
}

/**
 * Scales the model result back to the sent region and blends it through the
 * painted mask. History tiles cover `square`, the square around the mask.
 */
export async function applyMaskedResult(
  surface: HTMLCanvasElement,
  square: SquareSelection,
  sent: SentRegion,
  strokes: MaskStroke[],
  resultDataUrl: string,
  options: BlendOptions
) {
  return blendIntoSurface(surface, square, sent, resultDataUrl, options, () => maskAlpha(strokes, sent, options.feather));
}

/** Blends a result into the sent region through an alpha, and returns before/after tiles of `square`. */
async function blendIntoSurface(
  surface: HTMLCanvasElement,
  square: SquareSelection,
  sent: SentRegion,
  resultDataUrl: string,
  options: BlendOptions,
  alphaFor: (original: Uint8ClampedArray, result: Uint8ClampedArray) => Uint8ClampedArray
) {
  const resultImage = await loadImage(resultDataUrl);
  const result = createCanvas(sent.width, sent.height);
  const resultContext = context2d(result);
  resultContext.imageSmoothingEnabled = true;
  resultContext.imageSmoothingQuality = "high";
  resultContext.drawImage(resultImage, 0, 0, sent.width, sent.height);

  const surfaceContext = context2d(surface);
  const before = createCanvas(square.size, square.size);
  context2d(before).putImageData(surfaceContext.getImageData(square.x, square.y, square.size, square.size), 0, 0);

  const original = surfaceContext.getImageData(sent.x, sent.y, sent.width, sent.height);
  const resultPixels = resultContext.getImageData(0, 0, sent.width, sent.height).data;
  const blended = blendMasked(original.data, resultPixels, alphaFor(original.data, resultPixels), options);
  surfaceContext.putImageData(new ImageData(blended, sent.width, sent.height), sent.x, sent.y);

  const after = createCanvas(square.size, square.size);
  context2d(after).putImageData(surfaceContext.getImageData(square.x, square.y, square.size, square.size), 0, 0);
  const [beforeUrl, afterUrl] = await Promise.all([canvasToDataUrl(before), canvasToDataUrl(after)]);
  return { before: beforeUrl, after: afterUrl };
}