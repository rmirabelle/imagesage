use serde::Serialize;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    name: String,
    path: String,
    /// One of "folder", "document" (a .imagesage file) or "image" (PNG/JPEG).
    kind: &'static str,
    size: u64,
    modified_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseListing {
    path: String,
    parent: Option<String>,
    entries: Vec<BrowseEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePlace {
    name: String,
    path: String,
    /// One of "home", "desktop", "documents", "pictures", "downloads" or "drive".
    kind: &'static str,
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn file_kind(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "imagesage" => Some("document"),
        "png" | "jpg" | "jpeg" => Some("image"),
        _ => None,
    }
}

#[allow(unused_variables)]
fn is_hidden(name: &str, metadata: &fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if metadata.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    false
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn list_directory(directory: &Path) -> Result<BrowseListing, String> {
    if !directory.is_dir() {
        return Err(format!("{} is not a folder", display_path(directory)));
    }
    let read = fs::read_dir(directory)
        .map_err(|error| format!("Could not read {}: {error}", display_path(directory)))?;
    let mut entries = Vec::new();
    for item in read.flatten() {
        let item_path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        if is_hidden(&name, &metadata) {
            continue;
        }
        let kind = if metadata.is_dir() {
            "folder"
        } else if metadata.is_file() {
            match file_kind(&item_path) {
                Some(kind) => kind,
                None => continue,
            }
        } else {
            continue;
        };
        entries.push(BrowseEntry {
            name,
            path: display_path(&item_path),
            kind,
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "folder")
            .cmp(&(b.kind != "folder"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(BrowseListing {
        path: display_path(directory),
        parent: directory
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(display_path),
        entries,
    })
}

#[tauri::command]
pub fn list_browse_directory(path: String) -> Result<BrowseListing, String> {
    list_directory(&PathBuf::from(path))
}

fn push_place(
    places: &mut Vec<BrowsePlace>,
    name: &str,
    kind: &'static str,
    path: tauri::Result<PathBuf>,
) {
    if let Ok(path) = path {
        if path.is_dir() {
            places.push(BrowsePlace {
                name: name.into(),
                path: display_path(&path),
                kind,
            });
        }
    }
}

#[tauri::command]
pub fn browse_places(app: tauri::AppHandle) -> Vec<BrowsePlace> {
    let resolver = app.path();
    let mut places = Vec::new();
    push_place(&mut places, "Home", "home", resolver.home_dir());
    push_place(&mut places, "Desktop", "desktop", resolver.desktop_dir());
    push_place(
        &mut places,
        "Documents",
        "documents",
        resolver.document_dir(),
    );
    push_place(&mut places, "Pictures", "pictures", resolver.picture_dir());
    push_place(
        &mut places,
        "Downloads",
        "downloads",
        resolver.download_dir(),
    );
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).is_dir() {
            places.push(BrowsePlace {
                name: format!("{}: drive", letter as char),
                path: root,
                kind: "drive",
            });
        }
    }
    places
}

fn validate_entry_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Enter a name.".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("That name is not allowed.".into());
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(r#"A name cannot contain any of these characters: \ / : * ? " < > |"#.into());
    }
    Ok(trimmed)
}

#[tauri::command]
pub fn rename_browse_entry(path: String, new_name: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err("That file no longer exists.".into());
    }
    let name = validate_entry_name(&new_name)?;
    let parent = source
        .parent()
        .ok_or_else(|| "That item cannot be renamed.".to_string())?;
    let target = parent.join(name);
    if target == source {
        return Ok(display_path(&source));
    }
    let same_item_case_change = source
        .file_name()
        .and_then(|current| current.to_str())
        .is_some_and(|current| current.eq_ignore_ascii_case(name));
    if target.exists() && !same_item_case_change {
        return Err(format!("{name} already exists in this folder."));
    }
    fs::rename(&source, &target).map_err(|error| format!("Could not rename: {error}"))?;
    Ok(display_path(&target))
}

/// Moves the item to the Recycle Bin so the user can restore it.
#[tauri::command]
pub fn delete_browse_entry(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("That item no longer exists.".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{
            SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
            FO_DELETE, SHFILEOPSTRUCTW,
        };
        /* The source list is double null-terminated. */
        let mut from: Vec<u16> = target.as_os_str().encode_wide().collect();
        from.push(0);
        from.push(0);
        let mut operation = SHFILEOPSTRUCTW {
            hwnd: Default::default(),
            wFunc: FO_DELETE,
            pFrom: windows::core::PCWSTR(from.as_ptr()),
            pTo: windows::core::PCWSTR::null(),
            fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0)
                as u16,
            fAnyOperationsAborted: false.into(),
            hNameMappings: std::ptr::null_mut(),
            lpszProgressTitle: windows::core::PCWSTR::null(),
        };
        let result = unsafe { SHFileOperationW(&mut operation) };
        if result != 0 || operation.fAnyOperationsAborted.as_bool() {
            return Err(format!(
                "Windows could not move the item to the Recycle Bin (code {result})."
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if target.is_dir() {
            fs::remove_dir_all(&target)
        } else {
            fs::remove_file(&target)
        }
        .map_err(|error| format!("Could not delete: {error}"))
    }
}

/// Places the file on the system clipboard as a file drop, so it can be
/// pasted in File Explorer.
#[tauri::command]
pub fn copy_browse_entry(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("That item no longer exists.".into());
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{GlobalFree, HANDLE, POINT};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::DROPFILES;

        let mut wide: Vec<u16> = target.as_os_str().encode_wide().collect();
        wide.push(0);
        wide.push(0);
        let header = std::mem::size_of::<DROPFILES>();
        let total = header + wide.len() * std::mem::size_of::<u16>();

        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, total)
                .map_err(|error| format!("Could not allocate clipboard memory: {error}"))?;
            let base = GlobalLock(memory) as *mut u8;
            if base.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("Could not lock clipboard memory.".into());
            }
            let drop_files = base as *mut DROPFILES;
            drop_files.write(DROPFILES {
                pFiles: header as u32,
                pt: POINT { x: 0, y: 0 },
                fNC: false.into(),
                fWide: true.into(),
            });
            std::ptr::copy_nonoverlapping(
                wide.as_ptr() as *const u8,
                base.add(header),
                wide.len() * 2,
            );
            let _ = GlobalUnlock(memory);

            OpenClipboard(None).map_err(|error| {
                let _ = GlobalFree(Some(memory));
                format!("Could not open the clipboard: {error}")
            })?;
            let stored = EmptyClipboard()
                .and_then(|_| SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(memory.0))));
            let _ = CloseClipboard();
            if let Err(error) = stored {
                let _ = GlobalFree(Some(memory));
                return Err(format!("Could not copy to the clipboard: {error}"));
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Copying files to the clipboard is only supported on Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_names() {
        assert!(validate_entry_name("  ").is_err());
        assert!(validate_entry_name("a/b").is_err());
        assert!(validate_entry_name("..").is_err());
        assert_eq!(
            validate_entry_name(" ok.imagesage ").unwrap(),
            "ok.imagesage"
        );
    }

    #[test]
    fn lists_only_folders_and_supported_files() {
        let root =
            std::env::temp_dir().join(format!("imagesage-browse-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::write(root.join("b.imagesage"), b"").unwrap();
        fs::write(root.join("A.PNG"), b"").unwrap();
        fs::write(root.join("notes.txt"), b"").unwrap();
        fs::write(root.join(".hidden.png"), b"").unwrap();

        let listing = list_directory(&root).unwrap();
        let names: Vec<_> = listing
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                ("zeta", "folder"),
                ("A.PNG", "image"),
                ("b.imagesage", "document")
            ]
        );
        assert!(listing.parent.is_some());

        fs::remove_dir_all(&root).unwrap();
    }
}
