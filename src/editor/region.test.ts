import { describe, expect, it } from "vitest";
import {
  blendMasked,
  blendSelection,
  clampSelection,
  driftOffset,
  fluxEditPrompt,
  GPT_MAX_SQUARE,
  GPT_MIN_SQUARE,
  gptRegionPrompt,
  gptSquareSide,
  selectionAlpha,
  spillAlpha,
  isDownscaled,
  marginFor,
  maskBounds,
  pickResolution,
  planRegion,
  selectionBox,
  squareAround,
  squareRegion,
  validateGenerateSize,
  wholeImageSize,
  exceedsWholeImageLimits,
  fitWithinWholeImageLimits,
  type RegionOptions
} from "./region";

const OPTIONS: RegionOptions = { minMargin: 10, marginRatio: 0.04, maxResolution: "2k" };
const NO_EDGES = { left: false, top: false, right: false, bottom: false };

const solid = (width: number, height: number, rgb: [number, number, number]) => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([...rgb, 255], index);
  return pixels;
};

describe("margin and square region", () => {
  it("uses at least the minimum margin and grows with large selections", () => {
    expect(marginFor(100, OPTIONS)).toBe(10);
    expect(marginFor(1000, OPTIONS)).toBe(40);
  });

  it("grows the selection on every side away from the image edges", () => {
    expect(squareRegion({ x: 100, y: 100, size: 200 }, 1000, 1000, 10)).toEqual({ x: 90, y: 90, width: 220, height: 220 });
  });

  it("shifts inward at image edges so the region stays square", () => {
    expect(squareRegion({ x: 0, y: 0, size: 200 }, 1000, 1000, 10)).toEqual({ x: 0, y: 0, width: 220, height: 220 });
    expect(squareRegion({ x: 800, y: 800, size: 200 }, 1000, 1000, 10)).toEqual({ x: 780, y: 780, width: 220, height: 220 });
  });

  it("shrinks only when the image is too small, and still contains the selection", () => {
    const region = squareRegion({ x: 0, y: 400, size: 200 }, 200, 1000, 10);
    expect(region).toEqual({ x: 0, y: 400, width: 200, height: 200 });
  });
});

describe("FLUX 3 output size", () => {
  it("picks the smallest size that covers the region", () => {
    expect(pickResolution(600, "2k").id).toBe("1k");
    expect(pickResolution(1300, "2k").id).toBe("1.5k");
    expect(pickResolution(1800, "4k").id).toBe("2k");
  });

  it("never exceeds the user's limit", () => {
    expect(pickResolution(3000, "1.5k").id).toBe("1.5k");
  });

  it("flags plans whose output is smaller than the region", () => {
    expect(isDownscaled(planRegion({ x: 0, y: 0, size: 3000 }, 4000, 4000, OPTIONS))).toBe(true);
    expect(isDownscaled(planRegion({ x: 100, y: 100, size: 300 }, 4000, 4000, OPTIONS))).toBe(false);
  });
});

