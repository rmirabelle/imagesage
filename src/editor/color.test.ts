import { describe, expect, it } from "vitest";
import { hexToHsb, hexToRgb, hsbToHex, rgbToHsb } from "./color";

describe("color", () => {
  it("converts HSB to hex", () => {
    expect(hsbToHex({ h: 0, s: 100, b: 100 })).toBe("#ff0000");
    expect(hsbToHex({ h: 120, s: 100, b: 100 })).toBe("#00ff00");
    expect(hsbToHex({ h: 240, s: 100, b: 50 })).toBe("#000080");
    expect(hsbToHex({ h: 200, s: 0, b: 100 })).toBe("#ffffff");
    expect(hsbToHex({ h: 360, s: 100, b: 100 })).toBe("#ff0000");
  });

  it("converts RGB to HSB", () => {
    expect(rgbToHsb(255, 255, 0)).toEqual({ h: 60, s: 100, b: 100 });
    expect(rgbToHsb(0, 0, 0)).toEqual({ h: 0, s: 0, b: 0 });
    expect(rgbToHsb(255, 0, 128).h).toBeCloseTo(329.9, 1);
  });

  it("reads short and long hex, and refuses other text", () => {
    expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
    expect(hexToRgb("FF8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("#12345")).toBeNull();
    expect(hexToRgb("red")).toBeNull();
  });

  it("round-trips hex through HSB", () => {
    for (const hex of ["#123456", "#ff8000", "#7f7f7f", "#00c0ff"]) expect(hsbToHex(hexToHsb(hex)!)).toBe(hex);
  });
});
