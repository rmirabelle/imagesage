use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{ipc::Response, AppHandle, Manager, State};

use crate::models::{download_verified, VerifiedDownload};
use crate::requests::{self, AiRequests};

/**
 * Music for the video slideshow. The app downloads each track once, when the
 * user first picks it, from a `music-*` release of this repo (which
 * `publish.ps1` never deletes) into its local data folder. Dev builds also
 * list every MP3 in the project's `music` folder, so tracks can be tried
 * before they are published.
 */
const MUSIC_DOWNLOAD_PREFIX: &str = "https://github.com/rmirabelle/imagesage/releases/download/music-";

pub struct Track {
    id: &'static str,
    title: &'static str,
    file: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

/// The published tracks, by Robert Mirabelle; each file is in the `music-v1` release.
const TRACKS: &[Track] = &[
    Track {
        id: "indiara-lost",
        title: "Indiara Lost",
        file: "indiara-lost.mp3",
        url: "https://github.com/rmirabelle/imagesage/releases/download/music-v1/indiara-lost.mp3",
        size: 9_265_861,
        sha256: "1b757c6989ac6e315033f051b0ec2fd30cace90267e9a77ce42e9d80dde6a057",
    },
    Track {
        id: "infinity-teeth",
        title: "Infinity Teeth",
        file: "infinity-teeth.mp3",
        url: "https://github.com/rmirabelle/imagesage/releases/download/music-v1/infinity-teeth.mp3",
        size: 12_031_379,
        sha256: "e0062a9e3771fc120e3be79290acd7f3ccb452eb4c979cf04bf630ccfddfe7a1",
    },
    Track {
        id: "into-the-light",
        title: "Into the Light",
        file: "into-the-light.mp3",
        url: "https://github.com/rmirabelle/imagesage/releases/download/music-v1/into-the-light.mp3",
        size: 12_398_318,
        sha256: "693fcab1c2a21cb495086221e515ca954a08f666be164ab88e5fdbb80ee83f30",
    },
    Track {
        id: "nemesis-redux",
        title: "Nemesis (Redux)",
        file: "nemesis-redux.mp3",
        url: "https://github.com/rmirabelle/imagesage/releases/download/music-v1/nemesis-redux.mp3",
        size: 10_843_194,
        sha256: "6ed47cc933f293629847bfe1c00168f4553d181e6099a9e006b678111abb3bec",
    },
    Track {
        id: "shenandoah-spirit",
        title: "Shenandoah Spirit",
        file: "shenandoah-spirit.mp3",
        url: "https://github.com/rmirabelle/imagesage/releases/download/music-v1/shenandoah-spirit.mp3",
        size: 13_365_273,
        sha256: "9e637c3729ee39f8d09d7e99f7796bcc35ee6d3dfaf459af9b245f1d01067a66",
    },
];

/// The prefix of a track found in the project's `music` folder (dev builds only).
const DEV_PREFIX: &str = "dev:";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    id: String,
    title: String,
    size_bytes: u64,
    installed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicDownloadRequest {
    track: String,
    request_id: String,
}

fn track(id: &str) -> Result<&'static Track, String> {
    TRACKS
        .iter()
        .find(|track| track.id == id)
        .ok_or_else(|| format!("There is no track named {id}."))
}

fn music_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not find the app data folder: {error}"))?
        .join("music");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create the music folder: {error}"))?;
    Ok(dir)
}

/// The project's `music` folder, read only by dev builds.
fn dev_dir() -> Option<PathBuf> {
    cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("music"))
}

/// A plain MP3 file name: no folders, so a name cannot reach outside the music folder.
fn safe_mp3_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name != ".."
        && Path::new(name).extension().is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
}

/// A track counts as installed only when it has the expected size; the hash was checked when it was downloaded.
fn installed_path(app: &AppHandle, track: &Track) -> Result<Option<PathBuf>, String> {
    let path = music_dir(app)?.join(track.file);
    let size_matches = std::fs::metadata(&path).map(|meta| meta.len() == track.size).unwrap_or(false);
    Ok(size_matches.then_some(path))
}

/// The size of a file in the project's `music` folder, for matching it to a published track.
fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().filter(|meta| meta.is_file()).map(|meta| meta.len())
}

/**
 * The dev copy of a published track, when the project's `music` folder has it:
 * the file with the track's published name, or any MP3 with exactly its size
 * (the folder keeps the original file names).
 */
fn dev_copy(track: &Track) -> Option<PathBuf> {
    let dir = dev_dir()?;
    let named = dir.join(track.file);
    if named.is_file() {
        return Some(named);
    }
    std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| is_mp3(path) && file_size(path) == Some(track.size))
}

fn is_mp3(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
}

fn validate_track_url(url: &str) -> Result<(), String> {
    if url.starts_with(MUSIC_DOWNLOAD_PREFIX) && url.ends_with(".mp3") {
        Ok(())
    } else {
        Err("The track URL is not an official Image Sage track.".into())
    }
}

