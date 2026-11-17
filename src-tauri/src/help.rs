use tauri::{window::Color, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/**
 * The help window: a second window that shows the help chapters. It loads the
 * same page as the editor; its window label selects the help view.
 *
 * Dev builds also have `help_capture`, which makes the pictures for the
 * chapters: it photographs one part of the calling window and writes it to
 * `public/help/` in the project folder.
 */
pub const WINDOW: &str = "help";

/**
 * Shows the help window; the window is made on first use. `chapter` selects
 * the chapter to show. `quiet` (the dev layout check) does not bring the
 * window to the front, so it does not take the keyboard from the user's work.
 */
#[tauri::command]
pub async fn help_open(app: AppHandle, chapter: Option<String>, quiet: Option<bool>) -> Result<(), String> {
    let quiet = quiet.unwrap_or(false);
    if let Some(window) = app.get_webview_window(WINDOW) {
        if let Some(chapter) = chapter {
            let _ = app.emit_to(WINDOW, "help-chapter", chapter);
        }
        if !quiet {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(());
    }
    let url = match chapter.filter(|chapter| chapter.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        Some(chapter) => format!("index.html#{chapter}"),
        None => "index.html".into(),
    };
    WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App(url.into()))
        .title("Image Sage Help")
        .inner_size(980.0, 760.0)
        .min_inner_size(640.0, 420.0)
        .decorations(false)
        .shadow(true)
        .background_color(Color(0x22, 0x25, 0x2f, 0xff))
        .focused(!quiet)
        .build()
        .map_err(|error| format!("Could not open the help window: {error}"))?;
    Ok(())
}

/// The main window closed: the help window closes too, so the app can exit.
pub fn main_window_closed(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.destroy();
    }
}

/// True for a picture name made only of lowercase letters, digits and hyphens.
pub fn is_shot_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 60 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/**
 * Dev builds only: photographs the rectangle (`x`, `y`, `width`, `height`, in
 * CSS pixels of the calling window) and writes it as `public/help/<name>.png`.
 * `scale` is the number of picture pixels for each pixel the webview draws.
 */
#[tauri::command]
pub async fn help_capture(window: WebviewWindow, name: String, x: f64, y: f64, width: f64, height: f64, scale: f64) -> Result<String, String> {
    #[cfg(all(debug_assertions, windows))]
    {
        capture::capture(window, name, x, y, width, height, scale).await
    }
    #[cfg(not(all(debug_assertions, windows)))]
    {
        let _ = (window, name, x, y, width, height, scale);
        Err("Help pictures are made in dev builds only.".into())
    }
}

/**
 * Dev builds only: `on` makes the calling window's page draw at the standard
 * size for help pictures (1280 by 800 CSS pixels, two picture pixels for
 * each), so the pictures are the same on every screen. The window itself does
 * not change size and does not come to the front, so the user can work in
 * another program during a capture run. `on: false` ends it.
 */
#[tauri::command]
pub async fn help_stage(window: WebviewWindow, on: bool) -> Result<(), String> {
    #[cfg(all(debug_assertions, windows))]
    {
        let (method, params) = if on {
            ("Emulation.setDeviceMetricsOverride", serde_json::json!({ "width": 1280, "height": 800, "deviceScaleFactor": 2, "mobile": false }))
        } else {
            ("Emulation.clearDeviceMetricsOverride", serde_json::json!({}))
        };
        capture::call(window, method, params.to_string()).await.map(|_| ())
    }
    #[cfg(not(all(debug_assertions, windows)))]
    {
        let _ = (window, on);
        Err("Help pictures are made in dev builds only.".into())
    }
}

#[cfg(all(debug_assertions, windows))]
mod capture {
    use base64::Engine;
    use std::{sync::mpsc, time::Duration};
    use tauri::WebviewWindow;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    /// The folder for the help pictures, in the project folder.
    const FOLDER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../public/help");

    /// Calls one DevTools protocol method of the window's webview and returns its JSON answer.
    pub async fn call(window: WebviewWindow, method: &'static str, params: String) -> Result<String, String> {
        // The webview must be called on the main thread; its answer comes back through the channel.
        let (sender, receiver) = mpsc::channel::<Result<String, String>>();
        let failed = sender.clone();
        window
            .with_webview(move |webview| {
                let started = (|| unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let method = CoTaskMemPWSTR::from(method);
                    let params = CoTaskMemPWSTR::from(params.as_str());
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                        let _ = sender.send(result.map(|_| json).map_err(|error| error.to_string()));
                        Ok(())
                    }));
                    core.CallDevToolsProtocolMethod(*method.as_ref().as_pcwstr(), *params.as_ref().as_pcwstr(), &handler)
                })();
                if let Err(error) = started {
                    let _ = failed.send(Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;

        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(15)))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|_| format!("The webview did not answer {method}."))?
    }

    pub async fn capture(window: WebviewWindow, name: String, x: f64, y: f64, width: f64, height: f64, scale: f64) -> Result<String, String> {
        if !super::is_shot_name(&name) {
            return Err(format!("\"{name}\" is not a valid picture name."));
        }
        if !(width >= 1.0 && height >= 1.0 && x >= 0.0 && y >= 0.0 && scale > 0.0 && scale <= 4.0) {
            return Err(format!("The rectangle for \"{name}\" is not valid."));
        }
        let params = serde_json::json!({
            "format": "png",
            "captureBeyondViewport": false,
            "clip": { "x": x, "y": y, "width": width, "height": height, "scale": scale }
        });
        let json = call(window, "Page.captureScreenshot", params.to_string()).await?;
        let answer: serde_json::Value = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let data = answer.get("data").and_then(|data| data.as_str()).ok_or("The webview sent no picture.")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| error.to_string())?;

        std::fs::create_dir_all(FOLDER).map_err(|error| format!("Could not make {FOLDER}: {error}"))?;
        let path = format!("{FOLDER}/{name}.png");
        std::fs::write(&path, bytes).map_err(|error| format!("Could not write {path}: {error}"))?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picture_names_cannot_leave_the_folder() {
        assert!(is_shot_name("paint-toolbar-brush"));
        assert!(!is_shot_name("../secret"));
        assert!(!is_shot_name("Paint"));
        assert!(!is_shot_name("a.png"));
        assert!(!is_shot_name(""));
    }
}
