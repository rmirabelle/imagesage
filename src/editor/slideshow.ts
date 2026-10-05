/**
 * The video slideshow's timing, without DOM code. The video is a list of
 * segments; each shows one picture, fading in from the one before it, and the
 * end fades to black.
 *
 * Pictures are numbered: 0 is the original image, 1…n are the image after
 * each visible layer, and n + 1 is the intro card (when there is one).
 *
 * With an intro: the intro card, then the finished image fading in and
 * holding, then the build-up below. The build-up: the original image, then
 * every STEP seconds the next layer fading in over FADE_IN seconds with its
 * name in the lower left, then the top layer holding for FINAL_HOLD seconds.
 */
export const SLIDESHOW_FPS = 30;
export const STEP = 3.5;
export const FADE_IN = 0.5;
export const FINAL_HOLD = 10;
export const FADE_OUT = 1.5;
export const INTRO_CARD = 4;
export const INTRO_FADE = 1;
export const INTRO_FINAL_HOLD = 4;
/** The video fits inside 1080p and keeps the image's shape. */
export const VIDEO_MAX_WIDTH = 1920;
export const VIDEO_MAX_HEIGHT = 1080;

export interface Segment {
  picture: number;
  /** Seconds, including the fade in. */
  duration: number;
  /** Seconds to fade in from the previous segment's picture; 0 cuts. */
  fade: number;
  /** Shows the picture's name; it fades out after `labelFor` seconds when that is shorter than the segment. */
  label: boolean;
  labelFor: number;
}

/** What one video frame shows: a mix of two pictures, a picture's name at some opacity, and how much black covers it. */
export interface SlideFrame {
  from: number;
  to: number;
  /** 0 shows `from` only, 1 shows `to` only. */
  mix: number;
  /** The picture whose name shows, or null. */
  label: number | null;
  labelAlpha: number;
  /** 0 is no black, 1 is fully black. */
  black: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The video size for an image: inside 1080p, the same shape, both sides even (the H.264 encoder needs that). */
export function videoSize(width: number, height: number) {
  const scale = Math.min(1, VIDEO_MAX_WIDTH / width, VIDEO_MAX_HEIGHT / height);
  const even = (value: number) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** The segments for `stages` pictures (the original image plus each visible layer), with or without the intro. */
export function slideshowSegments(stages: number, intro: boolean): Segment[] {
  const top = Math.max(0, stages - 1);
  const segments: Segment[] = [];
  if (intro) {
    segments.push({ picture: top + 1, duration: INTRO_CARD, fade: 0, label: false, labelFor: 0 });
    segments.push({ picture: top, duration: INTRO_FADE + INTRO_FINAL_HOLD, fade: INTRO_FADE, label: false, labelFor: 0 });
  }
  if (top === 0) {
    segments.push({ picture: 0, duration: FINAL_HOLD, fade: intro ? INTRO_FADE : 0, label: false, labelFor: 0 });
    return segments;
  }
  segments.push({ picture: 0, duration: STEP, fade: intro ? INTRO_FADE : 0, label: false, labelFor: 0 });
  for (let picture = 1; picture <= top; picture++) {
    const last = picture === top;
    segments.push({ picture, duration: last ? FINAL_HOLD : STEP, fade: FADE_IN, label: true, labelFor: last ? STEP : STEP + FINAL_HOLD });
  }
  return segments;
}

/** The video length in seconds: every segment, then the fade to black. */
export const slideshowDuration = (segments: Segment[]) => segments.reduce((sum, segment) => sum + segment.duration, 0) + FADE_OUT;

export const slideshowFrameCount = (segments: Segment[]) => Math.round(slideshowDuration(segments) * SLIDESHOW_FPS);

/** What the video shows at `time` seconds. */
export function slideshowFrame(segments: Segment[], time: number): SlideFrame {
  const black = clamp01((time - (slideshowDuration(segments) - FADE_OUT)) / FADE_OUT);
  let start = 0;
  let index = 0;
  while (index < segments.length - 1 && time >= start + segments[index].duration) {
    start += segments[index].duration;
    index += 1;
  }
  const segment = segments[index];
  const since = time - start;
  const from = index > 0 ? segments[index - 1].picture : segment.picture;
  const mix = segment.fade > 0 ? clamp01(since / segment.fade) : 1;
  const labelAlpha = segment.label ? Math.min(mix, clamp01((segment.labelFor + FADE_IN - since) / FADE_IN)) : 0;
  return { from, to: segment.picture, mix, label: segment.label ? segment.picture : null, labelAlpha, black };
}
