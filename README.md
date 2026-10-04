# ImageSage

An AI image editor for Windows that works in layers. It is built with Tauri 2, React 19, and Rust.

ImageSage creates an image from a prompt, then lets you change it one part at a time. Each AI edit becomes its own layer, so you can mask it, adjust it, transform it, retry it with a better prompt, or delete it, without generating the whole image again.

---

## Features

### Create and edit with AI

- **New from prompt** — create an image with OpenAI GPT Image, or open a PNG or JPEG.
- **Edit the whole image**, a **square selection**, or a **painted area** (Brush). Square and brush edits send only the area around your selection, at the best size for the model, and blend the result back in.
- **Two engines for area edits** — OpenAI GPT Image, or FLUX Fill. With an OpenAI key, a vision model first describes the scene, so FLUX keeps the parts that must not change.
- **Transparent edits** — GPT Image can draw only the new content on a transparent background, so every other pixel stays the same.
- **Several edits at once** — send a new edit while others still run. Each one shows a waiting row in the layers list, with its progress and a Cancel button, and becomes a layer when it arrives.
- **Retry with a new prompt** — retry a layer, change the prompt first, and the result replaces that layer in place. It keeps the layer's name, masks, and adjustments. If the retry fails, the old layer comes back.
- **Cost estimates** — every edit button shows the estimated price, and the toolbar shows what the image has cost so far.

### Layers

- **Each edit is a layer** above the original image. Show, hide, rename, reorder (drag), retry, or delete each layer.
- **Layer masks** — paint where a layer shows. Show and Hide brushes, brush opacity (keys `1`–`9`, `0`), a red view of the masked area (`R`), and linear or radial gradients that you drag on the image.
- **Transform** — move, scale, and rotate a layer with handles on its bounds (`Shift` turns in 15° steps). The layer's masks move with it.

### Adjustments

- **Brightness**, **Hue/Saturation**, and **Opacity**, on any layer, the original image included.
- **Each adjustment has its own optional mask**, painted or filled with a gradient, so it applies only where you want it.
- **Several adjustments per layer**, even of the same kind, applied in order. Turn each one off, or all of a layer's adjustments at once.

### Documents

- **`.imagesage` documents** keep the original image, every layer, mask, and adjustment, and the prompts. Double-click a document to open it.
- **Automatic recovery** — two seconds after a change, unsaved work is copied to the app's data folder. After a crash or restart, ImageSage offers to restore it.
- **Export** the combined image as PNG or JPEG, with an optional largest width and height.
- **Tabs** — open several images at once.

### Workspace

- **Zoom and pan** like Photoshop: `Space` + drag pans, `Ctrl` + wheel zooms, and with `Space` held, `Ctrl`+click zooms in and `Ctrl`+`Alt`+click zooms out.
- **Tooltips** on every control.
- **API keys stay safe** — the OpenAI and FLUX keys are stored in Windows Credential Manager. All AI calls run in the Rust side of the app; the keys never reach the user interface.
- **In-app updates** — ImageSage checks GitHub releases and can download and run the new installer.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` | Send the edit |
| `S` / `B` | Square selection / Brush selection (press again to edit the whole image) |
| `M` | Mask tool: paint the selected mask |
| `[` / `]` | Smaller / larger brush |
| `1`–`9`, `0` | Mask brush opacity 10%–90%, 100% |
| `X` | Swap the mask brush between Show and Hide |
| `Alt` (held) | Erase (Brush), or paint the other of Show and Hide (Mask) |
| `R` | Show or hide the red mask view |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo a mask change |
| `Ctrl+D`, `Esc` | Clear the square or the painted area |
| `Enter` / `Esc` | Apply / cancel a Transform |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save As |
| `Space` + drag | Pan |
| `Ctrl` + wheel | Zoom around the pointer |
| `Space` + `Ctrl`+click / `Space` + `Ctrl`+`Alt`+click | Zoom in / out |

---

## Requirements

- Windows 10 or 11 (64-bit).
- An **OpenAI API key** for creating images, whole-image edits, and GPT Image area edits.
- Optional: a **Black Forest Labs (FLUX) API key** for FLUX area edits.

Enter the keys in **Settings** (the status button at the top right of the app).

## Install

Download the latest `ImageSage_x.y.z_x64-setup.exe` from the [releases page](https://github.com/rmirabelle/imagesage/releases/latest) and run it. ImageSage installs for the current user only and does not need administrator rights.

---

## Development

```powershell
npm install
npm run tauri dev
```

- `npm test` runs the unit tests (region math, blending, layers, adjustments, and the document format).
- `.\kill-dev.ps1` stops the dev app and frees the Vite port (14410).
- All AI HTTP calls live in Rust: `src-tauri/src/openai.rs` and `src-tauri/src/flux.rs`.
- Region math and blending live in `src/editor/region.ts`, free of DOM code.

Releases follow [docs/RELEASING.md](docs/RELEASING.md): `set-version.ps1`, a local installer build that is checked by hand, then `publish.ps1`.
