use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Response, window::Color, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/**
 * The video window: a second, small window that makes a short clip from one
 * layer with the local engine (Wan 2.2), plays it, and saves it. The editor
 * has no video layers; it only sends a layer's picture and prompt here.
 *
 * A clip stays in memory only. Image Sage writes a video to the disk only
 * when the user saves it, to the file the user chooses.
 */
pub const WINDOW: &str = "video";

/// What the editor sends for the next clip.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    /// The layer's picture, as a PNG data URL.
    image: String,
    /// The layer's prompt, as the start of the clip's prompt.
    prompt: String,
    /// The layer's name, for the window's heading.
    name: String,
}

/// The source that waits for the video window to take it.
#[derive(Default)]
pub struct PendingVideoSource(Mutex<Option<VideoSource>>);

/// Keeps the source and shows the video window; the window is made on first use.
#[tauri::command]
pub async fn video_open(app: AppHandle, pending: State<'_, PendingVideoSource>, source: VideoSource) -> Result<(), String> {
    *pending.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(source);
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = app.emit_to(WINDOW, "video-source", ());
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("Image Sage Video")
        .inner_size(760.0, 760.0)
        .min_inner_size(520.0, 520.0)
        .decorations(false)
        .shadow(true)
        .background_color(Color(0x22, 0x25, 0x2f, 0xff))
        .build()
        .map_err(|error| format!("Could not open the video window: {error}"))?;
    Ok(())
}

/// The source the editor sent last, once.
#[tauri::command]
pub fn video_take_source(pending: State<'_, PendingVideoSource>) -> Option<VideoSource> {
    pending.0.lock().unwrap_or_else(|error| error.into_inner()).take()
}

/// One clip as WebM bytes, and whether the user saved it.
struct Clip {
    bytes: Vec<u8>,
    saved: bool,
}

/// The current clip, in memory. A new clip replaces it; closing the video window removes it.
#[derive(Default)]
pub struct CurrentClip(Mutex<Option<Clip>>);

impl CurrentClip {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Clip>> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Keeps a new clip as the current one.
pub fn keep_clip(app: &AppHandle, bytes: Vec<u8>) {
    *app.state::<CurrentClip>().lock() = Some(Clip { bytes, saved: false });
}

/// Removes the current clip from memory.
pub fn discard_clip(app: &AppHandle) {
    app.state::<CurrentClip>().lock().take();
}

/**
 * The main window closed. With a clip that is not saved, the video window
 * stays and asks the user to save it; if not, the video window closes too,
 * so the app can exit.
 */
pub fn main_window_closed(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW) else { return };
    let unsaved = app.state::<CurrentClip>().lock().as_ref().is_some_and(|clip| !clip.saved);
    if unsaved {
        let _ = app.emit_to(WINDOW, "video-close-requested", ());
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = window.destroy();
    }
}

/// The current clip's WebM bytes, for the video window's player.
#[tauri::command]
pub fn video_read(clip: State<'_, CurrentClip>) -> Result<Response, String> {
    let bytes = clip.lock().as_ref().map(|clip| clip.bytes.clone()).ok_or("There is no video.")?;
    Ok(Response::new(bytes))
}

pub fn is_webm_name(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("webm"))
}

/// Saves the current clip to the file the user chose. Only a `.webm` name is written, so the webview cannot use this to replace another file type.
#[tauri::command]
pub fn video_save(clip: State<'_, CurrentClip>, path: String) -> Result<(), String> {
    if !is_webm_name(&path) {
        return Err("The video file name must end with .webm.".into());
    }
    let mut current = clip.lock();
    let clip = current.as_mut().ok_or("There is no video to save.")?;
    std::fs::write(&path, &clip.bytes).map_err(|error| format!("Could not save {path}: {error}"))?;
    clip.saved = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_webm_names_are_saved() {
        assert!(is_webm_name(r"D:\Clips\fox.webm"));
        assert!(is_webm_name(r"D:\Clips\fox.WEBM"));
        assert!(!is_webm_name(r"D:\Clips\fox.exe"));
        assert!(!is_webm_name(r"D:\Clips\webm"));
    }
}
