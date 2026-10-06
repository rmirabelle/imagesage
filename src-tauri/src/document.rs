use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const DOCUMENT_FORMAT: &str = "imagesage-document";
/// Version 2 stores each step as a full layer (with an optional mask) and the original image as `history/base.png`.
const DOCUMENT_VERSION: u64 = 2;
/// The oldest format this app still opens: version 1 stored each step as before/after tiles.
const OLDEST_DOCUMENT_VERSION: u64 = 1;
const DOCUMENT_EXTENSION: &str = "imagesage";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_HISTORY_STEPS: usize = 2000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedImageFile {
    kind: &'static str,
    data_url: String,
    width: u32,
    height: u32,
    manifest_json: Option<String>,
    history_tiles: Vec<HistoryTile>,
}

/// One before/after tile of an edit step, stored under `history/` in the archive.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTile {
    path: String,
    data_url: String,
}

fn image_details(bytes: &[u8]) -> Result<(&'static str, u32, u32), String> {
    let format = image::guess_format(bytes)
        .map_err(|_| "The selected file is not a supported PNG or JPEG image".to_string())?;
    let mime_type = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        _ => return Err("Image Sage can open PNG and JPEG images".into()),
    };
    let decoded = image::load_from_memory_with_format(bytes, format)
        .map_err(|error| format!("Could not decode the image: {error}"))?;
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return Err("The image has no visible pixels".into());
    }
    Ok((mime_type, width, height))
}

fn data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))
}

/// The size of a PNG or JPEG from its header, without decoding the pixels.
fn image_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Could not read the image: {error}"))?
        .into_dimensions()
        .map_err(|error| format!("Could not read the image size: {error}"))
}

pub(crate) fn decode_png_data_url(value: &str, label: &str) -> Result<Vec<u8>, String> {
    let (prefix, encoded) = value
        .split_once(',')
        .ok_or_else(|| format!("The {label} is invalid"))?;
    if !prefix.eq_ignore_ascii_case("data:image/png;base64") {
        return Err(format!("The {label} must be a PNG image"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Could not decode the {label}: {error}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(format!("The {label} is too large to save safely"));
    }
    if image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png) {
        return Err(format!("The {label} is not a PNG image"));
    }
    Ok(bytes)
}

/// True for `adjust-N-mask.png`, the mask of a layer's adjustment number N (from 1).
fn is_adjust_mask_name(name: &str) -> bool {
    let Some(number) = name
        .strip_prefix("adjust-")
        .and_then(|rest| rest.strip_suffix("-mask.png"))
    else {
        return false;
    };
    (1..=4).contains(&number.len()) && number.bytes().all(|byte| byte.is_ascii_digit())
}

/// Accepts only `history/base.png`, `history/base-adjust-N-mask.png`, and
/// `history/NNNN-{before,after,layer,mask,adjust-N-mask}.png`.
fn is_history_tile_path(path: &str) -> bool {
    let Some(name) = path.strip_prefix("history/") else {
        return false;
    };
    if name == "base.png" {
        return true;
    }
    if let Some(rest) = name.strip_prefix("base-") {
        return is_adjust_mask_name(rest);
    }
    let Some((number, suffix)) = name.split_once('-') else {
        return false;
    };
    number.len() == 4
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && (matches!(
            suffix,
            "before.png" | "after.png" | "layer.png" | "mask.png"
        ) || is_adjust_mask_name(suffix))
}

/// The tile paths of a layer's adjustment masks. A mask stored in the manifest
/// itself (a data URL, from an earlier version) is not a tile.
fn adjust_mask_tiles(adjust: Option<&Value>) -> Vec<&str> {
    adjust
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|adjustment| adjustment.get("mask").and_then(Value::as_str))
                .filter(|mask| !mask.starts_with("data:"))
                .collect()
        })
        .unwrap_or_default()
}

