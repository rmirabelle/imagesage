import { describe, expect, it } from "vitest";
import { colorizeFilterId, colorizeFilterIds, colorizeTables, hslToRgb, parseColorizeFilterId } from "./colorize";

describe("colorize", () => {
  it("converts hue, saturation and lightness to a color", () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([1, 0, 0]);
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 1, 0]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 1]);
    expect(hslToRgb(200, 0, 0.3)).toEqual([0.3, 0.3, 0.3]);
  });

  it("keeps black black and white white", () => {
    const [red, green, blue] = colorizeTables({ hue: 30, saturation: 0.5 }, 5);
    expect([red[0], green[0], blue[0]]).toEqual([0, 0, 0]);
    expect([red[4], green[4], blue[4]]).toEqual([1, 1, 1]);
    expect(red[2]).toBeGreaterThan(blue[2]);
  });

  it("round-trips its filter id", () => {
    const id = colorizeFilterId({ hue: 210, saturation: 0.25 });
    expect(parseColorizeFilterId(id)).toEqual({ hue: 210, saturation: 0.25 });
    expect(colorizeFilterIds(`brightness(1.2) url(#${id})`)).toEqual([id]);
    expect(parseColorizeFilterId("ctr_1_2_3_4")).toBeNull();
  });
});
