use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use image::{GrayImage, ImageBuffer, ImageFormat, Luma, Rgba, RgbImage};
use ort::{ep, session::Session};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::requests::{self, AiRequests};

/**
 * Local AI models. The app downloads each model once, on first use, from a
 * `model-*` release of this repo (which `publish.ps1` never deletes) into its
 * local data folder. The models then run offline through ONNX Runtime, on the
 * GPU with DirectML when it can, otherwise on the CPU. This module holds the
 * download and the helpers that every model shares.
 */
const MODEL_DOWNLOAD_PREFIX: &str = "https://github.com/rmirabelle/imagesage/releases/download/model-";

pub struct ModelFile {
    pub name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

pub struct ModelSpec {
    pub id: &'static str,
    pub files: &'static [ModelFile],
}

/// SAM 2.1 Small (Apache 2.0), encoder and decoder, for click to select.
pub const SAM2: ModelSpec = ModelSpec {
    id: "sam2",
    files: &[
        ModelFile {
            name: "sam2.1-small-encoder.onnx",
            url: "https://github.com/rmirabelle/imagesage/releases/download/model-sam2-small-v1/sam2.1-small-encoder.onnx",
            size: 138_018_779,
            sha256: "275013f35a03fcf9d9f32f0490bfb7acd8b8fb86f145ba173123eb3886c8d4b2",
        },
        ModelFile {
            name: "sam2.1-small-decoder.onnx",
            url: "https://github.com/rmirabelle/imagesage/releases/download/model-sam2-small-v1/sam2.1-small-decoder.onnx",
            size: 16_519_569,
            sha256: "d158eb26a43d39eed23ef677d6826d17eb9eda951921f9a252fa5d36d871b57d",
        },
    ],
};

const MODELS: [&ModelSpec; 1] = [&SAM2];

fn spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .into_iter()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("There is no model named {id}."))
}

pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadRequest {
    model: String,
    request_id: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A mask for the webview: a PNG data URL at the image size (white, with the mask as its alpha), and the area it covers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskResult {
    pub mask_data_url: String,
    /// Null when the mask is empty.
    pub bounds: Option<Bounds>,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not find the app data folder: {error}"))?
        .join("models");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the models folder: {error}"))?;
    Ok(dir)
}

pub fn model_path(app: &AppHandle, file: &ModelFile) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(file.name))
}

/// A file counts as installed only when it has the expected size; the hash was checked when it was downloaded.
fn file_installed(path: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(path).map(|meta| meta.len() == file.size).unwrap_or(false)
}

