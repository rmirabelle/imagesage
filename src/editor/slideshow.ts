/**
 * The video slideshow's timing, without DOM code. The video is a list of
 * segments; each shows one picture, fading in from the one before it, and the
 * end fades to black.
 *
 * Pictures are numbered: 0 is the original image, and 1…n are the image after
 * each visible layer, so n is the final image.
 *
 * With an intro: the very first frame is the final image, with no fade from
 * black, so a video site's thumbnail from the first frame is never black.
 * After OPEN_PAUSE seconds the intro overlay (a box with the title and
 * credits) fades in over it, and it holds for OPEN_HOLD more seconds. Then the build-up: the original
 * image named "Original image", then every STEP seconds the next layer fading
 * in over FADE_IN seconds with its name at the top center, the top layer
 * too. Then the top layer fades to black and the final image (the same
 * picture) fades in from black, named "Final image", over FINAL_FADE seconds.
 * It rests for FINAL_REST seconds; with an intro, the overlay then shows
 * again for FINAL_TITLE seconds.
 */
export const SLIDESHOW_FPS = 30;
export const STEP = 3.5;
export const FADE_IN = 0.5;
/** Half of it fades the top layer to black, half fades the final image in. */
export const FINAL_FADE = 3;
export const FINAL_REST = 10;
export const FINAL_TITLE = 6;
export const OVERLAY_FADE = 0.5;
export const FINAL_HOLD = FINAL_FADE + FINAL_REST + OVERLAY_FADE + FINAL_TITLE;
export const FADE_OUT = 3.5;
/** Seconds the opening final image shows alone before the intro overlay fades in. */
export const OPEN_PAUSE = 0.5;
export const OPEN_HOLD = 7;
export const INTRO_FADE = 1;
/** The video fits inside 1080p and keeps the image's shape. */
export const VIDEO_MAX_WIDTH = 1920;
export const VIDEO_MAX_HEIGHT = 1080;

/** A picture's own name, "Final image", or no name. */
export type SlideLabel = number | "final" | null;

export interface Segment {
  picture: number;
  /** Seconds, including the fade in. */
  duration: number;
  /** Seconds to fade in from the previous segment's picture (from black for the first segment); 0 cuts. */
  fade: number;
  /** The fade goes through black: the previous picture fades out in its first half, this one fades in in its second half. */
  throughBlack: boolean;
  /** The name shown; it fades out after `labelFor` seconds when that is shorter than the segment. */
  label: SlideLabel;
  labelFor: number;
  /** When the intro overlay shows, in seconds from the segment start: it fades in from `from` and is gone at `to`. */
  overlay: { from: number; to: number } | null;
}

/** What one video frame shows: a mix of two pictures, a name and the overlay at some opacity, and how much black covers it. */
export interface SlideFrame {
  from: number;
  to: number;
  /** 0 shows `from` only, 1 shows `to` only. */
  mix: number;
  label: SlideLabel;
  labelAlpha: number;
  /** 0 hides the intro overlay, 1 shows it fully. */
  overlay: number;
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
  /** The last segment: the final image from black, a long rest, then the overlay again until the end. */
  const final = (picture: number, label: SlideLabel, fade: number): Segment => ({
    picture,
    duration: FINAL_HOLD,
    fade,
    throughBlack: true,
    label,
    labelFor: FINAL_HOLD,
    /** The overlay stays until the end; the fade to black covers it with the image. */
    overlay: intro ? { from: fade + FINAL_REST, to: FINAL_HOLD + FADE_OUT + OVERLAY_FADE } : null
  });
  /** The first segment never fades in from black: its first frame is the picture itself. */
  if (top === 0) return [final(0, 0, 0)];
  const segments: Segment[] = [];
  if (intro) {
    const duration = OPEN_PAUSE + OPEN_HOLD;
    segments.push({ picture: top, duration, fade: 0, throughBlack: false, label: null, labelFor: 0, overlay: { from: OPEN_PAUSE, to: duration } });
  }
  segments.push({ picture: 0, duration: STEP, fade: intro ? INTRO_FADE : 0, throughBlack: false, label: 0, labelFor: STEP, overlay: null });
  for (let picture = 1; picture <= top; picture++) {
    segments.push({ picture, duration: STEP, fade: FADE_IN, throughBlack: false, label: picture, labelFor: STEP, overlay: null });
  }
  segments.push(final(top, "final", FINAL_FADE));
  return segments;
}

/** Seconds the music takes to fade in, so a track cut mid-song does not start abruptly. */
export const MUSIC_FADE_IN = 1;

/**
 * The music's volume, 0 to 1, at `time` seconds into the video. It fades in
 * over MUSIC_FADE_IN seconds and fades out over FADE_OUT seconds, with the
 * picture at the end of the video, or earlier when the track runs out
 * (`trackSeconds` is how much of it is left after the chosen start).
 */
export function musicGain(time: number, videoSeconds: number, trackSeconds: number) {
  const end = Math.min(videoSeconds, trackSeconds);
  return Math.min(clamp01(time / MUSIC_FADE_IN), clamp01((end - time) / FADE_OUT));
}

/** The video length in seconds: every segment, then the fade to black. */
export const slideshowDuration = (segments: Segment[]) => segments.reduce((sum, segment) => sum + segment.duration, 0) + FADE_OUT;

export const slideshowFrameCount = (segments: Segment[]) => Math.round(slideshowDuration(segments) * SLIDESHOW_FPS);

/** What the video shows at `time` seconds. */
export function slideshowFrame(segments: Segment[], time: number): SlideFrame {
  let start = 0;
  let index = 0;
  while (index < segments.length - 1 && time >= start + segments[index].duration) {
    start += segments[index].duration;
    index += 1;
  }
  const segment = segments[index];
  const since = time - start;
  const progress = segment.fade > 0 ? clamp01(since / segment.fade) : 1;
  /** Through black: the previous picture shows until half way, then this one; black peaks at half way. */
  const dip = segment.throughBlack && index > 0 ? 1 - Math.abs(progress * 2 - 1) : 0;
  const mix = segment.throughBlack && index > 0 ? (progress < 0.5 ? 0 : 1) : progress;
  /** The first segment fades in from black instead of from a picture. */
  const opening = index === 0 ? 1 - progress : 0;
  const closing = clamp01((time - (slideshowDuration(segments) - FADE_OUT)) / FADE_OUT);
  const from = index > 0 ? segments[index - 1].picture : segment.picture;
  /** While the previous picture fades to black, its name goes down with it. */
  const keepsPrevious = segment.throughBlack && index > 0 && mix === 0;
  const label = keepsPrevious ? segments[index - 1].label : segment.label;
  const labelAlpha = label === null ? 0 : keepsPrevious ? 1 : Math.min(mix, clamp01((segment.labelFor + FADE_IN - since) / FADE_IN));
  const overlay = segment.overlay
    ? Math.min(clamp01((since - segment.overlay.from) / OVERLAY_FADE), clamp01((segment.overlay.to - since) / OVERLAY_FADE))
    : 0;
  return { from, to: segment.picture, mix, label, labelAlpha, overlay, black: Math.max(opening, dip, closing) };
}
