import { describe, expect, it } from "vitest";
import {
  FADE_OUT,
  FINAL_HOLD,
  INTRO_CARD,
  INTRO_FADE,
  INTRO_FINAL_HOLD,
  STEP,
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

  it("lasts one step per layer, then the hold and the fade", () => {
    expect(slideshowDuration(slideshowSegments(1, false))).toBe(FINAL_HOLD + FADE_OUT);
    expect(slideshowDuration(slideshowSegments(4, false))).toBe(STEP * 3 + FINAL_HOLD + FADE_OUT);
    expect(slideshowDuration(slideshowSegments(4, true))).toBe(INTRO_CARD + INTRO_FADE + INTRO_FINAL_HOLD + STEP * 3 + FINAL_HOLD + FADE_OUT);
  });

  it("starts with the original image alone and no name", () => {
    expect(slideshowFrame(slideshowSegments(4, false), 1)).toEqual({ from: 0, to: 0, mix: 1, label: null, labelAlpha: 0, black: 0 });
  });

  it("fades each layer in with its name", () => {
    const segments = slideshowSegments(4, false);
    const fading = slideshowFrame(segments, STEP + 0.25);
    expect(fading).toMatchObject({ from: 0, to: 1, label: 1 });
    expect(fading.mix).toBeCloseTo(0.5);
    expect(fading.labelAlpha).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, STEP * 2 + 2)).toMatchObject({ from: 1, to: 2, mix: 1, label: 2, labelAlpha: 1 });
  });

  it("holds the top layer, drops its name, then fades to black", () => {
    const segments = slideshowSegments(4, false);
    const top = STEP * 3;
    expect(slideshowFrame(segments, top + 1).labelAlpha).toBe(1);
    expect(slideshowFrame(segments, top + STEP + 1).labelAlpha).toBe(0);
    expect(slideshowFrame(segments, top + 5)).toMatchObject({ to: 3, mix: 1, black: 0 });
    expect(slideshowFrame(segments, slideshowDuration(segments) - FADE_OUT / 2).black).toBeCloseTo(0.5);
    expect(slideshowFrame(segments, slideshowDuration(segments)).black).toBe(1);
  });

  it("opens with the intro card, fades to the finished image, then to the original", () => {
    const segments = slideshowSegments(4, true);
    expect(slideshowFrame(segments, 1)).toMatchObject({ to: 4, mix: 1, label: null });
    const toFinal = slideshowFrame(segments, INTRO_CARD + INTRO_FADE / 2);
    expect(toFinal).toMatchObject({ from: 4, to: 3, label: null });
    expect(toFinal.mix).toBeCloseTo(0.5);
    const toOriginal = slideshowFrame(segments, INTRO_CARD + INTRO_FADE + INTRO_FINAL_HOLD + INTRO_FADE / 2);
    expect(toOriginal).toMatchObject({ from: 3, to: 0, label: null });
    expect(toOriginal.mix).toBeCloseTo(0.5);
  });
});
