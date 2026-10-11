import { describe, expect, it } from "vitest";
import { grayLevel, projectOnLine, resolveClearStops, reverseStops, stopAt, toGray } from "./gradient";

describe("gradient stops", () => {
  const stops = [
    { offset: 0, color: "#000000", alpha: 1 },
    { offset: 1, color: "#ffffff", alpha: 0 }
  ];

  it("mixes the color and alpha between two stops", () => {
    expect(stopAt(stops, 0.5)).toEqual({ offset: 0.5, color: "#808080", alpha: 0.5 });
    expect(stopAt(stops, 0)).toEqual({ offset: 0, color: "#000000", alpha: 1 });
    expect(stopAt(stops, 1)).toEqual({ offset: 1, color: "#ffffff", alpha: 0 });
  });

  it("finds where a point falls along the line and how far it is from it", () => {
    expect(projectOnLine({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 3 })).toEqual({ offset: 0.5, distance: 3 });
    expect(projectOnLine({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -5, y: 0 }).offset).toBe(-0.5);
  });

  it("swaps the ends and mirrors the middle stops", () => {
    const reversed = reverseStops([stops[0], { offset: 0.25, color: "#ff0000", alpha: 1 }, stops[1]]);
    expect(reversed.map((stop) => [stop.offset, stop.color])).toEqual([[0, "#ffffff"], [0.75, "#ff0000"], [1, "#000000"]]);
  });

  it("draws a transparent stop in the color of the nearest solid stop", () => {
    const resolved = resolveClearStops([
      { offset: 0, color: "#ff0000", alpha: 1 },
      { offset: 0.6, color: "#00ff00", alpha: 1 },
      { offset: 1, color: "#ffffff", alpha: 0 }
    ]);
    expect(resolved.map((stop) => stop.color)).toEqual(["#ff0000", "#00ff00", "#00ff00"]);
  });

  it("turns colors into grays of the same lightness", () => {
    expect(toGray("#ffffff")).toBe("#ffffff");
    expect(grayLevel(toGray("#ff0000"))).toBeCloseTo(grayLevel("#ff0000"), 2);
  });
});
