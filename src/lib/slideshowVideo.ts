import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { SLIDESHOW_FPS, slideshowFrame, slideshowFrameCount, slideshowSegments } from "../editor/slideshow";

/** What the intro card says; empty fields are left out. */
export interface SlideshowIntro {
  title: string;
  author: string;
  /** One link per line. */
  links: string;
}

/**
 * Encodes the video slideshow as an H.264 MP4, with the webview's own video
 * encoder (WebCodecs) and `mp4-muxer` (MIT). It runs faster than real time.
 * `stages` are the pictures at video size: the original image, then the
 * image after each visible layer; `names` label them (the first has none).
 * With `intro`, an intro card made from the finished image opens the video.
 */
const BITRATE = 10_000_000;
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

/** Draws a stage name in a dark rounded box in the lower left. */
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
  const top = height - margin - boxHeight;
  context.fillStyle = "rgba(10, 12, 18, 0.62)";
  context.beginPath();
  context.roundRect(margin, top, textWidth + pad * 2, boxHeight, Math.round(size * 0.35));
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillText(text, margin + pad, top + boxHeight / 2, textWidth);
  context.restore();
}

const loadIcon = () => new Promise<HTMLImageElement | null>((resolve) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => resolve(null);
  image.src = "/icon.ico";
});

/**
 * The intro card: the finished image, blurred and darkened, with the title,
 * the author, "Made with ImageSage" and the app icon, and the links, centered.
 */
async function introCard(finished: HTMLCanvasElement, intro: SlideshowIntro) {
  const { width, height } = finished;
  const card = document.createElement("canvas");
  card.width = width;
  card.height = height;
  const context = card.getContext("2d")!;
  const blur = Math.round(height * 0.025);
  /** The blurred copy is drawn a little larger, so its soft edges stay outside the card. */
  context.filter = `blur(${blur}px)`;
  context.drawImage(finished, -blur * 2, -blur * 2, width + blur * 4, height + blur * 4);
  context.filter = "none";
  context.fillStyle = "rgba(8, 10, 15, 0.72)";
  context.fillRect(0, 0, width, height);

  const unit = height / 100;
  const font = (size: number, weight: number) => `${weight} ${Math.round(size * unit)}px "Segoe UI", system-ui, sans-serif`;
  const links = intro.links.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lines: { text: string; size: number; weight: number; color: string; gapBefore: number; icon?: boolean }[] = [
    ...(intro.title.trim() ? [{ text: intro.title.trim(), size: 7, weight: 750, color: "#ffffff", gapBefore: 0 }] : []),
    ...(intro.author.trim() ? [{ text: intro.author.trim(), size: 3.6, weight: 500, color: "#d9dce3", gapBefore: 2 }] : []),
    { text: "Made with ImageSage", size: 2.8, weight: 600, color: "#c3d0fc", gapBefore: 6, icon: true },
    ...links.map((link, index) => ({ text: link, size: 2.5, weight: 500, color: "#a9ddf8", gapBefore: index === 0 ? 3 : 1 }))
  ];
  const total = lines.reduce((sum, line) => sum + (line.gapBefore + line.size * 1.3) * unit, 0);
  let y = (height - total) / 2;
  const icon = await loadIcon();
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const line of lines) {
    y += line.gapBefore * unit;
    const lineHeight = line.size * 1.3 * unit;
    const middle = y + lineHeight / 2;
    context.font = font(line.size, line.weight);
    context.fillStyle = line.color;
    const maxWidth = width * 0.86;
    if (line.icon && icon) {
      const iconSize = Math.round(line.size * 1.5 * unit);
      const gap = Math.round(iconSize * 0.4);
      const textWidth = Math.min(context.measureText(line.text).width, maxWidth - iconSize - gap);
      const left = (width - iconSize - gap - textWidth) / 2;
      context.drawImage(icon, left, middle - iconSize / 2, iconSize, iconSize);
      context.textAlign = "left";
      context.fillText(line.text, left + iconSize + gap, middle, textWidth);
      context.textAlign = "center";
    } else {
      context.fillText(line.text, width / 2, middle, maxWidth);
    }
    y += lineHeight;
  }
  return card;
}

export async function encodeSlideshow(
  stages: HTMLCanvasElement[],
  names: (string | null)[],
  intro: SlideshowIntro | null,
  onProgress: (fraction: number) => void
): Promise<Blob> {
  const { width, height } = stages[0];
  /** The intro card is the last picture: after the original image and every layer. */
  const pictures = intro ? [...stages, await introCard(stages[stages.length - 1], intro)] : stages;
  const segments = slideshowSegments(stages.length, intro !== null);
  const config = await pickCodec(width, height);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: SLIDESHOW_FPS },
    fastStart: "in-memory"
  });
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
    if (shot.label !== null) drawLabel(context, names[shot.label] ?? "", shot.labelAlpha, width, height);
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
