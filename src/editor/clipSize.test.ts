import { describe, expect, it } from "vitest";
import { CLIP_QUALITIES, CLIP_SECONDS, clipFrames, clipSize } from "./clipSize";

const [small, large] = CLIP_QUALITIES;

describe("video clip sizes", () => {
  it("keeps the standard 16:9 large size", () => {
    expect(clipSize(1920, 1080, large.pixels)).toEqual({ width: 1280, height: 720 });
    expect(clipSize(1080, 1920, large.pixels)).toEqual({ width: 720, height: 1280 });
  });

  it("uses multiples of 16 within the area, with the same shape", () => {
    for (const quality of [small, large]) {
      for (const [width, height] of [[1920, 1080], [1024, 1024], [1536, 1024], [832, 1248], [300, 200], [4096, 1400]]) {
        const size = clipSize(width, height, quality.pixels)!;
        expect(size.width % 16).toBe(0);
        expect(size.height % 16).toBe(0);
        expect(size.width * size.height).toBeLessThanOrEqual(quality.pixels);
        expect(size.width * size.height).toBeGreaterThan(quality.pixels * 0.85);
        expect(Math.abs(size.width / size.height / (width / height) - 1)).toBeLessThan(0.03);
      }
    }
  });

  it("refuses shapes wider or taller than 3:1", () => {
    expect(clipSize(4000, 1000, small.pixels)).toBeNull();
    expect(clipSize(1000, 4000, small.pixels)).toBeNull();
    expect(clipSize(0, 100, small.pixels)).toBeNull();
  });

  it("makes lengths that are a multiple of 4 pictures, plus 1", () => {
    expect(CLIP_SECONDS.map(clipFrames)).toEqual([33, 49, 81]);
  });
});
