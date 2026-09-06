use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager,
};

/// Explicitly quit the app — used by the "Close on Escape" setting when
/// closing the last tab. On macOS this is needed because the standard
/// "close window" behavior leaves the app running in the dock.
///
/// SAFETY: this bypasses any pending dirty-tab confirmation. Callers MUST
/// close all dirty tabs via the frontend tab store (which surfaces a
/// confirm() prompt) before invoking this. Currently only invoked from the
/// close-on-ESC flow in `+page.svelte`, which guarantees this — either the
/// last tab is closed via `handleCloseTab` first (dirty prompt included), or
/// the invocation only happens from the home tab when no file tabs exist.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Extensions the app is allowed to read from / write to on behalf of the
/// web view. MDHero is a markdown app: a document, its links and its saves are
/// text. Bounding the two filesystem commands to this set means that even if a
/// script ever ran in the web view (see the Mermaid/CSP hardening), it cannot
/// turn `read_markdown_file` / `write_markdown_file` into an arbitrary-file
/// read/write primitive against `~/.ssh/id_rsa`, `authorized_keys` and the
/// like. (Felipe Boralli disclosure, 2026-08-14.)
const ALLOWED_TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt", "text"];

fn has_allowed_extension(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_TEXT_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

#[tauri::command]
pub fn read_markdown_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);

    if !has_allowed_extension(p) {
        return Err(format!("Refusing to read a non-text file: {}", path));
    }

    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    fs::read_to_string(p).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);

    if !has_allowed_extension(p) {
        return Err(format!("Refusing to write a non-text file: {}", path));
    }

    if p.exists() && !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    fs::write(p, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// The current user's home directory.
///
/// `std::env::var("HOME")` is not set on Windows, so every caller that used it
/// failed there — the "Plans" list was permanently empty on Windows builds.
/// Kept dependency-free on purpose: `USERPROFILE` (plus the HOMEDRIVE/HOMEPATH
/// fallback for older/roaming setups) is what Windows actually provides.
pub fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|s| !s.is_empty()) {
            return Some(std::path::PathBuf::from(profile));
        }
        match (
            std::env::var_os("HOMEDRIVE").filter(|s| !s.is_empty()),
            std::env::var_os("HOMEPATH").filter(|s| !s.is_empty()),
        ) {
            (Some(drive), Some(rest)) => {
                let mut joined = std::ffi::OsString::from(drive);
                joined.push(&rest);
                Some(std::path::PathBuf::from(joined))
            }
            _ => None,
        }
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
    }
}

/// Strip Windows' verbatim prefix (`\\?\`) that `canonicalize` returns.
///
/// The prefix is valid but leaks into anything that displays the path, and it
/// breaks naive string handling on the frontend. `\\?\UNC\server\share` folds
/// back to `\\server\share`. No-op on other platforms.
fn strip_verbatim_prefix(path: String) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path
}

#[tauri::command]
pub fn resolve_path(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let absolute = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to determine current directory: {}", e))?
            .join(p)
    };

    absolute
        .canonicalize()
        .unwrap_or(absolute)
        .to_str()
        .map(|s| strip_verbatim_prefix(s.to_string()))
        .ok_or_else(|| format!("Path is not valid UTF-8: {}", path))
}

/// Whether a path exists on disk. Used by the local-file-link handler (#30)
/// to surface a graceful "file not found" toast before attempting to open,
/// instead of silently no-opping or replacing the current document.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Allow the webview's asset protocol to serve specific image files — but only
/// files a document is entitled to.
///
/// The frontend resolves every local `<img src>` to an absolute path during
/// rendering and hands the list here (issue #31). Each path is canonicalized
/// (so symlinks cannot smuggle a file in) and must sit inside one of the
/// document's asset roots, see [`asset_roots`]. Anything else is refused and
/// returned to the caller so it can be logged. There is no static scope in
/// `tauri.conf.json` any more: the only files the webview can ever fetch are
/// the ones a document legitimately referenced from its own tree.
///
/// Why the bound matters: DOMPurify is the only thing between a markdown file
/// and script execution in the webview, and `csp` is null. Before this check a
/// document could write `![x](../../../.ssh/id_rsa)` and make that file
/// fetchable, so a single sanitizer bypass would have been a file-exfiltration
/// primitive across the whole disk. Now it is bounded to what the user opened.
#[tauri::command]
pub fn allow_assets(
    app: AppHandle,
    document_path: String,
    pinned_folders: Vec<String>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let (allowed, rejected) = partition_assets(Path::new(&document_path), &pinned_folders, &paths);
    let scope = app.asset_protocol_scope();
    for p in &allowed {
        scope
            .allow_file(p)
            .map_err(|e| format!("Failed to allow asset {}: {}", p.display(), e))?;
    }
    Ok(rejected)
}

