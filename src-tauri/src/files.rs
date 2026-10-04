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
