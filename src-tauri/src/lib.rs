use std::io::Write;

/// Writes bytes to a file named `name` inside a per-app temp directory and
/// returns the absolute path. Used to hand generated text/title PNGs to the
/// bundled ffmpeg sidecar during export.
#[tauri::command]
fn write_temp_file(name: String, data: Vec<u8>) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("cutline");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.push(name);
    let mut file = std::fs::File::create(&dir).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Writes UTF-8 text to an arbitrary path (used to save project files).
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Writes raw bytes to an arbitrary path (used to save frame snapshots).
#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

/// Reads a UTF-8 text file (used to load project files); errs if missing.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Creates (and returns the path of) a subdirectory under the per-app temp dir.
/// Used by frame-accurate export to stage the rendered PNG sequence.
#[tauri::command]
fn make_temp_dir(name: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("cutline");
    dir.push(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Recursively removes a directory (best-effort cleanup of staged frames).
/// Ignores a missing directory so double-cleanup is harmless.
#[tauri::command]
fn remove_dir(path: String) -> Result<(), String> {
    match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());

    // The auto-updater (and the process plugin used to relaunch after an update)
    // are desktop-only.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            write_temp_file,
            write_text_file,
            write_binary_file,
            read_text_file,
            make_temp_dir,
            remove_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
