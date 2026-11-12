/**
 * Size and length rules for video clips from the local engine (Wan 2.2).
 * A clip has the shape of the layer it starts from. Its sides are multiples
 * of 16, and its area stays within the area that Wan 2.2 learned from:
 * 832 x 480 for a small clip, 1280 x 720 for a large one.
 */
export const CLIP_SIZE_MULTIPLE = 16;
export const CLIP_MAX_ASPECT = 3;
/** Wan 2.2 makes 16 pictures for each second. */
export const CLIP_FPS = 16;

export interface ClipQuality {
  id: string;
  label: string;
  /** The largest area of a clip, in pixels. */
  pixels: number;
}

export const CLIP_QUALITIES: ClipQuality[] = [
  { id: "small", label: "Small", pixels: 832 * 480 },
  { id: "large", label: "Large", pixels: 1280 * 720 }
];
/** The editor sends the layer at this area; the video window scales it down for a small clip. */
export const CLIP_SOURCE_PIXELS = CLIP_QUALITIES[CLIP_QUALITIES.length - 1].pixels;

/** Clip lengths in seconds; 5 seconds is the longest that Wan 2.2 learned from. */
export const CLIP_SECONDS = [2, 3, 5];

/** How many pictures a clip of this length has: Wan 2.2 needs a multiple of 4, plus 1. */
export const clipFrames = (seconds: number) => seconds * CLIP_FPS + 1;

/**
 * The largest clip size of this shape within `pixels`. Null when the shape
 * is wider or taller than 3:1. Each height that is a multiple of 16 gets the
 * nearest width that is one, so the shape changes by one percent or two at most.
 */
export function clipSize(width: number, height: number, pixels: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0) || Math.max(width / height, height / width) > CLIP_MAX_ASPECT) return null;
  const aspect = width / height;
  const round = (side: number) => Math.max(CLIP_SIZE_MULTIPLE, Math.round(side / CLIP_SIZE_MULTIPLE) * CLIP_SIZE_MULTIPLE);
  const tallest = Math.floor(Math.sqrt(pixels / aspect) / CLIP_SIZE_MULTIPLE + 1) * CLIP_SIZE_MULTIPLE;
  for (let clipHeight = tallest; clipHeight >= CLIP_SIZE_MULTIPLE; clipHeight -= CLIP_SIZE_MULTIPLE) {
    const clipWidth = round(clipHeight * aspect);
    if (clipWidth * clipHeight <= pixels) return { width: clipWidth, height: clipHeight };
  }
  return null;
}
