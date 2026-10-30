/**
 * Size rules for images from the local engine (Chroma1-HD and Qwen-Image-2.1).
 * Both work best near one megapixel: the engine makes the image at a size of
 * the same shape within these limits, and Image Sage scales it to the canvas.
 * Qwen-Image-2.1 needs sides that are multiples of 32; Chroma takes those too.
 */
export const LOCAL_SIZE_MULTIPLE = 32;
export const LOCAL_MIN_PIXELS = 768 * 768;
export const LOCAL_MAX_PIXELS = 1280 * 1280;
export const LOCAL_MAX_ASPECT = 4;

/** The size the local engine makes an image of this shape at. Null when the shape is wider or taller than 4:1. */
export function localImageSize(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0) || Math.max(width / height, height / width) > LOCAL_MAX_ASPECT) return null;
  const area = width * height;
  const scale = area > LOCAL_MAX_PIXELS
    ? Math.sqrt(LOCAL_MAX_PIXELS / area)
    : area < LOCAL_MIN_PIXELS ? Math.sqrt(LOCAL_MIN_PIXELS / area) : 1;
  const round = (side: number) => Math.max(LOCAL_SIZE_MULTIPLE, Math.round((side * scale) / LOCAL_SIZE_MULTIPLE) * LOCAL_SIZE_MULTIPLE);
  let localWidth = round(width);
  let localHeight = round(height);
  while (localWidth * localHeight > LOCAL_MAX_PIXELS) {
    if (localWidth >= localHeight) localWidth -= LOCAL_SIZE_MULTIPLE;
    else localHeight -= LOCAL_SIZE_MULTIPLE;
  }
  while (localWidth * localHeight < LOCAL_MIN_PIXELS) {
    if (localWidth <= localHeight) localWidth += LOCAL_SIZE_MULTIPLE;
    else localHeight += LOCAL_SIZE_MULTIPLE;
  }
  return { width: localWidth, height: localHeight };
}
