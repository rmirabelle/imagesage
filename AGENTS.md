# ImageSage repository instructions

## Release memory

- Read `docs/RELEASING.md` before changing installer configuration, preparing a
  release, or publishing.
- Preserve the shared XSage per-user installer contract. Do not switch to
  `perMachine` or Program Files unless the user explicitly reopens that product
  decision.
- Keep `src-tauri/installer.nsi`, the bundled `icons/icon.ico` resource, and the
  Windows GUI-subsystem attribute intact.
- `publish.ps1` builds and checks the installer; no manual installer check is
  needed. A local build is not authorization to publish. "Publish" from the
  user includes committing and pushing (the script pushes).
- Use `set-version.ps1` and `publish.ps1`; do not manually create release tags or
  GitHub releases.
- Inside those scripts, call `git`, `gh`, `npm`, and `cargo` only through the
  `Invoke-Native` helper. Windows PowerShell 5.1 otherwise aborts on harmless
  stderr output (see `docs/RELEASING.md`).
- The publish workflow intentionally deletes superseded releases only after the
  new release and its installer asset pass verification. It never deletes
  `model-*` releases; they hold the subject model.

## Development process

- Restart the dev app after runtime edits when needed for user testing.
- Do not start the dev app while an installed ImageSage is running; the
  single-instance plugin would route the launch to it. Stop it first.
- Stop the dev app with `.\kill-dev.ps1` (tree-kills `imagesage.exe` and frees
  Vite port 14410).
- All AI HTTP calls live in Rust: OpenAI GPT Image creates and edits images
  (`src-tauri/src/openai.rs`). The API key stays in Windows Credential Manager
  and never reaches the webview.
- Click to select runs locally through ONNX Runtime with SAM 2.1 in
  `src-tauri/src/sam.rs`. `src-tauri/src/models.rs` downloads the model on
  first use from this repo's `model-*` releases, which `publish.ps1` keeps;
  see `docs/RELEASING.md`.
- GPT Image size rules live in `src/editor/region.ts` and are unit-tested
  (`npm test`). Keep them free of DOM code.
- In managed Codex sessions, prefer process-local Git `safe.directory` variables
  documented in `docs/RELEASING.md`; never alter the user's global Git config.
