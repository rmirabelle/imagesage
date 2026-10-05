import type { MaskStroke, Rect, SceneAnchor, SceneDescription, SentRegion, SquareSelection } from "./types";

/** Size rules for new images from GPT Image 2.x (flexible sizes). */
export const SIZE_MULTIPLE = 16;
export const MIN_REQUEST_PIXELS = 655_360;
export const MAX_REQUEST_PIXELS = 8_294_400;
export const MAX_REQUEST_EDGE = 3840;
export const MAX_REQUEST_ASPECT = 3;
export const MIN_SELECTION_SIZE = 16;

/**
 * FLUX 3 Image output sizes for a 1:1 result, by their approximate side length.
 * The model has no mask, so the edit target is a box inside a square region.
 */
export const FLUX_RESOLUTIONS = [
  { id: "1k", edge: 1024 },
  { id: "1.5k", edge: 1536 },
  { id: "2k", edge: 2048 },
  { id: "4k", edge: 4096 }
] as const;
export type FluxResolution = (typeof FLUX_RESOLUTIONS)[number]["id"];
export const MAX_UPLOAD_EDGE = 2048;

export interface RegionOptions {
  /** Smallest context margin, in image pixels. */
  minMargin: number;
  /** Margin as a share of the selection size, when that is larger than `minMargin`. */
  marginRatio: number;
  /** Largest FLUX output size to ask for. */
  maxResolution: FluxResolution;
}

export interface BlendOptions {
  /** Width of the inner soft edge, in image pixels. */
  feather: number;
  /** Shift the result's colors so its margin matches the original margin. */
  driftCorrection: boolean;
}

export const marginFor = (selectionSize: number, options: Pick<RegionOptions, "minMargin" | "marginRatio">) =>
  Math.max(Math.round(options.minMargin), Math.round(selectionSize * options.marginRatio));

/**
 * The square sent to the model: the selection plus `margin` on every side.
 * Near an image edge the square shifts inward instead of shrinking, so it stays
 * square (and the 1:1 result pastes back without distortion). It shrinks only
 * when the image itself is too small.
 */
export function squareRegion(selection: SquareSelection, imageWidth: number, imageHeight: number, margin: number): Rect {
  const side = Math.min(selection.size + margin * 2, imageWidth, imageHeight);
  const extra = side - selection.size;
  const x = Math.max(0, Math.min(imageWidth - side, Math.round(selection.x - extra / 2)));
  const y = Math.max(0, Math.min(imageHeight - side, Math.round(selection.y - extra / 2)));
  return { x, y, width: side, height: side };
}

/** The smallest output size that covers the region, but no larger than the user's limit. */
export function pickResolution(side: number, maxResolution: FluxResolution): { id: FluxResolution; edge: number } {
  const limit = FLUX_RESOLUTIONS.findIndex((resolution) => resolution.id === maxResolution);
  const allowed = FLUX_RESOLUTIONS.slice(0, limit < 0 ? FLUX_RESOLUTIONS.length : limit + 1);
  return allowed.find((resolution) => resolution.edge >= side) ?? allowed[allowed.length - 1];
}

export function planRegion(
  selection: SquareSelection,
  imageWidth: number,
  imageHeight: number,
  options: RegionOptions
): SentRegion {
  const margin = marginFor(selection.size, options);
  const rect = squareRegion(selection, imageWidth, imageHeight, margin);
  const upload = Math.min(rect.width, MAX_UPLOAD_EDGE);
  const resolution = pickResolution(rect.width, options.maxResolution);
  return { ...rect, margin, requestWidth: upload, requestHeight: upload, resolution: resolution.id };
}

/** True when the upload or the output is smaller than the region, so the result will be softer than the original. */
export const isDownscaled = (sent: SentRegion) => {
  const edge = FLUX_RESOLUTIONS.find((resolution) => resolution.id === sent.resolution)?.edge ?? sent.requestWidth;
  return sent.requestWidth < sent.width || edge < sent.width;
};

/** The selection inside the sent square, as FLUX 3's `[y0, x0, y1, x1]` box on a 0–1000 scale. */
export function selectionBox(selection: SquareSelection, sent: SentRegion): [number, number, number, number] {
  return rectBox({ x: selection.x, y: selection.y, width: selection.size, height: selection.size }, sent);
}

