import type { EditStep } from "./types";

/**
 * Documents saved before layers store steps as a tree of before/after tiles;
 * the editor walks this tree once to turn each step into a full layer.
 * Steps form a tree. Node 0 is the original image; node `n` is `history[n - 1]`.
 * Each step's tiles are relative to its parent node, so moving between two
 * nodes undoes steps up to their common ancestor and then redoes steps down.
 */

/** The node a step started from. Steps saved before branching have no `parent`: they follow the previous step. */
export function parentOf(history: Pick<EditStep, "parent">[], node: number): number | null {
  if (node <= 0) return null;
  const parent = history[node - 1]?.parent;
  return typeof parent === "number" && parent >= 0 && parent < node ? parent : node - 1;
}

/** The node and its ancestors, from the node up to the original image (node 0). */
export function ancestry(history: Pick<EditStep, "parent">[], node: number): number[] {
  const chain: number[] = [];
  for (let current: number | null = node; current !== null; current = parentOf(history, current)) chain.push(current);
  return chain;
}

/**
 * The steps to undo (`up`, in order) and then to redo (`down`, in order) to
 * move the image from node `from` to node `to`.
 */
export function pathBetween(history: Pick<EditStep, "parent">[], from: number, to: number) {
  const fromChain = ancestry(history, from);
  const toChain = ancestry(history, to);
  const toSet = new Set(toChain);
  const common = fromChain.find((node) => toSet.has(node)) ?? 0;
  return {
    up: fromChain.slice(0, fromChain.indexOf(common)),
    down: toChain.slice(0, toChain.indexOf(common)).reverse()
  };
}
