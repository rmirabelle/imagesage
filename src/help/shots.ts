import type { Page } from "./capture";

/**
 * One help picture. The capture run (capture.ts) makes
 * `public/help/<name>.png` from it; a chapter shows it with
 * `<Shot name="..." />`.
 */
export interface Shot {
  /** The file name: lowercase letters, digits and hyphens. */
  name: string;
  /** What must be open: no image ("empty"), the sample image ("image"), or it does not matter ("none"). */
  needs: "empty" | "image" | "none";
  /** Puts the app in the state to show, for example selects a tool or opens a menu. */
  setup?: (page: Page) => void | Promise<void>;
  /** The part to show: one CSS selector, several whose boxes are joined, or a function that returns the elements. Keep it small; crop out what the text does not discuss. */
  target: string | string[] | ((page: Page) => Element[]);
  /** Space around the part in CSS pixels: one number, or [top and bottom, left and right]. The default is 8. */
  margin?: number | [number, number];
  /** An element that gets a ring, to point at it. */
  mark?: string;
  /** Puts the app back, for example closes the menu or dialog. */
  cleanup?: (page: Page) => void | Promise<void>;
}

/** The tool buttons alone; the toolbar around them is as wide as the window. */
const TOOLS = ".editor-toolbar .paint-tool-picker";
const COLORS = '.editor-toolbar [aria-label="Paint color"]';
const MASK_TOOLS = ".editor-toolbar .mask-tool-picker";
const toolButton = (label: string) => `${TOOLS} button[aria-label="${label}"]`;
const maskButton = (label: string) => `${MASK_TOOLS} button[aria-label="${label}"]`;

/** One toolbar button alone and in use, small enough to sit in a sentence. */
const toolIcon = (name: string, label: string): Shot => ({ name, needs: "image", setup: (page) => page.select(toolButton(label)), target: toolButton(label), margin: 3 });

/** A dialog that a menu command opens; `close` is the control that closes it with no other effect. */
const dialog = (name: string, menu: string, item: string, root: string, close: string, more: Partial<Shot> = {}): Shot => ({
  name,
  needs: "image",
  setup: async (page) => {
    await page.menuCommand(menu, item);
    await page.waitFor(root);
  },
  target: root,
  margin: 10,
  cleanup: (page) => page.press(close),
  ...more
});

/** One section of the Settings dialog. Nothing in it is pressed: Save, Test, Remove, Download and Browse all act at once. */
const settings = (name: string, section: string, target: Shot["target"], margin = 16): Shot => ({
  name,
  needs: "none",
  setup: async (page) => {
    await page.menuCommand("File", "Settings…");
    await page.waitFor(".settings-dialog .settings-pane");
    page.pressText(".settings-dialog .settings-nav button", section);
    await page.settle(300);
  },
  target,
  margin,
  cleanup: (page) => page.press(".settings-dialog .save-dialog-close")
});

/** The layer rows of the sample image, top first. */
const ROW = "li.steps-row";
/** Leaves every tool, so the next shot starts from the pointer. */
const toPointer = async (page: Page) => {
  for (let count = 0; count < 4; count += 1) {
    page.key("Escape");
    await page.settle(60);
  }
};

/** The slideshow dialog picks the remembered music track again, which can start a download; the run sets that memory aside. */
const MUSIC_KEYS = ["imagesage.slideshow-music", "imagesage.slideshow-music-by-image"];
let musicBefore: (string | null)[] = [];

/**
 * The pictures, in the order the run makes them. The shots with the sample
 * image share one image, so a later shot sees what an earlier one added
 * (layers, adjustments, a mask); their order matters.
 */