/** Any rectangle inside the sent square, as FLUX 3's `[y0, x0, y1, x1]` box on a 0–1000 scale. */
export function rectBox(rect: Rect, sent: SentRegion): [number, number, number, number] {
  const scale = (value: number, size: number) => Math.max(0, Math.min(1000, Math.round((value / size) * 1000)));
  return [
    scale(rect.y - sent.y, sent.height),
    scale(rect.x - sent.x, sent.width),
    scale(rect.y - sent.y + rect.height, sent.height),
    scale(rect.x - sent.x + rect.width, sent.width)
  ];
}

/** The painted area of a mask (paint strokes and subjects, not erase strokes), clamped to the image; null when nothing is painted. */
export function maskBounds(strokes: MaskStroke[], imageWidth: number, imageHeight: number): Rect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const stroke of strokes) {
    if (stroke.erase) continue;
    if (stroke.image) {
      const area = stroke.image.bounds;
      left = Math.min(left, area.x);
      top = Math.min(top, area.y);
      right = Math.max(right, area.x + area.width);
      bottom = Math.max(bottom, area.y + area.height);
    }
    for (const [x, y] of stroke.points) {
      left = Math.min(left, x - stroke.radius);
      top = Math.min(top, y - stroke.radius);
      right = Math.max(right, x + stroke.radius);
      bottom = Math.max(bottom, y + stroke.radius);
    }
  }
  if (!Number.isFinite(left)) return null;
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const width = Math.min(imageWidth, Math.ceil(right)) - x;
  const height = Math.min(imageHeight, Math.ceil(bottom)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The smallest square that covers a rectangle, kept inside the image. History tiles cover this square. */
export function squareAround(rect: Rect, imageWidth: number, imageHeight: number): SquareSelection {
  const size = Math.min(Math.max(rect.width, rect.height, MIN_SELECTION_SIZE), imageWidth, imageHeight);
  return clampSelection({
    x: Math.round(rect.x + rect.width / 2 - size / 2),
    y: Math.round(rect.y + rect.height / 2 - size / 2),
    size
  }, imageWidth, imageHeight);
}

/**
 * Builds the FLUX 3 Image prompt: the instruction in prose, tied to a target box
 * named `<edit_region>`, followed by the box list in the JSON form BFL documents.
 */
export function fluxEditPrompt(instruction: string, box: [number, number, number, number], scene?: SceneDescription | null) {
  const text = instruction.trim();
  const anchors = (scene && cleanAnchors(scene.anchors, box)) || fallbackAnchors(box);
  /**
   * The box is an existing area of the reference image, kept in place
   * (`from` the reference, same source and target box), not new content: a
   * `from: null` row tells FLUX to generate the box from scratch, which drops
   * whatever was there. Anchor rows tell FLUX what must not change.
   */
  const rows = [
    {
      id: "edit_region",
      from: "ref_image_0",
      src_bbox: box,
      tgt_bbox: box,
      kind: "new",
      desc: `the existing area of the image, changed as follows: ${text}`
    },
    ...anchors.map((anchor) => ({
      id: anchor.id,
      from: "ref_image_0",
      src_bbox: anchor.bbox,
      tgt_bbox: anchor.bbox,
      kind: "anchor",
      desc: anchor.desc
    }))
  ];
  return [
    ...(scene?.caption.trim() ? [scene.caption.trim()] : []),
    `In <ref_image_0>, edit <edit_region> in place: ${text}`,
    "Inside <edit_region>, keep every object, shape, and detail that this instruction does not mention exactly as it is.",
    `Keep everything outside <edit_region> exactly as it is, including ${anchors.map((anchor) => `<${anchor.id}>`).join(", ")}.`,
    "Blend the change seamlessly into its surroundings: continue lines, edges, textures, and gradients across the box border,",
    "and match the lighting, color, perspective, sharpness, and grain of the image.",
    JSON.stringify(rows)
  ].join(" ");
}

const MAX_ANCHORS = 6;
/** Smallest anchor side on the 0–1000 scale; FLUX handles very small boxes poorly. */
const MIN_ANCHOR_SIDE = 20;

/**
 * Checks anchors from the vision model: valid boxes inside 0–1000, not wholly
 * inside the edit box, unique snake_case ids. Null when none are usable.
 */
export function cleanAnchors(anchors: SceneAnchor[], box: [number, number, number, number]): SceneAnchor[] | null {
  const used = new Set(["edit_region"]);
  const clean: SceneAnchor[] = [];
  for (const anchor of anchors) {
    if (clean.length >= MAX_ANCHORS || anchor.bbox.length !== 4 || !anchor.desc.trim()) continue;
    const [top, left, bottom, right] = anchor.bbox.map((value) => Math.max(0, Math.min(1000, Math.round(value))));
    if (bottom - top < MIN_ANCHOR_SIDE || right - left < MIN_ANCHOR_SIDE) continue;
    if (top >= box[0] && left >= box[1] && bottom <= box[2] && right <= box[3]) continue;
    const base = anchor.id.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "anchor";
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
    used.add(id);
    clean.push({ id, bbox: [top, left, bottom, right], desc: anchor.desc.trim() });
  }
  return clean.length ? clean : null;
}

/** Without a scene description, the strips around the edit box are the anchors. */
export function fallbackAnchors(box: [number, number, number, number]): SceneAnchor[] {
  const [top, left, bottom, right] = box;
  const strips: SceneAnchor[] = [
    { id: "context_above", bbox: [0, 0, top, 1000], desc: "the existing image above the edit area, unchanged" },
    { id: "context_below", bbox: [bottom, 0, 1000, 1000], desc: "the existing image below the edit area, unchanged" },
    { id: "context_left", bbox: [top, 0, bottom, left], desc: "the existing image left of the edit area, unchanged" },
    { id: "context_right", bbox: [top, right, bottom, 1000], desc: "the existing image right of the edit area, unchanged" }
  ];
  return strips.filter(({ bbox }) => bbox[2] - bbox[0] >= MIN_ANCHOR_SIDE && bbox[3] - bbox[1] >= MIN_ANCHOR_SIDE);
}

/** Smallest and largest square side GPT Image accepts (multiples of 16, within the pixel limits). */
export const GPT_MIN_SQUARE = Math.ceil(Math.sqrt(MIN_REQUEST_PIXELS) / SIZE_MULTIPLE) * SIZE_MULTIPLE;
export const GPT_MAX_SQUARE = Math.floor(Math.sqrt(MAX_REQUEST_PIXELS) / SIZE_MULTIPLE) * SIZE_MULTIPLE;

/** The side a sent square is uploaded and generated at for GPT Image. Small squares are scaled up. */
export const gptSquareSide = (side: number) =>
  Math.max(GPT_MIN_SQUARE, Math.min(GPT_MAX_SQUARE, Math.round(side / SIZE_MULTIPLE) * SIZE_MULTIPLE));

/** The sent region resized for a GPT Image region edit. */
export function gptRegion(sent: SentRegion): SentRegion {
  const side = gptSquareSide(sent.width);
  return { ...sent, requestWidth: side, requestHeight: side, resolution: undefined };
}

/**
 * Share of the selection side that the GPT Image mask leaves out on each side.
 * GPT Image often draws past its mask; the smaller mask makes such overflow
 * land inside the user's selection, which is still pasted back.
 */
export const GPT_MASK_INSET = 0.2;

/** The selection as a blend alpha over the sent region: 255 inside, a soft edge of `feather` pixels, 0 outside. */
export function selectionAlpha(
  width: number,
  height: number,
  inner: Rect,
  touchesImageEdge: { left: boolean; top: boolean; right: boolean; bottom: boolean },
  feather: number
): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(width * height);
  const soft = Math.max(0, Math.min(feather, Math.floor(Math.min(inner.width, inner.height) / 2)));
  for (let y = 0; y < inner.height; y++) {
    for (let x = 0; x < inner.width; x++) {
      let value = 1;
      if (soft > 0) {
        const nearest = Math.min(
          touchesImageEdge.left ? Infinity : x,
          touchesImageEdge.top ? Infinity : y,
          touchesImageEdge.right ? Infinity : inner.width - 1 - x,
          touchesImageEdge.bottom ? Infinity : inner.height - 1 - y
        );
        if (nearest < soft) value = smoothstep((nearest + 0.5) / soft);
      }
      alpha[(inner.y + y) * width + inner.x + x] = Math.round(value * 255);
    }
  }
  return alpha;
}

