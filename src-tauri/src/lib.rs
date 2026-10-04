mod browse;
mod credentials;
mod document;
mod files;
mod flux;
mod openai;
mod pricing;
mod recovery;
mod requests;
mod updater;

use std::{path::Path, sync::Mutex};
use tauri::{Emitter, Manager, State};

struct PendingOpenDocument(Mutex<Option<String>>);

/// The first argument that names a file ImageSage can open (`.imagesage`, PNG or JPEG).
fn openable_file_from_args(args: &[String], cwd: &str) -> Option<String> {
    args.iter().skip(1).find_map(|argument| {
        let path = Path::new(argument);
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        if !matches!(extension.as_str(), "imagesage" | "png" | "jpg" | "jpeg") {
            return None;
        }
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            Path::new(cwd).join(path)
        };
        Some(resolved.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn take_pending_open_document(state: State<'_, PendingOpenDocument>) -> Option<String> {
    state
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
}

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let window_state_flags = tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
        | tauri_plugin_window_state::StateFlags::FULLSCREEN;

    let initial_args = std::env::args_os()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let initial_cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let initial_document = openable_file_from_args(&initial_args, &initial_cwd);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) = openable_file_from_args(&args, &cwd) {
                let _ = app.emit("open-document-requested", path);
            }
            restore_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .build(),
        )
        .manage(PendingOpenDocument(Mutex::new(initial_document)))
        .manage(requests::AiRequests::default())
        .setup(|app| {
            restore_main_window(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::save_image,
            files::cursor_position,
            document::open_image_file,
            document::save_imagesage_document,
            browse::list_browse_directory,
            browse::browse_places,
            browse::rename_browse_entry,
            browse::delete_browse_entry,
            browse::copy_browse_entry,
            credentials::api_key_status,
            credentials::set_api_key,
            credentials::clear_api_key,
            credentials::test_api_key,
            openai::ai_generate,
            openai::ai_edit_whole,
            openai::ai_edit_masked,
            openai::describe_scene,
            flux::flux_edit,
            flux::flux_credits,
            pricing::fetch_prices,
            recovery::recovery_save,
            recovery::recovery_put_tiles,
            recovery::save_document_from_tiles,
            recovery::recovery_list,
            recovery::recovery_remove,
            recovery::recovery_remove_path,
            requests::ai_cancel,
            take_pending_open_document,
            updater::check_for_update,
            updater::download_and_run_installer,
            updater::get_app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running ImageSage");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_openable_file_arguments_case_insensitively() {
        let args = vec!["imagesage.exe".into(), "Poster.IMAGESAGE".into()];
        assert_eq!(
            openable_file_from_args(&args, r"C:\Images"),
            Some(r"C:\Images\Poster.IMAGESAGE".into())
        );
        let args = vec!["imagesage.exe".into(), r"D:\photo.JPG".into()];
        assert_eq!(
            openable_file_from_args(&args, r"C:\Images"),
            Some(r"D:\photo.JPG".into())
        );
    }

    #[test]
    fn ignores_unsupported_file_arguments() {
        let args = vec!["imagesage.exe".into(), "notes.txt".into()];
        assert_eq!(openable_file_from_args(&args, r"C:\Images"), None);
    }
}
