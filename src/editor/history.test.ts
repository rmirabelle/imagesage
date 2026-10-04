import { describe, expect, it } from "vitest";
import { ancestry, parentOf, pathBetween } from "./history";

/** forest (0) → cabin (1) → path (2); forest (0) → second cabin (3); cabin (1) → lake (4). */
const tree = [{ parent: 0 }, { parent: 1 }, { parent: 0 }, { parent: 1 }];

describe("history tree", () => {
  it("treats steps without a parent as a straight line", () => {
    const linear = [{}, {}, {}];
    expect(parentOf(linear, 3)).toBe(2);
    expect(ancestry(linear, 3)).toEqual([3, 2, 1, 0]);
    expect(pathBetween(linear, 3, 1)).toEqual({ up: [3, 2], down: [] });
    expect(pathBetween(linear, 0, 2)).toEqual({ up: [], down: [1, 2] });
  });

  it("moves between branches through the common ancestor", () => {
    expect(pathBetween(tree, 2, 3)).toEqual({ up: [2, 1], down: [3] });
    expect(pathBetween(tree, 4, 2)).toEqual({ up: [4], down: [2] });
    expect(pathBetween(tree, 3, 3)).toEqual({ up: [], down: [] });
  });
});