describe("target box and prompt", () => {
  it("places the selection inside the square on a 0-1000 scale as [y0, x0, y1, x1]", () => {
    const sent = planRegion({ x: 100, y: 200, size: 200 }, 1000, 1000, { ...OPTIONS, minMargin: 100, marginRatio: 0 });
    expect(sent).toMatchObject({ x: 0, y: 100, width: 400 });
    expect(selectionBox({ x: 100, y: 200, size: 200 }, sent)).toEqual([250, 250, 750, 750]);
  });

  it("names the box and appends the documented box list", () => {
    const prompt = fluxEditPrompt("  add a red kite  ", [250, 250, 750, 750]);
    expect(prompt).toContain("In <ref_image_0>, edit <edit_region> in place: add a red kite");
    const rows = JSON.parse(prompt.slice(prompt.indexOf("[{")));
    expect(rows[0]).toEqual({
      id: "edit_region",
      from: "ref_image_0",
      src_bbox: [250, 250, 750, 750],
      tgt_bbox: [250, 250, 750, 750],
      kind: "new",
      desc: "the existing area of the image, changed as follows: add a red kite"
    });
    expect(rows.slice(1).map((row: { id: string; kind: string }) => `${row.id}:${row.kind}`))
      .toEqual(["context_above:anchor", "context_below:anchor", "context_left:anchor", "context_right:anchor"]);
  });

  it("starts with the scene caption and uses clean scene anchors", () => {
    const prompt = fluxEditPrompt("add a chair", [400, 400, 600, 600], {
      caption: "A cabin at night.",
      anchors: [
        { id: "Cabin 1", bbox: [100, 600, 500, 950], desc: "a log cabin" },
        { id: "inside", bbox: [450, 450, 550, 550], desc: "wholly inside the edit box" },
        { id: "cabin_1", bbox: [0, 0, 5, 5], desc: "too small" },
        { id: "cabin_1", bbox: [700, 0, 1000, 1000], desc: "the lawn" }
      ]
    });
    expect(prompt.startsWith("A cabin at night. In <ref_image_0>")).toBe(true);
    expect(prompt).toContain("including <cabin_1>, <cabin_1_2>.");
    const rows = JSON.parse(prompt.slice(prompt.indexOf("[{")));
    expect(rows.map((row: { id: string }) => row.id)).toEqual(["edit_region", "cabin_1", "cabin_1_2"]);
  });
});
describe("generate size validation", () => {
  it("accepts presets and rejects illegal sizes", () => {
    expect(validateGenerateSize(1024, 1024)).toBeNull();
    expect(validateGenerateSize(2560, 1440)).toBeNull();
    expect(validateGenerateSize(1000, 1000)).toMatch(/multiples of 16/);
    expect(validateGenerateSize(800, 800)).toMatch(/at least/);
    expect(validateGenerateSize(3840, 1024)).toMatch(/aspect/);
  });
});

describe("selection clamping", () => {
  it("keeps the square inside the image", () => {
    expect(clampSelection({ x: 950, y: -20, size: 100 }, 1000, 800)).toEqual({ x: 900, y: 0, size: 100 });
    expect(clampSelection({ x: 0, y: 0, size: 5000 }, 1000, 800)).toEqual({ x: 0, y: 0, size: 800 });
  });
});

describe("blending", () => {
  const width = 20;
  const height = 20;
  const inner = { x: 5, y: 5, width: 10, height: 10 };

  it("measures color drift from the margin ring only", () => {
    const original = solid(width, height, [100, 100, 100]);
    const result = solid(width, height, [110, 95, 100]);
    expect(driftOffset(original, result, width, height, inner)).toEqual([-10, 5, 0]);
  });

  it("corrects drift and keeps the selection center fully replaced", () => {
    const original = solid(width, height, [100, 100, 100]);
    const result = solid(width, height, [110, 110, 110]);
    for (let y = inner.y; y < inner.y + inner.height; y++) {
      for (let x = inner.x; x < inner.x + inner.width; x++) result.set([210, 60, 110, 255], (y * width + x) * 4);
    }
    const blended = blendSelection(original, result, width, height, inner, NO_EDGES, { feather: 3, driftCorrection: true });
    const center = (5 * inner.width + 5) * 4;
    expect(Array.from(blended.slice(center, center + 3))).toEqual([200, 50, 100]);
  });

  it("feathers inner edges toward the original", () => {
    const original = solid(width, height, [0, 0, 0]);
    const result = solid(width, height, [200, 200, 200]);
    const blended = blendSelection(original, result, width, height, inner, NO_EDGES, { feather: 4, driftCorrection: false });
    const edge = blended[0];
    const center = blended[(5 * inner.width + 5) * 4];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(60);
    expect(center).toBe(200);
  });

  it("does not feather sides that touch the image border", () => {
    const original = solid(width, height, [0, 0, 0]);
    const result = solid(width, height, [200, 200, 200]);
    const blended = blendSelection(original, result, width, height, inner, { ...NO_EDGES, left: true, top: true }, { feather: 4, driftCorrection: false });
    expect(blended[0]).toBe(200);
  });
});

