use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

use crate::models::{download_verified, VerifiedDownload};
use crate::requests::{self, AiImage, AiRequests, ProgressReporter};

/**
 * The optional local engine: stable-diffusion.cpp's `sd-server.exe` (CUDA 12
 * build) runs Chroma1-HD on this computer for new images from a prompt. The
 * engine downloads once, on first use, from a pinned upstream release and is
 * checked against its SHA-256. The model files are the user's own (for
 * example a ComfyUI models folder) and are read in place. The server keeps
 * the model loaded between images and stops after some idle minutes to free
 * the GPU memory.
 */
const ENGINE_BUILD: &str = "sdcpp-77b72a2";
const ENGINE_URL_PREFIX: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-";
const ENGINE_MARKER: &str = "installed.json";
const SERVER_EXE: &str = "sd-server.exe";
const LOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const IDLE_CHECK: Duration = Duration::from_secs(30);
const LOG_LINES: usize = 20;
/// Chroma1-HD's recommended guidance.
const CFG_SCALE: f64 = 4.0;

struct EngineZip {
    name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

const ENGINE_ZIPS: [EngineZip; 2] = [
    EngineZip {
        name: "sd-master-77b72a2-bin-win-cuda12-x64.zip",
        url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1024-77b72a2/sd-master-77b72a2-bin-win-cuda12-x64.zip",
        size: 350_857_718,
        sha256: "e60e538b86ecd47d8e141297fa45734125fdf97925d8ed3b49acb1397b5ee90b",
    },
    EngineZip {
        name: "cudart-sd-bin-win-cu12-x64.zip",
        url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1024-77b72a2/cudart-sd-bin-win-cu12-x64.zip",
        size: 563_452_046,
        sha256: "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
    },
];

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalConfig {
    diffusion_model: String,
    text_encoder: String,
    vae: String,
    /// Minutes without a job before the engine stops and frees the GPU memory.
    idle_minutes: u32,
    /// What every image avoids; Chroma uses real guidance, so this changes the result a lot.
    negative_prompt: String,
    /// The engine's sampler name, such as `euler` or `dpm++2m`.
    sampler: String,
    /// The engine's scheduler name; empty uses the model's own default.
    scheduler: String,
}

/**
 * The default negative prompt: it steers Chroma to a realistic photo, away
 * from drawn styles and smooth, airbrushed skin, and against bad hands and
 * bodies. It leaves out "ugly" and "deformed", which push faces toward a
 * retouched beauty look.
 */
const DEFAULT_NEGATIVE_PROMPT: &str = "cartoon, anime, illustration, drawing, painting, 3d render, cgi, airbrushed, plastic skin, overly smooth skin, \
     oversaturated, low quality, blurry, out of focus, jpeg artifacts, \
     bad anatomy, extra fingers, missing fingers, fused fingers, malformed hands, extra limbs, missing limbs";
/// The earlier default; a saved copy of it becomes the new default.
const OLD_DEFAULT_NEGATIVE_PROMPT: &str = "low quality, ugly, unfinished, out of focus, deformed, disfigure, blurry, smudged, restricted palette, flat colors, \
     bad anatomy, incorrect anatomy, extra fingers, missing fingers, fused fingers, malformed hands, extra limbs, missing limbs";

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            diffusion_model: String::new(),
            text_encoder: String::new(),
            vae: String::new(),
            idle_minutes: 10,
            negative_prompt: DEFAULT_NEGATIVE_PROMPT.into(),
            sampler: "euler".into(),
            scheduler: String::new(),
        }
    }
}

