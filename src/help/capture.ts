import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { SHOTS, type Shot } from "./shots";

/**
 * The capture run, for dev builds only. It makes every help picture: for each
 * shot in shots.ts it puts the app in the state the shot needs, measures the
 * part to show, and asks Rust (`help_capture`) to photograph that rectangle
 * into `public/help/<name>.png`. Run it again after the UI changes.
 *
 * Start it from Help, Capture Help Pictures, or from a terminal with
 * `curl http://localhost:14410/__help-shots` (see vite.config.ts).
 */

/** Picture pixels for each CSS pixel. The same on every screen, so the help shows each picture at a known size. */
const SHOT_SCALE = 2;

/** What the app gives the capture run: it opens and closes the sample image. */
export interface Stage {
  /** True when no image is open. */
  isEmpty: () => boolean;
  openSample: () => Promise<void>;
  closeSample: () => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const isVisible = (element: Element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};

/** The tools a shot uses to put the app in its state. */
export const page = {
  /** The first visible element that matches, so a hidden image tab is never used. */
  find(selector: string): HTMLElement {
    const found = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(isVisible);
    if (!found) throw new Error(`Nothing visible matches ${selector}`);
    return found;
  },
  /** A click with no mouse; toolbar buttons that act on press accept it too. */
  press(selector: string) {
    page.find(selector).click();
  },
  /** Selects a tool button; a press on a tool that is in use would put it away. */
  select(selector: string) {
    const button = page.find(selector);
    if (button.getAttribute("aria-checked") !== "true") button.click();
  },
  /** Opens one menu of the menu bar. */
  openMenu(label: string) {
    const button = Array.from(document.querySelectorAll<HTMLElement>(".menubar-root > button")).find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`There is no ${label} menu`);
    if (button.getAttribute("aria-expanded") !== "true") button.click();
  },
  /** Closes the open menu. */
  closeMenu() {
    document.querySelector<HTMLElement>(".menubar-root > button.active")?.click();
  },
  /** Chooses one item of the open menu. */
  chooseMenuItem(label: string) {
    const item = Array.from(document.querySelectorAll<HTMLElement>(".menubar-dropdown button")).find((entry) => entry.querySelector(".menubar-item-label")?.textContent?.trim() === label);
    if (!item) throw new Error(`The open menu has no item ${label}`);
    item.click();
  },
  /** Sends one key to the window, as the keyboard does. */
  key(key: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
    const init = { key, bubbles: true, cancelable: true, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, altKey: !!modifiers.alt };
    /** The editor ignores keys that come from a text field, so the key goes to the page itself. */
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.dispatchEvent(new KeyboardEvent("keydown", init));
    document.body.dispatchEvent(new KeyboardEvent("keyup", init));
  },
  /** Opens a menu of the menu bar and chooses one of its items. */
  async menuCommand(menu: string, item: string) {
    page.openMenu(menu);
    await page.settle(50);
    page.chooseMenuItem(item);
  },
  /** A click on the first visible element that matches and has this text. */
  pressText(selector: string, text: string) {
    const found = Array.from(document.querySelectorAll<HTMLElement>(selector)).find((element) => isVisible(element) && element.textContent?.trim().includes(text));
    if (!found) throw new Error(`Nothing visible matches ${selector} with the text ${text}`);
    found.click();
  },
  /** A right-click, which opens the element's menu. */
  rightClick(selector: string) {
    const element = page.find(selector);
    const box = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 2 }));
  },
  /** Closes open menus and popovers: they close on a press somewhere else. */
  dismiss() {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 2, clientY: 2 }));
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 2, clientY: 2 }));
  },
  /** Sets a slider, as a drag does. */
  setRange(selector: string, value: number) {
    const input = page.find(selector) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  },
  /** All visible elements that match. */
  findAll(selector: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
  },
  /** Waits until the window shows the new state. */
  async settle(ms = 200) {
    await frame();
    await frame();
    await wait(ms);
  },
  /** Waits until something visible matches. */
  async waitFor(selector: string, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (Array.from(document.querySelectorAll(selector)).some(isVisible)) return;
      await wait(50);
    }
    throw new Error(`${selector} did not appear`);
  }
};
export type Page = typeof page;

