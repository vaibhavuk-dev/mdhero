use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Which files are watched, and how many of them share each parent directory.
///
/// Pure bookkeeping, kept apart from `notify` so the reference-count rules are
/// unit-testable: a directory starts being watched when its first file is
/// added and stops when its last file is removed (#97).
#[derive(Default)]
pub struct WatchSet {
    files: HashSet<PathBuf>,
    dirs: HashMap<PathBuf, usize>,
}

impl WatchSet {
    /// Add a file. Returns the parent directory if it must now start being
    /// watched (this is its first file). Adding a file twice is a no-op.
    pub fn add(&mut self, file: PathBuf) -> Option<PathBuf> {
        let dir = file.parent()?.to_path_buf();
        if !self.files.insert(file) {
            return None;
        }
        let count = self.dirs.entry(dir.clone()).or_insert(0);
        *count += 1;
        (*count == 1).then_some(dir)
    }

    /// Remove a file. Returns the parent directory if it can now stop being
    /// watched (this was its last file). Removing an unknown file is a no-op.
    pub fn remove(&mut self, file: &Path) -> Option<PathBuf> {
        if !self.files.remove(file) {
            return None;
        }
        let dir = file.parent()?.to_path_buf();
        match self.dirs.get_mut(&dir) {
            Some(count) if *count > 1 => {
                *count -= 1;
                None
            }
            Some(_) => {
                self.dirs.remove(&dir);
                Some(dir)
            }
            None => None,
        }
    }

    /// The stored path for `file`, if it is watched. The stored value is what
    /// the frontend handed us, so emitting it back round-trips exactly.
    pub fn watched(&self, file: &Path) -> Option<&PathBuf> {
        self.files.get(file)
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn clear(&mut self) {
        self.files.clear();
        self.dirs.clear();
    }
}

type FsDebouncer = Debouncer<notify::RecommendedWatcher>;

/// One debouncer for the whole app, created on the first watched file and
/// dropped when the last one goes, watching each parent directory once no
/// matter how many open tabs live in it. Watching the directory rather than
/// the file survives atomic saves (write temp + rename), which is how most
/// editors save.
pub struct WatcherState {
    debouncer: Mutex<Option<FsDebouncer>>,
    set: Arc<Mutex<WatchSet>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            debouncer: Mutex::new(None),
            set: Arc::new(Mutex::new(WatchSet::default())),
        }
    }
}

fn make_debouncer(app: &AppHandle, set: Arc<Mutex<WatchSet>>) -> Result<FsDebouncer, String> {
    let app_handle = app.clone();
    new_debouncer(
        Duration::from_millis(500),
        move |res: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| match res {
            Ok(events) => {
                for event in events {
                    if event.kind != DebouncedEventKind::Any {
                        continue;
                    }
                    // Only files an open tab asked for; everything else in the
                    // directory is noise.
                    let hit = set
                        .lock()
                        .ok()
                        .and_then(|s| s.watched(&event.path).cloned());
                    if let Some(path) = hit {
                        let _ = app_handle.emit(
                            "file-changed",
                            serde_json::json!({ "path": path.to_string_lossy() }),
                        );
                    }
                }
            }
            Err(e) => eprintln!("Watch error: {:?}", e),
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))
}

/// Start delivering `file-changed` events for `path`. Safe to call for a file
/// that is already watched.
#[tauri::command]
pub fn watch_file(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut debouncer = state.debouncer.lock().map_err(|e| e.to_string())?;
    let file = PathBuf::from(&path);
    let new_dir = state
        .set
        .lock()
        .map_err(|e| e.to_string())?
        .add(file.clone());
    if let Some(dir) = new_dir {
        if debouncer.is_none() {
            *debouncer = Some(make_debouncer(&app, Arc::clone(&state.set))?);
        }
        let result = debouncer
            .as_mut()
            .expect("debouncer was just created")
            .watcher()
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch directory: {}", e));
        if result.is_err() {
            // Roll the bookkeeping back so a retry starts clean.
            if let Ok(mut set) = state.set.lock() {
                set.remove(&file);
            }
            result?;
        }
    }
    Ok(())
}

/// Stop delivering events for `path`; the directory watch goes when its last
/// file does, and the debouncer (a thread plus OS handles) goes with the last
/// directory.
#[tauri::command]
pub fn unwatch_file(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut debouncer = state.debouncer.lock().map_err(|e| e.to_string())?;
    let (gone_dir, empty) = {
        let mut set = state.set.lock().map_err(|e| e.to_string())?;
        let gone = set.remove(Path::new(&path));
        (gone, set.is_empty())
    };
    if let (Some(dir), Some(d)) = (gone_dir, debouncer.as_mut()) {
        let _ = d.watcher().unwatch(&dir);
    }
    if empty {
        *debouncer = None;
    }
    Ok(())
}

/// Drop every watch. Used at shutdown of the frontend listener.
#[tauri::command]
pub fn stop_watching(app: AppHandle) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut debouncer = state.debouncer.lock().map_err(|e| e.to_string())?;
    state.set.lock().map_err(|e| e.to_string())?.clear();
    *debouncer = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::WatchSet;
    use std::path::{Path, PathBuf};

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn first_file_in_a_directory_starts_the_watch_and_the_last_stops_it() {
        let mut set = WatchSet::default();
        assert_eq!(set.add(p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add(p("/docs/b.md")), None, "second file in the same dir reuses the watch");
        assert_eq!(set.remove(Path::new("/docs/a.md")), None, "one file still needs the dir");
        assert_eq!(set.remove(Path::new("/docs/b.md")), Some(p("/docs")));
        assert!(set.is_empty());
    }

    #[test]
    fn directories_are_counted_independently() {
        let mut set = WatchSet::default();
        assert_eq!(set.add(p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add(p("/notes/n.md")), Some(p("/notes")));
        assert_eq!(set.remove(Path::new("/docs/a.md")), Some(p("/docs")));
        assert!(!set.is_empty());
        assert!(set.watched(Path::new("/notes/n.md")).is_some());
    }

    #[test]
    fn adding_twice_and_removing_the_unknown_are_no_ops() {
        let mut set = WatchSet::default();
        assert_eq!(set.add(p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add(p("/docs/a.md")), None);
        // Still exactly one reference: removing it releases the directory.
        assert_eq!(set.remove(Path::new("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.remove(Path::new("/docs/never.md")), None);
        assert_eq!(set.remove(Path::new("/docs/a.md")), None);
    }

    #[test]
    fn only_watched_files_match_and_the_stored_path_is_returned() {
        let mut set = WatchSet::default();
        set.add(p("/docs/a.md"));
        assert_eq!(set.watched(Path::new("/docs/a.md")), Some(&p("/docs/a.md")));
        assert_eq!(set.watched(Path::new("/docs/other.md")), None, "a sibling's change is noise");
        set.clear();
        assert!(set.is_empty());
        assert_eq!(set.watched(Path::new("/docs/a.md")), None);
    }
}