impl LocalConfig {
    /// The model files that are not set or do not exist, by name.
    fn missing(&self) -> Vec<&'static str> {
        [
            (&self.diffusion_model, "diffusion model"),
            (&self.text_encoder, "text encoder"),
            (&self.vae, "VAE"),
        ]
        .into_iter()
        .filter(|(path, _)| path.trim().is_empty() || !Path::new(path.as_str()).is_file())
        .map(|(_, name)| name)
        .collect()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    engine_installed: bool,
    engine_size_bytes: u64,
    config: LocalConfig,
    missing: Vec<&'static str>,
    running: bool,
    /// The negative prompt a new config starts with, so the settings can restore it.
    default_negative_prompt: &'static str,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundModels {
    diffusion_model: Option<String>,
    text_encoder: Option<String>,
    vae: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRequest {
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGenerateRequest {
    request_id: String,
    prompt: String,
    quality: String,
    size: String,
}

/// The last lines the engine printed, to explain a failed start.
#[derive(Default)]
struct ServerLog(VecDeque<String>);

impl ServerLog {
    fn record(&mut self, line: &str) {
        let line = line.trim_end_matches("\u{1b}[K").trim();
        /* Progress bars redraw one line many times; they explain nothing. */
        if line.is_empty() || line.starts_with('|') {
            return;
        }
        if self.0.len() == LOG_LINES {
            self.0.pop_front();
        }
        self.0.push_back(line.to_string());
    }

    fn last_error(&self) -> Option<String> {
        self.0
            .iter()
            .rev()
            .find(|line| line.starts_with("[E]"))
            .or_else(|| self.0.back())
            .cloned()
    }
}

struct Server {
    child: Child,
    port: u16,
    config: LocalConfig,
    ready: bool,
    busy: u32,
    last_used: Instant,
    log: Arc<Mutex<ServerLog>>,
}

impl Server {
    fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The running engine, if any.
#[derive(Default, Clone)]
pub struct LocalEngine(Arc<Mutex<Option<Server>>>);

impl LocalEngine {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Server>> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn engines_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not find the app data folder: {error}"))?
        .join("engines");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create the engines folder: {error}"))?;
    Ok(dir)
}

fn engine_installed(dir: &Path) -> bool {
    dir.join(ENGINE_MARKER).is_file() && dir.join(SERVER_EXE).is_file()
}

fn validate_engine_url(url: &str) -> Result<(), String> {
    if url.starts_with(ENGINE_URL_PREFIX) && url.ends_with(".zip") {
        Ok(())
    } else {
        Err("The engine URL is not an official stable-diffusion.cpp release.".into())
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not find the settings folder: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create the settings folder: {error}"))?;
    Ok(dir.join("local-engine.json"))
}

fn load_config(app: &AppHandle) -> Result<LocalConfig, String> {
    match std::fs::read_to_string(config_path(app)?) {
        Ok(text) => Ok(parse_config(&text)),
        Err(_) => Ok(LocalConfig::default()),
    }
}

fn parse_config(text: &str) -> LocalConfig {
    let mut config: LocalConfig = serde_json::from_str(text).unwrap_or_default();
    if config.negative_prompt == OLD_DEFAULT_NEGATIVE_PROMPT {
        config.negative_prompt = DEFAULT_NEGATIVE_PROMPT.into();
    }
    config
}

#[tauri::command]
pub fn local_status(app: AppHandle, engine: State<'_, LocalEngine>) -> Result<LocalStatus, String> {
    let config = load_config(&app)?;
    Ok(LocalStatus {
        engine_installed: engine_installed(&engines_dir(&app)?.join(ENGINE_BUILD)),
        engine_size_bytes: ENGINE_ZIPS.iter().map(|zip| zip.size).sum(),
        missing: config.missing(),
        config,
        running: engine.lock().as_ref().is_some_and(|server| server.ready),
        default_negative_prompt: DEFAULT_NEGATIVE_PROMPT,
    })
}

/// Saves the settings. A running engine that is not busy stops when its model files change.
#[tauri::command]
pub fn local_config_set(app: AppHandle, engine: State<'_, LocalEngine>, config: LocalConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&config).map_err(|error| format!("Could not save the settings: {error}"))?;
    std::fs::write(config_path(&app)?, text).map_err(|error| format!("Could not save the settings: {error}"))?;
    let mut slot = engine.lock();
    let stale = slot
        .as_ref()
        .is_some_and(|server| server.busy == 0 && !same_models(&server.config, &config));
    if stale {
        if let Some(server) = slot.take() {
            server.stop();
        }
    } else if let Some(server) = slot.as_mut() {
        server.config.idle_minutes = config.idle_minutes;
    }
    Ok(())
}

fn same_models(a: &LocalConfig, b: &LocalConfig) -> bool {
    a.diffusion_model == b.diffusion_model && a.text_encoder == b.text_encoder && a.vae == b.vae
}

/// Finds Chroma's model files in a ComfyUI folder (its root, or its `models` folder).
#[tauri::command]
pub fn local_find_models(folder: String) -> FoundModels {
    find_models(Path::new(&folder))
}

fn find_models(folder: &Path) -> FoundModels {
    let Some(root) = [folder.to_path_buf(), folder.join("models"), folder.join("ComfyUI").join("models")]
        .into_iter()
        .find(|candidate| ["diffusion_models", "unet", "text_encoders", "clip", "vae"].iter().any(|name| candidate.join(name).is_dir()))
    else {
        return FoundModels::default();
    };
    let model_file = |name: &str| name.ends_with(".safetensors") || name.ends_with(".gguf") || name.ends_with(".sft");
    FoundModels {
        diffusion_model: best_file(&root, &["diffusion_models", "unet", "checkpoints"], |name| {
            (model_file(name) && name.contains("chroma")).then(|| if name.contains("hd") { 0 } else { 1 })
        }),
        text_encoder: best_file(&root, &["text_encoders", "clip"], |name| {
            (model_file(name) && name.contains("t5xxl")).then(|| if name.contains("fp16") { 0 } else if name.contains("fp8") { 2 } else { 1 })
        }),
        vae: best_file(&root, &["vae"], |name| {
            (model_file(name) && (name.starts_with("ae.") || (name.contains("flux") && name.contains("vae")))).then_some(0)
        }),
    }
}

/// The best-ranked file (lowest rank) in the named folders and their subfolders. `rank` gets the lowercase file name.
fn best_file(root: &Path, folders: &[&str], rank: impl Fn(&str) -> Option<u32>) -> Option<String> {
    let mut best: Option<(u32, PathBuf)> = None;
    let mut pending: Vec<(PathBuf, u32)> = folders.iter().map(|folder| (root.join(folder), 0)).collect();
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 2 {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if let Some(score) = rank(&name) {
                if best.as_ref().is_none_or(|(current, _)| score < *current) {
                    best = Some((score, path));
                }
            }
        }
    }
    best.map(|(_, path)| path.to_string_lossy().into_owned())
}

/// Downloads and unpacks the engine, checking each zip's hash before it is used.
#[tauri::command]
pub async fn local_engine_download(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: LocalRequest,
) -> Result<(), String> {
    for zip in &ENGINE_ZIPS {
        validate_engine_url(zip.url)?;
    }
    let engines = engines_dir(&app)?;
    let target = engines.join(ENGINE_BUILD);
    if engine_installed(&target) {
        return Ok(());
    }
    let total: u64 = ENGINE_ZIPS.iter().map(|zip| zip.size).sum();
    requests::run_cancellable(app, &requests, request.request_id, |reporter| async move {
        reporter.progress("downloading", 0.0);
        let client = requests::download_client()?;
        let mut done = 0_u64;
        let mut zips = Vec::new();
        for zip in &ENGINE_ZIPS {
            let path = engines.join(zip.name);
            let complete = std::fs::metadata(&path).map(|meta| meta.len() == zip.size).unwrap_or(false);
            if !complete {
                let download = VerifiedDownload { url: zip.url, size: zip.size, sha256: zip.sha256, what: "engine" };
                download_verified(&client, &reporter, &download, &path, done, total).await?;
            }
            done += zip.size;
            zips.push(path);
        }
        reporter.stage("preparing");
        let unpacked = target.clone();
        tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&unpacked);
            for zip in &zips {
                extract_zip(zip, &unpacked)?;
            }
            std::fs::write(unpacked.join(ENGINE_MARKER), json!({ "build": ENGINE_BUILD }).to_string())
                .map_err(|error| format!("Could not finish the engine install: {error}"))?;
            for zip in &zips {
                let _ = std::fs::remove_file(zip);
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|error| format!("The engine install stopped unexpectedly: {error}"))??;
        reporter.progress("downloading", 1.0);
        Ok(())
    })
    .await
}

fn extract_zip(zip: &Path, target: &Path) -> Result<(), String> {
    let fail = |error: &dyn std::fmt::Display| format!("Could not unpack the engine: {error}");
    let file = std::fs::File::open(zip).map_err(|error| fail(&error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| fail(&error))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| fail(&error))?;
        let relative = entry.enclosed_name().ok_or_else(|| fail(&"a file name points outside the folder"))?;
        let path = target.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&path).map_err(|error| fail(&error))?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| fail(&error))?;
        }
        let mut output = std::fs::File::create(&path).map_err(|error| fail(&error))?;
        std::io::copy(&mut entry, &mut output).map_err(|error| fail(&error))?;
    }
    Ok(())
}