/// Split the requested asset paths into the canonical files that may be
/// served and the requests that must be refused. Pure so it can be tested
/// without an app handle.
pub fn partition_assets(
    document_path: &Path,
    pinned_folders: &[String],
    paths: &[String],
) -> (Vec<PathBuf>, Vec<String>) {
    let ceiling = home_dir().and_then(|h| fs::canonicalize(h).ok());
    partition_assets_below(document_path, pinned_folders, paths, ceiling.as_deref())
}

/// [`partition_assets`] with an explicit ceiling for the git-root walk; see
/// [`git_root`]. Split out so the ceiling is testable without a real home.
fn partition_assets_below(
    document_path: &Path,
    pinned_folders: &[String],
    paths: &[String],
    ceiling: Option<&Path>,
) -> (Vec<PathBuf>, Vec<String>) {
    let roots = asset_roots(document_path, pinned_folders, ceiling);
    let mut allowed = Vec::new();
    let mut rejected = Vec::new();
    for p in paths {
        match fs::canonicalize(p) {
            Ok(c) if c.is_file() && roots.iter().any(|r| c.starts_with(r)) => allowed.push(c),
            _ => rejected.push(p.clone()),
        }
    }
    (allowed, rejected)
}

/// The directory trees a document may load images from:
///
/// 1. the directory the document lives in — widened to the enclosing git
///    checkout when there is one, because `docs/guide.md` referencing
///    `../assets/diagram.png` is how repositories are laid out;
/// 2. every folder the user pinned in the sidebar — an explicit act of trust
///    and the escape hatch for vaults that keep attachments beside the notes
///    tree rather than inside it.
///
/// Everything is canonicalized so comparison happens on real paths. A document
/// that does not exist on disk (`new://`, `paste://`) contributes no root, so
/// only pinned folders remain.
fn asset_roots(document_path: &Path, pinned_folders: &[String], ceiling: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(doc) = fs::canonicalize(document_path) {
        if let Some(dir) = doc.parent() {
            roots.push(git_root(dir, ceiling).unwrap_or_else(|| dir.to_path_buf()));
        }
    }
    for folder in pinned_folders {
        if let Ok(f) = fs::canonicalize(folder) {
            if f.is_dir() {
                roots.push(f);
            }
        }
    }
    roots
}

/// Nearest ancestor (including `dir` itself) that holds a `.git` entry — a
/// directory for a normal checkout, a file for worktrees and submodules.
///
/// The walk never reaches `ceiling` (the home directory in production), any
/// ancestor of it, or a filesystem root. Without that, a dotfiles repo at
/// `~/.git` would widen every document under home to the whole home
/// directory — exactly the exposure this bound exists to remove.
fn git_root(dir: &Path, ceiling: Option<&Path>) -> Option<PathBuf> {
    dir.ancestors()
        .take_while(|a| a.parent().is_some() && ceiling.map_or(true, |c| !c.starts_with(a)))
        .find(|a| a.join(".git").exists())
        .map(Path::to_path_buf)
}

#[tauri::command]
pub fn list_claude_plans() -> Result<Vec<PlanFile>, String> {
    let home = home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let plans_dir = home.join(".claude").join("plans");

    if !plans_dir.exists() {
        return Ok(Vec::new());
    }

    let mut plans: Vec<PlanFile> = Vec::new();

    let entries =
        fs::read_dir(&plans_dir).map_err(|e| format!("Failed to read plans directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" || ext == "markdown" {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let modified = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    plans.push(PlanFile {
                        name,
                        path: path.to_string_lossy().to_string(),
                        modified,
                    });
                }
            }
        }
    }

    // Sort by most recent first
    plans.sort_by(|a, b| b.modified.cmp(&a.modified));

    Ok(plans)
}

#[derive(serde::Serialize)]
pub struct PlanFile {
    pub name: String,
    pub path: String,
    pub modified: u64,
}

#[tauri::command]
pub fn list_folder_md_files(folder: String, max_depth: Option<u32>) -> Result<Vec<MdFile>, String> {
    let root = Path::new(&folder);
    if !root.exists() || !root.is_dir() {
        return Ok(Vec::new());
    }

    let depth_limit = max_depth.unwrap_or(3);
    let mut files: Vec<MdFile> = Vec::new();
    collect_md_files(root, root, depth_limit, 0, &mut files);

    // Sort by most recent first
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    // Cap at 50 files to keep UI fast
    files.truncate(50);

    Ok(files)
}

