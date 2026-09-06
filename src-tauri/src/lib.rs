mod commands;
pub mod menu;
mod watcher;

use std::sync::Mutex;
use tauri::Manager;

/// Stores file paths received from OS "Open With" events.
/// These arrive before the webview is ready, so we buffer them.
pub struct OpenedFiles {
    pub paths: Mutex<Vec<String>>,
}

impl Default for OpenedFiles {
    fn default() -> Self {
        Self {
            paths: Mutex::new(Vec::new()),
        }
    }
}

#[tauri::command]
fn get_opened_files(state: tauri::State<'_, OpenedFiles>) -> Vec<String> {
    let mut paths = state.paths.lock().unwrap();
    let result = paths.clone();
    paths.clear();
    result
}

/// Parse a `mdhero://open?path=<url-encoded-abs-path>` deep link into an
/// absolute markdown file path. Returns None for any other action, a relative
/// path, a non-markdown extension, or a file that doesn't exist — the scheme is
/// a door any webpage can knock on, so we validate strictly before opening. The
/// path only ever routes to `openFile` (read + render), never a write or exec.
#[cfg(target_os = "macos")]
fn parse_mdhero_url(url: &tauri::Url) -> Option<String> {
    // Action lives in the authority slot: mdhero://open?path=...
    if url.host_str() != Some("open") {
        return None;
    }
    // query_pairs() percent-decodes once. ponytail: it also maps `+`→space
    // (form-urlencoding); paths with a literal `+` should encode it as %2B.
    let raw = url
        .query_pairs()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.into_owned())?;

    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", std::env::var("HOME").ok()?, rest),
        None => raw,
    };

    let path = std::path::Path::new(&expanded);
    let is_md = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|e| matches!(e.as_str(), "md" | "markdown" | "mdown" | "mkd"))
        .unwrap_or(false);

    if path.is_absolute() && is_md && path.exists() {
        Some(expanded)
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_cli::init())
        .manage(watcher::WatcherState::default())
        .manage(OpenedFiles::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_markdown_file,
            commands::write_markdown_file,
            commands::resolve_path,
            commands::path_exists,
            commands::allow_assets,
            commands::list_claude_plans,
            commands::list_folder_md_files,
            commands::quit_app,
            commands::show_ai_context_menu,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::stop_watching,
            get_opened_files,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = menu::create_menu(&handle)?;
            app.set_menu(menu)?;

            // Red-button (window) close routes through the frontend quit guard
            // instead of closing, so unsaved changes get a confirm dialog (#54).
            // Cmd+Q / menu Quit go through the custom "quit" menu event above.
            // quit_app (AppHandle::exit) is a hard exit that bypasses this, so a
            // confirmed quit can't loop back here.
            if let Some(main_window) = app.get_webview_window("main") {
                let quit_win = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = quit_win.eval("window.__mdhero_quit?.()");
                    }
                });
            }

            app.on_menu_event(move |app_handle, event| {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let id = event.id().as_ref();
                    match id {
                        "open" => {
                            let _ = window.eval("window.__mdhero_open_file?.()");
                        }
                        "paste_md" => {
                            let _ = window.eval("window.__mdhero_paste?.()");
                        }
                        "theme" => {
                            let _ = window.eval("window.__mdhero_toggle_theme?.()");
                        }
                        "find" => {
                            let _ = window.eval("window.__mdhero_find?.()");
                        }
                        "close" => {
                            let _ = window.eval("window.__mdhero_close_tab?.()");
                        }
                        "print" => {
                            let _ = window.eval("window.__mdhero_print?.()");
                        }
                        "check_updates" => {
                            let _ = window.eval("window.__mdhero_check_updates?.()");
                        }
                        "about" => {
                            let _ = window.eval("window.__mdhero_about?.()");
                        }
                        "quit" => {
                            let _ = window.eval("window.__mdhero_quit?.()");
                        }
                        // AI lookup right-click menu items — forward the
                        // structured ID to the frontend router. JSON-stringify
                        // the ID so embedded colons (and any future special
                        // chars) survive the eval boundary cleanly.
                        s if s.starts_with("aimenu:") => {
                            let js =
                                format!("window.__mdhero_ai_lookup?.({})", serde_json::json!(s));
                            let _ = window.eval(&js);
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let app_handle = _app_handle;
                let mut file_paths: Vec<String> = Vec::new();

                for url in urls {
                    // "Open With" / double-click deliver a file: URL; the
                    // mdhero:// scheme (#60) delivers a link to parse. Unknown
                    // schemes are dropped (openFile can't do anything with them).
                    let path = match url.scheme() {
                        "file" => url
                            .to_file_path()
                            .ok()
                            .map(|p| p.to_string_lossy().to_string()),
                        "mdhero" => parse_mdhero_url(&url),
                        _ => None,
                    };

                    if let Some(p) = path {
                        file_paths.push(p);
                    }
                }

                if file_paths.is_empty() {
                    return;
                }

                // Try to send directly to frontend if webview is ready
                if let Some(window) = app_handle.get_webview_window("main") {
                    for file_path in &file_paths {
                        let js = format!(
                            "window.__mdhero_open_path?.({})",
                            serde_json::json!(file_path)
                        );
                        let _ = window.eval(&js);
                    }
                }

                // Also buffer in state in case webview isn't ready yet
                if let Some(state) = app_handle.try_state::<OpenedFiles>() {
                    if let Ok(mut paths) = state.paths.lock() {
                        paths.extend(file_paths);
                    }
                }
            }
        });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::parse_mdhero_url;
    use tauri::Url;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn parses_valid_open_url_with_encoded_space() {
        let file = std::env::temp_dir().join("mdhero deep link.md");
        std::fs::write(&file, "# hi").unwrap();
        let enc = format!(
            "mdhero://open?path={}",
            file.to_string_lossy().replace(' ', "%20")
        );
        assert_eq!(
            parse_mdhero_url(&u(&enc)),
            Some(file.to_string_lossy().to_string())
        );
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn expands_tilde() {
        let home = std::env::var("HOME").unwrap();
        let file = std::path::Path::new(&home).join("mdhero_tilde_test.md");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            parse_mdhero_url(&u("mdhero://open?path=~/mdhero_tilde_test.md")),
            Some(file.to_string_lossy().to_string())
        );
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn rejects_wrong_action() {
        assert_eq!(parse_mdhero_url(&u("mdhero://delete?path=/tmp/x.md")), None);
    }

    #[test]
    fn rejects_non_markdown_extension() {
        // /etc/passwd exists but isn't markdown → refused before any open.
        assert_eq!(parse_mdhero_url(&u("mdhero://open?path=/etc/passwd")), None);
    }

    #[test]
    fn rejects_relative_path() {
        assert_eq!(parse_mdhero_url(&u("mdhero://open?path=notes.md")), None);
    }

    #[test]
    fn rejects_missing_file() {
        assert_eq!(
            parse_mdhero_url(&u("mdhero://open?path=/tmp/does-not-exist-abc.md")),
            None
        );
    }

    #[test]
    fn rejects_missing_path_param() {
        assert_eq!(parse_mdhero_url(&u("mdhero://open")), None);
    }
}