/// Reads one output stream of the engine so it never blocks, keeping the last lines.
fn pump(mut stream: impl Read + Send + 'static, log: Arc<Mutex<ServerLog>>) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        let mut line = Vec::new();
        while let Ok(count) = stream.read(&mut buffer) {
            if count == 0 {
                break;
            }
            for &byte in &buffer[..count] {
                if byte == b'\r' || byte == b'\n' {
                    if !line.is_empty() {
                        log.lock().unwrap_or_else(|error| error.into_inner()).record(&String::from_utf8_lossy(&line));
                        line.clear();
                    }
                } else {
                    line.push(byte);
                }
            }
        }
    });
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("Could not find a free port for the local engine: {error}"))
}

fn spawn_server(dir: &Path, config: &LocalConfig) -> Result<Server, String> {
    let port = free_port()?;
    let mut command = Command::new(dir.join(SERVER_EXE));
    command
        .current_dir(dir)
        .args(["--listen-ip", "127.0.0.1", "--listen-port", &port.to_string()])
        .args(["--diffusion-model", &config.diffusion_model])
        .args(["--t5xxl", &config.text_encoder])
        .args(["--vae", &config.vae])
        .args(["--model-args", "chroma_use_dit_mask=false"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| format!("Could not start the local engine: {error}"))?;
    #[cfg(windows)]
    stop_with_app(&child);
    let log = Arc::new(Mutex::new(ServerLog::default()));
    if let Some(stdout) = child.stdout.take() {
        pump(stdout, log.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, log.clone());
    }
    Ok(Server {
        child,
        port,
        config: config.clone(),
        ready: false,
        busy: 0,
        last_used: Instant::now(),
        log,
    })
}

/// Puts the engine in a job object that Windows closes with Image Sage, so the engine never outlives the app.
#[cfg(windows)]
fn stop_with_app(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::{Foundation::HANDLE, System::JobObjects::*};

    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        Some(job.0 as usize)
    });
    if let Some(job) = job {
        unsafe {
            let _ = AssignProcessToJobObject(HANDLE(*job as *mut _), HANDLE(child.as_raw_handle()));
        }
    }
}