fn collect_md_files(
    root: &Path,
    dir: &Path,
    max_depth: u32,
    current_depth: u32,
    files: &mut Vec<MdFile>,
) {
    if current_depth > max_depth {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip hidden directories/files
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        // Skip common non-content directories
        if path.is_dir() {
            if let Some(name) = path.file_name() {
                let n = name.to_string_lossy();
                if matches!(
                    n.as_ref(),
                    "node_modules"
                        | "target"
                        | "dist"
                        | "build"
                        | ".git"
                        | "__pycache__"
                        | "vendor"
                ) {
                    continue;
                }
            }
            collect_md_files(root, &path, max_depth, current_depth + 1, files);
            continue;
        }

        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" || ext == "markdown" || ext == "mdown" || ext == "mkd" {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    // Relative path from the root folder
                    let rel_path = path
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let modified = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    files.push(MdFile {
                        name,
                        path: path.to_string_lossy().to_string(),
                        rel_path,
                        modified,
                    });
                }
            }
        }
    }
}

#[derive(serde::Serialize)]
pub struct MdFile {
    pub name: String,
    pub path: String,
    pub rel_path: String,
    pub modified: u64,
}

// ---- AI Lookup right-click context menu ----------------------------------
//
// The frontend's aiLookup store owns the data (providers + prompts). When the
// user right-clicks selected text in the rendered article, the frontend invokes
// `show_ai_context_menu` with the current provider list and a flag for whether
// any text is selected. We build a native Tauri menu from that payload and
// popup at the cursor. Click handling is in `lib.rs::setup`'s `on_menu_event`,
// which matches IDs starting with `aimenu:` and forwards them to the JS
// `__mdhero_ai_lookup` window function. The selection itself is held in the
// webview (not passed through here) so this command doesn't touch user content.

