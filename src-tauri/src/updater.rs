use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const REPO_API: &str = "https://api.github.com/repos/rmirabelle/imagesage/releases/latest";
const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/rmirabelle/imagesage/releases/download/";
const USER_AGENT: &str = "ImageSage-Updater";

#[derive(Debug, Serialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub asset_name: String,
    pub release_notes: String,
    pub release_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn parse_version(version: &str) -> Vec<u32> {
    version
        .trim_start_matches(|character: char| !character.is_ascii_digit())
        .split('.')
        .take(4)
        .map(|part| {
            part.chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>()
        })
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let latest = parse_version(latest);
    let current = parse_version(current);
    let length = latest.len().max(current.len());
    for index in 0..length {
        let latest_part = latest.get(index).copied().unwrap_or(0);
        let current_part = current.get(index).copied().unwrap_or(0);
        if latest_part != current_part {
            return latest_part > current_part;
        }
    }
    false
}

async fn fetch_latest() -> Result<Option<GitHubRelease>> {
    let response = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()?
        .get(REPO_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .context("network error")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(anyhow!("GitHub returned {}", response.status()));
    }
    response
        .json()
        .await
        .map(Some)
        .context("malformed GitHub release data")
}

fn installer_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    assets
        .iter()
        .find(|asset| asset.name.to_ascii_lowercase().ends_with("-setup.exe"))
        .or_else(|| {
            assets
                .iter()
                .find(|asset| asset.name.to_ascii_lowercase().ends_with(".exe"))
        })
}

#[tauri::command]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let current = current_version().to_string();
    let Some(release) = fetch_latest().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let latest = release.tag_name.trim_start_matches('v').to_string();
    if !is_newer(&latest, &current) {
        return Ok(None);
    }
    let asset = installer_asset(&release.assets)
        .ok_or_else(|| "The latest release does not contain a Windows installer.".to_string())?;
    Ok(Some(UpdateInfo {
        current_version: current,
        latest_version: latest,
        download_url: asset.browser_download_url.clone(),
        asset_name: asset.name.clone(),
        release_notes: release.body.unwrap_or_default(),
        release_url: release.html_url,
    }))
}

#[tauri::command]
pub async fn download_and_run_installer(
    app: AppHandle,
    url: String,
    asset_name: String,
) -> Result<(), String> {
    validate_download(&url, &asset_name)?;
    let target = std::env::temp_dir().join(&asset_name);
    download_to(&app, &url, &target)
        .await
        .map_err(|error| format!("Download failed: {error:#}"))?;
    launch_detached(&target).map_err(|error| format!("Launch failed: {error:#}"))?;
    app.exit(0);
    Ok(())
}

fn validate_download(url: &str, asset_name: &str) -> Result<(), String> {
    if !url.starts_with(RELEASE_DOWNLOAD_PREFIX) {
        return Err("The update URL is not an official Image Sage release.".into());
    }
    if asset_name.contains(['/', '\\']) || !asset_name.to_ascii_lowercase().ends_with(".exe") {
        return Err("The update asset name is invalid.".into());
    }
    Ok(())
}

async fn download_to(app: &AppHandle, url: &str, target: &Path) -> Result<()> {
    let response = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()?
        .get(url)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("server returned {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(target)
        .await
        .with_context(|| format!("create {}", target.display()))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0_u64;
    let mut last_emitted = 0_u64;

    emit_progress(app, 0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if downloaded.saturating_sub(last_emitted) >= 65_536 {
            last_emitted = downloaded;
            emit_progress(app, downloaded, total);
        }
    }
    use tokio::io::AsyncWriteExt;
    file.flush().await?;
    drop(file);
    emit_progress(app, downloaded, downloaded);
    Ok(())
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: u64) {
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "downloaded": downloaded, "total": total }),
    );
}

/**
 * NSIS flags for an unattended upgrade, as in DB Sage: `/P` (passive) skips
 * every page and takes the default choices (uninstall the old version, keep
 * app data), and `/R` starts the app again when the install finishes.
 */
const INSTALLER_ARGS: [&str; 2] = ["/P", "/R"];

#[cfg(windows)]
fn launch_detached(path: &PathBuf) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    std::process::Command::new(path)
        .args(INSTALLER_ARGS)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .with_context(|| format!("spawn {}", path.display()))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_detached(path: &PathBuf) -> Result<()> {
    std::process::Command::new(path)
        .args(INSTALLER_ARGS)
        .spawn()
        .with_context(|| format!("spawn {}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub fn get_app_version() -> String {
    current_version().to_string()
}

#[cfg(test)]
mod tests {
    use super::{is_newer, parse_version};

    #[test]
    fn parses_prefixed_versions() {
        assert_eq!(parse_version("v1.2.3"), vec![1, 2, 3]);
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
    }
}