describe("brush mask", () => {
  it("finds the painted area and ignores erase strokes", () => {
    const strokes = [
      { radius: 10, erase: false, points: [[100, 100], [200, 120]] as [number, number][] },
      { radius: 50, erase: true, points: [[500, 500]] as [number, number][] }
    ];
    expect(maskBounds(strokes, 1000, 1000)).toEqual({ x: 90, y: 90, width: 120, height: 40 });
    expect(maskBounds([strokes[1]], 1000, 1000)).toBeNull();
  });

  it("covers the painted area with a square inside the image", () => {
    expect(squareAround({ x: 90, y: 90, width: 120, height: 40 }, 1000, 1000)).toEqual({ x: 90, y: 50, size: 120 });
    expect(squareAround({ x: 0, y: 0, width: 50, height: 20 }, 1000, 1000)).toEqual({ x: 0, y: 0, size: 50 });
  });

  it("keeps unpainted pixels exactly and blends painted ones", () => {
    const original = solid(2, 1, [100, 100, 100]);
    const result = solid(2, 1, [200, 0, 50]);
    const blended = blendMasked(original, result, new Uint8ClampedArray([0, 255]), { driftCorrection: false });
    expect(Array.from(blended.slice(0, 4))).toEqual([100, 100, 100, 255]);
    expect(Array.from(blended.slice(4, 7))).toEqual([200, 0, 50]);
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

describe("GPT Image region edits", () => {
  it("keeps the square side legal for GPT Image", () => {
    expect(GPT_MIN_SQUARE).toBe(816);
    expect(GPT_MAX_SQUARE).toBe(2880);
    expect(gptSquareSide(300)).toBe(816);
    expect(gptSquareSide(1000)).toBe(1008);
    expect(gptSquareSide(5000)).toBe(2880);
    expect(validateGenerateSize(gptSquareSide(1234), gptSquareSide(1234))).toBeNull();
  });

  it("puts the keep-the-context rules before the instruction", () => {
    const prompt = gptRegionPrompt("  add a red hat ");
    expect(prompt.indexOf("outside the masked area must stay identical")).toBeLessThan(prompt.indexOf("add a red hat"));
    expect(prompt).toContain("Change inside the masked area: add a red hat");
  });
});

describe("spillAlpha", () => {
  const size = 60;
  const flat = (value: number) => {
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set([value, value, value, 255], index);
    return pixels;
  };
  const fill = (pixels: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, value: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels.set([value, value, value, 255], (y * size + x) * 4);
  };

  it("adds new content that crosses the edit edge, and ignores changes that do not touch it", () => {
    const original = flat(100);
    const result = flat(100);
    fill(result, 25, 25, 45, 35, 220);
    fill(result, 2, 50, 8, 56, 220);
    const base = selectionAlpha(size, size, { x: 20, y: 20, width: 20, height: 20 }, { left: false, top: false, right: false, bottom: false }, 0);
    const alpha = spillAlpha(original, result, size, size, base, 2);
    expect(alpha[30 * size + 43]).toBeGreaterThan(200);
    expect(alpha[53 * size + 5]).toBe(0);
    expect(alpha[10 * size + 10]).toBe(0);
  });

  it("returns the base unchanged when the margin did not change", () => {
    const base = selectionAlpha(size, size, { x: 20, y: 20, width: 20, height: 20 }, { left: false, top: false, right: false, bottom: false }, 4);
    const result = flat(100);
    fill(result, 20, 20, 40, 40, 30);
    expect(spillAlpha(flat(100), result, size, size, base, 2)).toEqual(base);
  });
});
