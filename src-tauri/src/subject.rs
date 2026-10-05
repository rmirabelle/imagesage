use image::{imageops::FilterType, ImageFormat};
use ort::{session::Session, value::Tensor};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

use crate::models::{self, MaskResult, BIREFNET};
use crate::requests::{self, AiRequests};

/**
 * Subject detection with BiRefNet (MIT license,
 * github.com/ZhengPeng7/BiRefNet), converted to fp16 by
 * `tools/model/convert_birefnet.py`. See `models.rs` for the download.
 */
const INPUT_SIZE: u32 = 1024;
/// Mask values at or above this count as the subject when finding its bounds.
const SUBJECT_THRESHOLD: u8 = 128;

/// The loaded model, kept for the life of the app after its first use.
#[derive(Default)]
pub struct SubjectModel(Arc<Mutex<Option<Session>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectRequest {
    image_png: String,
    request_id: String,
}

#[tauri::command]
pub async fn subject_mask(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    model: State<'_, SubjectModel>,
    request: SubjectRequest,
) -> Result<MaskResult, String> {
    if !models::is_installed(&app, &BIREFNET)? {
        return Err("The subject model is not downloaded yet.".into());
    }
    let path = models::model_path(&app, &BIREFNET.files[0])?;
    let png = requests::decode_png(&request.image_png, "image")?;
    let session = model.0.clone();
    requests::run_cancellable(app, &requests, request.request_id, |reporter| async move {
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = session.lock().unwrap_or_else(|error| error.into_inner());
            if guard.is_none() {
                reporter.stage("loading");
                *guard = Some(models::load_session(&path)?);
            }
            reporter.stage("detecting");
            detect(guard.as_mut().expect("the session was just loaded"), &png)
        })
        .await
        .map_err(|error| format!("Subject detection stopped unexpectedly: {error}"))?
    })
    .await
}

fn detect(session: &mut Session, png: &[u8]) -> Result<MaskResult, String> {
    let image = image::load_from_memory_with_format(png, ImageFormat::Png)
        .map_err(|error| format!("Could not read the image: {error}"))?
        .to_rgb8();
    let (width, height) = image.dimensions();
    let resized = image::imageops::resize(&image, INPUT_SIZE, INPUT_SIZE, FilterType::Triangle);
    let input = Tensor::from_array(([1_usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize], models::normalize(&resized)))
        .map_err(|error| format!("Could not prepare the image: {error}"))?;
    let outputs = session
        .run(ort::inputs![input])
        .map_err(|error| format!("Subject detection failed: {error}"))?;
    let (_, logits) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("Could not read the subject mask: {error}"))?;
    let small = models::to_mask(logits, INPUT_SIZE)?;
    let mask = image::imageops::resize(&small, width, height, FilterType::Triangle);
    Ok(MaskResult {
        bounds: models::bounds_of(&mask, SUBJECT_THRESHOLD),
        mask_data_url: models::alpha_png(&mask)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Runs the real model: `IMAGESAGE_MODEL=<model.onnx> IMAGESAGE_IMAGE=<image.png> cargo test --lib real_model -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_model_finds_a_subject() {
        let model = std::env::var("IMAGESAGE_MODEL").expect("IMAGESAGE_MODEL");
        let png = std::fs::read(std::env::var("IMAGESAGE_IMAGE").expect("IMAGESAGE_IMAGE")).unwrap();
        let started = std::time::Instant::now();
        let mut session = models::load_session(Path::new(&model)).unwrap();
        println!("load: {:?}", started.elapsed());
        for run in 0..3 {
            let started = std::time::Instant::now();
            let result = detect(&mut session, &png).unwrap();
            println!("run {run}: {:?}, bounds {:?}", started.elapsed(), result.bounds);
            assert!(result.bounds.is_some());
        }
    }
}
