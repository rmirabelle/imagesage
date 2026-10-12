import { describe, expect, it } from "vitest";
import { combineSelection, featherSelection, marqueeBox, invertSelection, selectionBounds, selectionContours, simplifyLoop, smoothEdge, wandArea } from "./magicWand";

/**
 * A 4 × 1 image: red, red, blue, red. The last red does not touch the first
 * two, so Contiguous leaves it out.
 */
const pixels = new Uint8ClampedArray([
  255, 0, 0, 255,
  250, 5, 0, 255,
  0, 0, 255, 255,
  255, 0, 0, 255
]);

describe("magic wand", () => {
  it("selects touching pixels of a like color", () => {
    expect([...wandArea(pixels, 4, 1, 0, 0, 10, true)]).toEqual([1, 1, 0, 0]);
  });

  it("selects every matching pixel when not contiguous", () => {
    expect([...wandArea(pixels, 4, 1, 0, 0, 10, false)]).toEqual([1, 1, 0, 1]);
  });

  it("uses the tolerance on each color value", () => {
    expect([...wandArea(pixels, 4, 1, 0, 0, 4, true)]).toEqual([1, 0, 0, 0]);
  });

  it("replaces, adds to and takes from a selection", () => {
    const before = new Uint8Array([255, 255, 0, 128]);
    const area = new Uint8Array([0, 255, 255, 128]);
    expect([...combineSelection(before, area, "replace")]).toEqual([0, 255, 255, 128]);
    expect([...combineSelection(before, area, "add")]).toEqual([255, 255, 255, 128]);
    expect([...combineSelection(before, area, "subtract")]).toEqual([255, 0, 0, 64]);
    expect([...combineSelection(null, area, "subtract")]).toEqual([0, 0, 0, 0]);
    expect([...invertSelection(before)]).toEqual([0, 0, 255, 127]);
  });

  it("traces the selection as closed loops of corners", () => {
    /** The left column of a 2 × 2 image: one loop with four corners. */
    expect(selectionContours(new Uint8Array([1, 0, 1, 0]), 2, 2)).toEqual([[0, 0, 1, 0, 1, 2, 0, 2]]);
    /** Two pixels that touch only at a corner: two loops. */
    expect(selectionContours(new Uint8Array([1, 0, 0, 1]), 2, 2)).toHaveLength(2);
    /** A hole makes a second loop. */
    expect(selectionContours(new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3)).toHaveLength(2);
  });

  it("softens the pixels just outside a wand area and keeps the area whole", () => {
    const one = new Uint8Array(9);
    one[4] = 255;
    expect([...smoothEdge(one, 3, 3)]).toEqual([28, 28, 28, 28, 255, 28, 28, 28, 28]);
  });

  it("boxes an ellipse drag, as a circle with Shift and from the center with Alt", () => {
    expect(marqueeBox({ x: 10, y: 10 }, { x: 4, y: 30 }, false, false)).toEqual({ x: 4, y: 10, width: 6, height: 20 });
    expect(marqueeBox({ x: 10, y: 10 }, { x: 4, y: 30 }, true, false)).toEqual({ x: -10, y: 10, width: 20, height: 20 });
    expect(marqueeBox({ x: 10, y: 10 }, { x: 14, y: 13 }, false, true)).toEqual({ x: 6, y: 7, width: 8, height: 6 });
  });

  it("smooths the steps of a slanted edge", () => {
    const steps = [0, 0, 1, 0, 1, 1, 2, 1, 2, 2, 3, 2, 3, 3, 0, 3];
    expect(simplifyLoop(steps, 1).length).toBeLessThan(steps.length);
  });

  it("finds the box around the selection", () => {
    expect(selectionBounds(new Uint8Array([0, 1, 1, 0]), 2, 2)).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    expect(selectionBounds(new Uint8Array(4), 2, 2)).toBeNull();
  });

  it("feathers the edge of a selection and keeps it whole at the image edge", () => {
    /** The left half of a 20 × 1 strip is selected. */
    const half = new Uint8Array(20);
    half.fill(255, 0, 10);
    const soft = featherSelection(half, 20, 1, 4);
    expect(soft[0]).toBe(255);
    expect(soft[19]).toBe(0);
    expect(soft[8]).toBeGreaterThan(128);
    expect(soft[8]).toBeLessThan(255);
    expect(soft[11]).toBeGreaterThan(0);
    expect(soft[11]).toBeLessThan(128);
    for (let index = 1; index < 20; index++) expect(soft[index]).toBeLessThanOrEqual(soft[index - 1]);
    expect([...featherSelection(half, 20, 1, 0)]).toEqual([...half]);
  });
});