/** A separable box blur with edge clamping; `radius` 0 returns a copy. */
function boxBlur(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return values.slice();
  const pass = (source: Float32Array, length: number, lines: number, at: (line: number, index: number) => number) => {
    const output = new Float32Array(source.length);
    const span = radius * 2 + 1;
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset++) sum += source[at(line, Math.max(0, Math.min(length - 1, offset)))];
      for (let index = 0; index < length; index++) {
        output[at(line, index)] = sum / span;
        sum += source[at(line, Math.min(length - 1, index + radius + 1))] - source[at(line, Math.max(0, index - radius))];
      }
    }
    return output;
  };
  const rows = pass(values, width, height, (line, index) => line * width + index);
  return pass(rows, height, width, (line, index) => index * width + line);
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Smallest smoothed color difference (0–255) that counts as new content in the margin. */
export const MIN_SPILL_DIFFERENCE = 28;

/**
 * Widens a blend alpha to take in new content that the model drew past the
 * edit area, such as an object that crosses the selection edge, so it is not
 * cut off. Only margin areas that differ strongly from the original and that
 * touch the edit area are added, with a soft edge of about `radius` pixels.
 * `original` and `result` are RGBA pixels of the sent region; `base` is the
 * blend alpha (0–255 per pixel) of the edit area itself.
 */