fn read_limited(entry: &mut zip::read::ZipFile<'_>, maximum: u64) -> Result<Vec<u8>, String> {
    if entry.size() > maximum {
        return Err(format!("{} is too large to open safely", entry.name()));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {}: {error}", entry.name()))?;
    Ok(bytes)
}

fn validate_manifest(manifest: &Value) -> Result<(), String> {
    if manifest.get("format").and_then(Value::as_str) != Some(DOCUMENT_FORMAT) {
        return Err("This is not an Image Sage document".into());
    }
    let version = manifest
        .get("formatVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The Image Sage document has no valid format version".to_string())?;
    if !(OLDEST_DOCUMENT_VERSION..=DOCUMENT_VERSION).contains(&version) {
        return Err(format!(
            "This Image Sage document uses unsupported format version {version}"
        ));
    }
    Ok(())
}

/// Every tile path the manifest's history refers to, validated by name.
fn history_tile_paths(manifest: &Value) -> Result<Vec<String>, String> {
    let Some(history) = manifest.get("history") else {
        return Ok(Vec::new());
    };
    let steps = history
        .as_array()
        .ok_or_else(|| "The Image Sage document history is invalid".to_string())?;
    if steps.len() > MAX_HISTORY_STEPS {
        return Err("The Image Sage document history is too long to open safely".into());
    }
    let mut paths = Vec::with_capacity(steps.len() * 2 + 1);
    let mut add = |path: &str| -> Result<(), String> {
        if !is_history_tile_path(path) {
            return Err(format!("The document references an invalid tile: {path}"));
        }
        paths.push(path.to_string());
        Ok(())
    };
    if let Some(base) = manifest.get("base").and_then(Value::as_str) {
        add(base)?;
    }
    for mask in adjust_mask_tiles(manifest.get("baseAdjust")) {
        add(mask)?;
    }
    for step in steps {
        let tile = |key: &str| step.get(key).and_then(Value::as_str);
        // A layer step has a full image (and maybe a mask); an older step has before/after tiles.
        match (tile("layer"), tile("before"), tile("after")) {
            (Some(layer), _, _) => {
                add(layer)?;
                if let Some(mask) = tile("layerMask") {
                    add(mask)?;
                }
            }
            (None, Some(before), Some(after)) => {
                add(before)?;
                add(after)?;
            }
            _ => return Err("An edit step has no image tiles".into()),
        }
        for mask in adjust_mask_tiles(step.get("adjust")) {
            add(mask)?;
        }
    }
    Ok(paths)
}

fn open_document(path: &Path, include_history: bool) -> Result<OpenedImageFile, String> {
    let file = File::open(path).map_err(|error| format!("Could not open the document: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("Could not read the Image Sage document: {error}"))?;

    let manifest_bytes = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "The Image Sage document is missing manifest.json".to_string())?;
        read_limited(&mut entry, MAX_MANIFEST_BYTES)?
    };
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("The Image Sage document manifest is invalid: {error}"))?;
    validate_manifest(&manifest)?;

    let image_bytes = {
        let mut entry = archive
            .by_name("image.png")
            .map_err(|_| "The Image Sage document is missing its image".to_string())?;
        read_limited(&mut entry, MAX_IMAGE_BYTES)?
    };
    let (mime_type, width, height) = image_details(&image_bytes)?;

    let mut history_tiles = Vec::new();
    if include_history {
        for tile_path in history_tile_paths(&manifest)? {
            let bytes = {
                let mut entry = archive
                    .by_name(&tile_path)
                    .map_err(|_| format!("The Image Sage document is missing {tile_path}"))?;
                read_limited(&mut entry, MAX_IMAGE_BYTES)?
            };
            history_tiles.push(HistoryTile {
                path: tile_path,
                data_url: data_url("image/png", &bytes),
            });
        }
    }

    Ok(OpenedImageFile {
        kind: "document",
        data_url: data_url(mime_type, &image_bytes),
        width,
        height,
        manifest_json: Some(manifest.to_string()),
        history_tiles,
    })
}

fn open_plain_image(path: &Path) -> Result<OpenedImageFile, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Could not inspect the selected image: {error}"))?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("The selected image is too large to open safely".into());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read the selected image: {error}"))?;
    let (mime_type, width, height) = image_details(&bytes)?;
    Ok(OpenedImageFile {
        kind: "image",
        data_url: data_url(mime_type, &bytes),
        width,
        height,
        manifest_json: None,
        history_tiles: Vec::new(),
    })
}

pub fn is_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(DOCUMENT_EXTENSION))
}

#[tauri::command]
pub fn open_image_file(path: String, include_history: bool) -> Result<OpenedImageFile, String> {
    let path = Path::new(&path);
    if is_document_path(path) {
        open_document(path, include_history)
    } else {
        open_plain_image(path)
    }
}

