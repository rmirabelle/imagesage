import { describe, expect, it } from "vitest";
import {
  FADE_OUT,
  FINAL_FADE,
  FINAL_HOLD,
  FINAL_LABEL,
  FINAL_REST,
  FLASH,
  FLASHES,
  INTRO_FADE,
  LABEL_FADE,
  LABEL_LEAD,
  LABEL_PAUSE,
  LAYER_FADE,
  LAYER_STEP,
  MUSIC_FADE_IN,
  OPEN_PAUSE,
  OPEN_HOLD,
  OPEN_REST,
  RETURN_FADE,
  RETURN_STEP,
  OVERLAY_FADE,
  STEP,
  musicGain,
  slideshowDuration,
  slideshowFrame,
  slideshowSegments,
  videoSize
} from "./slideshow";

describe("slideshow", () => {
  it("fits the video inside 1080p with even sides", () => {
    expect(videoSize(4000, 2000)).toEqual({ width: 1920, height: 960 });
    expect(videoSize(1001, 667)).toEqual({ width: 1002, height: 668 });
    expect(videoSize(1000, 3000)).toEqual({ width: 360, height: 1080 });
  });

  it("lasts one step per picture, then the final image's long hold and the fade", () => {
    expect(slideshowDuration(slideshowSegments(1, false))).toBe(FINAL_HOLD + FADE_OUT);
    expect(slideshowDuration(slideshowSegments(4, false))).toBeCloseTo(STEP + LAYER_STEP * 3 + RETURN_STEP + FINAL_HOLD + FADE_OUT);
    expect(slideshowDuration(slideshowSegments(4, true))).toBeCloseTo(OPEN_PAUSE + OPEN_HOLD + OPEN_REST + STEP + LAYER_STEP * 3 + RETURN_STEP + FINAL_HOLD + FADE_OUT);
  });

  it("starts with the original image, named, without an intro", () => {
    expect(slideshowFrame(slideshowSegments(4, false), 1)).toEqual({ from: 0, to: 0, mix: 1, label: 0, labelAlpha: 1, overlay: 0, black: 0 });
  });

  it("fades each layer's name in first, then flashes the layer, then fades it in", () => {
    const segments = slideshowSegments(4, false);
    const naming = slideshowFrame(segments, STEP + LABEL_FADE / 2);
    expect(naming).toMatchObject({ from: 0, to: 1, mix: 0, label: 1 });
    expect(naming.labelAlpha).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, STEP + LABEL_FADE + LABEL_PAUSE / 2)).toMatchObject({ mix: 0, labelAlpha: 1 });
    const flashStart = STEP + LABEL_LEAD;
    for (let flash = 0; flash < FLASHES; flash++) {
      expect(slideshowFrame(segments, flashStart + FLASH * (flash * 2 + 0.5))).toMatchObject({ mix: 1, labelAlpha: 1 });
      expect(slideshowFrame(segments, flashStart + FLASH * (flash * 2 + 1.5))).toMatchObject({ mix: 0, labelAlpha: 1 });
    }
    const fadeStart = flashStart + FLASH * 2 * FLASHES;
    expect(slideshowFrame(segments, fadeStart + LAYER_FADE / 2).mix).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, fadeStart + LAYER_FADE + 1)).toMatchObject({ from: 0, to: 1, mix: 1, label: 1, labelAlpha: 1 });
    expect(slideshowFrame(segments, STEP + LAYER_STEP * 2 - 0.5)).toMatchObject({ from: 1, to: 2, mix: 1, label: 2, labelAlpha: 1 });
  });

  it("shows the top layer, the original image again through black, then fades the final image in, holds it, and fades to black", () => {
    const segments = slideshowSegments(4, false);
    expect(slideshowFrame(segments, STEP + LAYER_STEP * 3 - 0.5)).toMatchObject({ from: 2, to: 3, mix: 1, label: 3, labelAlpha: 1 });
    const top = STEP + LAYER_STEP * 3;
    const goingDark = slideshowFrame(segments, top + RETURN_FADE / 4);
    expect(goingDark).toMatchObject({ from: 3, to: 0, mix: 0, label: 3, labelAlpha: 1 });
    expect(goingDark.black).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, top + RETURN_FADE / 2).black).toBeCloseTo(1);
    const comingIn = slideshowFrame(segments, top + RETURN_FADE * 0.75);
    expect(comingIn).toMatchObject({ to: 0, mix: 1, label: 0 });
    expect(comingIn.black).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, top + RETURN_FADE + 1)).toMatchObject({ to: 0, mix: 1, label: 0, labelAlpha: 1, black: 0 });
    expect(slideshowFrame(segments, top + RETURN_STEP - 0.01).labelAlpha).toBeLessThan(0.1);
    const final = top + RETURN_STEP;
    const revealing = slideshowFrame(segments, final + FINAL_FADE / 2);
    expect(revealing).toMatchObject({ from: 0, to: 3, label: "final", black: 0 });
    expect(revealing.mix).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, final + FINAL_FADE + FINAL_LABEL - 0.1)).toMatchObject({ to: 3, mix: 1, label: "final", labelAlpha: 1, black: 0 });
    expect(slideshowFrame(segments, final + FINAL_FADE + FINAL_LABEL + 0.25).labelAlpha).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, final + FINAL_HOLD - 1)).toMatchObject({ to: 3, mix: 1, labelAlpha: 0, overlay: 0, black: 0 });
    expect(slideshowFrame(segments, slideshowDuration(segments) - FADE_OUT / 2).black).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, slideshowDuration(segments)).black).toBe(1);
  });

  it("with an intro, opens on the final image itself, then the overlay, then fades to the original", () => {
    const segments = slideshowSegments(4, true);
    expect(slideshowFrame(segments, 0)).toMatchObject({ from: 3, to: 3, mix: 1, label: null, overlay: 0, black: 0 });
    expect(slideshowFrame(slideshowSegments(1, true), 0)).toMatchObject({ to: 0, mix: 1, black: 0 });
    expect(slideshowFrame(segments, OPEN_PAUSE / 2)).toMatchObject({ to: 3, overlay: 0, black: 0 });
    expect(slideshowFrame(segments, OPEN_PAUSE + OVERLAY_FADE + 1)).toMatchObject({ to: 3, mix: 1, overlay: 1, black: 0 });
    expect(slideshowFrame(segments, OPEN_PAUSE + OPEN_HOLD - OVERLAY_FADE / 2).overlay).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, OPEN_PAUSE + OPEN_HOLD + OPEN_REST - 0.1)).toMatchObject({ to: 3, mix: 1, overlay: 0, black: 0 });
    const toOriginal = slideshowFrame(segments, OPEN_PAUSE + OPEN_HOLD + OPEN_REST + INTRO_FADE / 2);
    expect(toOriginal).toMatchObject({ from: 3, to: 0, label: 0, overlay: 0 });
    expect(toOriginal.mix).toBeCloseTo(0.5);
  });

  it("fades the music in at the start and out with the picture, or when the track runs out", () => {
    expect(musicGain(0, 60, 200)).toBe(0);
    expect(musicGain(MUSIC_FADE_IN / 2, 60, 200)).toBeCloseTo(0.5);
    expect(musicGain(30, 60, 200)).toBe(1);
    expect(musicGain(60 - FADE_OUT / 2, 60, 200)).toBeCloseTo(0.5);
    expect(musicGain(60, 60, 200)).toBe(0);
    expect(musicGain(40 - FADE_OUT / 2, 60, 40)).toBeCloseTo(0.5);
    expect(musicGain(45, 60, 40)).toBe(0);
  });

  it("with an intro, shows the overlay again after the final image rests", () => {
    const segments = slideshowSegments(4, true);
    const final = OPEN_PAUSE + OPEN_HOLD + OPEN_REST + STEP + LAYER_STEP * 3 + RETURN_STEP;
    expect(slideshowFrame(segments, final + FINAL_FADE + FINAL_REST - 0.1).overlay).toBe(0);
    expect(slideshowFrame(segments, final + FINAL_FADE + FINAL_REST + OVERLAY_FADE + 1)).toMatchObject({ to: 3, label: "final", overlay: 1 });
    expect(slideshowFrame(segments, slideshowDuration(segments) - 0.1).overlay).toBe(1);
  });
});