export function spillAlpha(
  original: Uint8ClampedArray,
  result: Uint8ClampedArray,
  width: number,
  height: number,
  base: Uint8ClampedArray,
  radius: number
): Uint8ClampedArray {
  const count = width * height;
  /** A robust color shift (per-channel median over the margin), so an overall drift does not count as new content. */
  const samples: number[][] = [[], [], []];
  const stride = Math.max(1, Math.floor(count / 50_000));
  for (let pixel = 0; pixel < count; pixel += stride) {
    if (base[pixel] !== 0) continue;
    for (let channel = 0; channel < 3; channel++) samples[channel].push(original[pixel * 4 + channel] - result[pixel * 4 + channel]);
  }
  const offset = samples.map(median);
  const difference = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    /** Changes inside the edit area must not blur out into the margin. */
    if (base[pixel] !== 0) continue;
    let sum = 0;
    for (let channel = 0; channel < 3; channel++) sum += Math.abs(original[pixel * 4 + channel] - result[pixel * 4 + channel] - offset[channel]);
    difference[pixel] = sum / 3;
  }
  const smooth = boxBlur(difference, width, height, radius);
  const marginValues: number[] = [];
  for (let pixel = 0; pixel < count; pixel += stride) if (base[pixel] === 0) marginValues.push(smooth[pixel]);
  const threshold = Math.max(MIN_SPILL_DIFFERENCE, median(marginValues) * 3);

  /** Keep only changed margin areas connected to the edit area. */
  const spill = new Uint8Array(count);
  const queue: number[] = [];
  const changed = (pixel: number) => base[pixel] === 0 && smooth[pixel] > threshold;
  for (let pixel = 0; pixel < count; pixel++) {
    if (base[pixel] === 0 || spill[pixel]) continue;
    const x = pixel % width;
    for (const next of [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, pixel - width, pixel + width]) {
      if (next >= 0 && next < count && !spill[next] && changed(next)) {
        spill[next] = 1;
        queue.push(next);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const pixel = queue[head];
    const x = pixel % width;
    for (const next of [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, pixel - width, pixel + width]) {
      if (next >= 0 && next < count && !spill[next] && changed(next)) {
        spill[next] = 1;
        queue.push(next);
      }
    }
  }
  if (!queue.length) return base.slice();

  /** Grow the spill by `radius`, then soften it; fade it out toward the border of the sent region. */
  const grown = boxBlur(Float32Array.from(spill), width, height, radius);
  for (let pixel = 0; pixel < count; pixel++) grown[pixel] = grown[pixel] > 0.001 ? 1 : 0;
  const soft = boxBlur(grown, width, height, radius);
  const output = base.slice();
  const ramp = Math.max(1, radius * 2);
  for (let pixel = 0; pixel < count; pixel++) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const border = Math.min(1, Math.min(x, y, width - 1 - x, height - 1 - y) / ramp);
    output[pixel] = Math.max(base[pixel], Math.round(soft[pixel] * border * 255));
  }
  return output;
}

