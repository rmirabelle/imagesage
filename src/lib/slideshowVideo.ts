import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { musicGain, SLIDESHOW_FPS, slideshowDuration, slideshowFrame, slideshowFrameCount, slideshowSegments } from "../editor/slideshow";
import { MUSIC_SAMPLE_RATE } from "./music";
import { getAppVersion } from "./updater";

/** The music under the video: a decoded track, and the second of it where the video starts. */
export interface SlideshowMusic {
  buffer: AudioBuffer;
  start: number;
}

/** The video's settings: the title in the intro overlay (left out when empty), the music, if any, and the seconds each layer shows. */
export interface SlideshowOptions {
  title: string;
  music: SlideshowMusic | null;
  layerSeconds: number;
}

/**
 * Encodes the video slideshow as an H.264 MP4, with the webview's own video
 * encoder (WebCodecs) and `mp4-muxer` (MIT). It runs faster than real time.
 * `stages` are the pictures at video size: the original image, then the
 * image after each visible layer; `names` label them. The video opens and
 * closes on the final image with the intro overlay over it. Music, when
 * chosen, is encoded first as AAC audio.
 */
const BITRATE = 10_000_000;
const AUDIO_BITRATE = 192_000;
/** AAC-LC, the audio that every MP4 player can play. */
const AUDIO_CODEC = "mp4a.40.2";
/** Audio frames per chunk handed to the encoder. */
const AUDIO_CHUNK = 4096;
/** One key frame every two seconds, so players can seek. */
const KEY_FRAME_EVERY = SLIDESHOW_FPS * 2;
/** H.264 profiles to try, best first: High, then Main, then Baseline (level 4.0, enough for 1080p30). */
const CODECS = ["avc1.640028", "avc1.4D4028", "avc1.42E028"];

async function pickCodec(width: number, height: number) {
  if (typeof VideoEncoder === "undefined") throw new Error("This version of the app's web view cannot encode video.");
  for (const codec of CODECS) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate: BITRATE, framerate: SLIDESHOW_FPS };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported) return config;
  }
  throw new Error("No H.264 video encoder is available on this PC.");
}

async function pickAudioConfig(): Promise<AudioEncoderConfig> {
  if (typeof AudioEncoder === "undefined") throw new Error("This version of the app's web view cannot encode audio.");
  const config: AudioEncoderConfig = { codec: AUDIO_CODEC, sampleRate: MUSIC_SAMPLE_RATE, numberOfChannels: 2, bitrate: AUDIO_BITRATE };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error("No AAC audio encoder is available on this PC, so the video cannot have music.");
  return config;
}

/**
 * Encodes `seconds` of the music, from its chosen start, into the MP4's audio
 * track. A mono track plays on both sides; past the end of the track is silence.
 */
async function encodeMusic(muxer: Muxer<ArrayBufferTarget>, music: SlideshowMusic, config: AudioEncoderConfig, seconds: number) {
  let failure: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => { failure = error instanceof Error ? error : new Error(String(error)); }
  });
  encoder.configure(config);
  const rate = MUSIC_SAMPLE_RATE;
  const { buffer } = music;
  const first = Math.max(0, Math.round(music.start * rate));
  const total = Math.round(seconds * rate);
  const available = Math.max(0, Math.min(total, buffer.length - first));
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let at = 0; at < total; at += AUDIO_CHUNK) {
    if (failure) throw failure;
    const count = Math.min(AUDIO_CHUNK, total - at);
    /** Planar: the left samples, then the right ones. */
    const data = new Float32Array(count * 2);
    for (let index = 0; index < count; index++) {
      const frame = at + index;
      if (frame >= available) break;
      const gain = musicGain(frame / rate, seconds, available / rate);
      data[index] = left[first + frame] * gain;
      data[count + index] = right[first + frame] * gain;
    }
    const audio = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: count, numberOfChannels: 2, timestamp: Math.round((at / rate) * 1_000_000), data });
    encoder.encode(audio);
    audio.close();
    while (encoder.encodeQueueSize > 16) await new Promise((resolve) => setTimeout(resolve, 4));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
}

/** Draws a stage name in a dark rounded box at the top center, one margin below the top edge. */
function drawLabel(context: CanvasRenderingContext2D, name: string, alpha: number, width: number, height: number) {
  if (alpha <= 0 || !name) return;
  const size = Math.max(14, Math.round(height * 0.034));
  const pad = Math.round(size * 0.55);
  const margin = Math.round(height * 0.04);
  context.save();
  context.globalAlpha = alpha;
  context.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
  context.textBaseline = "middle";
  const text = context.measureText(name).width > width * 0.8 ? `${name.slice(0, 60)}…` : name;
  const textWidth = Math.min(context.measureText(text).width, width - margin * 2 - pad * 2);
  const boxHeight = size + pad * 1.4;
  const boxWidth = textWidth + pad * 2;
  const left = (width - boxWidth) / 2;
  const top = margin;
  context.fillStyle = "rgba(10, 12, 18, 0.62)";
  context.beginPath();
  context.roundRect(left, top, boxWidth, boxHeight, Math.round(size * 0.35));
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillText(text, left + pad, top + boxHeight / 2, textWidth);
  context.restore();
}

