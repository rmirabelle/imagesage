# ImageSage release playbook

This is the durable source of truth for building, testing, and publishing ImageSage.
Do not publish directly from memory or bypass `publish.ps1`.

## Windows installer contract

ImageSage follows the shared XSage installer protocol used by DB Sage and the other
XSage desktop applications:

- Installation is **per-user** (`currentUser`), under the user's local application
  data. Do not change it to `perMachine` or Program Files without an explicit new
  product decision and a full installer migration plan.
- `src-tauri/installer.nsi` is the shared custom XSage NSIS template.
- `src-tauri/icons/icon.ico` must be both the bundle icon and a bundled resource.
- The installer copies the icon to
  `C:\Users\Public\${PRODUCTNAME}\icon.ico`, then assigns that explicit path and
  the AppUserModelId to Start Menu and optional desktop shortcuts. Explorer does
  not reliably expand an environment-variable icon path in shortcut metadata.
- Release builds use the Windows GUI PE subsystem. The release executable must
  never open a console window.
- First installation does not offer an uninstall choice. A same-version manual
  rerun offers repair/reinstall or uninstall; a newer manual installer offers the
  upgrade flow. Windows Settings also contains the normal uninstall entry.
- ImageSage is a normal windowed application: closing its window quits it (after
  an unsaved-work prompt). The installer template is copied unchanged from
  IconSage (`D:/Code/IconSage/src-tauri/installer.nsi`). In-app updates exit
  ImageSage before launching setup.
- The OpenAI API key is entered by the user at runtime and stored in Windows
  Credential Manager. No key or token is ever embedded in the binary.

`publish.ps1` validates these rules before it creates a tag and validates the
generated executable and NSIS script again after the release build.

## Release workflow

1. Stop the Tauri dev process (`.\kill-dev.ps1`). The single-instance plugin
   routes a second launch to whichever ImageSage is already running.
2. Synchronize the intended semantic version:

   ```powershell
   .\set-version.ps1 0.2.0
   ```

3. Review the version changes, build the installer locally, and resolve every
   warning or error:

   ```powershell
   npm run tauri build
   ```

4. Install that exact local NSIS bundle from
   `src-tauri\target\release\bundle\nsis` and manually verify:

   - no console window appears;
   - ImageSage opens its main window, and closing it quits the process;
   - Start Menu and optional desktop shortcuts show the ImageSage icon (test a
     **GUI** install, not `/S`; silent installs order shortcut creation differently);
   - double-clicking an `.imagesage` file opens it in ImageSage;
   - the fresh install, same-version repair, upgrade, and uninstall paths all
     behave as expected.

5. Commit and push the reviewed source changes. Publishing requires a clean work
   tree and the public `rmirabelle/imagesage` origin.
6. Confirm GitHub CLI authentication, then publish:

   ```powershell
   gh auth status
   .\publish.ps1
   ```

7. Confirm the printed release URL and test the app's update check if the release
   is intended to update an older installed version.

Do not run `publish.ps1` until the local installer has passed the manual check.
The script creates and verifies the new public release first, then deletes every
older release and its tag, except the `model-*` releases. If verification fails before cleanup, older releases
are intentionally preserved.

## Local models

The app's local models are downloaded on first use from `model-*` releases in
this repo. Each is a prerelease that is never marked latest, so the update
check never sees it, and `publish.ps1` never deletes releases tagged `model-*`.
`src-tauri/src/models.rs` pins each file's URL, size and SHA-256; a new model
needs a new `model-*` release and new constants there.

- `model-birefnet-v1`: BiRefNet general, for subject detection. The app no
  longer uses it; the release stays so older installed versions keep working.
- `model-sam2-small-v1`: SAM 2.1 Small (Apache 2.0,
  github.com/facebookresearch/sam2), encoder and decoder exported by
  `tools/model/export_sam2.py`. Used by click to select (`sam.rs`).

ONNX Runtime is linked into `imagesage.exe`. Its GPU backend, `DirectML.dll`,
is copied by `src-tauri/build.rs` into `src-tauri/` (gitignored) and bundled as
a resource, so the installer puts it next to the exe. Check that it is there
after a local install.

## Windows PowerShell 5.1 note

`set-version.ps1` and `publish.ps1` run under Windows PowerShell 5.1 with
`$ErrorActionPreference = "Stop"`. In 5.1, a native command's stderr output
becomes a `NativeCommandError` record whenever stderr is redirected or the host
is not a plain console (for example an agent tool, CI, or `*> $null`). Under
`Stop`, the first such line aborts the script even though the command succeeded:
`cargo` prints `Compiling ...` to stderr, and `gh release view` prints
`release not found` to stderr.

Both scripts therefore call every native command (`git`, `gh`, `npm`, `cargo`)
through the `Invoke-Native` helper, which temporarily sets the preference to
`Continue` and fails on the exit code instead. Keep that pattern when adding new
native calls; never call a native command directly in these scripts. Red
`NativeCommandError` text in a captured run is only echoed stderr, not a failure.
The scripts can be run directly from any host; a separate console window is not
required.

## Codex workspace note

If Git reports dubious ownership only inside the managed Codex environment, use a
process-local safe-directory override rather than changing the user's global Git
configuration:

```powershell
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = 'D:/Code/ImageSage'
.\publish.ps1
```

This override is an automation-environment workaround, not part of normal ImageSage
installation or publishing.