/**
 * Builds the GPT Image prompt for a region edit. GPT Image redraws the whole
 * upload even with a mask, so the rules to keep the unmasked context come
 * first and are repeated after the instruction.
 */
export function gptRegionPrompt(instruction: string) {
  return [
    "This is a precise inpainting task on a crop of a larger photo or picture.",
    "Only the area marked by the mask (its transparent pixels) may change.",
    "Every pixel outside the masked area must stay identical to the input image: the same position, shapes, edges, colors, brightness, contrast, sharpness, noise, and grain.",
    "Do not move, resize, crop, zoom, reframe, rotate, restyle, relight, recolor, sharpen, or smooth the image.",
    "Do not redraw or reinterpret anything outside the mask.",
    `Change inside the masked area: ${instruction.trim()}`,
    "Inside the masked area, keep every object and detail that this instruction does not mention.",
    "Every new or changed object must fit completely inside the masked area, with a clear gap between it and the mask edge.",
    "No new object, surface, path, ground cover, shadow, or light may touch the mask edge or seem to continue outside the mask. Make new things smaller if they do not fit.",
    "In a band along the mask edge (about one tenth of the masked area's width), keep the original background of the input image, such as grass, ground, wall, or sky, so it joins the image outside the mask with no visible line.",
    "Again: leave everything outside the mask exactly as it is in the input."
  ].join(" ");
}

/**
 * Builds the GPT Image prompt for a transparent overlay: only the new content,
 * drawn inside `box` (the selection as fractions 0–1 of the upload:
 * left, top, right, bottom), with everything else see-through.
 */
export function gptOverlayPrompt(instruction: string, box: { left: number; top: number; right: number; bottom: number }) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return [
    "The input image is a reference that shows a scene.",
    "Create a transparent overlay for it: an image of the same size in which only the new content is drawn and every other pixel is fully transparent.",
    `New content: ${instruction.trim()}`,
    `Draw the new content only inside the target area, which spans from ${percent(box.left)} to ${percent(box.right)} of the width (from the left edge)`,
    `and from ${percent(box.top)} to ${percent(box.bottom)} of the height (from the top edge).`,
    "Give it the size, position, perspective, and scale it must have in the scene, so it lines up when the overlay is placed exactly over the reference image.",
    "Match the scene's light direction, color temperature, brightness, sharpness, and grain.",
    "Do not draw the background, the ground, the sky, or any other part of the existing scene. Do not copy the reference image.",
    "Do not draw a frame, a border, a backdrop, or a box. Leave everything except the new content fully transparent."
  ].join(" ");
}

/** True when GPT Image cannot take the image as it is: too many pixels or a side over 3840 px. */
export const exceedsWholeImageLimits = (width: number, height: number) =>
  width * height > MAX_REQUEST_PIXELS || Math.max(width, height) > MAX_REQUEST_EDGE;

/**
 * The size a whole image is sent to GPT Image at: the image's own size when it
 * is legal, else the nearest legal size with the same shape (sides in
 * multiples of 16, within the pixel and edge limits). Null when the shape is
 * wider or taller than 3:1, which GPT Image cannot edit.
 */