/** The app icon, cut at its right at the last visible pixel, so the space after it is only the column gap. */
const loadIcon = () => new Promise<HTMLCanvasElement | null>((resolve) => {
  const image = new Image();
  image.onload = () => {
    const full = document.createElement("canvas");
    full.width = image.naturalWidth;
    full.height = image.naturalHeight;
    const fullContext = full.getContext("2d", { willReadFrequently: true })!;
    fullContext.drawImage(image, 0, 0);
    const pixels = fullContext.getImageData(0, 0, full.width, full.height).data;
    let right = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 16) right = Math.max(right, ((index - 3) / 4) % full.width);
    }
    const cut = document.createElement("canvas");
    cut.width = right + 1;
    cut.height = full.height;
    cut.getContext("2d")!.drawImage(full, 0, 0);
    resolve(cut);
  };
  image.onerror = () => resolve(null);
  image.src = "/app-icon.png";
});

/** Splits `text` into lines no wider than `maxWidth` in the context's current font, breaking between words. */
function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The overlay at the start and the end of the video: a dark rounded box in
 * the middle with the title, which wraps onto more lines when it is long, and
 * under it a bordered credit box. The credit box has the app icon in a left
 * column and two lines in a right column: "made with Image Sage™" (the name
 * in bright blue, the ™ small) and a small "Image Sage v0.3 - Robert Mirabelle". The credit lines never wrap or
 * shrink. The rest of the canvas stays clear, so the image shows around it.
 * Sizes are in hundredths of the video height.
 */
async function introOverlay(width: number, height: number, title: string) {
  const card = document.createElement("canvas");
  card.width = width;
  card.height = height;
  const context = card.getContext("2d")!;
  const unit = height / 100;
  const font = (size: number, weight: number) => `${weight} ${Math.round(size * unit)}px "Segoe UI", system-ui, sans-serif`;
  /** The version as major.minor ("0.3"), or nothing when the app cannot tell. */
  const version = await getAppVersion().then((full) => full.split(".").slice(0, 2).join(".")).catch(() => "");
  const icon = await loadIcon();
  const credit = `Image Sage${version ? ` v${version}` : ""} - Robert Mirabelle`;
  const TITLE = 6, MADE = 2.2, CREDIT = 1.25, ICON = 5.6, LINE = 1.3;
  /** The trademark sign is this much smaller than its line, and raised. */
  const TM_SCALE = 0.5;
  const measure = (text: string, size: number, weight: number) => {
    context.font = font(size, weight);
    return context.measureText(text).width;
  };
  /** "made with Image Sage™" in three runs: plain, the name in bright blue, and a small raised ™. */
  const madeRuns = [
    { text: "made with ", size: MADE, color: "#c3d0fc", raise: 0 },
    { text: "Image Sage", size: MADE, color: "#a9ddf8", raise: 0 },
    { text: "™", size: MADE * TM_SCALE, color: "#a9ddf8", raise: MADE * 0.32 }
  ];
  const madeWidth = madeRuns.reduce((sum, run) => sum + measure(run.text, run.size, 600), 0);

  /** The credit box: the icon at the left, the two lines at the right, centered on each other. */
  /** Tighter at the left, top and bottom, around the icon; the right keeps room after the text. */
  const creditPadLeft = (icon ? 1.1 : 2) * unit;
  const creditPadRight = 2 * unit;
  const creditPadY = 1.1 * unit;
  const iconSize = icon ? ICON * unit : 0;
  /** The cut icon keeps its height, so it is narrower than it is tall. */
  const iconWidth = icon ? iconSize * (icon.width / icon.height) : 0;
  const columnGap = icon ? 1 * unit : 0;
  const linesGap = 0.5 * unit;
  const linesHeight = MADE * LINE * unit + linesGap + CREDIT * LINE * unit;
  const linesWidth = Math.max(madeWidth, measure(credit, CREDIT, 500));
  const creditWidth = creditPadLeft + iconWidth + columnGap + linesWidth + creditPadRight;
  const creditHeight = Math.max(iconSize, linesHeight) + creditPadY * 2;

  /** The title wraps to stay within most of the video width; it is never narrower than the credit box needs. */
  context.font = font(TITLE, 750);
  const titleLines = title.trim() ? wrapLines(context, `“${title.trim()}”`, Math.max(width * 0.7, creditWidth)) : [];
  const titleLineHeight = TITLE * LINE * unit;
  const titleHeight = titleLines.length * titleLineHeight;
  const titleWidth = Math.max(0, ...titleLines.map((line) => context.measureText(line).width));
  const titleGap = titleLines.length ? 3.5 * unit : 0;
  const padX = 5 * unit;
  const padY = 4 * unit;
  const boxWidth = Math.max(titleWidth, creditWidth) + padX * 2;
  const boxHeight = titleHeight + titleGap + creditHeight + padY * 2;
  const top = (height - boxHeight) / 2;
  const center = width / 2;
  context.fillStyle = "rgba(10, 12, 18, 0.74)";
  context.beginPath();
  context.roundRect(center - boxWidth / 2, top, boxWidth, boxHeight, 2 * unit);
  context.fill();

  context.textBaseline = "middle";
  let y = top + padY;
  context.textAlign = "center";
  context.font = font(TITLE, 750);
  context.fillStyle = "#ffffff";
  for (const line of titleLines) {
    context.fillText(line, center, y + titleLineHeight / 2);
    y += titleLineHeight;
  }
  y += titleGap;

  const creditLeft = center - creditWidth / 2;
  context.strokeStyle = "rgba(195, 208, 252, 0.45)";
  /** A one-pixel line on the half pixel covers exactly one pixel row, so it stays sharp. */
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(Math.round(creditLeft) + 0.5, Math.round(y) + 0.5, Math.round(creditWidth), Math.round(creditHeight), 1.2 * unit);
  context.stroke();
  const middle = y + creditHeight / 2;
  if (icon) context.drawImage(icon, creditLeft + creditPadLeft, middle - iconSize / 2, iconWidth, iconSize);
  const textLeft = creditLeft + creditPadLeft + iconWidth + columnGap;
  let lineTop = middle - linesHeight / 2;
  context.textAlign = "left";
  let x = textLeft;
  for (const run of madeRuns) {
    context.font = font(run.size, 600);
    context.fillStyle = run.color;
    context.fillText(run.text, x, lineTop + (MADE * LINE * unit) / 2 - run.raise * unit);
    x += context.measureText(run.text).width;
  }
  lineTop += MADE * LINE * unit + linesGap;
  context.font = font(CREDIT, 500);
  context.fillStyle = "#8a91a3";
  context.fillText(credit, textLeft, lineTop + (CREDIT * LINE * unit) / 2);
  return card;
}

