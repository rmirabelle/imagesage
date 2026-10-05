import { describe, expect, it } from "vitest";
import {
  exceedsWholeImageLimits,
  fitWithinWholeImageLimits,
  validateGenerateSize,
  wholeImageSize
} from "./region";

describe("generate size validation", () => {
  it("accepts presets and rejects illegal sizes", () => {
    expect(validateGenerateSize(1024, 1024)).toBeNull();
    expect(validateGenerateSize(2560, 1440)).toBeNull();
    expect(validateGenerateSize(1000, 1000)).toMatch(/multiples of 16/);
    expect(validateGenerateSize(800, 800)).toMatch(/at least/);
    expect(validateGenerateSize(3840, 1024)).toMatch(/aspect/);
  });
});

describe("whole-image size", () => {
  it("keeps a legal size as it is", () => {
    expect(wholeImageSize(1536, 1024)).toEqual({ width: 1536, height: 1024, scaled: false });
  });

  it("brings other sizes to the nearest legal size with the same shape", () => {
    const large = wholeImageSize(6000, 4000)!;
    expect(large.scaled).toBe(true);
    expect(large.width % 16).toBe(0);
    expect(large.width * large.height).toBeLessThanOrEqual(8_294_400);
    expect(Math.abs(large.width / large.height - 1.5)).toBeLessThan(0.02);
    const odd = wholeImageSize(1000, 750)!;
    expect(odd.width % 16 + odd.height % 16).toBe(0);
    expect(odd.width * odd.height).toBeGreaterThanOrEqual(655_360);
  });

  it("refuses shapes wider than 3:1", () => {
    expect(wholeImageSize(4000, 1000)).toBeNull();
  });

  it("flags opened images over the limits and fits them inside", () => {
    expect(exceedsWholeImageLimits(6000, 4000)).toBe(true);
    expect(exceedsWholeImageLimits(2560, 1440)).toBe(false);
    const fit = fitWithinWholeImageLimits(6000, 4000);
    expect(fit.width * fit.height).toBeLessThanOrEqual(8_294_400);
    expect(Math.max(fit.width, fit.height)).toBeLessThanOrEqual(3840);
  });
});
