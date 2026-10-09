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
 * credits) fades in over it, and it holds for OPEN_HOLD more seconds. After the
 * overlay fades out, the final image stays OPEN_REST seconds more. Then the
 * build-up: the original image named "Original image" for STEP seconds, then
 * each layer for LAYER_STEP seconds (less with many layers, see
 * MAX_VIDEO_SECONDS), the top layer too. A layer's name at the
 * top center fades in over LABEL_FADE seconds first and shows alone for
 * LABEL_PAUSE seconds; then the layer flashes FLASHES times (FLASH seconds on,
 * FLASH seconds off) and fades in over LAYER_FADE seconds. Then the top layer
 * fades to black and the original image fades in from black again, named
 * "Original image", over RETURN_FADE seconds, and shows for RETURN_HOLD
 * seconds; its name fades out at the end. Then the final image fades in over
 * it, named "Final image", over FINAL_FADE seconds; the name fades out
 * FINAL_LABEL seconds later.
 * It rests for FINAL_REST seconds; with an intro, the overlay then shows
 * again for FINAL_TITLE seconds.
 */
export const SLIDESHOW_FPS = 30;
export const STEP = 3.5;
export const FADE_IN = 0.5;
/** Seconds a layer's name fades in, before the layer shows. */
export const LABEL_FADE = 0.5;
/** Seconds the layer's name shows alone after it fades in, before the layer flashes. */
export const LABEL_PAUSE = 0.4;
export const LABEL_LEAD = LABEL_FADE + LABEL_PAUSE;
export const FLASH = 0.1;
export const FLASHES = 1;
export const LAYER_FADE = 0.5;
/** Seconds the layer shows fully, after its flashes and fade. */
export const LAYER_HOLD = 1.5;
export const LAYER_STEP = LABEL_LEAD + FLASH * 2 * FLASHES + LAYER_FADE + LAYER_HOLD;
/**
 * The longest video by default, in seconds. With many layers, each layer gets
 * less time by default (see defaultLayerSeconds), so the whole video fits.
 */
export const MAX_VIDEO_SECONDS = 90;
/** The seconds per layer the user can choose in the video dialog. */
export const MIN_LAYER_SECONDS = 1;
export const MAX_LAYER_SECONDS = 4;
/** Half of it fades the top layer to black, half fades the original image in again. */
export const RETURN_FADE = 3;
/** Seconds the original image shows again, after it is in, before the final image fades in over it. */
export const RETURN_HOLD = 2;
export const RETURN_STEP = RETURN_FADE + RETURN_HOLD;
/** Seconds the final image takes to fade in over the original image. */
export const FINAL_FADE = 3;
export const FINAL_REST = 10;
/** Seconds the "Final image" name stays after the final image is in, before it fades out. */
export const FINAL_LABEL = 1;
export const FINAL_TITLE = 6;
export const OVERLAY_FADE = 0.5;
export const FINAL_HOLD = FINAL_FADE + FINAL_REST + OVERLAY_FADE + FINAL_TITLE;
export const FADE_OUT = 3.5;
/** Seconds the opening final image shows alone before the intro overlay fades in. */
export const OPEN_PAUSE = 0.5;
export const OPEN_HOLD = 7;
/** Seconds the opening final image stays alone after the intro overlay is gone. */
export const OPEN_REST = 2;
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
  /** Seconds the name fades in before the picture changes; 0 fades the name in with the picture. */
  labelLead: number;
  /** Times the picture flashes on and off before it fades in. */
  flashes: number;
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

/**
 * One layer's segment, `seconds` long. Its name lead, fade and hold change
 * together by the same factor; the flash keeps its length.
 */
function layerSegment(picture: number, seconds: number): Segment {
  const flashing = FLASH * 2 * FLASHES;
  const scale = (seconds - flashing) / (LAYER_STEP - flashing);
  return { picture, duration: seconds, fade: LAYER_FADE * scale, throughBlack: false, labelLead: LABEL_LEAD * scale, flashes: FLASHES, label: picture, labelFor: seconds, overlay: null };
}

/**
 * The seconds each layer shows unless the user chooses: LAYER_STEP, or less
 * so the video fits in MAX_VIDEO_SECONDS, but not below MIN_LAYER_SECONDS.
 * It is rounded down to a tenth of a second, as the video dialog shows it.
 */
