//! Integration test for the macOS window-tiling fix.
//!
//! macOS only injects the standard window commands — Minimize/Zoom plus the
//! Sequoia "Move & Resize" tiling shortcuts (fn+Control+arrows) — into the
//! submenu that `AppHandle::set_menu` registers as the NSApp windows menu, and
//! it selects that submenu purely by id (`WINDOW_SUBMENU_ID`). If the app menu
//! ever loses a submenu carrying this exact id, the tiling shortcuts silently
//! break again (the original bug).
//!
//! muda menu objects can only be constructed on the main thread, so this target
//! sets `harness = false` (see Cargo.toml) and runs the assertions from `main`,
//! which executes on the process's main thread.

fn main() {
    // The build matrix is macOS + Windows. muda needs a desktop GUI stack
    // (GTK on Linux); skip elsewhere so `cargo test` stays green off-target.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    run();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    eprintln!("skipping window-menu test on this platform");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run() {
    use tauri::menu::WINDOW_SUBMENU_ID;

    let app = tauri::test::mock_app();
    let menu = mdhero_lib::menu::create_menu(app.handle()).expect("menu should build");

    let window_item = menu.get(WINDOW_SUBMENU_ID).unwrap_or_else(|| {
        panic!(
            "a submenu with WINDOW_SUBMENU_ID ({WINDOW_SUBMENU_ID:?}) must exist so \
             AppHandle::set_menu registers it as the windows menu and macOS injects \
             the Minimize/Zoom + Move & Resize tiling shortcuts"
        )
    });

    let submenu = window_item
        .as_submenu()
        .expect("the WINDOW_SUBMENU_ID entry must be a submenu");

    assert_eq!(submenu.text().unwrap(), "Window");
    // We supply Minimize + Zoom; macOS appends Move & Resize and the live window
    // list at runtime. Omitting close_window keeps Cmd+W bound to "Close Tab".
    assert_eq!(
        submenu.items().unwrap().len(),
        2,
        "window submenu should expose exactly Minimize and Zoom"
    );

    // The pre-existing Edit > Find item (Cmd+F) must remain intact.
    let edit = menu
        .items()
        .unwrap()
        .into_iter()
        .find_map(|item| {
            let submenu = item.as_submenu()?;
            (submenu.text().ok()? == "Edit").then(|| submenu.clone())
        })
        .expect("Edit submenu should exist");
    assert!(
        edit.get("find").is_some(),
        "Edit > Find (Cmd+F) should be preserved"
    );

    // File > Print (#89) must exist, be enabled, and carry the platform
    // accelerator — it is the only discoverable way to print on Windows.
    let file = menu
        .items()
        .unwrap()
        .into_iter()
        .find_map(|item| {
            let submenu = item.as_submenu()?;
            (submenu.text().ok()? == "File").then(|| submenu.clone())
        })
        .expect("File submenu should exist");
    let print = file
        .get("print")
        .expect("File > Print should exist");
    let print = print.as_menuitem().expect("File > Print should be a plain item");
    assert_eq!(print.text().unwrap(), "Print...");
    assert!(print.is_enabled().unwrap(), "File > Print should be enabled");

    println!("ok: Window submenu present with tiling id; Edit > Find preserved; File > Print present");
}
