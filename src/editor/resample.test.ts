import { describe, expect, it } from "vitest";
import { sharpenPixels } from "./resample";

describe("sharpen after an enlargement", () => {
  it("pushes a pixel away from the average around it and keeps alpha", () => {
    /** A 3 × 1 row: gray, light, gray. The light middle gets lighter; the grays get darker. */
    const data = new Uint8ClampedArray([100, 100, 100, 255, 160, 160, 160, 200, 100, 100, 100, 255]);
    sharpenPixels(data, 3, 1, 0.5);
    expect(data[4]).toBe(180);
    expect(data[0]).toBe(85);
    expect(data[7]).toBe(200);
  });
});
