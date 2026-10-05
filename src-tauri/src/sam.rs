use image::{imageops::FilterType, ImageFormat};
use ort::{session::Session, value::Tensor};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

use crate::models::{self, MaskResult, SAM2};
use crate::requests::{self, AiRequests};

/**
 * Click to select with SAM 2.1 Small (Meta, Apache 2.0), exported by
 * `tools/model/export_sam2.py`, which also records the model's inputs and
 * outputs. The encoder runs once per image and its result is kept; the
 * decoder runs for each click, so a click updates the mask almost at once.
 */
const INPUT_SIZE: u32 = 1024;
/// The decoder's masks are logits over the 1024 square, at this size.
const MASK_SIZE: u32 = 256;
/// Mask values at or above this count as selected when finding the bounds.
const SELECTED_THRESHOLD: u8 = 128;

/// The encoder's result for one image, and the last decoded mask for refining the next one.
struct Encoding {
    key: String,
    width: u32,
    height: u32,
    high_res_feats_0: Vec<f32>,
    high_res_feats_1: Vec<f32>,
    image_embed: Vec<f32>,
    last: Option<(Vec<SamPoint>, Vec<f32>)>,
}

#[derive(Default)]
struct SamState {
    encoder: Option<Session>,
    decoder: Option<Session>,
    encoding: Option<Encoding>,
}

#[derive(Default)]
pub struct SamModel(Arc<Mutex<SamState>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeRequest {
    image_png: String,
    /// Names the image; encoding the same key again does nothing.
    key: String,
    request_id: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct SamPoint {
    x: f32,
    y: f32,
    /// True adds the area under the point; false removes it.
    include: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskRequest {
    key: String,
    points: Vec<SamPoint>,
}

fn lock(model: &SamModel) -> std::sync::MutexGuard<'_, SamState> {
    model.0.lock().unwrap_or_else(|error| error.into_inner())
}

/// Loads the encoder and decoder on first use.
fn ensure_sessions(app: &AppHandle, state: &mut SamState) -> Result<(), String> {
    if state.encoder.is_none() {
        state.encoder = Some(models::load_session(&models::model_path(app, &SAM2.files[0])?)?);
    }
    if state.decoder.is_none() {
        // The decoder is small and runs on every click; on the CPU it skips copying the image features to the GPU each time.
        state.decoder = Some(models::load_cpu_session(&models::model_path(app, &SAM2.files[1])?)?);
    }
    Ok(())
}

#[tauri::command]
pub async fn sam_encode(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    model: State<'_, SamModel>,
    request: EncodeRequest,
) -> Result<(), String> {
    if !models::is_installed(&app, &SAM2)? {
        return Err("The click-to-select model is not downloaded yet.".into());
    }
    if lock(&model).encoding.as_ref().is_some_and(|encoding| encoding.key == request.key) {
        return Ok(());
    }
    let png = requests::decode_png(&request.image_png, "image")?;
    let state = model.0.clone();
    let worker_app = app.clone();
    requests::run_cancellable(app, &requests, request.request_id, |reporter| async move {
        tauri::async_runtime::spawn_blocking(move || {
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            if state.encoder.is_none() || state.decoder.is_none() {
                reporter.stage("loading");
                ensure_sessions(&worker_app, &mut state)?;
            }
            reporter.stage("preparing");
            let encoding = encode(state.encoder.as_mut().expect("the encoder was just loaded"), &png, request.key)?;
            state.encoding = Some(encoding);
            Ok(())
        })
        .await
        .map_err(|error| format!("Preparing the image stopped unexpectedly: {error}"))?
    })
    .await
}

fn encode(session: &mut Session, png: &[u8], key: String) -> Result<Encoding, String> {
    let image = image::load_from_memory_with_format(png, ImageFormat::Png)
        .map_err(|error| format!("Could not read the image: {error}"))?
        .to_rgb8();
    let (width, height) = image.dimensions();
    let resized = image::imageops::resize(&image, INPUT_SIZE, INPUT_SIZE, FilterType::Triangle);
    let input = Tensor::from_array(([1_usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize], models::normalize(&resized)))
        .map_err(|error| format!("Could not prepare the image: {error}"))?;
    let outputs = session
        .run(ort::inputs!["image" => input])
        .map_err(|error| format!("Preparing the image failed: {error}"))?;
    let take = |name: &str| -> Result<Vec<f32>, String> {
        let (_, values) = outputs[name]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("Could not read the image features: {error}"))?;
        Ok(values.to_vec())
    };
    Ok(Encoding {
        key,
        width,
        height,
        high_res_feats_0: take("high_res_feats_0")?,
        high_res_feats_1: take("high_res_feats_1")?,
        image_embed: take("image_embed")?,
        last: None,
    })
}

#[tauri::command]
pub async fn sam_mask(model: State<'_, SamModel>, request: MaskRequest) -> Result<MaskResult, String> {
    let state = model.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
        let SamState { decoder, encoding, .. } = &mut *state;
        let (Some(decoder), Some(encoding)) = (decoder.as_mut(), encoding.as_mut()) else {
            return Err("The image is not prepared for click to select.".to_string());
        };
        if encoding.key != request.key {
            return Err("The image changed. Start click to select again.".into());
        }
        decode(decoder, encoding, &request.points)
    })
    .await
    .map_err(|error| format!("Click to select stopped unexpectedly: {error}"))?
}