export function wholeImageSize(width: number, height: number): { width: number; height: number; scaled: boolean } | null {
  if (Math.max(width / height, height / width) > MAX_REQUEST_ASPECT) return null;
  if (validateGenerateSize(width, height) === null) return { width, height, scaled: false };
  let scale = Math.min(MAX_REQUEST_EDGE / Math.max(width, height), Math.sqrt(MAX_REQUEST_PIXELS / (width * height)));
  if (width * height * scale * scale < MIN_REQUEST_PIXELS) scale = Math.sqrt(MIN_REQUEST_PIXELS / (width * height));
  let requestWidth = Math.max(SIZE_MULTIPLE, Math.round((width * scale) / SIZE_MULTIPLE) * SIZE_MULTIPLE);
  let requestHeight = Math.max(SIZE_MULTIPLE, Math.round((height * scale) / SIZE_MULTIPLE) * SIZE_MULTIPLE);
  while (requestWidth * requestHeight > MAX_REQUEST_PIXELS || Math.max(requestWidth, requestHeight) > MAX_REQUEST_EDGE) {
    if (requestWidth >= requestHeight) requestWidth -= SIZE_MULTIPLE;
    else requestHeight -= SIZE_MULTIPLE;
  }
  while (requestWidth * requestHeight < MIN_REQUEST_PIXELS) {
    if (requestWidth <= requestHeight) requestWidth += SIZE_MULTIPLE;
    else requestHeight += SIZE_MULTIPLE;
  }
  return validateGenerateSize(requestWidth, requestHeight) === null
    ? { width: requestWidth, height: requestHeight, scaled: true }
    : null;
}

