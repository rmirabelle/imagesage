use std::{fs, path::PathBuf};

/**
 * ONNX Runtime is linked into the exe, but DirectML (its GPU backend) is a
 * separate DLL that must sit beside the exe. The `ort` build puts a symbolic
 * link to its own download cache in `target/<profile>/`. The DLL is copied
 * from there into `src-tauri/` (gitignored), so the bundle can ship it as a
 * resource (`tauri.conf.json`), installed next to the exe.
 *
 * The link itself is then removed. Tauri copies every resource into
 * `target/<profile>/`, and copying onto the link would write into the shared
 * cache file, which fails while any dev build of the app has it loaded.
 */
fn copy_directml() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let profile_dir = out_dir.ancestors().nth(3).expect("target profile folder");
    let linked = profile_dir.join("DirectML.dll");
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let bundled = manifest_dir.join("DirectML.dll");
    let is_link = fs::symlink_metadata(&linked).map(|meta| meta.file_type().is_symlink()).unwrap_or(false);
    if is_link {
        let up_to_date = fs::metadata(&bundled)
            .and_then(|bundled_meta| Ok(bundled_meta.len() == fs::metadata(&linked)?.len()))
            .unwrap_or(false);
        if !up_to_date {
            fs::copy(&linked, &bundled)
                .unwrap_or_else(|error| panic!("Could not copy {} for the bundle: {error}", linked.display()));
        }
        fs::remove_file(&linked).unwrap_or_else(|error| panic!("Could not remove the link {}: {error}", linked.display()));
    }
    if !bundled.exists() {
        panic!("DirectML.dll is missing: build once with the `ort` crate's copy-dylibs feature so it can be copied to {}", bundled.display());
    }
}

fn main() {
    copy_directml();
    tauri_build::build()
}