/// While a job uses the engine, the idle check leaves it running.
struct Session {
    engine: LocalEngine,
    port: u16,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(server) = self.engine.lock().as_mut().filter(|server| server.port == self.port) {
            server.busy = server.busy.saturating_sub(1);
            server.last_used = Instant::now();
        }
    }
}

/// Starts the engine with the saved model files, or reuses it, and waits until the model is loaded.
async fn open_session(app: &AppHandle, engine: &LocalEngine, reporter: &ProgressReporter) -> Result<Session, String> {
    let dir = engines_dir(app)?.join(ENGINE_BUILD);
    if !engine_installed(&dir) {
        return Err("The local engine is not installed. Download it in Settings → Local.".into());
    }
    let config = load_config(app)?;
    let missing = config.missing();
    if !missing.is_empty() {
        return Err(format!("Choose the Chroma {} in Settings → Local.", missing.join(", ")));
    }
    let port = {
        let mut slot = engine.lock();
        let reusable = slot.as_mut().is_some_and(|server| {
            same_models(&server.config, &config) && matches!(server.child.try_wait(), Ok(None))
        });
        if !reusable {
            if let Some(old) = slot.take() {
                old.stop();
            }
            *slot = Some(spawn_server(&dir, &config)?);
        }
        let server = slot.as_mut().expect("the engine was just started");
        server.busy += 1;
        server.last_used = Instant::now();
        server.port
    };
    let session = Session { engine: engine.clone(), port };
    wait_until_ready(engine, port, reporter).await?;
    Ok(session)
}