/// How steep the edge is: values this many logits past the edge are fully in or out, so the edge is about one pixel wide.
const EDGE_STEEPNESS: f32 = 6.0;

/**
 * The 256 x 256 logits, scaled up to the image size and then cut at the edge
 * (logit 0), as SAM itself does. Scaling the logits first gives a smooth,
 * sharp edge; scaling a soft mask instead would blur the edge across many
 * pixels.
 */
fn sharp_mask(logits: &[f32], width: u32, height: u32) -> Result<image::GrayImage, String> {
    let side = MASK_SIZE as usize;
    if logits.len() != side * side {
        return Err("The click-to-select mask has an unexpected size.".into());
    }
    // Bilinear scaling by hand: the image library clamps decimal values to 0–1, which would lose the logits' sign.
    let source = |position: u32, size: u32| {
        let at = ((position as f32 + 0.5) * side as f32 / size as f32 - 0.5).clamp(0.0, (side - 1) as f32);
        let low = at.floor() as usize;
        (low, (low + 1).min(side - 1), at - low as f32)
    };
    let columns: Vec<_> = (0..width).map(|x| source(x, width)).collect();
    let mut mask = image::GrayImage::new(width, height);
    for y in 0..height {
        let (top, bottom, fy) = source(y, height);
        for (x, &(left, right, fx)) in columns.iter().enumerate() {
            let at = |row: usize, column: usize| logits[row * side + column];
            let upper = at(top, left) + (at(top, right) - at(top, left)) * fx;
            let lower = at(bottom, left) + (at(bottom, right) - at(bottom, left)) * fx;
            let logit = upper + (lower - upper) * fy;
            let alpha = 1.0 / (1.0 + (-logit * EDGE_STEEPNESS).exp());
            mask.put_pixel(x as u32, y, image::Luma([(alpha * 255.0).round() as u8]));
        }
    }
    Ok(mask)
}

/// A point in image pixels, in the 1024 square the model works in.
fn to_model_space(point: SamPoint, width: u32, height: u32) -> [f32; 2] {
    [point.x / width as f32 * INPUT_SIZE as f32, point.y / height as f32 * INPUT_SIZE as f32]
}

/// The index of the best score.
fn best_index(scores: &[f32]) -> usize {
    scores
        .iter()
        .enumerate()
        .fold((0, f32::MIN), |best, (index, &score)| if score > best.1 { (index, score) } else { best })
        .0
}

/**
 * Decodes a mask for the points. When the points only add to the previous
 * ones, the previous mask goes in too, which helps the model refine it.
 */