#[derive(Deserialize)]
pub struct AIPrompt {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct AIProvider {
    pub id: String,
    pub name: String,
    pub prompts: Vec<AIPrompt>,
}

#[tauri::command]
pub fn show_ai_context_menu(
    app: AppHandle,
    providers: Vec<AIProvider>,
    has_selection: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let menu = Menu::new(&app).map_err(|e| e.to_string())?;

    // Standard editing items at the top (matches what most apps' context menus
    // open with). These are also the default browser context menu items, which
    // would otherwise be lost when we suppress the default contextmenu.
    menu.append(&PredefinedMenuItem::cut(&app, None).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::copy(&app, None).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::paste(&app, None).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    // Search Google — enabled only when there's a selection. The doc keeps this
    // as a single, recognisable top-level item rather than burying it inside a
    // provider submenu, because it's most users' baseline "look this up" reflex.
    let google_item = MenuItem::with_id(
        &app,
        "aimenu:google",
        "Search Google for selection",
        has_selection,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&google_item).map_err(|e| e.to_string())?;

    if !providers.is_empty() {
        menu.append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }

    // One submenu per provider. The submenu items are saved prompts; clicking
    // one assembles the URL from provider.urlTemplate + prompt.template +
    // current selection (done frontend-side).
    for provider in &providers {
        let submenu_label = format!("Ask {}", provider.name);
        let submenu =
            Submenu::new(&app, &submenu_label, has_selection).map_err(|e| e.to_string())?;

        if provider.prompts.is_empty() {
            // Empty submenu would be silently invisible on some platforms;
            // surface a disabled hint so the user understands why nothing
            // happens, and to find Settings.
            let hint = MenuItem::with_id(
                &app,
                format!("aimenu:noop:{}", provider.id),
                "No prompts — add some in Settings",
                false,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            submenu.append(&hint).map_err(|e| e.to_string())?;
        } else {
            for prompt in &provider.prompts {
                let id = format!("aimenu:template:{}:{}", provider.id, prompt.id);
                let item = MenuItem::with_id(&app, id, &prompt.name, has_selection, None::<&str>)
                    .map_err(|e| e.to_string())?;
                submenu.append(&item).map_err(|e| e.to_string())?;
            }
        }

        menu.append(&submenu).map_err(|e| e.to_string())?;
    }

    menu.append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    // Custom prompt is always enabled — user can type a standalone prompt with
    // no selection.
    let custom_item = MenuItem::with_id(
        &app,
        "aimenu:custom",
        "Custom prompt...",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&custom_item).map_err(|e| e.to_string())?;

    window.popup_menu(&menu).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod fs_scope_tests {
    use super::{has_allowed_extension, read_markdown_file, write_markdown_file};
    use std::path::Path;

    #[test]
    fn text_extensions_are_allowed_case_insensitively() {
        for ok in ["/x/a.md", "/x/a.MARKDOWN", "/x/a.Txt", "/x/a.mkd", "/x/a.mdx"] {
            assert!(has_allowed_extension(Path::new(ok)), "{ok} should be allowed");
        }
    }

    #[test]
    fn sensitive_and_extensionless_paths_are_refused() {
        for bad in [
            "/home/u/.ssh/id_rsa",
            "/home/u/.ssh/authorized_keys",
            "/etc/passwd",
            "/home/u/.bashrc",
            "/home/u/a.sh",
            "/home/u/a.exe",
            "/home/u/Makefile",
        ] {
            assert!(!has_allowed_extension(Path::new(bad)), "{bad} should be refused");
        }
    }

    #[test]
    fn read_and_write_reject_a_non_text_path_before_touching_disk() {
        // The path does not exist; the extension guard must fire first, so the
        // error is the refusal, never a "file not found".
        let err = read_markdown_file("/home/u/.ssh/id_rsa".into()).unwrap_err();
        assert!(err.contains("Refusing to read"), "got: {err}");
        let err = write_markdown_file("/root/.ssh/authorized_keys".into(), "x".into()).unwrap_err();
        assert!(err.contains("Refusing to write"), "got: {err}");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strips_the_verbatim_prefix_canonicalize_returns() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\hugo\a.md".to_string()),
            r"C:\Users\hugo\a.md"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\a.md".to_string()),
            r"\\server\share\a.md"
        );
        assert_eq!(
            strip_verbatim_prefix(r"C:\Users\hugo\a.md".to_string()),
            r"C:\Users\hugo\a.md"
        );
    }
}

#[cfg(test)]
mod asset_scope_tests {
    use super::{partition_assets, partition_assets_below};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory under the OS temp dir. On macOS that lives behind a
    /// symlink (`/var` → `/private/var`), which is deliberate: it proves the
    /// comparison happens on canonical paths, not on the strings handed in.
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mdhero-asset-scope-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) -> String {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn accepts_an_image_beside_the_document_and_returns_it_canonical() {
        let dir = scratch();
        let doc = dir.join("note.md");
        touch(&doc);
        let pic = touch(&dir.join("pic.png"));

        let (allowed, rejected) = partition_assets(&doc, &[], &[pic.clone()]);

        assert_eq!(allowed, vec![fs::canonicalize(&pic).unwrap()]);
        assert!(rejected.is_empty());
    }

    #[test]
    fn accepts_images_in_subfolders_of_the_document() {
        let dir = scratch();
        let doc = dir.join("note.md");
        touch(&doc);
        let pic = touch(&dir.join("img").join("deep").join("pic.png"));

        let (allowed, rejected) = partition_assets(&doc, &[], &[pic]);

        assert_eq!(allowed.len(), 1);
        assert!(rejected.is_empty());
    }

    #[test]
    fn rejects_traversal_above_the_document_tree() {
        let dir = scratch();
        let doc = dir.join("notes").join("note.md");
        touch(&doc);
        let secret = touch(&dir.join("secret.txt"));
        // Exactly what `![x](../secret.txt)` resolves to in the renderer.
        let traversal = s(&dir.join("notes").join("..").join("secret.txt"));

        let (allowed, rejected) = partition_assets(&doc, &[], &[secret.clone(), traversal.clone()]);

        assert!(allowed.is_empty());
        assert_eq!(rejected, vec![secret, traversal]);
    }

    #[test]
    fn widens_to_the_enclosing_git_checkout_but_no_further() {
        let dir = scratch();
        let repo = dir.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let doc = repo.join("docs").join("guide.md");
        touch(&doc);
        let inside = touch(&repo.join("assets").join("diagram.png"));
        let above = touch(&dir.join("outside.png"));

        let (allowed, rejected) = partition_assets(&doc, &[], &[inside.clone(), above.clone()]);

        assert_eq!(allowed, vec![fs::canonicalize(&inside).unwrap()]);
        assert_eq!(rejected, vec![above]);
    }

    #[test]
    fn never_widens_to_the_ceiling_or_above_it() {
        // A dotfiles checkout at ~/.git must not turn "~" into an asset root.
        let dir = scratch();
        let home = dir.join("home");
        fs::create_dir_all(home.join(".git")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap(); // and one above home
        let doc = home.join("notes").join("note.md");
        touch(&doc);
        let elsewhere = touch(&home.join("Pictures").join("pic.png"));
        let beside = touch(&home.join("notes").join("pic.png"));
        let ceiling = fs::canonicalize(&home).unwrap();

        let (allowed, rejected) =
            partition_assets_below(&doc, &[], &[elsewhere.clone(), beside.clone()], Some(&ceiling));

        assert_eq!(allowed, vec![fs::canonicalize(&beside).unwrap()]);
        assert_eq!(rejected, vec![elsewhere]);
    }

    #[test]
    fn a_checkout_below_the_ceiling_still_widens() {
        let dir = scratch();
        let home = dir.join("home");
        let repo = home.join("code").join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let doc = repo.join("docs").join("guide.md");
        touch(&doc);
        let inside = touch(&repo.join("assets").join("d.png"));
        let ceiling = fs::canonicalize(&home).unwrap();

        let (allowed, rejected) = partition_assets_below(&doc, &[], &[inside], Some(&ceiling));

        assert_eq!(allowed.len(), 1);
        assert!(rejected.is_empty());
    }

    #[test]
    fn a_git_file_marks_a_checkout_too() {
        // Worktrees and submodules keep a `.git` *file*, not a directory.
        let dir = scratch();
        let repo = dir.join("wt");
        touch(&repo.join(".git"));
        let doc = repo.join("docs").join("guide.md");
        touch(&doc);
        let inside = touch(&repo.join("assets").join("diagram.png"));

        let (allowed, _) = partition_assets(&doc, &[], &[inside]);

        assert_eq!(allowed.len(), 1);
    }

    #[test]
    fn a_pinned_folder_is_an_allowed_root() {
        let dir = scratch();
        let doc = dir.join("notes").join("note.md");
        touch(&doc);
        let shared = touch(&dir.join("attachments").join("pic.png"));

        let (allowed, rejected) = partition_assets(&doc, &[], &[shared.clone()]);
        assert!(allowed.is_empty());
        assert_eq!(rejected, vec![shared.clone()]);

        let pinned = vec![s(&dir.join("attachments"))];
        let (allowed, rejected) = partition_assets(&doc, &pinned, &[shared]);
        assert_eq!(allowed.len(), 1);
        assert!(rejected.is_empty());
    }

    #[test]
    fn a_pinned_folder_does_not_match_by_string_prefix() {
        let dir = scratch();
        let doc = dir.join("elsewhere").join("note.md");
        touch(&doc);
        let pic = touch(&dir.join("attachments-private").join("pic.png"));

        let pinned = vec![s(&dir.join("attachments"))];
        fs::create_dir_all(dir.join("attachments")).unwrap();
        let (allowed, rejected) = partition_assets(&doc, &pinned, &[pic.clone()]);

        assert!(allowed.is_empty());
        assert_eq!(rejected, vec![pic]);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_the_tree() {
        let dir = scratch();
        let doc = dir.join("notes").join("note.md");
        touch(&doc);
        let secret = dir.join("secret.txt");
        touch(&secret);
        let link = dir.join("notes").join("innocent.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let (allowed, rejected) = partition_assets(&doc, &[], &[s(&link)]);

        assert!(allowed.is_empty());
        assert_eq!(rejected, vec![s(&link)]);
    }

    #[test]
    fn rejects_missing_files_and_directories() {
        let dir = scratch();
        let doc = dir.join("note.md");
        touch(&doc);
        fs::create_dir_all(dir.join("folder")).unwrap();
        let missing = s(&dir.join("nope.png"));
        let folder = s(&dir.join("folder"));

        let (allowed, rejected) = partition_assets(&doc, &[], &[missing.clone(), folder.clone()]);

        assert!(allowed.is_empty());
        assert_eq!(rejected, vec![missing, folder]);
    }

    #[test]
    fn a_document_that_is_not_on_disk_gets_only_pinned_roots() {
        let dir = scratch();
        let pic = touch(&dir.join("pic.png"));
        let doc = Path::new("paste://1");

        let (allowed, rejected) = partition_assets(doc, &[], &[pic.clone()]);
        assert!(allowed.is_empty());
        assert_eq!(rejected, vec![pic.clone()]);

        let (allowed, _) = partition_assets(doc, &[s(&dir)], &[pic]);
        assert_eq!(allowed.len(), 1);
    }
}