async fn wait_until_ready(engine: &LocalEngine, port: u16, reporter: &ProgressReporter) -> Result<(), String> {
    if engine.lock().as_ref().is_some_and(|server| server.port == port && server.ready) {
        return Ok(());
    }
    reporter.stage("loading");
    let client = requests::client()?;
    let url = format!("http://127.0.0.1:{port}/sdcpp/v1/capabilities");
    let started = Instant::now();
    loop {
        {
            let mut slot = engine.lock();
            let Some(server) = slot.as_mut().filter(|server| server.port == port) else {
                return Err("The local engine was stopped.".into());
            };
            if let Ok(Some(status)) = server.child.try_wait() {
                let reason = server.log.lock().unwrap_or_else(|error| error.into_inner()).last_error();
                slot.take();
                return Err(match reason {
                    Some(reason) => format!("The local engine stopped ({status}): {reason}"),
                    None => format!("The local engine stopped ({status})."),
                });
            }
        }
        if client.get(&url).send().await.is_ok_and(|response| response.status().is_success()) {
            if let Some(server) = engine.lock().as_mut().filter(|server| server.port == port) {
                server.ready = true;
            }
            return Ok(());
        }
        if started.elapsed() > LOAD_TIMEOUT {
            return Err("The local engine did not load the model in 10 minutes.".into());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Starts the engine and loads the model, to check the settings.
#[tauri::command]
pub async fn local_load(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    engine: State<'_, LocalEngine>,
    request: LocalRequest,
) -> Result<String, String> {
    let engine = engine.inner().clone();
    let handle = app.clone();
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| async move {
        let started = Instant::now();
        let _session = open_session(&handle, &engine, &reporter).await?;
        Ok(format!("The model is loaded and ready ({} s).", started.elapsed().as_secs()))
    })
    .await
}

/// Asks the engine to stop a job when Image Sage stops waiting for it (cancel or error).
struct CancelOnDrop(Option<String>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(url) = self.0.take() {
            tauri::async_runtime::spawn(async move {
                if let Ok(client) = requests::client() {
                    let _ = client.post(url).send().await;
                }
            });
        }
    }
}

fn steps_for(quality: &str) -> u32 {
    match quality {
        "low" => 20,
        "high" => 40,
        _ => 30,
    }
}

fn parse_size(size: &str) -> Result<(u32, u32), String> {
    let invalid = || format!("The image size {size} is not valid for the local engine.");
    let (width, height) = size.split_once('x').ok_or_else(invalid)?;
    let width: u32 = width.parse().map_err(|_| invalid())?;
    let height: u32 = height.parse().map_err(|_| invalid())?;
    let valid = |side: u32| (256..=4096).contains(&side) && side % 16 == 0;
    if valid(width) && valid(height) {
        Ok((width, height))
    } else {
        Err(invalid())
    }
}

/// The engine's job request: the prompt, the size, and the sampling settings from Settings → Local.
fn generate_body(prompt: &str, width: u32, height: u32, steps: u32, config: &LocalConfig) -> Value {
    let sampler = config.sampler.trim();
    let mut sample_params = json!({
        "sample_method": if sampler.is_empty() { "euler" } else { sampler },
        "sample_steps": steps,
        "guidance": { "txt_cfg": CFG_SCALE }
    });
    let scheduler = config.scheduler.trim();
    if !scheduler.is_empty() {
        sample_params["scheduler"] = json!(scheduler);
    }
    json!({
        "prompt": prompt,
        "negative_prompt": config.negative_prompt.trim(),
        "width": width,
        "height": height,
        "seed": -1,
        "sample_params": sample_params,
        "preview": "proj",
        "preview_interval": 1,
        "output_format": "png"
    })
}

/// Creates a new image from a prompt with Chroma1-HD on this computer.
#[tauri::command]
pub async fn local_generate(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    engine: State<'_, LocalEngine>,
    request: LocalGenerateRequest,
) -> Result<AiImage, String> {
    let (width, height) = parse_size(&request.size)?;
    let steps = steps_for(&request.quality);
    let engine = engine.inner().clone();
    let handle = app.clone();
    let prompt = request.prompt;
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| async move {
        let session = open_session(&handle, &engine, &reporter).await?;
        let config = load_config(&handle)?;
        reporter.progress("generating", 0.0);
        let client = requests::client()?;
        let base = format!("http://127.0.0.1:{}/sdcpp/v1", session.port);
        let body = generate_body(&prompt, width, height, steps, &config);
        let fail = |error: reqwest::Error| requests::describe_transport_error("the local engine", &error);
        let created: Value = client.post(format!("{base}/img_gen")).json(&body).send().await.map_err(fail)?.json().await.map_err(fail)?;
        let id = created["id"]
            .as_str()
            .ok_or_else(|| format!("The local engine did not accept the job: {created}"))?
            .to_string();
        let mut cancel = CancelOnDrop(Some(format!("{base}/jobs/{id}/cancel")));
        let mut shown_step = 0_u64;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let job: Value = client.get(format!("{base}/jobs/{id}")).send().await.map_err(fail)?.json().await.map_err(fail)?;
            match job["status"].as_str() {
                Some("completed") => {
                    cancel.0 = None;
                    let image = job["result"]["images"][0]["b64_json"]
                        .as_str()
                        .ok_or("The local engine returned no image.")?;
                    return Ok(AiImage { data_url: format!("data:image/png;base64,{image}"), usage: None });
                }
                Some("failed") | Some("cancelled") => {
                    cancel.0 = None;
                    let reason = job["error"]["message"].as_str().unwrap_or("no reason given");
                    return Err(format!("The local engine could not make the image: {reason}"));
                }
                _ => {
                    let preview = &job["preview"];
                    let (Some(step), Some(total)) = (preview["step"].as_u64(), preview["total_steps"].as_u64()) else { continue };
                    if step == shown_step || total == 0 {
                        continue;
                    }
                    shown_step = step;
                    if step >= total {
                        reporter.stage("finishing");
                    } else {
                        reporter.progress("generating", step as f64 / total as f64);
                    }
                    if let Some(image) = preview["b64_json"].as_str().filter(|_| step % 5 == 0) {
                        reporter.partial(step, format!("data:image/png;base64,{image}"));
                    }
                }
            }
        }
    })
    .await
}