fn decode(session: &mut Session, encoding: &mut Encoding, points: &[SamPoint]) -> Result<MaskResult, String> {
    if points.is_empty() {
        encoding.last = None;
        let empty = image::GrayImage::new(encoding.width, encoding.height);
        return Ok(MaskResult { bounds: None, mask_data_url: models::alpha_png(&empty)? });
    }
    let coords: Vec<f32> = points.iter().flat_map(|point| to_model_space(*point, encoding.width, encoding.height)).collect();
    let labels: Vec<f32> = points.iter().map(|point| if point.include { 1.0 } else { 0.0 }).collect();
    let previous = encoding
        .last
        .as_ref()
        .filter(|(before, _)| before.len() < points.len() && points.starts_with(before))
        .map(|(_, logits)| logits.clone());
    let has_mask = previous.is_some();
    let mask_input = previous.unwrap_or_else(|| vec![0.0; (MASK_SIZE * MASK_SIZE) as usize]);
    let fail = |error: ort::Error| format!("Click to select failed: {error}");
    let count = points.len();
    let outputs = session
        .run(ort::inputs![
            "image_embed" => Tensor::from_array(([1_usize, 256, 64, 64], encoding.image_embed.clone())).map_err(fail)?,
            "high_res_feats_0" => Tensor::from_array(([1_usize, 32, 256, 256], encoding.high_res_feats_0.clone())).map_err(fail)?,
            "high_res_feats_1" => Tensor::from_array(([1_usize, 64, 128, 128], encoding.high_res_feats_1.clone())).map_err(fail)?,
            "point_coords" => Tensor::from_array(([1_usize, count, 2], coords)).map_err(fail)?,
            "point_labels" => Tensor::from_array(([1_usize, count], labels)).map_err(fail)?,
            "mask_input" => Tensor::from_array(([1_usize, 1, MASK_SIZE as usize, MASK_SIZE as usize], mask_input)).map_err(fail)?,
            "has_mask_input" => Tensor::from_array(([1_usize], vec![if has_mask { 1.0_f32 } else { 0.0 }])).map_err(fail)?
        ])
        .map_err(fail)?;
    let (_, scores) = outputs["iou_predictions"].try_extract_tensor::<f32>().map_err(fail)?;
    let (shape, masks) = outputs["masks"].try_extract_tensor::<f32>().map_err(fail)?;
    let plane = (MASK_SIZE * MASK_SIZE) as usize;
    let candidates = masks.len() / plane;
    if candidates == 0 || shape.iter().rev().take(2).any(|&side| side != MASK_SIZE as i64) {
        return Err("The click-to-select mask has an unexpected size.".into());
    }
    let best = best_index(&scores[..candidates.min(scores.len())]);
    let logits = masks[best * plane..(best + 1) * plane].to_vec();
    let mask = sharp_mask(&logits, encoding.width, encoding.height)?;
    encoding.last = Some((points.to_vec(), logits));
    Ok(MaskResult {
        bounds: models::bounds_of(&mask, SELECTED_THRESHOLD),
        mask_data_url: models::alpha_png(&mask)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn points_scale_into_the_model_square() {
        let point = SamPoint { x: 320.0, y: 100.0, include: true };
        assert_eq!(to_model_space(point, 640, 400), [512.0, 256.0]);
    }

    #[test]
    fn the_mask_is_cut_sharply_at_the_edge() {
        let logits: Vec<f32> = (0..MASK_SIZE * MASK_SIZE).map(|index| if index % MASK_SIZE < MASK_SIZE / 2 { 8.0 } else { -8.0 }).collect();
        let mask = sharp_mask(&logits, 1024, 4).unwrap();
        assert_eq!(mask.get_pixel(0, 0)[0], 255);
        assert_eq!(mask.get_pixel(1023, 0)[0], 0);
        let soft = (0..1024).filter(|&x| (5..250).contains(&mask.get_pixel(x, 0)[0])).count();
        assert!(soft <= 3, "{soft} soft pixels");
    }

    #[test]
    fn the_best_score_wins() {
        assert_eq!(best_index(&[0.2, 0.9, 0.5]), 1);
        assert_eq!(best_index(&[0.7]), 0);
    }

    /// Runs the real model: `IMAGESAGE_SAM_DIR=<folder with both files> IMAGESAGE_IMAGE=<image.png> cargo test --lib real_sam -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_sam_selects_an_area() {
        let dir = std::env::var("IMAGESAGE_SAM_DIR").expect("IMAGESAGE_SAM_DIR");
        let png = std::fs::read(std::env::var("IMAGESAGE_IMAGE").expect("IMAGESAGE_IMAGE")).unwrap();
        let mut encoder = models::load_session(&Path::new(&dir).join(SAM2.files[0].name)).unwrap();
        let mut decoder = models::load_cpu_session(&Path::new(&dir).join(SAM2.files[1].name)).unwrap();
        for run in 0..2 {
            let started = std::time::Instant::now();
            let mut encoding = encode(&mut encoder, &png, "test".into()).unwrap();
            let encoded = started.elapsed();
            let first = SamPoint { x: encoding.width as f32 * 0.6, y: encoding.height as f32 * 0.15, include: true };
            let started = std::time::Instant::now();
            let one = decode(&mut decoder, &mut encoding, &[first]).unwrap();
            let decoded = started.elapsed();
            let second = SamPoint { x: encoding.width as f32 * 0.6, y: encoding.height as f32 * 0.25, include: true };
            let two = decode(&mut decoder, &mut encoding, &[first, second]).unwrap();
            println!("run {run}: encode {encoded:?}, decode {decoded:?}, bounds {:?} then {:?}", one.bounds, two.bounds);
            assert!(one.bounds.is_some());
        }
    }
}
