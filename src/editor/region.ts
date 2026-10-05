/** Size rules for images sent to GPT Image 2.x (flexible sizes). */
export const SIZE_MULTIPLE = 16;
export const MIN_REQUEST_PIXELS = 655_360;
export const MAX_REQUEST_PIXELS = 8_294_400;
export const MAX_REQUEST_EDGE = 3840;
export const MAX_REQUEST_ASPECT = 3;

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