/// Stops the engine after its idle minutes, to free the GPU memory, and forgets an engine that exited.
pub fn watch_idle(engine: LocalEngine) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_CHECK).await;
            let mut slot = engine.lock();
            let done = slot.as_mut().is_some_and(|server| {
                let idle = Duration::from_secs(u64::from(server.config.idle_minutes.max(1)) * 60);
                let exited = !matches!(server.child.try_wait(), Ok(None));
                exited || (server.busy == 0 && server.last_used.elapsed() >= idle)
            });
            if done {
                if let Some(server) = slot.take() {
                    server.stop();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_urls_are_official_and_hashed() {
        for zip in &ENGINE_ZIPS {
            assert!(validate_engine_url(zip.url).is_ok(), "{}", zip.url);
            assert!(zip.url.ends_with(zip.name));
            assert_eq!(zip.sha256.len(), 64);
        }
        assert!(validate_engine_url("https://github.com/leejet/stable-diffusion.cpp.evil/releases/download/master-1/x.zip").is_err());
        assert!(validate_engine_url("https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1/x.exe").is_err());
    }

    #[test]
    fn sizes_must_be_multiples_of_16() {
        assert_eq!(parse_size("1024x768"), Ok((1024, 768)));
        assert!(parse_size("1000x768").is_err());
        assert!(parse_size("128x128").is_err());
        assert!(parse_size("1024").is_err());
    }

    #[test]
    fn quality_sets_the_steps() {
        assert_eq!(steps_for("low"), 20);
        assert_eq!(steps_for("medium"), 30);
        assert_eq!(steps_for("high"), 40);
    }

    #[test]
    fn log_keeps_errors_and_skips_progress_bars() {
        let mut log = ServerLog::default();
        log.record("[I] loading diffusion model");
        log.record("  |=====>      | 3/30 - 1.2s/it\u{1b}[K");
        log.record("[E] failed to load model");
        log.record("[I] exiting");
        assert_eq!(log.0.len(), 3);
        assert_eq!(log.last_error().as_deref(), Some("[E] failed to load model"));
    }

    #[test]
    fn config_lists_missing_files_and_defaults_idle_minutes() {
        let config: LocalConfig = serde_json::from_str(r#"{"vae":"C:\\nope\\ae.safetensors"}"#).unwrap();
        assert_eq!(config.idle_minutes, 10);
        assert_eq!(config.negative_prompt, DEFAULT_NEGATIVE_PROMPT);
        assert_eq!(config.sampler, "euler");
        let old = parse_config(&json!({ "negativePrompt": OLD_DEFAULT_NEGATIVE_PROMPT }).to_string());
        assert_eq!(old.negative_prompt, DEFAULT_NEGATIVE_PROMPT);
        let own = parse_config(r#"{"negativePrompt":"text"}"#);
        assert_eq!(own.negative_prompt, "text");
        assert_eq!(config.missing(), vec!["diffusion model", "text encoder", "VAE"]);
    }

    #[test]
    fn job_request_has_the_sampling_settings() {
        let mut config = LocalConfig { sampler: "dpm++2m".into(), ..LocalConfig::default() };
        let body = generate_body("a cat", 1024, 768, 30, &config);
        assert_eq!(body["negative_prompt"], DEFAULT_NEGATIVE_PROMPT);
        assert_eq!(body["sample_params"]["sample_method"], "dpm++2m");
        assert!(body["sample_params"].get("scheduler").is_none());
        config.scheduler = "beta".into();
        config.sampler = " ".into();
        let body = generate_body("a cat", 1024, 768, 30, &config);
        assert_eq!(body["sample_params"]["scheduler"], "beta");
        assert_eq!(body["sample_params"]["sample_method"], "euler");
    }

    #[test]
    fn finds_comfyui_models_from_the_root_folder() {
        let root = std::env::temp_dir().join(format!("imagesage-find-{}", std::process::id()));
        let models = root.join("ComfyUI").join("models");
        for (folder, name) in [
            ("diffusion_models", "Chroma1-Base.safetensors"),
            ("diffusion_models", "Chroma1-HD.safetensors"),
            ("diffusion_models", "wan2.2.safetensors"),
            ("text_encoders", "t5xxl_fp8_e4m3fn.safetensors"),
            ("text_encoders", "t5xxl_fp16.safetensors"),
            ("vae", "ae.safetensors"),
            ("vae/Wan", "wan_2.1_vae.safetensors"),
        ] {
            let dir = models.join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let found = find_models(&root);
        let name = |path: &Option<String>| path.as_deref().and_then(|path| Path::new(path).file_name()).map(|name| name.to_string_lossy().into_owned());
        assert_eq!(name(&found.diffusion_model).as_deref(), Some("Chroma1-HD.safetensors"));
        assert_eq!(name(&found.text_encoder).as_deref(), Some("t5xxl_fp16.safetensors"));
        assert_eq!(name(&found.vae).as_deref(), Some("ae.safetensors"));
        assert_eq!(find_models(&root.join("nowhere")), FoundModels::default());
        let _ = std::fs::remove_dir_all(&root);
    }
}