export async function encodeSlideshow(
  stages: HTMLCanvasElement[],
  names: (string | null)[],
  options: SlideshowOptions,
  onProgress: (fraction: number) => void
): Promise<Blob> {
  const { width, height } = stages[0];
  const pictures = stages;
  const overlay = await introOverlay(width, height, options.title);
  const segments = slideshowSegments(stages.length, true, options.layerSeconds);
  const config = await pickCodec(width, height);
  const audioConfig = options.music ? await pickAudioConfig() : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: SLIDESHOW_FPS },
    ...(audioConfig ? { audio: { codec: "aac" as const, numberOfChannels: 2, sampleRate: MUSIC_SAMPLE_RATE } } : {}),
    fastStart: "in-memory"
  });
  if (options.music && audioConfig) await encodeMusic(muxer, options.music, audioConfig, slideshowDuration(segments));
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => { failure = error instanceof Error ? error : new Error(String(error)); }
  });
  encoder.configure(config);

  const frame = document.createElement("canvas");
  frame.width = width;
  frame.height = height;
  const context = frame.getContext("2d")!;
  const total = slideshowFrameCount(segments);
  const microseconds = 1_000_000 / SLIDESHOW_FPS;
  for (let index = 0; index < total; index++) {
    if (failure) throw failure;
    const shot = slideshowFrame(segments, index / SLIDESHOW_FPS);
    context.globalAlpha = 1;
    context.drawImage(pictures[shot.mix >= 1 ? shot.to : shot.from], 0, 0);
    if (shot.mix > 0 && shot.mix < 1 && shot.to !== shot.from) {
      context.globalAlpha = shot.mix;
      context.drawImage(pictures[shot.to], 0, 0);
      context.globalAlpha = 1;
    }
    if (shot.label !== null) drawLabel(context, shot.label === "final" ? "Final image" : names[shot.label] ?? "", shot.labelAlpha, width, height);
    if (shot.overlay > 0) {
      context.globalAlpha = shot.overlay;
      context.drawImage(overlay, 0, 0);
      context.globalAlpha = 1;
    }
    if (shot.black > 0) {
      context.fillStyle = `rgba(0, 0, 0, ${shot.black})`;
      context.fillRect(0, 0, width, height);
    }
    const videoFrame = new VideoFrame(frame, { timestamp: Math.round(index * microseconds), duration: Math.round(microseconds) });
    encoder.encode(videoFrame, { keyFrame: index % KEY_FRAME_EVERY === 0 });
    videoFrame.close();
    /** Waits while the encoder is behind, so frames do not pile up in memory. */
    while (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 4));
    if (index % SLIDESHOW_FPS === 0) onProgress(index / total);
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  muxer.finalize();
  onProgress(1);
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}
