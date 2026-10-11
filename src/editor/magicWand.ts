/**
 * The Magic Wand, without DOM code: it selects pixels of a color like the
 * one under a click, as in Photoshop. No model and no network; it runs at
 * once on the pixels.
 *
 * A pixel matches when none of its red, green, blue and alpha values is more
 * than `tolerance` (0 to 255) away from the clicked pixel. Contiguous selects
 * only matching pixels that touch the clicked one, through matching pixels
 * (up, down, left, right); otherwise every matching pixel in the image.
 */
export interface WandClick {
  x: number;
  y: number;
  /** True adds the area; false removes it. */
  include: boolean;
}

export const DEFAULT_WAND_TOLERANCE = 32;

/** The area of one click: 1 for each selected pixel, 0 for the others. */
export function wandArea(pixels: Uint8ClampedArray, width: number, height: number, x: number, y: number, tolerance: number, contiguous: boolean): Uint8Array {
  const area = new Uint8Array(width * height);
  const seedX = Math.min(width - 1, Math.max(0, Math.floor(x)));
  const seedY = Math.min(height - 1, Math.max(0, Math.floor(y)));
  const seed = (seedY * width + seedX) * 4;
  const r = pixels[seed], g = pixels[seed + 1], b = pixels[seed + 2], a = pixels[seed + 3];
  const matches = (index: number) => {
    const at = index * 4;
    return Math.abs(pixels[at] - r) <= tolerance
      && Math.abs(pixels[at + 1] - g) <= tolerance
      && Math.abs(pixels[at + 2] - b) <= tolerance
      && Math.abs(pixels[at + 3] - a) <= tolerance;
  };
  if (!contiguous) {
    for (let index = 0; index < area.length; index++) if (matches(index)) area[index] = 1;
    return area;
  }
  /** A flood fill with a stack of pixel indexes; `area` also marks the pixels already seen. */
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const push = (next: number) => {
    if (seen[next]) return;
    seen[next] = 1;
    stack[top++] = next;
  };
  push(seedY * width + seedX);
  while (top > 0) {
    const index = stack[--top];
    if (!matches(index)) continue;
    area[index] = 1;
    const px = index % width;
    if (px > 0) push(index - 1);
    if (px < width - 1) push(index + 1);
    if (index >= width) push(index - width);
    if (index + width < area.length) push(index + width);
  }
  return area;
}

/** The smallest rectangle around the selected pixels, or null when nothing is selected. */
export function selectionBounds(selection: Uint8Array, width: number, height: number) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!selection[y * width + x]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** How a new area changes the selection: it takes its place, adds to it, or is taken away from it. */
export type SelectMode = "replace" | "add" | "subtract";

/**
 * The selection after a new area, in `mode`. Both are levels, 0 (not
 * selected) to 255 (fully selected), so smooth edges stay smooth: adding
 * keeps the higher level, and taking away keeps what the area leaves.
 * `before` is null when nothing was selected.
 */
export function combineSelection(before: Uint8Array | null, area: Uint8Array, mode: SelectMode): Uint8Array {
  if (mode === "replace" || !before) return mode === "subtract" ? new Uint8Array(area.length) : area.slice();
  const next = before.slice();
  for (let index = 0; index < next.length; index++) {
    next[index] = mode === "add" ? Math.max(next[index], area[index]) : Math.round(next[index] * (255 - area[index]) / 255);
  }
  return next;
}

/** The selection turned inside out. */
export const invertSelection = (levels: Uint8Array) => levels.map((level) => 255 - level);

/** Levels as on/off pixels: 1 where at least half selected, for the marching ants. */
export const selectedHalf = (levels: Uint8Array) => levels.map((level) => level >= 128 ? 1 : 0);

/**
 * The outline of a selection as closed loops, for marching ants whose
 * dashes flow without a break. Each loop is a flat list x0 y0 x1 y1 … of
 * pixel corners, going round the selected pixels; points in a straight line
 * are left out. The image edge counts as unselected. Where two selected
 * pixels touch only at a corner, the loops keep them apart.
 */
