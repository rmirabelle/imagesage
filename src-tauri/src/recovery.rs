use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf};
use tauri::{AppHandle, Manager};

use crate::document;

/**
 * Automatic recovery. Each open image with unsaved changes is written, as an
 * ordinary `.imagesage` document, to the app's local data folder. After a
 * crash or restart the app reopens these files. A file is removed when its
 * image is saved, closed, or discarded.
 *
 * Layers are large and rarely change, so the app sends each layer image and
 * mask only once, into a tile store beside the recovery file
 * (`<id>.tiles/<key>.png`). A recovery save then sends only the manifest and
 * the tile keys; the document is assembled here, on a worker thread.
 */
fn recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not find the app data folder: {error}"))?
        .join("recovery");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the recovery folder: {error}"))?;
    Ok(dir)
}

/// Recovery ids come from the frontend; only plain ids may become file names.
fn recovery_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    if !valid {
        return Err("Invalid recovery id".into());
    }
    Ok(recovery_dir(app)?.join(format!("{id}.imagesage")))
}

fn tile_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(recovery_file(app, id)?.with_extension("tiles"))
}

/// Tile keys come from the frontend; only plain keys may become file names.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 120
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn remove_tile_dir(dir: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the recovery tiles: {error}")),
    }
}

async fn on_worker<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("The recovery task stopped unexpectedly: {error}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTile {
    key: String,
    data_url: String,
}

#[derive(Deserialize)]
pub struct TileRef {
    path: String,
    key: String,
}

/// Stores tiles (layer images and masks) for later recovery saves.
#[tauri::command]
pub async fn recovery_put_tiles(
    app: AppHandle,
    id: String,
    tiles: Vec<StoredTile>,
) -> Result<(), String> {
    let dir = tile_dir(&app, &id)?;
    on_worker(move || {
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not create the recovery tiles folder: {error}"))?;
        for tile in tiles {
            if !valid_key(&tile.key) {
                return Err("Invalid recovery tile key".into());
            }
            let bytes = document::decode_png_data_url(&tile.data_url, "recovery tile")?;
            let target = dir.join(format!("{}.png", tile.key));
            let temporary = dir.join(format!("{}.png.saving", tile.key));
            std::fs::write(&temporary, bytes)
                .map_err(|error| format!("Could not write a recovery tile: {error}"))?;
            std::fs::rename(&temporary, &target)
                .map_err(|error| format!("Could not write a recovery tile: {error}"))?;
        }
        Ok(())
    })
    .await
}

/**
 * Writes the recovery document from stored tiles: `tiles` maps each tile path
 * in the manifest to a stored key, and `image_key` names the stored tile used
 * as the document's preview image. Stored tiles that are no longer used are removed.
 */
#[tauri::command]
pub async fn recovery_save(
    app: AppHandle,
    id: String,
    manifest_json: String,
    image_key: String,
    tiles: Vec<TileRef>,
) -> Result<(), String> {
    let path = recovery_file(&app, &id)?;
    let dir = tile_dir(&app, &id)?;
    on_worker(move || {
        let read = |key: &str| -> Result<Vec<u8>, String> {
            if !valid_key(key) {
                return Err("Invalid recovery tile key".into());
            }
            std::fs::read(dir.join(format!("{key}.png")))
                .map_err(|error| format!("A recovery tile is missing: {error}"))
        };
        let image_bytes = read(&image_key)?;
        let mut used: HashSet<String> = HashSet::from([format!("{image_key}.png")]);
        let mut parts = Vec::with_capacity(tiles.len());
        for tile in &tiles {
            parts.push((tile.path.clone(), read(&tile.key)?));
            used.insert(format!("{}.png", tile.key));
        }
        document::write_document(&path, &manifest_json, image_bytes, parts)?;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !used.contains(&name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    })
    .await
}

/**
 * Saves a document to `path` (the user's file) from tiles already in the tile
 * store of document `id`, sent before with `recovery_put_tiles`. Large
 * documents then never travel in one message; one very large message can stall
 * the save. `data_url` is the preview image. Stored tiles are kept, because the
 * recovery copy may still use them.
 */
#[tauri::command]
pub async fn save_document_from_tiles(
    app: AppHandle,
    id: String,
    path: String,
    manifest_json: String,
    data_url: String,
    tiles: Vec<TileRef>,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !document::is_document_path(&target) {
        return Err("An ImageSage document must have the .imagesage extension".into());
    }
    let dir = tile_dir(&app, &id)?;
    on_worker(move || {
        let image_bytes = document::decode_png_data_url(&data_url, "document image")?;
        let mut parts = Vec::with_capacity(tiles.len());
        for tile in &tiles {
            if !valid_key(&tile.key) {
                return Err("Invalid tile key".into());
            }
            let bytes = std::fs::read(dir.join(format!("{}.png", tile.key)))
                .map_err(|error| format!("A layer image for the save is missing: {error}"))?;
            parts.push((tile.path.clone(), bytes));
        }
        document::write_document(&target, &manifest_json, image_bytes, parts)
    })
    .await
}

/// Paths of every recovery file left from an earlier run.
#[tauri::command]
pub fn recovery_list(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = recovery_dir(&app)?;
    let entries = std::fs::read_dir(&dir)
        .map_err(|error| format!("Could not read the recovery folder: {error}"))?;
    let mut paths: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| document::is_document_path(path))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    paths.sort();
    Ok(paths)
}

#[tauri::command]
pub fn recovery_remove(app: AppHandle, id: String) -> Result<(), String> {
    let path = recovery_file(&app, &id)?;
    remove_tile_dir(&path.with_extension("tiles"))?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the recovery file: {error}")),
    }
}

/// Removes the recovery file at a listed path, after it has been reopened.
#[tauri::command]
pub fn recovery_remove_path(app: AppHandle, path: String) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    let target = PathBuf::from(&path);
    if target.parent() != Some(dir.as_path()) || !document::is_document_path(&target) {
        return Err("That file is not in the recovery folder".into());
    }
    remove_tile_dir(&target.with_extension("tiles"))?;
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the recovery file: {error}")),
    }
}