/** The largest size with the same shape that fits GPT Image's limits, for scaling down an opened image. */
export function fitWithinWholeImageLimits(width: number, height: number) {
  const scale = Math.min(1, MAX_REQUEST_EDGE / Math.max(width, height), Math.sqrt(MAX_REQUEST_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function validateGenerateSize(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "Width and height must be whole numbers.";
  if (width % SIZE_MULTIPLE || height % SIZE_MULTIPLE) return "Width and height must be multiples of 16.";
  if (Math.max(width, height) > MAX_REQUEST_EDGE) return `The longest side can be at most ${MAX_REQUEST_EDGE} px.`;
  if (Math.max(width / height, height / width) > MAX_REQUEST_ASPECT) return "The aspect ratio must be between 1:3 and 3:1.";
  if (width * height < MIN_REQUEST_PIXELS) return "The image must have at least 655,360 pixels (for example 816 × 816).";
  if (width * height > MAX_REQUEST_PIXELS) return "The image can have at most 8,294,400 pixels (4K).";
  return null;
}

/** Clamps a square to the image and to the minimum size. */
export function clampSelection(selection: SquareSelection, imageWidth: number, imageHeight: number): SquareSelection {
  const size = Math.max(
    Math.min(MIN_SELECTION_SIZE, imageWidth, imageHeight),
    Math.min(Math.round(selection.size), imageWidth, imageHeight)
  );
  return {
    x: Math.max(0, Math.min(imageWidth - size, Math.round(selection.x))),
    y: Math.max(0, Math.min(imageHeight - size, Math.round(selection.y))),
    size
  };
}

/**
 * Per-channel offset that moves the result's margin ring onto the original's.
 * Returns zeros when the ring is too small to measure, and clamps large shifts
 * so a real content change in the margin cannot recolor the whole edit.
 */
export function driftOffset(
  original: Uint8ClampedArray,
  result: Uint8ClampedArray,
  width: number,
  height: number,
  inner: Rect
): [number, number, number] {
  const sums = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < height; y++) {
    const insideRow = y >= inner.y && y < inner.y + inner.height;
    for (let x = 0; x < width; x++) {
      if (insideRow && x >= inner.x && x < inner.x + inner.width) continue;
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) sums[channel] += original[index + channel] - result[index + channel];
      count++;
    }
  }
  if (count < 64) return [0, 0, 0];
  const limit = 40;
  return sums.map((sum) => Math.max(-limit, Math.min(limit, sum / count))) as [number, number, number];
}

const smoothstep = (value: number) => value * value * (3 - 2 * value);

/**
 * Blends the model result into the original over the selection only.
 *
 * `original` and `result` are RGBA pixels of the whole sent region
 * (`width` × `height`); `inner` is the selection inside it. Returns the RGBA
 * pixels of the selection after blending. Sides of the selection that touch the
 * image border are not feathered, because no original context lies beyond them.
 */
export function blendSelection(
  original: Uint8ClampedArray,
  result: Uint8ClampedArray,
  width: number,
  height: number,
  inner: Rect,
  touchesImageEdge: { left: boolean; top: boolean; right: boolean; bottom: boolean },
  options: BlendOptions
): Uint8ClampedArray {
  const offset = options.driftCorrection ? driftOffset(original, result, width, height, inner) : [0, 0, 0];
  const feather = Math.max(0, Math.min(options.feather, Math.floor(Math.min(inner.width, inner.height) / 2)));
  const output = new Uint8ClampedArray(inner.width * inner.height * 4);
  for (let y = 0; y < inner.height; y++) {
    for (let x = 0; x < inner.width; x++) {
      const source = ((inner.y + y) * width + inner.x + x) * 4;
      const target = (y * inner.width + x) * 4;
      let alpha = 1;
      if (feather > 0) {
        const distances = [
          touchesImageEdge.left ? Infinity : x,
          touchesImageEdge.top ? Infinity : y,
          touchesImageEdge.right ? Infinity : inner.width - 1 - x,
          touchesImageEdge.bottom ? Infinity : inner.height - 1 - y
        ];
        const nearest = Math.min(...distances);
        if (nearest < feather) alpha = smoothstep((nearest + 0.5) / feather);
      }
      for (let channel = 0; channel < 3; channel++) {
        const corrected = result[source + channel] + offset[channel];
        output[target + channel] = original[source + channel] * (1 - alpha) + corrected * alpha;
      }
      output[target + 3] = original[source + 3] * (1 - alpha) + result[source + 3] * alpha;
    }
  }
  return output;
}

/**
 * Blends the model result into the original through a painted mask.
 *
 * `original` and `result` are RGBA pixels of the whole sent region; `alpha` is
 * the mask (0–255 per pixel, already softened at its edge). Unpainted pixels
 * keep the original exactly. With drift correction, the result's colors are
 * shifted so its unpainted area matches the original's.
 */
export function blendMasked(
  original: Uint8ClampedArray,
  result: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  options: Pick<BlendOptions, "driftCorrection">
): Uint8ClampedArray {
  const offset = [0, 0, 0];
  if (options.driftCorrection) {
    const sums = [0, 0, 0];
    let count = 0;
    for (let pixel = 0; pixel < alpha.length; pixel++) {
      if (alpha[pixel] !== 0) continue;
      const index = pixel * 4;
      for (let channel = 0; channel < 3; channel++) sums[channel] += original[index + channel] - result[index + channel];
      count++;
    }
    if (count >= 64) for (let channel = 0; channel < 3; channel++) offset[channel] = Math.max(-40, Math.min(40, sums[channel] / count));
  }
  const output = new Uint8ClampedArray(original);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    const weight = alpha[pixel] / 255;
    if (weight === 0) continue;
    const index = pixel * 4;
    for (let channel = 0; channel < 3; channel++) {
      output[index + channel] = original[index + channel] * (1 - weight) + (result[index + channel] + offset[channel]) * weight;
    }
  }
  return output;
}
/** The area where an alpha channel (one value per pixel) is at least `threshold`; null when it is nowhere. */
export function alphaBounds(alpha: Uint8ClampedArray, width: number, height: number, threshold: number): Rect | null {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] < threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** A rectangle grown by `pad` pixels on each side, kept inside the image. */
export function padRect(rect: Rect, pad: number, imageWidth: number, imageHeight: number): Rect {
  const x = Math.max(0, rect.x - pad);
  const y = Math.max(0, rect.y - pad);
  return {
    x,
    y,
    width: Math.min(imageWidth, rect.x + rect.width + pad) - x,
    height: Math.min(imageHeight, rect.y + rect.height + pad) - y
  };
}

/**
 * Keeps a detected subject only near the area the user marked. `near` is that
 * area blurred outward, so a rough mark that cuts into the subject does not cut
 * it; where `near` is weak the subject fades out. Changes `subject` in place.
 */
export function limitToArea(subject: Uint8ClampedArray, near: Uint8ClampedArray) {
  for (let pixel = 0; pixel < subject.length; pixel++) {
    subject[pixel] = Math.round(subject[pixel] * Math.min(1, near[pixel] * 4 / 255));
  }
  return subject;
}
