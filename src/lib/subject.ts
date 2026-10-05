import { canvasFromDataUrl, canvasToDataUrl, context2d, createCanvas } from "../editor/canvas";
import { alphaBounds, limitToArea, padRect } from "../editor/region";
import type { MaskImage, Rect } from "../editor/types";
import { runWithProgress, type AiProgress } from "./ai";

/** The model works at 1024 px, so a larger image is sent at most this size; the mask is scaled back up. */
const UPLOAD_MAX_SIDE = 2048;

/** Subject detection runs on this PC with a local model (BiRefNet); see `models.ts` for its download. */
export interface SubjectMask {
  /** A PNG data URL at the image size: white, with the subject as its alpha. */
  maskDataUrl: string;
  /** The subject's area, or null when no subject was found. */
  bounds: Rect | null;
}

export const detectSubject = (requestId: string, imagePng: string, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<SubjectMask>("subject_mask", requestId, { imagePng }, onProgress);

/** A layer mask that limits where to look: the model sees only the area the mask shows (with `hides`, the area it does not cover). */
export interface SubjectArea {
  mask: HTMLCanvasElement;
  hides: boolean;
}

/** The alpha channel of part of a canvas, one value per pixel. */
function alphaOf(canvas: HTMLCanvasElement, rect: Rect) {
  const pixels = context2d(canvas).getImageData(rect.x, rect.y, rect.width, rect.height).data;
  const alpha = new Uint8ClampedArray(rect.width * rect.height);
  for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = pixels[pixel * 4 + 3];
  return alpha;
}

/** Where a layer mask shows the layer, as alpha on a new full-size canvas, blurred by `blur` pixels. */
function shownArea(area: SubjectArea, blur = 0) {
  const shown = createCanvas(area.mask.width, area.mask.height);
  const context = context2d(shown);
  if (area.hides) {
    context.fillStyle = "#000";
    context.fillRect(0, 0, shown.width, shown.height);
    context.globalCompositeOperation = "destination-out";
  }
  context.drawImage(area.mask, 0, 0);
  if (!blur) return shown;
  const blurred = createCanvas(shown.width, shown.height);
  const blurContext = context2d(blurred);
  blurContext.filter = `blur(${blur}px)`;
  blurContext.drawImage(shown, 0, 0);
  return blurred;
}

/**
 * Finds the subject of a picture, as a mask at the picture's size; null when
 * there is none. With `area`, only the part of the picture inside that mask's
 * shown area (plus a margin) is searched, and the subject is kept only near it.
 */
export async function findSubject(
  source: HTMLCanvasElement,
  requestId: string,
  onProgress: (progress: AiProgress) => void,
  area?: SubjectArea
): Promise<MaskImage | null> {
  const { width, height } = source;
  const whole = { x: 0, y: 0, width, height };
  const shown = area ? shownArea(area) : null;
  const marked = shown ? alphaBounds(alphaOf(shown, whole), width, height, 8) : null;
  const pad = marked ? Math.max(16, Math.round(Math.max(marked.width, marked.height) * 0.08)) : 0;
  const crop = marked ? padRect(marked, pad, width, height) : whole;

  const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(crop.width, crop.height));
  const upload = createCanvas(Math.max(1, Math.round(crop.width * scale)), Math.max(1, Math.round(crop.height * scale)));
  const uploadContext = upload.getContext("2d")!;
  uploadContext.imageSmoothingEnabled = true;
  uploadContext.imageSmoothingQuality = "high";
  uploadContext.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, upload.width, upload.height);
  const result = await detectSubject(requestId, await canvasToDataUrl(upload), onProgress);
  if (!result.bounds) return null;

  const mask = createCanvas(width, height);
  const maskContext = context2d(mask);
  maskContext.imageSmoothingEnabled = true;
  maskContext.imageSmoothingQuality = "high";
  maskContext.drawImage(await canvasFromDataUrl(result.maskDataUrl), crop.x, crop.y, crop.width, crop.height);
  const subject = alphaOf(mask, crop);
  if (area) limitToArea(subject, alphaOf(shownArea(area, pad / 2), crop));
  const found = alphaBounds(subject, crop.width, crop.height, 128);
  if (!found) return null;
  const pixels = maskContext.getImageData(crop.x, crop.y, crop.width, crop.height);
  for (let pixel = 0; pixel < subject.length; pixel++) pixels.data[pixel * 4 + 3] = subject[pixel];
  maskContext.putImageData(pixels, crop.x, crop.y);
  return { src: await canvasToDataUrl(mask), bounds: { ...found, x: found.x + crop.x, y: found.y + crop.y } };
}