export function selectionContours(selection: Uint8Array, width: number, height: number): number[][] {
  const stride = width + 1;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height ? selection[y * width + x] : 0;
  /** Each corner has at most two edges going out of it; -1 is none. */
  const first = new Int32Array(stride * (height + 1)).fill(-1);
  const second = new Int32Array(stride * (height + 1)).fill(-1);
  let edges = 0;
  const add = (fromX: number, fromY: number, toX: number, toY: number) => {
    const from = fromY * stride + fromX;
    const to = toY * stride + toX;
    if (first[from] < 0) first[from] = to;
    else second[from] = to;
    edges++;
  };
  /** Clockwise round each selected pixel, on its sides that face unselected pixels. */
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!selection[y * width + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops: number[][] = [];
  const take = (corner: number, cameX: number, cameY: number) => {
    const a = first[corner];
    const b = second[corner];
    let next = a;
    if (a >= 0 && b >= 0) {
      /** Two ways on: take the right turn, so pixels that touch only at a corner stay in separate loops. */
      const cx = corner % stride, cy = Math.floor(corner / stride);
      const turn = (to: number) => cameX * ((Math.floor(to / stride)) - cy) - cameY * ((to % stride) - cx);
      next = turn(a) > turn(b) ? a : b;
    } else if (a < 0) {
      next = b;
    }
    if (next === a) first[corner] = -1;
    else second[corner] = -1;
    return next;
  };
  for (let start = 0; start < first.length && edges > 0; start++) {
    while (first[start] >= 0 || second[start] >= 0) {
      const loop: number[] = [];
      let corner = start;
      let dx = 0, dy = 0;
      do {
        const next = take(corner, dx, dy);
        if (next < 0) break;
        edges--;
        const ndx = (next % stride) - (corner % stride);
        const ndy = Math.floor(next / stride) - Math.floor(corner / stride);
        /** A corner where the direction changes is a point of the loop. */
        if (ndx !== dx || ndy !== dy) loop.push(corner % stride, Math.floor(corner / stride));
        dx = ndx;
        dy = ndy;
        corner = next;
      } while (corner !== start);
      if (loop.length >= 6) loops.push(loop);
    }
  }
  return loops;
}

/**
 * A loop (flat x y list) with points that stray less than `tolerance` from
 * the line between their neighbors left out, so the steps of a slanted edge
 * become one straight line on screen (Ramer–Douglas–Peucker).
 */
export function simplifyLoop(loop: number[], tolerance: number): number[] {
  const count = loop.length / 2;
  if (count <= 4 || tolerance <= 0) return loop;
  const keep = new Uint8Array(count);
  /** Splits the loop at its first point and the point farthest from it, then keeps what each half needs. */
  let far = 0, best = -1;
  for (let index = 1; index < count; index++) {
    const distance = (loop[index * 2] - loop[0]) ** 2 + (loop[index * 2 + 1] - loop[1]) ** 2;
    if (distance > best) {
      best = distance;
      far = index;
    }
  }
  keep[0] = 1;
  keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, count]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const ax = loop[from * 2], ay = loop[from * 2 + 1];
    const bx = loop[(to % count) * 2], by = loop[(to % count) * 2 + 1];
    const length = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, worstAt = -1;
    for (let index = from + 1; index < to; index++) {
      const distance = Math.abs((bx - ax) * (ay - loop[index * 2 + 1]) - (ax - loop[index * 2]) * (by - ay)) / length;
      if (distance > worst) {
        worst = distance;
        worstAt = index;
      }
    }
    if (worst > tolerance) {
      keep[worstAt] = 1;
      stack.push([from, worstAt], [worstAt, to]);
    }
  }
  const result: number[] = [];
  for (let index = 0; index < count; index++) if (keep[index]) result.push(loop[index * 2], loop[index * 2 + 1]);
  return result;
}

/**
 * Smooths the edge of a whole-pixel area (levels 0 or 255), as Photoshop's
 * Anti-alias does: each unselected pixel next to the area becomes partly
 * selected, by how much of the 3 × 3 square around it is selected. Selected
 * pixels stay fully selected, so even a one-pixel area stays whole.
 */
export function smoothEdge(levels: Uint8Array, width: number, height: number): Uint8Array {
  /** Sums of each row's 3 neighbors, then of 3 of those sums down: the 3 × 3 sum. */
  const rows = new Uint16Array(levels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      rows[at] = levels[at] + (x > 0 ? levels[at - 1] : 0) + (x < width - 1 ? levels[at + 1] : 0);
    }
  }
  const smooth = levels.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (levels[at]) continue;
      const sum = rows[at] + (y > 0 ? rows[at - width] : 0) + (y < height - 1 ? rows[at + width] : 0);
      if (sum) smooth[at] = Math.round(sum / 9);
    }
  }
  return smooth;
}

/**
 * The box of a rectangle or ellipse selection dragged from `start` to
 * `current`. With `even` (Shift held), its sides are equal: a square or a
 * circle; with `centered` (Alt held), `start` is its center instead of a corner.
 */
export function marqueeBox(start: { x: number; y: number }, current: { x: number; y: number }, even: boolean, centered: boolean) {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (even) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (centered) return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}