/// Saves a document on a worker thread, so the window keeps responding while the file is written.
#[tauri::command]
pub async fn save_imagesage_document(
    path: String,
    manifest_json: String,
    data_url: String,
    history_tiles: Vec<HistoryTile>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_document(path, manifest_json, data_url, history_tiles)
    })
    .await
    .map_err(|error| format!("The save stopped unexpectedly: {error}"))?
}

fn save_document(
    path: String,
    manifest_json: String,
    data_url: String,
    history_tiles: Vec<HistoryTile>,
) -> Result<(), String> {
    let image_bytes = decode_png_data_url(&data_url, "document image")?;
    let mut tiles = Vec::with_capacity(history_tiles.len());
    for tile in history_tiles {
        let bytes = decode_png_data_url(&tile.data_url, "history tile")?;
        tiles.push((tile.path, bytes));
    }
    write_document(Path::new(&path), &manifest_json, image_bytes, tiles)
}

/**
 * Writes a document from its parts: the manifest, the image shown in previews,
 * and every history tile the manifest names, as (path, PNG bytes).
 */
pub(crate) fn write_document(
    target: &Path,
    manifest_json: &str,
    image_bytes: Vec<u8>,
    tiles: Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let mut manifest: Value = serde_json::from_str(manifest_json)
        .map_err(|error| format!("Could not serialize the Image Sage document: {error}"))?;
    validate_manifest(&manifest)?;
    let (width, height) = image_size(&image_bytes)?;
    let image = manifest
        .get_mut("image")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "The Image Sage document has no image metadata".to_string())?;
    image.insert("path".into(), Value::String("image.png".into()));
    image.insert("width".into(), Value::from(width));
    image.insert("height".into(), Value::from(height));

    let referenced: HashSet<String> = history_tile_paths(&manifest)?.into_iter().collect();
    let mut written = HashSet::new();
    for (tile_path, _) in &tiles {
        if !is_history_tile_path(tile_path) || !referenced.contains(tile_path) {
            return Err(format!("Unexpected history tile: {tile_path}"));
        }
        if !written.insert(tile_path.clone()) {
            return Err(format!("Duplicate history tile: {tile_path}"));
        }
    }
    if let Some(missing) = referenced.iter().find(|path| !written.contains(*path)) {
        return Err(format!("The history tile {missing} is missing"));
    }

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Could not serialize the Image Sage document: {error}"))?;

    // Write beside the target, then swap it in, so a failed save never truncates the old file.
    let temporary = target.with_extension("imagesage.saving");
    let result = (|| -> Result<(), String> {
        let file = File::create(&temporary)
            .map_err(|error| format!("Could not create the Image Sage document: {error}"))?;
        let mut archive = ZipWriter::new(file);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        // PNG data is already compressed; storing it avoids slow, useless deflate passes.
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut write_entry = |name: &str, bytes: &[u8], options| -> Result<(), String> {
            archive
                .start_file(name, options)
                .map_err(|error| format!("Could not write {name}: {error}"))?;
            archive
                .write_all(bytes)
                .map_err(|error| format!("Could not write {name}: {error}"))
        };
        write_entry("manifest.json", &manifest_bytes, deflated)?;
        write_entry("image.png", &image_bytes, stored)?;
        for (tile_path, bytes) in &tiles {
            write_entry(tile_path, bytes, stored)?;
        }
        archive
            .finish()
            .map_err(|error| format!("Could not finish the Image Sage document: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    std::fs::rename(&temporary, target).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("Could not replace {}: {error}", target.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    fn png_url() -> String {
        format!("data:image/png;base64,{ONE_PIXEL_PNG}")
    }

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "imagesage-{label}-{}-{}.imagesage",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn manifest_with_steps(steps: usize) -> Value {
        let history: Vec<Value> = (1..=steps)
            .map(|index| {
                serde_json::json!({
                    "id": format!("step-{index}"),
                    "prompt": format!("edit {index}"),
                    "before": format!("history/{index:04}-before.png"),
                    "after": format!("history/{index:04}-after.png")
                })
            })
            .collect();
        serde_json::json!({
            "format": DOCUMENT_FORMAT,
            "formatVersion": DOCUMENT_VERSION,
            "createdAt": "2026-10-02T00:00:00.000Z",
            "image": { "path": "image.png", "width": 1, "height": 1 },
            "history": history,
            "historyIndex": steps
        })
    }

    fn tiles_for(steps: usize) -> Vec<HistoryTile> {
        (1..=steps)
            .flat_map(|index| {
                ["before", "after"].map(|kind| HistoryTile {
                    path: format!("history/{index:04}-{kind}.png"),
                    data_url: png_url(),
                })
            })
            .collect()
    }

    #[test]
    fn accepts_only_numbered_history_tiles() {
        assert!(is_history_tile_path("history/0001-before.png"));
        assert!(is_history_tile_path("history/0420-after.png"));
        assert!(!is_history_tile_path("history/1-before.png"));
        assert!(!is_history_tile_path("history/0001-other.png"));
        assert!(!is_history_tile_path("history/../0001-before.png"));
        assert!(!is_history_tile_path("image.png"));
        assert!(is_history_tile_path("history/0003-adjust-2-mask.png"));
        assert!(is_history_tile_path("history/base-adjust-1-mask.png"));
        assert!(!is_history_tile_path("history/0003-adjust--mask.png"));
        assert!(!is_history_tile_path("history/base-adjust-x-mask.png"));
        assert!(!is_history_tile_path("history/base-layer.png"));
    }

    #[test]
    fn lists_adjustment_mask_tiles() {
        let manifest = serde_json::json!({
            "base": "history/base.png",
            "baseAdjust": [{ "id": "a", "kind": "brightness", "value": 5, "mask": "history/base-adjust-1-mask.png" }],
            "history": [{
                "layer": "history/0001-layer.png",
                "adjust": [
                    { "id": "b", "kind": "brightness", "value": 5, "mask": "history/0001-adjust-1-mask.png" },
                    { "id": "c", "kind": "brightness", "value": 5, "mask": "data:image/png;base64,AAAA" },
                    { "id": "d", "kind": "brightness", "value": 5 }
                ]
            }]
        });
        assert_eq!(
            history_tile_paths(&manifest).unwrap(),
            vec![
                "history/base.png",
                "history/base-adjust-1-mask.png",
                "history/0001-layer.png",
                "history/0001-adjust-1-mask.png"
            ]
        );
    }

    #[test]
    fn document_round_trip_preserves_history() {
        let path = temp_path("round-trip");
        save_document(
            path.to_string_lossy().into_owned(),
            manifest_with_steps(2).to_string(),
            png_url(),
            tiles_for(2),
        )
        .unwrap();

        let opened = open_image_file(path.to_string_lossy().into_owned(), true).unwrap();
        assert_eq!(opened.kind, "document");
        assert_eq!((opened.width, opened.height), (1, 1));
        assert_eq!(opened.history_tiles.len(), 4);
        let restored: Value =
            serde_json::from_str(opened.manifest_json.as_deref().unwrap()).unwrap();
        assert_eq!(restored["history"][1]["prompt"], "edit 2");

        let preview = open_image_file(path.to_string_lossy().into_owned(), false).unwrap();
        assert!(preview.history_tiles.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn accepts_layer_documents() {
        assert!(is_history_tile_path("history/base.png"));
        assert!(is_history_tile_path("history/0002-layer.png"));
        assert!(is_history_tile_path("history/0002-mask.png"));
        let manifest = serde_json::json!({
            "base": "history/base.png",
            "history": [
                { "layer": "history/0001-layer.png" },
                { "layer": "history/0002-layer.png", "layerMask": "history/0002-mask.png" }
            ]
        });
        assert_eq!(history_tile_paths(&manifest).unwrap().len(), 4);
        assert!(
            history_tile_paths(&serde_json::json!({ "history": [{ "prompt": "x" }] })).is_err()
        );
    }

    #[test]
    fn rejects_missing_and_unreferenced_tiles() {
        let path = temp_path("tiles");
        let mut missing = tiles_for(1);
        missing.pop();
        assert!(save_document(
            path.to_string_lossy().into_owned(),
            manifest_with_steps(1).to_string(),
            png_url(),
            missing,
        )
        .is_err());

        let mut extra = tiles_for(1);
        extra.push(HistoryTile {
            path: "history/0009-before.png".into(),
            data_url: png_url(),
        });
        assert!(save_document(
            path.to_string_lossy().into_owned(),
            manifest_with_steps(1).to_string(),
            png_url(),
            extra,
        )
        .is_err());
        assert!(!path.exists());
    }
}