export function defaultLayerSeconds(stages: number, intro: boolean) {
  const top = Math.max(0, stages - 1);
  /** With 0 seconds per layer, the duration is everything but the layers. */
  const others = slideshowDuration(slideshowSegments(stages, intro, 0));
  const fit = top > 0 ? (MAX_VIDEO_SECONDS - others) / top : LAYER_STEP;
  return Math.floor(Math.min(LAYER_STEP, Math.max(MIN_LAYER_SECONDS, fit)) * 10 + 1e-6) / 10;
}

/** The segments for `stages` pictures (the original image plus each visible layer), with or without the intro; each layer shows `layerSeconds`. */
export function slideshowSegments(stages: number, intro: boolean, layerSeconds = defaultLayerSeconds(stages, intro)): Segment[] {
  const top = Math.max(0, stages - 1);
  /** The last segment: the final image fading in over the original image, a long rest, then the overlay again until the end. */
  const final = (picture: number, label: SlideLabel, fade: number): Segment => ({
    picture,
    duration: FINAL_HOLD,
    fade,
    throughBlack: false,
    labelLead: 0,
    flashes: 0,
    label,
    /** The name stays FINAL_LABEL seconds after the image is in, then fades, so the image can be seen alone. */
    labelFor: fade + FINAL_LABEL,
    /** The overlay stays until the end; the fade to black covers it with the image. */
    overlay: intro ? { from: fade + FINAL_REST, to: FINAL_HOLD + FADE_OUT + OVERLAY_FADE } : null
  });
  /** The first segment never fades in from black: its first frame is the picture itself. */
  if (top === 0) return [final(0, 0, 0)];
  const segments: Segment[] = [];
  if (intro) {
    const overlayEnd = OPEN_PAUSE + OPEN_HOLD;
    segments.push({ picture: top, duration: overlayEnd + OPEN_REST, fade: 0, throughBlack: false, labelLead: 0, flashes: 0, label: null, labelFor: 0, overlay: { from: OPEN_PAUSE, to: overlayEnd } });
  }
  segments.push({ picture: 0, duration: STEP, fade: intro ? INTRO_FADE : 0, throughBlack: false, labelLead: 0, flashes: 0, label: 0, labelFor: STEP, overlay: null });
  for (let picture = 1; picture <= top; picture++) segments.push(layerSegment(picture, layerSeconds));
  /** The original image again, through black; its name is gone before the final image fades in. */
  segments.push({ picture: 0, duration: RETURN_STEP, fade: RETURN_FADE, throughBlack: true, labelLead: 0, flashes: 0, label: 0, labelFor: RETURN_STEP - FADE_IN, overlay: null });
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
  /** The picture changes after the name's lead, then flashes, then fades in. */
  const flashing = segment.flashes * 2 * FLASH;
  const shown = since - segment.labelLead;
  const fadeSince = shown - flashing;
  const progress = shown < 0 ? 0 : segment.fade > 0 ? clamp01(fadeSince / segment.fade) : 1;
  const flash = shown >= 0 && fadeSince < 0 ? (Math.floor(shown / FLASH + 1e-6) % 2 === 0 ? 1 : 0) : null;
  /** Through black: the previous picture shows until half way, then this one; black peaks at half way. */
  const dip = segment.throughBlack && index > 0 ? 1 - Math.abs(progress * 2 - 1) : 0;
  const mix = flash ?? (segment.throughBlack && index > 0 ? (progress < 0.5 ? 0 : 1) : progress);
  /** The first segment fades in from black instead of from a picture. */
  const opening = index === 0 ? 1 - progress : 0;
  const closing = clamp01((time - (slideshowDuration(segments) - FADE_OUT)) / FADE_OUT);
  const from = index > 0 ? segments[index - 1].picture : segment.picture;
  /** While the previous picture fades to black, its name goes down with it. */
  const keepsPrevious = segment.throughBlack && index > 0 && mix === 0;
  const label = keepsPrevious ? segments[index - 1].label : segment.label;
  /** A shortened layer shortens its name's fade in by the same factor as its lead. */
  const labelIn = segment.labelLead > 0 ? clamp01(since / (LABEL_FADE * segment.labelLead / LABEL_LEAD)) : mix;
  const labelAlpha = label === null ? 0 : keepsPrevious ? 1 : Math.min(labelIn, clamp01((segment.labelFor + FADE_IN - since) / FADE_IN));
  const overlay = segment.overlay
    ? Math.min(clamp01((since - segment.overlay.from) / OVERLAY_FADE), clamp01((segment.overlay.to - since) / OVERLAY_FADE))
    : 0;
  return { from, to: segment.picture, mix, label, labelAlpha, overlay, black: Math.max(opening, dip, closing) };
}