pub fn is_installed(app: &AppHandle, model: &ModelSpec) -> Result<bool, String> {
    for file in model.files {
        if !file_installed(&model_path(app, file)?, file) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn validate_model_url(url: &str) -> Result<(), String> {
    if url.starts_with(MODEL_DOWNLOAD_PREFIX) && url.ends_with(".onnx") {
        Ok(())
    } else {
        Err("The model URL is not an official Image Sage model.".into())
    }
}

fn hash_matches(digest: &[u8], expected_hex: &str) -> bool {
    let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    actual.eq_ignore_ascii_case(expected_hex)
}

#[tauri::command]
pub fn model_status(app: AppHandle, model: String) -> Result<ModelStatus, String> {
    let spec = spec(&model)?;
    Ok(ModelStatus {
        installed: is_installed(&app, spec)?,
        size_bytes: spec.files.iter().map(|file| file.size).sum(),
    })
}

/// Downloads every missing file of a model, checking each file's hash before it is kept.
#[tauri::command]
pub async fn model_download(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: ModelDownloadRequest,
) -> Result<(), String> {
    let spec = spec(&request.model)?;
    let mut missing = Vec::new();
    for file in spec.files {
        validate_model_url(file.url)?;
        let target = model_path(&app, file)?;
        if !file_installed(&target, file) {
            missing.push((file, target));
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let total: u64 = missing.iter().map(|(file, _)| file.size).sum::<u64>().max(1);
    requests::run_cancellable(app, &requests, request.request_id, |reporter| async move {
        reporter.progress("downloading", 0.0);
        let client = requests::client()?;
        let mut done = 0_u64;
        for (file, target) in missing {
            let download = VerifiedDownload { url: file.url, size: file.size, sha256: file.sha256, what: "model" };
            download_verified(&client, &reporter, &download, &target, done, total).await?;
            done += file.size;
        }
        reporter.progress("downloading", 1.0);
        Ok(())
    })
    .await
}

/// One file to download whose size and SHA-256 are known ahead; `what` names it in messages ("model").
pub struct VerifiedDownload<'a> {
    pub url: &'a str,
    pub size: u64,
    pub sha256: &'a str,
    pub what: &'a str,
}

/**
 * Downloads one file to `target`, through a `.part` file that becomes the
 * target only when its size and hash match. Progress is reported as part of
 * `total` bytes, of which `done` were finished before this file.
 */
pub async fn download_verified(
    client: &reqwest::Client,
    reporter: &requests::ProgressReporter,
    download: &VerifiedDownload<'_>,
    target: &Path,
    done: u64,
    total: u64,
) -> Result<(), String> {
    let what = download.what;
    let mut partial = target.as_os_str().to_owned();
    partial.push(".part");
    let partial = PathBuf::from(partial);
    let response = client
        .get(download.url)
        .send()
        .await
        .map_err(|error| requests::describe_transport_error("GitHub", &error))?;
    if !response.status().is_success() {
        return Err(format!("The {what} download failed: the server returned {}.", response.status()));
    }
    let mut output = tokio::fs::File::create(&partial)
        .await
        .map_err(|error| format!("Could not create the {what} file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    let mut reported = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| requests::describe_transport_error("GitHub", &error))?;
        hasher.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|error| format!("Could not write the {what} file: {error}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - reported >= 1 << 20 {
            reported = downloaded;
            reporter.progress("downloading", (done + downloaded) as f64 / total.max(1) as f64);
        }
    }
    output
        .flush()
        .await
        .map_err(|error| format!("Could not write the {what} file: {error}"))?;
    drop(output);
    if downloaded != download.size || !hash_matches(&hasher.finalize(), download.sha256) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!("The downloaded {what} is damaged. Try again."));
    }
    tokio::fs::rename(&partial, target)
        .await
        .map_err(|error| format!("Could not save the {what} file: {error}"))
}

fn fail_load(error: impl std::fmt::Display) -> String {
    format!("Could not load the model: {error}")
}

pub fn load_session(path: &Path) -> Result<Session, String> {
    // DirectML needs sequential execution and no memory pattern; without a usable GPU, ONNX Runtime uses the CPU.
    Session::builder()
        .map_err(fail_load)?
        .with_parallel_execution(false)
        .map_err(fail_load)?
        .with_memory_pattern(false)
        .map_err(fail_load)?
        .with_execution_providers([ep::DirectML::default().build()])
        .map_err(fail_load)?
        .commit_from_file(path)
        .map_err(fail_load)
}

/// A CPU-only session, for small models where copying data to the GPU costs more than it saves.
pub fn load_cpu_session(path: &Path) -> Result<Session, String> {
    Session::builder().map_err(fail_load)?.commit_from_file(path).map_err(fail_load)
}

/// The image as a planar (NCHW) tensor, normalized with the ImageNet mean and standard deviation.
pub fn normalize(image: &RgbImage) -> Vec<f32> {
    let plane = (image.width() * image.height()) as usize;
    let mut tensor = vec![0.0_f32; plane * 3];
    for (index, pixel) in image.pixels().enumerate() {
        for channel in 0..3 {
            tensor[channel * plane + index] = (pixel[channel] as f32 / 255.0 - IMAGENET_MEAN[channel]) / IMAGENET_STD[channel];
        }
    }
    tensor
}

pub fn bounds_of(mask: &GrayImage, threshold: u8) -> Option<Bounds> {
    let (mut left, mut top, mut right, mut bottom) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, Luma([value])) in mask.enumerate_pixels() {
        if *value >= threshold {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
    }
    (left != u32::MAX).then(|| Bounds {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    })
}

/// A white PNG with the mask as its alpha, as a data URL.
pub fn alpha_png(mask: &GrayImage) -> Result<String, String> {
    let rgba = ImageBuffer::from_fn(mask.width(), mask.height(), |x, y| {
        Rgba([255, 255, 255, mask.get_pixel(x, y)[0]])
    });
    let mut bytes = Vec::new();
    rgba.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|error| format!("Could not encode the mask: {error}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_is_planar_and_uses_imagenet_values() {
        let image = RgbImage::from_raw(2, 1, vec![255, 0, 0, 0, 0, 255]).unwrap();
        let tensor = normalize(&image);
        assert_eq!(tensor.len(), 6);
        assert!((tensor[0] - (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]).abs() < 1e-6);
        assert!((tensor[1] - (0.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]).abs() < 1e-6);
        assert!((tensor[5] - (1.0 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]).abs() < 1e-6);
    }

    #[test]
    fn bounds_cover_pixels_at_the_threshold() {
        let mut mask = GrayImage::new(5, 4);
        mask.put_pixel(1, 2, Luma([128]));
        mask.put_pixel(3, 1, Luma([255]));
        mask.put_pixel(4, 3, Luma([127]));
        assert_eq!(bounds_of(&mask, 128), Some(Bounds { x: 1, y: 1, width: 3, height: 2 }));
        assert_eq!(bounds_of(&GrayImage::new(3, 3), 128), None);
    }

    #[test]
    fn every_model_file_has_an_official_url() {
        for model in MODELS {
            for file in model.files {
                assert!(validate_model_url(file.url).is_ok(), "{}", file.url);
                assert_eq!(file.sha256.len(), 64);
            }
        }
        assert!(validate_model_url("https://github.com/rmirabelle/imagesage/releases/download/v0.1.0/x.onnx").is_err());
        assert!(validate_model_url("https://github.com/rmirabelle/imagesage.evil/releases/download/model-x/x.onnx").is_err());
        assert!(spec("sam2").is_ok() && spec("nope").is_err());
    }

    #[test]
    fn hash_check_compares_hex() {
        let digest = Sha256::digest(b"abc");
        assert!(hash_matches(&digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert!(!hash_matches(&digest, SAM2.files[0].sha256));
    }
}