/** The rectangle around all targets of a shot plus its margin, kept inside the window. */
function shotBox(shot: Shot) {
  const elements = typeof shot.target === "function" ? shot.target(page) : (Array.isArray(shot.target) ? shot.target : [shot.target]).map((selector) => page.find(selector));
  if (!elements.length) throw new Error("The shot has no part to show");
  const targets = elements.map((element) => element.getBoundingClientRect());
  const [marginY, marginX] = Array.isArray(shot.margin) ? shot.margin : [shot.margin ?? 8, shot.margin ?? 8];
  const left = Math.max(0, Math.floor(Math.min(...targets.map((box) => box.left)) - marginX));
  const top = Math.max(0, Math.floor(Math.min(...targets.map((box) => box.top)) - marginY));
  const right = Math.min(window.innerWidth, Math.ceil(Math.max(...targets.map((box) => box.right)) + marginX));
  const bottom = Math.min(window.innerHeight, Math.ceil(Math.max(...targets.map((box) => box.bottom)) + marginY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function takeShot(shot: Shot, log: (message: string) => void) {
  let marked: HTMLElement | null = null;
  try {
    await shot.setup?.(page);
    await page.settle();
    if (shot.mark) {
      marked = page.find(shot.mark);
      marked.classList.add("help-shot-mark");
      await frame();
    }
    /** The webview multiplies the scale by the screen's own scale, so that one is divided out. */
    await invoke<string>("help_capture", { name: shot.name, ...shotBox(shot), scale: SHOT_SCALE / window.devicePixelRatio });
    log(`help picture made: ${shot.name}`);
    return true;
  } catch (error) {
    log(`help picture FAILED: ${shot.name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    marked?.classList.remove("help-shot-mark");
    try {
      await shot.cleanup?.(page);
      await page.settle(80);
    } catch (error) {
      log(`help picture cleanup FAILED: ${shot.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

let running = false;

/** Makes all help pictures, or only those whose name starts with `only`. Returns how many were made and how many failed. */
export async function captureHelpShots(stage: Stage, log: (message: string) => void, only?: string) {
  if (running) {
    log("help pictures: a run is in progress");
    return { made: 0, failed: 0 };
  }
  running = true;
  /** Tooltips and the text cursor must not show in a picture. */
  document.documentElement.classList.add("help-capturing");
  let made = 0;
  let failed = 0;
  const count = (ok: boolean) => { if (ok) made += 1; else failed += 1; };
  const wanted = SHOTS.filter((shot) => !only || shot.name.startsWith(only));
  try {
    /** Every run draws the page at one size, so the pictures do not depend on the screen. The window itself does not change or take the focus. */
    await invoke("help_stage", { on: true });
    await page.settle(500);
    const empty = wanted.filter((shot) => shot.needs === "empty");
    if (empty.length && !stage.isEmpty()) {
      log(`help pictures: ${empty.length} need a window with no image open; close all images and run again`);
      failed += empty.length;
    } else {
      for (const shot of empty) count(await takeShot(shot, log));
    }
    for (const shot of wanted.filter((item) => item.needs === "none")) count(await takeShot(shot, log));

    const withImage = wanted.filter((shot) => shot.needs === "image");
    if (withImage.length) {
      await stage.openSample();
      await page.waitFor(".editor-toolbar");
      await page.settle(500);
      try {
        for (const shot of withImage) count(await takeShot(shot, log));
      } finally {
        stage.closeSample();
      }
    }
  } catch (error) {
    log(`help pictures stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    document.documentElement.classList.remove("help-capturing");
    await invoke("help_stage", { on: false }).catch((error) => log(`help pictures: the window size did not come back: ${String(error)}`));
    running = false;
  }
  log(`help pictures done: ${made} made, ${failed} failed`);
  void emitTo("help", "help-shots-updated").catch(() => { /* The help window is not open. */ });
  return { made, failed };
}

/** The sample image for the pictures: a drawn landscape, so the run needs no file and no AI. */
export function sampleImage(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1536;
  canvas.height = 1024;
  const context = canvas.getContext("2d")!;
  const sky = context.createLinearGradient(0, 0, 0, 760);
  sky.addColorStop(0, "#1c2a5e");
  sky.addColorStop(0.55, "#d9628a");
  sky.addColorStop(1, "#ffc56b");
  context.fillStyle = sky;
  context.fillRect(0, 0, 1536, 1024);

  const sun = context.createRadialGradient(1050, 640, 20, 1050, 640, 330);
  sun.addColorStop(0, "rgba(255,246,214,1)");
  sun.addColorStop(0.18, "rgba(255,226,150,.95)");
  sun.addColorStop(1, "rgba(255,200,110,0)");
  context.fillStyle = sun;
  context.fillRect(0, 0, 1536, 1024);

  /** Three rows of hills, the nearest one the darkest. */
  const hills: [string, number, number, number][] = [["#6b4a7c", 660, 70, 0.006], ["#43305f", 760, 90, 0.0045], ["#231a3a", 880, 60, 0.008]];
  hills.forEach(([color, base, heightOf, wave], row) => {
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(0, 1024);
    for (let x = 0; x <= 1536; x += 8) {
      context.lineTo(x, base - Math.sin(x * wave + row * 1.7) * heightOf - Math.sin(x * wave * 2.7 + row) * heightOf * 0.35);
    }
    context.lineTo(1536, 1024);
    context.fill();
  });

  /** One tree on the nearest hill. */
  context.fillStyle = "#140f24";
  context.fillRect(352, 700, 16, 190);
  [[360, 690, 92], [300, 730, 60], [420, 735, 64], [360, 620, 62]].forEach(([x, y, radius]) => {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  });
  return canvas;
}
