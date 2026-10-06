# Image Sage

An AI image generator and editor for Windows. 

Image Sage generates an image from a prompt, then lets you edit the generated image using professional-grade tools. Each additional generation becomes its own layer, so you can mask it, adjust it, transform it, regenerate it with a better prompt, delete it, etc.

The current frontier LLM for image generation is *ChatGPT Seedance 2.5*. No other model comes close.  

But even GPT has a weakness:

## Diminishing Returns

You generate an image using GPT. The results are amazing. 

You then ask GPT to edit your image, making an adjustment to one area. This engages GPT in an entirely new way. Your first generation was *text-to-image*. This and future edits are *image-to-image*.

GPT faithfully adjusts the original image, making the edit you specify, initially with excellent results.

But there's a problem. 

If you look carefully, GPT's modified image is returned with brand new subtle artifacts. Color in existing areas of the image becomes "patchy". Previously sharp edges lose definition. Lines lose precision. Noise appears. These are subtle imperfections, but they are additive. Each new generation loses more quality.

You may consider sending only a portion of your image to GPT (the area you want changed), so it can't screw up existing areas. But this doesn't work either, because it instructs GPT to do "inpainting" instead of generation. GPT doesn't do inpainting well. Without your full image as context, GPT will add elements that are the wrong size, or wrong color, etc.  

Other LLMs that do accurate inpainting, such as FLUX 3, produce amateur results. 

So, GPT produces the best quality images, but it doesn't do edits well. What's a designer to do?

Image Sage.

---

## Features

### Create and edit with AI

- **New from prompt** — Generate a new image using GPT
- **Open** - Choose your own image to start with
- **Edit the image** - Use professional image editing tools
- **Send multiple edit generations at once** — send a new edit while others still run. Each one shows a waiting row in the layers list, with its progress and a Cancel button, and becomes a layer when it arrives.
- **Regenerate with a new prompt** — regenerate a layer, change the prompt in the prompt bar first, and the result replaces that layer in place. It keeps the layer's name, masks, and adjustments. If it fails, the old layer comes back.
- **Cost estimates** — every edit button shows the estimated price, and the toolbar shows what the image has cost so far.
- **Monthly spend** — the OpenAI button at the top right shows what Image Sage was charged this month; its tooltip also shows today. Use in other apps is not counted.

### Layers

- **Each edit is a layer** above the original image. Show, hide, solo (`Ctrl`+click the eye), rename, reorder (drag), duplicate, regenerate, or delete each layer.
- **Import** an image file as a new layer.
- **Layer masks** — Paint to mask out existing areas of your image that you want to preserve. This is how you overcome GPTs limitations to make edits look like they were perfectly inpainted without artifacts.
- **Mask tools** — a Show and a Hide brush with size and opacity controls, linear and radial gradients, Click to auto-select the subject, invert, and copy and paste between layers and images. A red view shows where the mask hides.
- **Blend modes** — Normal, Screen, or Overlay for each layer. Click the blend mode on the layer card to change it.
- **Transform** — move, scale, and rotate a layer with handles on its bounds (`Shift` turns in 15° steps). The layer's masks move with it.

### Adjustments

- **Brightness**, **Contrast**, **Blur**, **Hue/Saturation**, and **Opacity**, on any layer, the original image included.
- **Each adjustment has its own optional mask**, painted or filled with a gradient, so it applies only where you want it.
- **Several adjustments per layer**, even of the same kind, applied in order. Turn each one off, or all of a layer's adjustments at once. Right-click the adjustments switch to delete them all.

### Documents

- **`.imagesage` documents** keep the original image, every layer, mask, and adjustment, and the prompts. Double-click a document to open it.
- **Automatic recovery** — two seconds after a change, unsaved work is copied to the app's data folder. After a crash or restart, Image Sage offers to restore it.
- **Export** the combined image as PNG or JPEG, with an optional largest width and height.
- **Video slideshow** — export an MP4 (1080p) that shows the original image, then each visible layer fading in with its name.
- **Tabs** — open several images at once.

### Workspace

- **Zoom and pan** like Photoshop: `Space` + drag pans, `Ctrl` + wheel zooms, and with `Space` held, `Ctrl`+click zooms in and `Ctrl`+`Alt`+click zooms out.
- **Tooltips** on every control.
- **API keys stay safe** — the OpenAI key is stored in Windows Credential Manager. All AI calls run in the Rust side of the app; the keys never reach the user interface.
- **In-app updates** — Image Sage checks GitHub releases and can download and run the new installer.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` | Send the edit |
| `M` | Mask tool: paint the selected mask |
| `Ctrl+M` | Add a layer mask to the selected layer |
| `Ctrl+T` | Transform the selected layer |
| `Ctrl+J` | Duplicate the selected layer |
| `Del` | Delete the selected layer (asks first) |
| `[` / `]` | Smaller / larger brush |
| `1`–`9`, `0` | Mask brush opacity 10%–90%, 100% |
| `+` / `-` (number row) | Mask brush opacity up / down by 10% |
| `X` | Swap the mask brush between Show and Hide |
| `Alt` (held) | Paint the other of Show and Hide (Mask) |
| `R` | Show or hide the red mask view |
| `Ctrl+I` | Invert the selected mask (Mask tool on) |
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+R`) | Undo / redo a mask change |
| `Esc` | Turn off the Mask tool, or cancel Regenerate |
| `Enter` / `Esc` | Apply / cancel a Transform |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save As |
| `Space` + drag | Pan |
| `Ctrl` + wheel | Zoom around the pointer |
| `Space` + `Ctrl`+click / `Space` + `Ctrl`+`Alt`+click | Zoom in / out |

---

## Requirements

- Windows 10 or 11 (64-bit).
- An **OpenAI API key** for creating and editing images.

Enter the key in **Settings** (the OpenAI button at the top right of the app). When no key is saved, Settings has a link to the OpenAI API keys page.

## Install

Download the latest `ImageSage_x.y.z_x64-setup.exe` from the [releases page](https://github.com/rmirabelle/imagesage/releases/latest) and run it. Image Sage installs for the current user only and does not need administrator rights.

---

## Development

```powershell
npm install
npm run tauri dev
```

- `npm test` runs the unit tests (GPT Image size rules, prices, layers, adjustments, the slideshow, and the document format).
- `.\kill-dev.ps1` stops the dev app and frees the Vite port (14410).
- All AI HTTP calls live in Rust: `src-tauri/src/openai.rs`.
- GPT Image size rules live in `src/editor/region.ts`, free of DOM code.
- Click to select runs locally with SAM 2.1 (`src-tauri/src/sam.rs`); the app downloads the model on first use.

Releases follow [docs/RELEASING.md](docs/RELEASING.md): `set-version.ps1`, a local installer build that is checked by hand, then `publish.ps1`.