export const SHOTS: Shot[] = [
  // Getting started
  { name: "start-buttons", needs: "empty", target: ".empty-actions", margin: 14 },
  { name: "openai-status", needs: "none", target: ".ai-status .ai-status-dots", margin: 4 },
  {
    /** The key field is shown, never the stored key: a picture must not hold a part of a real key. */
    ...settings("settings-openai", "OpenAI", [".settings-dialog .settings-pane-intro", ".settings-dialog .settings-group"]),
    setup: async (page) => {
      await page.menuCommand("File", "Settings…");
      await page.waitFor(".settings-dialog .settings-pane");
      document.querySelector<HTMLElement>('.settings-dialog [aria-label="Replace key"]')?.click();
      await page.waitFor(".settings-dialog .settings-input");
      (document.activeElement as HTMLElement | null)?.blur();
    }
  },
  {
    name: "new-image-dialog",
    needs: "none",
    setup: async (page) => {
      await page.menuCommand("File", "New Image…");
      await page.waitFor(".new-image-dialog");
    },
    target: ".new-image-dialog",
    margin: 10,
    cleanup: (page) => page.press(".new-image-dialog .save-dialog-close")
  },

  // Settings, updates and shortcuts; Local models
  settings("settings-nav", "OpenAI", (page) => page.findAll(".settings-dialog .settings-nav button"), 10),
  settings("settings-general", "General", [".settings-dialog .settings-pane-intro", ".settings-dialog .settings-group"]),
  settings("settings-local-engine", "Local", (page) => page.findAll(".settings-dialog .settings-group.local-files").slice(0, 1)),
  {
    /** The first model group: its title, its status and its file rows. The group is scrolled to the top of the pane first. */
    ...settings("settings-local-model", "Local", (page) => Array.from(page.findAll(".settings-dialog .settings-group.local-files")[1]?.children ?? []).slice(0, 5)),
    setup: async (page) => {
      await page.menuCommand("File", "Settings\u2026");
      await page.waitFor(".settings-dialog .settings-pane");
      page.pressText(".settings-dialog .settings-nav button", "Local");
      await page.settle(300);
      page.findAll(".settings-dialog .settings-group.local-files")[1]?.scrollIntoView({ block: "start" });
    }
  },
  {
    name: "about-dialog",
    needs: "none",
    setup: async (page) => {
      await page.menuCommand("Help", "About Image Sage");
      await page.waitFor(".about-dialog");
    },
    target: ".about-dialog",
    margin: 10,
    cleanup: (page) => page.press(".about-dialog-close")
  },

  // For README.md; see vite.config.ts
  { name: "readme-window", needs: "image", setup: (page) => page.select(toolButton("Select")), target: ".app-shell", margin: 0 },

  // The window, with the sample image
  { name: "window-overview", needs: "image", setup: (page) => page.select(toolButton("Select")), target: ".app-shell", margin: 0 },
  { name: "prompt-controls", needs: "image", target: ".prompt-controls", margin: 10 },
  { name: "doc-tab", needs: "image", target: ".doc-tab.active", margin: 6 },

  // The Paint tools
  { name: "paint-toolbar-brush", needs: "image", setup: (page) => page.select(toolButton("Paint brush")), target: TOOLS, margin: [8, 10] },
  { name: "paint-brush-settings", needs: "image", setup: (page) => page.select(toolButton("Paint brush")), target: [toolButton("Paint brush"), ".tool-settings"], margin: 10 },
  { name: "paint-color", needs: "image", setup: (page) => page.select(toolButton("Paint brush")), target: COLORS, margin: 10 },
  toolIcon("tool-brush", "Paint brush"),
  toolIcon("tool-rect", "Rectangle select"),
  toolIcon("tool-ellipse", "Ellipse select"),
  toolIcon("tool-lasso", "Paint lasso"),
  toolIcon("tool-eraser", "Eraser"),
  toolIcon("tool-radial", "Radial gradient"),
  toolIcon("tool-linear", "Linear gradient"),
  { name: "paint-toolbar-gradient", needs: "image", setup: (page) => page.select(toolButton("Linear gradient")), target: [TOOLS, COLORS], margin: [8, 10] },
  {
    name: "paint-wand-settings",
    needs: "image",
    setup: async (page) => {
      page.select(toolButton("Magic wand"));
      await page.waitFor(".tool-settings .wand-contiguous");
    },
    target: [toolButton("Magic wand"), ".tool-settings"],
    margin: 10
  },
  toolIcon("tool-wand", "Magic wand"),
  { ...toolIcon("tool-select", "Select"), setup: async (page) => { await toPointer(page); page.select(toolButton("Select")); } },

  // Files and sizes. No shot presses a button that opens a Windows file dialog or writes a file.
  dialog("open-places", "File", "Open…", ".open-dialog", 'button[aria-label="Close open dialog"]', { target: (page) => page.findAll(".open-places-group").slice(0, 1), margin: 10 }),
  dialog("export-dialog", "File", "Export Image…", '.save-dialog[aria-labelledby="export-image-title"]', 'button[aria-label="Close save dialog"]'),
  dialog("image-size-dialog", "Edit", "Image Size…", ".canvas-size-dialog", '.canvas-size-dialog button[aria-label="Close"]'),
  dialog("canvas-size-dialog", "Edit", "Canvas Size…", ".canvas-size-dialog", '.canvas-size-dialog button[aria-label="Close"]'),
  {
    ...dialog("slideshow-dialog", "File", "Export Video Slideshow…", ".slideshow-dialog", ".slideshow-dialog .save-dialog-close"),
    setup: async (page) => {
      musicBefore = MUSIC_KEYS.map((key) => localStorage.getItem(key));
      MUSIC_KEYS.forEach((key) => localStorage.removeItem(key));
      await page.menuCommand("File", "Export Video Slideshow…");
      await page.waitFor(".slideshow-dialog");
    },
    cleanup: (page) => {
      page.press(".slideshow-dialog .save-dialog-close");
      MUSIC_KEYS.forEach((key, index) => {
        const value = musicBefore[index];
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      });
    }
  },

  // Adjustments, on the one layer of the sample image
  {
    name: "adjust-add-menu",
    needs: "image",
    setup: async (page) => {
      page.press(".layer-strip-add");
      await page.waitFor(".steps-menu.part-menu");
    },
    target: [".layer-strip-add", ".steps-menu.part-menu"],
    cleanup: (page) => page.dismiss()
  },
  {
    name: "adjust-contrast",
    needs: "image",
    setup: async (page) => {
      page.press(".layer-strip-add");
      await page.waitFor(".steps-menu.part-menu");
      page.pressText('.steps-menu.part-menu button[role="menuitem"]', "Contrast");
      await page.waitFor(".layer-adjust-popover");
      page.setRange('.layer-adjust-popover input[type="range"]', 25);
    },
    target: ".layer-adjust-popover",
    cleanup: (page) => page.dismiss()
  },
  {
    name: "adjust-chips",
    needs: "image",
    setup: async (page) => {
      page.press(".layer-strip-add");
      await page.waitFor(".steps-menu.part-menu");
      page.pressText('.steps-menu.part-menu button[role="menuitem"]', "Sharpen");
      await page.waitFor(".layer-adjust-popover");
      page.setRange('.layer-adjust-popover input[type="range"]', 60);
      await page.settle(100);
      page.dismiss();
    },
    target: ".layer-strip",
    margin: 8
  },
  {
    name: "adjust-chip-menu",
    needs: "image",
    setup: async (page) => {
      page.rightClick(".layer-chip.adjust");
      await page.waitFor(".steps-menu.part-menu");
    },
    target: ".steps-menu.part-menu",
    cleanup: (page) => page.dismiss()
  },

  // Layers: a new empty layer, then a snapshot on top
  {
    name: "layers-panel",
    needs: "image",
    setup: async (page) => {
      if (page.findAll(ROW).length < 3) {
        page.press(".steps-toolbar button.steps-tool:not(.solid)");
        await page.settle(300);
        page.press(".steps-toolbar button.steps-tool.solid");
        await page.settle(600);
      }
    },
    target: (page) => [page.find(".steps-panel-header"), ...page.findAll(ROW)],
    margin: 0
  },
  { name: "layers-toolbar", needs: "image", target: (page) => page.findAll(".steps-toolbar button.steps-tool"), margin: 8 },
  { name: "layer-eye", needs: "image", target: ".steps-eye", margin: 3 },
  {
    name: "layer-menu",
    needs: "image",
    setup: async (page) => {
      page.rightClick("button.steps-item");
      await page.waitFor(".steps-menu.layer-menu");
    },
    target: ".steps-menu.layer-menu",
    cleanup: (page) => page.dismiss()
  },
  {
    name: "layer-blend-menu",
    needs: "image",
    setup: async (page) => {
      page.press(".blend-tag");
      await page.waitFor('.steps-menu[role="menu"]');
    },
    target: [".blend-tag", '.steps-menu[role="menu"]'],
    cleanup: (page) => page.dismiss()
  },

  // Selections and Transform
  {
    name: "selection-card",
    needs: "image",
    /** The Layers panel covers the last card in a window this narrow, so the panel is collapsed for this shot. */
    setup: async (page) => {
      await toPointer(page);
      page.press("button.steps-collapse");
      page.key("a", { ctrl: true });
      await page.settle(400);
    },
    target: (page) => page.findAll(".mask-shortcuts .shortcut-card").filter((card) => card.querySelector(".shortcut-card-head")?.textContent?.trim() === "Selection"),
    cleanup: (page) => {
      page.key("d", { ctrl: true });
      page.press("button.steps-expand");
    }
  },
  {
    name: "transform-frame",
    needs: "image",
    setup: async (page) => {
      page.key("t", { ctrl: true });
      await page.waitFor("svg.transform-frame");
    },
    target: ["svg.transform-frame", ".transform-actions"],
    margin: 12
  },
  {
    name: "transform-card",
    needs: "image",
    target: '.mask-shortcuts[aria-label="Transform shortcuts"]',
    cleanup: (page) => page.press('button[aria-label="Cancel transform"]')
  },

  // The Mask tool, last: it adds a mask that hides the top layer
  {
    name: "mask-add-menu",
    needs: "image",
    setup: async (page) => {
      await toPointer(page);
      page.press(".thumb-mask-add");
      await page.waitFor(".steps-menu.part-menu");
    },
    target: (page) => [page.find(".thumb-mask-add").parentElement ?? page.find(".thumb-mask-add"), page.find(".steps-menu.part-menu")],
    margin: 6,
    cleanup: (page) => page.dismiss()
  },
  {
    name: "mask-toolbar",
    needs: "image",
    setup: async (page) => {
      page.press(".thumb-mask-add");
      await page.waitFor(".steps-menu.part-menu");
      page.pressText('.steps-menu.part-menu button[role="menuitem"]', "Add");
      await page.waitFor(MASK_TOOLS);
    },
    target: MASK_TOOLS,
    margin: [8, 10]
  },
  { name: "mask-brush-settings", needs: "image", setup: (page) => page.select(maskButton("Brush")), target: [maskButton("Brush"), ".tool-settings"], margin: 10 },
  { name: "mask-cards", needs: "image", target: '.mask-shortcuts[aria-label="Mask shortcuts"]', margin: 8 },
  {
    name: "mask-menu",
    needs: "image",
    setup: async (page) => {
      page.rightClick(".thumb-mask");
      await page.waitFor(".steps-menu.part-menu");
    },
    target: ".steps-menu.part-menu",
    cleanup: (page) => page.dismiss()
  },
  {
    name: "mask-gradient-ends",
    needs: "image",
    setup: (page) => page.select(maskButton("Linear gradient")),
    target: [maskButton("Linear gradient"), '.editor-toolbar [aria-label="Mask gradient colors"]'],
    margin: [8, 10],
    cleanup: toPointer
  }
];