/// The tracks to offer: the published ones, then (in dev builds) the other MP3s in the project's `music` folder.
#[tauri::command]
pub fn music_tracks(app: AppHandle) -> Result<Vec<TrackInfo>, String> {
    let mut list = Vec::new();
    for track in TRACKS {
        list.push(TrackInfo {
            id: track.id.into(),
            title: track.title.into(),
            size_bytes: track.size,
            installed: dev_copy(track).is_some() || installed_path(&app, track)?.is_some(),
        });
    }
    if let Some(dir) = dev_dir() {
        let mut found: Vec<(String, u64)> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let size = entry.metadata().ok()?.len();
                (safe_mp3_name(&name) && !TRACKS.iter().any(|track| track.file == name || track.size == size)).then_some((name, size))
            })
            .collect();
        found.sort();
        for (name, size) in found {
            let title = Path::new(&name).file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
            list.push(TrackInfo { id: format!("{DEV_PREFIX}{name}"), title, size_bytes: size, installed: true });
        }
    }
    Ok(list)
}

/// Downloads a published track, checking its hash before it is kept.
#[tauri::command]
pub async fn music_download(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request: MusicDownloadRequest,
) -> Result<(), String> {
    if request.track.starts_with(DEV_PREFIX) {
        return Ok(());
    }
    let track = track(&request.track)?;
    validate_track_url(track.url)?;
    if dev_copy(track).is_some() || installed_path(&app, track)?.is_some() {
        return Ok(());
    }
    let target = music_dir(&app)?.join(track.file);
    requests::run_cancellable(app, &requests, request.request_id, move |reporter| async move {
        reporter.progress("downloading", 0.0);
        let client = requests::client()?;
        let download = VerifiedDownload { url: track.url, size: track.size, sha256: track.sha256, what: "track" };
        download_verified(&client, &reporter, &download, &target, 0, track.size).await?;
        reporter.progress("downloading", 1.0);
        Ok(())
    })
    .await
}

/// The bytes of a track's MP3 file, for the webview to decode.
#[tauri::command]
pub fn music_read(app: AppHandle, track: String) -> Result<Response, String> {
    let path = if let Some(name) = track.strip_prefix(DEV_PREFIX) {
        let dir = dev_dir().ok_or("Tracks from the project folder are only for dev builds.")?;
        if !safe_mp3_name(name) {
            return Err(format!("{name} is not an MP3 file name."));
        }
        dir.join(name)
    } else {
        let spec = self::track(&track)?;
        match dev_copy(spec) {
            Some(path) => path,
            None => installed_path(&app, spec)?.ok_or("The track is not downloaded yet.")?,
        }
    };
    let bytes = std::fs::read(&path).map_err(|error| format!("Could not read the track: {error}"))?;
    Ok(Response::new(bytes))
}

/// Audio files the user may pick for the slideshow; the webview decodes these formats.
const AUDIO_EXTENSIONS: [&str; 6] = ["mp3", "wav", "m4a", "aac", "ogg", "flac"];
/// The largest audio file read, so a wrong pick cannot fill the memory.
const MAX_AUDIO_BYTES: u64 = 300 * 1024 * 1024;

fn is_audio_file_name(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| AUDIO_EXTENSIONS.iter().any(|allowed| extension.eq_ignore_ascii_case(allowed)))
}

/// The bytes of an audio file the user picked on this PC, for the webview to decode. Only audio file types are read.
#[tauri::command]
pub fn music_read_file(path: String) -> Result<Response, String> {
    let file = Path::new(&path);
    if !is_audio_file_name(file) {
        return Err("Pick an MP3, WAV, M4A, AAC, OGG or FLAC file.".into());
    }
    let size = std::fs::metadata(file).map_err(|error| format!("Could not open {path}: {error}"))?.len();
    if size > MAX_AUDIO_BYTES {
        return Err("The audio file is larger than 300 MB.".into());
    }
    let bytes = std::fs::read(file).map_err(|error| format!("Could not read {path}: {error}"))?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_track_has_an_official_url() {
        for track in TRACKS {
            assert!(validate_track_url(track.url).is_ok(), "{}", track.url);
            assert_eq!(track.sha256.len(), 64);
            assert!(safe_mp3_name(track.file));
        }
        assert!(validate_track_url("https://github.com/rmirabelle/imagesage/releases/download/v0.1.0/x.mp3").is_err());
        assert!(validate_track_url("https://github.com/rmirabelle/imagesage/releases/download/music-v1/x.exe").is_err());
    }

    #[test]
    fn mp3_names_stay_in_the_folder() {
        assert!(safe_mp3_name("Calm Morning.mp3"));
        assert!(!safe_mp3_name("../secret.mp3"));
        assert!(!safe_mp3_name("C:evil.mp3"));
        assert!(!safe_mp3_name("song.wav"));
    }

    #[test]
    fn only_audio_files_are_read() {
        assert!(is_audio_file_name(Path::new(r"C:\Music\Song.MP3")));
        assert!(is_audio_file_name(Path::new("take.flac")));
        assert!(!is_audio_file_name(Path::new(r"C:\Users\me\secrets.txt")));
        assert!(!is_audio_file_name(Path::new("noextension")));
    }
}
