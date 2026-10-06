use base64::{engine::general_purpose::STANDARD, Engine as _};

#[tauri::command]
pub fn save_image(path: String, data_url: String) -> Result<(), String> {
    let (_, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "The editor produced an invalid image".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Could not decode the image: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("Could not save {path}: {error}"))
}

/// Runs File Explorer with one raw argument, so a path with spaces stays one path.
fn run_explorer(argument: String) -> Result<(), String> {
    let mut command = std::process::Command::new("explorer");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.raw_arg(argument);
    }
    #[cfg(not(windows))]
    command.arg(argument);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open File Explorer: {error}"))
}

/// Opens the folder of an existing file in File Explorer, with the file selected.
#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("{path} no longer exists"));
    }
    run_explorer(format!("/select,\"{path}\""))
}

/**
 * Plays an exported MP4 video in the default video app. Only existing .mp4
 * files are opened, so the webview cannot use this to start a program.
 */
#[tauri::command]
pub fn play_video(path: String) -> Result<(), String> {
    let file = std::path::Path::new(&path);
    let is_mp4 = file
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"));
    if !is_mp4 || !file.is_file() {
        return Err(format!("{path} is not an MP4 video that exists"));
    }
    run_explorer(format!("\"{path}\""))
}

/// Writes an error from the webview to the app's error output, so crashes show in the dev log.
#[tauri::command]
pub fn log_frontend_error(message: String) {
    eprintln!("[imagesage] frontend error: {}", message.chars().take(4000).collect::<String>());
}

/// Returns the OS cursor position in physical pixels, for the window-control hover fix.
#[tauri::command]
pub fn cursor_position() -> (i32, i32) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            let _ = GetCursorPos(&mut point);
        }
        (point.x, point.y)
    }
    #[cfg(not(windows))]
    {
        (0, 0)
    }
}
