<script lang="ts">
  import { onMount, tick } from "svelte";
  import { document as docStore } from "$lib/stores/document";
  import { tabStore, HOME_TAB_ID, type Tab } from "$lib/stores/tabs";
  import { initRenderer, renderFull, resolveLocalPath, isMarpDoc } from "$lib/renderer/pipeline";
  import {
    allowAssets,
    getBaseDir,
    newDocument,
    openFile,
    openFileDialog,
    openWithSystem,
    pathExists,
    saveAsNewDocument,
    saveFile,
  } from "$lib/tauri/files";
  import { showToast } from "$lib/stores/toast";
  import { basename } from "$lib/utils/path";
  import { settings, getContentMaxWidth } from "$lib/stores/settings";
  import { startFileWatcher, stopFileWatcher } from "$lib/tauri/watcher";
  import { restoreSession } from "$lib/tauri/session";
  import { themeMode, cycleTheme } from "$lib/stores/theme";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { tocVisible, tocEntries } from "$lib/stores/toc";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";
  import DropZone from "$lib/components/DropZone.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import TableOfContents from "$lib/components/TableOfContents.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import SearchOverlay from "$lib/components/SearchOverlay.svelte";
  import PasteModal from "$lib/components/PasteModal.svelte";
  import OpenDialog from "$lib/components/OpenDialog.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import AboutDialog from "$lib/components/AboutDialog.svelte";
  import CustomPromptModal from "$lib/components/CustomPromptModal.svelte";
  import { assembleUrlByIds, consumePendingSelection } from "$lib/stores/aiLookup";
  import FrontmatterBar from "$lib/components/FrontmatterBar.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import ProgressBar from "$lib/components/ProgressBar.svelte";
  import ScrollToTop from "$lib/components/ScrollToTop.svelte";
  import ImageLightbox from "$lib/components/ImageLightbox.svelte";
  import UpdateToast from "$lib/components/UpdateToast.svelte";
  import Toast from "$lib/components/Toast.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import PresentationView from "$lib/components/PresentationView.svelte";
  import { updateScrollPercent } from "$lib/stores/recents";
  import { checkForUpdates, updateAvailable, updateDismissed, checkInFlight } from "$lib/stores/updater";
  import { get } from "svelte/store";
  import { getCurrentSourceLine, scrollToSourceLine, type ViewMode } from "$lib/utils/scroll-sync";
  import { saveProgress, getProgress } from "$lib/stores/readingProgress";

  let rendererReady = $state(false);
  let lastWatchedPath: string | null = null;
  let searchVisible = $state(false);
  let pasteVisible = $state(false);
  let pasteDefaultMode = $state<"paste" | "url">("paste");
  let openVisible = $state(false);
  let settingsVisible = $state(false);
  let aboutVisible = $state(false);
  let customPromptVisible = $state(false);
  let customPromptSelection = $state("");
  let zenMode = $state(false);
  let rawMode = $state(false);
  let presenting = $state(false);
  // Split mode (#19): editor + live preview side by side. Both Split and Edit
  // are "editing" states (activeTab.isEditing true); splitMode just adds the
  // preview pane, so save / dirty / editContent all keep working unchanged.
  let splitMode = $state(false);
  let splitPreviewHtml = $state("");
  let splitPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let contentMaxWidth = $derived(getContentMaxWidth($settings));

  // Lightbox state
  let lightboxVisible = $state(false);
  let lightboxImages = $state<string[]>([]);
  let lightboxIndex = $state(0);

  // Aggregated flag for any modal/overlay being visible. The close-on-ESC gate
  // and any future "is the user mid-interaction?" check should read this so a
  // new modal can't silently miss the gate by being added to state but not the
  // ESC handler. Each modal's own ESC handler also calls stopPropagation(); the
  // two together cover both focus-inside and focus-outside-modal cases.
  let anyModalVisible = $derived(
    searchVisible || pasteVisible || openVisible || settingsVisible || aboutVisible || customPromptVisible || lightboxVisible
  );

  // Reading progress: debounced scroll save + restore guard
  let isRestoring = false;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function handleScrollForProgress() {
    if (isRestoring) return;
    const tab = tabStore.getActiveTab();
    if (!tab || tab.isEditing) return;
    if (tab.filePath.startsWith("paste://")) return;

    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      // Tiny-file edge case: skip save if document fits in viewport
      if (document.documentElement.scrollHeight <= window.innerHeight) return;
      const line = getCurrentSourceLine("viewer");
      saveProgress(tab.filePath, line);
    }, 500);
  }

  function saveProgressNow() {
    clearTimeout(scrollSaveTimer);
    const tab = tabStore.getActiveTab();
    if (!tab || tab.isEditing) return;
    if (tab.filePath.startsWith("paste://")) return;
    // Tiny-file edge case: skip save if document fits in viewport
    if (document.documentElement.scrollHeight <= window.innerHeight) return;
    const line = getCurrentSourceLine("viewer");
    saveProgress(tab.filePath, line);
  }

  function handleVisibilityChange() {
    if (document.hidden) saveProgressNow();
  }

  function restoreProgress(filePath: string) {
    const savedLine = getProgress(filePath);
    if (!savedLine || savedLine <= 1) return;

    isRestoring = true;
    clearTimeout(restoreTimer);

    tick().then(() => {
      requestAnimationFrame(() => {
        const article = document.querySelector("article.prose");
        if (!article) { isRestoring = false; return; }

        const elements = Array.from(article.querySelectorAll<HTMLElement>("[data-source-line]"));
        if (elements.length === 0) { isRestoring = false; return; }

        // Find the saved line if it still exists, else fall back to the last
        // element (handles file-shrunk case where saved line no longer exists)
        let target: HTMLElement | null = null;
        for (const el of elements) {
          const elLine = parseInt(el.getAttribute("data-source-line") || "0", 10);
          if (elLine >= savedLine) { target = el; break; }
        }
        if (!target) target = elements[elements.length - 1];

        // Tiny-file edge case: don't restore if document fits in viewport
        const docHeight = document.documentElement.scrollHeight;
        if (docHeight <= window.innerHeight) { isRestoring = false; return; }

        target.scrollIntoView({ behavior: "smooth", block: "start" });

        // Clear isRestoring on scrollend (preferred) with 1s timeout fallback
        // for WebViews that don't support the scrollend event
        const clearRestoring = () => {
          clearTimeout(restoreTimer);
          window.removeEventListener("scrollend", clearRestoring);
          isRestoring = false;
        };
        window.addEventListener("scrollend", clearRestoring, { once: true });
        restoreTimer = setTimeout(clearRestoring, 1000);
      });
    });
  }

  const { tabs, activeTabId } = tabStore;

  let activeTab = $derived<Tab | null>($tabs.find((t) => t.id === $activeTabId) ?? null);
  let canEditActive = $derived(
    !!activeTab?.filePath
    && !activeTab.filePath.startsWith("paste://")
    && !activeTab.filePath.startsWith("url://")
  );
  let currentMode = $derived<ViewMode>(
    activeTab?.isEditing ? "editor" : rawMode ? "raw" : "viewer"
  );
  // Which segment of the View/Split/Edit control is active.
  let activeEditMode = $derived<"view" | "split" | "edit">(
    activeTab?.isEditing ? (splitMode ? "split" : "edit") : "view"
  );

  // Live-render the editor content into the split preview pane, debounced so
  // fast typing stays smooth. ponytail: full re-render per debounce tick; fine
  // for typical docs — add incremental rendering only if a huge file lags.
  $effect(() => {
    if (!splitMode || !activeTab?.isEditing) return;
    const content = activeTab.editContent;
    const baseDir = getBaseDir(activeTab.filePath);
    clearTimeout(splitPreviewTimer);
    splitPreviewTimer = setTimeout(() => {
      const result = renderFull(content, baseDir);
      allowAssets(result.assetPaths, activeTab.filePath);
      splitPreviewHtml = result.html;
    }, 120);
    return () => clearTimeout(splitPreviewTimer);
  });

  // Marp presentation (#44). `presenting` is a page-level view mode (like rawMode);
  // it's only meaningful when the active doc is a Marp deck.
  let activeIsMarp = $derived(isMarpDoc($docStore.frontmatter));
  let activePaginate = $derived(
    $docStore.frontmatter?.paginate === true || $docStore.frontmatter?.paginate === "true"
  );

  function togglePresent() {
    presenting = !presenting;
    if (presenting) {
      // Entering the slideshow supersedes raw/edit/split.
      rawMode = false;
      splitMode = false;
      if (activeTab?.isEditing) tabStore.setEditing(activeTab.id, false);
    }
  }

  /**
   * Switch view mode while preserving the source-line position so the user
   * stays anchored at the same place in the document.
   */
  function switchMode(target: ViewMode) {
    if (!activeTab || target === currentMode) return;
    if (target === "editor" && !canEditActive) return;

    // An explicit mode switch (raw/edit) leaves the slideshow (#44).
    presenting = false;

    // Close the find overlay on any mode change so a search started against one
    // target (viewer/raw/editor) can't leave a stale match count or highlights
    // behind when the on-screen target changes.
    searchVisible = false;

    const line = getCurrentSourceLine(currentMode);

    // Apply state changes for the target mode
    if (target === "editor") {
      tabStore.setEditing(activeTab.id, true);
    } else {
      // Exiting edit mode: re-render `editContent` (in-memory) so the viewer
      // shows the latest unsaved changes immediately. The dirty indicator
      // continues to mark that the changes aren't on disk yet.
      if (activeTab.isEditing && activeTab.dirty) {
        const baseDir = getBaseDir(activeTab.filePath);
        const result = renderFull(activeTab.editContent, baseDir);
        // Fire-and-forget: referenced images were almost always allowed at open;
        // a brand-new external image typed mid-edit self-heals on the next
        // render/reload. Not worth making this sync path async (#31).
        allowAssets(result.assetPaths, activeTab.filePath);
        // Update the rendered HTML in the docStore so the viewer reflects
        // the unsaved edits. We do NOT call tabStore.updateTabContent or
        // markSaved — the source on disk is unchanged, dirty stays true.
        docStore.set({
          filePath: activeTab.filePath,
          fileName: activeTab.fileName,
          content: activeTab.content,             // disk content (unchanged)
          renderedHtml: result.html,              // preview of unsaved edits
          frontmatter: result.frontmatter,
          wordCount: result.wordCount,
          loading: false,
          error: null,
        });
      }
      if (activeTab.isEditing) tabStore.setEditing(activeTab.id, false);
      rawMode = target === "raw";
      splitMode = false; // leaving editing always leaves split
    }

    // Scroll the destination after it renders. Two rAFs are needed for the
    // editor — the first lets Svelte mount the textarea, the second lets the
    // browser compute its scrollHeight before we set scrollTop.
    tick().then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToSourceLine(target, line));
      });
    });
  }

  async function handleSave(tab: Tab) {
    if (!tab.dirty) return;
    try {
      let targetPath = tab.filePath;
      let targetName = tab.fileName;
      // An unsaved `new://` document has no location yet — prompt for one on
      // this first save, which rebinds the tab to the chosen real path (#63).
      if (tab.filePath.startsWith("new://")) {
        const saved = await saveAsNewDocument(tab.id, tab.editContent);
        if (!saved) return; // cancelled — keep editing, stays dirty
        targetPath = saved;
        targetName = basename(saved);
      } else {
        await saveFile(tab.filePath, tab.editContent);
      }
      const baseDir = getBaseDir(targetPath);
      const result = renderFull(tab.editContent, baseDir);
      await allowAssets(result.assetPaths, targetPath);
      tabStore.markSaved(tab.id);
      tabStore.updateTabContent(
        targetPath,
        tab.editContent,
        result.html,
        result.frontmatter,
        result.wordCount
      );
      // Sync docStore so the rendered view reflects the saved content immediately
      // when the user toggles out of edit mode (the tab-sync $effect only fires on
      // active-tab change, not on content updates of the same tab).
      docStore.set({
        filePath: targetPath,
        fileName: targetName,
        content: tab.editContent,
        renderedHtml: result.html,
        frontmatter: result.frontmatter,
        wordCount: result.wordCount,
        loading: false,
        error: null,
      });
    } catch (err) {
      console.error("Save failed:", err);
      alert(`Save failed: ${err}`);
    }
  }

  /**
   * Open a local file linked from the rendered markdown (issue #30). Resolves
   * the href against the current document's directory: markdown files open in a
   * new in-app tab, other files (PDF, images, …) open in the OS default app,
   * and a missing target surfaces a toast without disturbing the current tab.
   */
  async function handleLocalLink(href: string) {
    const tab = activeTab;
    // paste:// and url:// tabs have no real base dir to resolve against — keep
    // the prior external-opener behavior for their links.
    if (!tab || !tab.filePath || tab.filePath.startsWith("paste://") || tab.filePath.startsWith("url://") || tab.filePath.startsWith("new://")) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
      } catch {}
      return;
    }

    // Strip a trailing #fragment / ?query — we open the file, not an in-file
    // anchor (cross-file anchor scroll is out of scope for now). A bare "#frag"
    // was already handled as in-page navigation in the renderer.
    let target = href.replace(/[?#].*$/, "");
    // file: URLs arrive here (they're local) — reduce to a plain path.
    target = target.replace(/^file:\/\//i, "");
    if (!target) return;

    const resolved = resolveLocalPath(target, getBaseDir(tab.filePath));
    const name = basename(resolved);

    if (!(await pathExists(resolved))) {
      showToast(`Can't find “${name}”`);
      return;
    }

    if (/\.(md|markdown)$/i.test(resolved)) {
      await openFile(resolved);
      return;
    }

    // Security: never hand executable/script types to the OS opener. A clicked
    // link with deceptive text could otherwise launch a pre-existing payload in
    // one click. Everything else (PDF, images, docs…) opens in the default app.
    if (isExecutablePath(resolved)) {
      showToast(`Won't open executable file “${name}”. Open it from your file manager if you trust it.`);
      return;
    }

    try {
      await openWithSystem(resolved);
    } catch {
      showToast(`Couldn't open “${name}”`);
    }
  }

  // Extensions that can run code when opened with the OS default handler.
  const EXECUTABLE_EXTENSIONS = new Set([
    // macOS / shell / scripting
    "app", "command", "sh", "bash", "zsh", "scpt", "applescript",
    "terminal", "workflow", "action", "osascript",
    // Windows
    "exe", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js", "jse",
    "wsf", "msi", "msp", "cpl", "lnk", "reg", "hta", "pif",
    // cross-platform
    "jar",
  ]);

  function isExecutablePath(path: string): boolean {
    const name = path.split(/[\\/]/).pop() || "";
    const dot = name.lastIndexOf(".");
    if (dot < 0) return false;
    return EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
  }

  // View / Split / Edit segmented control (#19). Split & Edit are both editing
  // states; splitMode is the only difference. Routed through switchMode so the
  // source-line position is preserved across the change.
  function setMode(target: "view" | "split" | "edit") {
    if (!activeTab) return;
    if (target === "view") {
      splitMode = false;
      switchMode(rawMode ? "raw" : "viewer");
      return;
    }
    if (!canEditActive) return;
    if (target === "edit") {
      splitMode = false;
      switchMode("editor");
    } else {
      switchMode("editor");
      splitMode = true;
    }
  }

  function handleEditToggle() {
    if (!canEditActive || !activeTab) return;
    // Cmd+E toggles full Edit against View (never Split).
    setMode(activeTab.isEditing ? "view" : "edit");
  }

  function handleRawToggle() {
    if (activeTab?.isEditing) return;
    switchMode(rawMode ? "viewer" : "raw");
  }

  async function handleCloseTab(id: string): Promise<boolean> {
    const t = $tabs.find((x) => x.id === id);
    if (!t) return false;
    // Native dialog via the plugin — window.confirm() is a no-op in the Tauri
    // WKWebView (silently returns false), which made this guard dead and closed
    // dirty tabs without warning.
    if (t.dirty) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      // The primary/default button (Enter) must be the SAFE action, so a
      // reflexive Return can't destroy unsaved work. `ask`'s OK button is the
      // default, so OK = "Keep Editing" and the cancel-position button is the
      // deliberate, non-default "Discard".
      const keepEditing = await ask(`You have unsaved changes to ${t.fileName}.`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Keep Editing",
        cancelLabel: "Discard",
      });
      if (keepEditing) return false;
    }
    // Flush reading progress before closing — catches the case where user
    // scrolls and closes within the 500ms debounce window
    if (t.id === $activeTabId) {
      saveProgressNow();
    }
    tabStore.closeTab(id);
    return true;
  }

  // Close the active tab, from either Cmd+W route (the File > Close Tab menu
  // item, or the keydown fallback). The guard makes a double-fire harmless: if
  // a platform delivers both the menu accelerator and the keydown for one press,
  // the second call returns instead of closing a second tab. handleCloseTab
  // always awaits at least a microtask, so the flag is set before it can re-enter.
  let closeInFlight = false;
  async function closeActiveTab() {
    if (closeInFlight) return;
    closeInFlight = true;
    try {
      const t = tabStore.getActiveTab();
      if (t) await handleCloseTab(t.id);
    } finally {
      closeInFlight = false;
    }
  }

  // Close-on-ESC: close the active file tab, and quit the app if it was the last
  // one (on macOS closing the window alone leaves the app in the dock). Async
  // because the dirty-confirm dialog is — a cancelled discard must not quit.
  async function closeActiveTabOnEscape() {
    const tabsBeforeClose = $tabs.length;
    if (activeTab && activeTab.id !== HOME_TAB_ID) {
      const closed = await handleCloseTab(activeTab.id);
      if (closed && tabsBeforeClose === 1) {
        invoke("quit_app").catch(() => {});
      }
    } else if (tabsBeforeClose === 0) {
      // Active is home tab and no file tabs are open → quit
      invoke("quit_app").catch(() => {});
    }
    // Else: home tab is active with file tabs in background — do nothing.
  }

  onMount(() => {
    initRenderer();
    rendererReady = true;

    // Expose functions for native menu and OS file-open handlers
    (window as any).__mdhero_open_file = () => { openVisible = true; };
    (window as any).__mdhero_open_path = (path: string) => {
      if (path && rendererReady) {
        openFile(path);
      }
    };
    (window as any).__mdhero_paste = () => {
      pasteDefaultMode = "paste";
      pasteVisible = true;
    };
    (window as any).__mdhero_toggle_theme = () => {
      themeMode.update((m) => cycleTheme(m));
    };
    (window as any).__mdhero_find = () => {
      searchVisible = !searchVisible;
    };
    // File > Close Tab (Cmd/Ctrl+W). The menu item declared this accelerator
    // but lib.rs had no branch for its id, so the event was dropped — and
    // because the native menu consumes the key, the keydown fallback never ran
    // either: the shortcut and the menu item were both dead.
    (window as any).__mdhero_close_tab = () => {
      void closeActiveTab();
    };
    (window as any).__mdhero_zen = () => {
      zenMode = !zenMode;
    };
    (window as any).__mdhero_about = () => {
      aboutVisible = true;
    };
    // App-quit guard (#54): the red-button (CloseRequested) and Cmd+Q / menu
    // Quit (custom "quit" menu item) both route here rather than terminating, so
    // quitting with unsaved edits gets the same confirm dialog as tab close.
    // One prompt covers all dirty tabs. On "Keep Editing" we stay; otherwise
    // (Discard, no dirty tabs, or dialog failure) we quit via quit_app — a hard
    // exit, so we never trap the user in an app that can't close.
    (window as any).__mdhero_quit = async () => {
      const dirty = $tabs.filter((t) => t.dirty);
      if (dirty.length > 0) {
        try {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const msg =
            dirty.length === 1
              ? `You have unsaved changes to ${dirty[0].fileName}.`
              : `You have unsaved changes in ${dirty.length} tabs.`;
          const keepEditing = await ask(msg, {
            title: "Unsaved changes",
            kind: "warning",
            okLabel: "Keep Editing",
            cancelLabel: "Discard",
          });
          if (keepEditing) return;
        } catch {
          // Fall through and quit rather than trap the user behind prevent_close.
        }
      }
      saveProgressNow();
      invoke("quit_app").catch(() => {});
    };
    (window as any).__mdhero_check_updates = async () => {
      if (get(checkInFlight)) return;
      // Reset dismissal so a manual check always re-surfaces an available update.
      updateDismissed.set(false);
      await checkForUpdates(true);
      // If still nothing, give the user explicit feedback — silence is confusing
      // when a menu item is the trigger.
      if (!get(updateAvailable)) {
        alert("MDHero is up to date.");
      }
    };
    // Router for AI Lookup right-click menu items. lib.rs::setup forwards any
    // menu event ID starting with "aimenu:" through this hook. The current
    // selection was stashed in the aiLookup runtime helper at contextmenu
    // capture time — we consume it here so a stale selection can't leak into
    // a future menu open.
    (window as any).__mdhero_ai_lookup = async (menuId: string) => {
      const selection = consumePendingSelection();
      if (menuId === "aimenu:google") {
        if (!selection.trim()) return;
        const url = `https://www.google.com/search?q=${encodeURIComponent(selection)}`;
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
      if (menuId === "aimenu:custom") {
        customPromptSelection = selection;
        customPromptVisible = true;
        return;
      }
      if (menuId.startsWith("aimenu:template:")) {
        // aimenu:template:{providerId}:{promptId}
        const rest = menuId.slice("aimenu:template:".length);
        const colon = rest.indexOf(":");
        if (colon < 0) return;
        const providerId = rest.slice(0, colon);
        const promptId = rest.slice(colon + 1);
        const url = assembleUrlByIds(providerId, promptId, selection);
        if (!url) return;
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
      // aimenu:noop:* fires only from disabled items in theory — defensive ignore.
    };

    // Listen for keyboard shortcuts and scroll for reading progress
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("keyup", handleKeyup);
    // Safety net: if focus leaves while j/k is held, keyup may never fire — stop the loop.
    window.addEventListener("blur", stopScroll);
    window.addEventListener("scroll", handleScrollForProgress, { passive: true });
    window.addEventListener("beforeunload", saveProgressNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    void (async () => {
      // Bring back last run's tabs first (#72), so a file opened via "Open
      // With" or the CLI below lands on top of them as the active tab.
      if ($settings.restoreTabsOnLaunch) {
        try {
          await restoreSession();
        } catch {}
      }

      // Check for files opened via "Open With" / double-click (buffered in Rust state)
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const openedFiles = await invoke<string[]>("get_opened_files");
        if (openedFiles.length > 0) {
          await openFile(openedFiles[0]);
        }
      } catch {}

      // Check for updates (non-blocking, skips in dev)
      checkForUpdates();

      // Check for CLI file argument
      try {
        const { getMatches } = await import("@tauri-apps/plugin-cli");
        const matches = await getMatches();
        if (matches.args?.file?.value) {
          await openFile(matches.args.file.value as string);
        }
      } catch {
        // CLI plugin may not be available in dev
      }
    })();

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
      window.removeEventListener("blur", stopScroll);
      stopScroll();
      window.removeEventListener("scroll", handleScrollForProgress);
      window.removeEventListener("beforeunload", saveProgressNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  });

  let lastKey = "";
  let lastKeyTime = 0;

  // Continuous vim j/k scrolling. Instead of firing a per-press smooth animation
  // (which eases per 100px chunk and gets cancelled/restarted by OS key-repeat,
  // producing visible stutter), we drive a single requestAnimationFrame loop while
  // the key is held and stop it on keyup. This matches the native, continuous feel
  // of arrow-key/trackpad scrolling. The half-page (d/u) and gg/G jumps stay smooth.
  //
  // Velocity is time-based (px/sec, scaled by the frame delta) rather than a fixed
  // px-per-frame step, so the speed stays consistent regardless of display refresh
  // rate (60Hz vs 120Hz ProMotion) and roughly matches native arrow-key scrolling.
  const SCROLL_SPEED = 1000; // px per second
  let scrollRAF: number | null = null;
  let scrollDir = 0; // -1 = up, +1 = down, 0 = stopped
  let scrollLastTs = 0;
  const pressedScrollKeys = new Set<"j" | "k">();
  let activeScrollKey: "j" | "k" | null = null;

  function updateScrollDirection() {
    scrollDir = activeScrollKey === "j" ? 1 : activeScrollKey === "k" ? -1 : 0;
  }

  function startScroll(key: "j" | "k") {
    pressedScrollKeys.add(key);
    activeScrollKey = key;
    updateScrollDirection();
    if (scrollRAF !== null) return;
    scrollLastTs = 0;
    const step = (ts: number) => {
      if (scrollDir === 0) {
        scrollRAF = null;
        return;
      }
      // First frame establishes the baseline timestamp; no movement yet.
      const dt = scrollLastTs === 0 ? 0 : ts - scrollLastTs;
      scrollLastTs = ts;
      window.scrollBy(0, scrollDir * SCROLL_SPEED * (dt / 1000));
      scrollRAF = requestAnimationFrame(step);
    };
    scrollRAF = requestAnimationFrame(step);
  }

  function stopScroll() {
    pressedScrollKeys.clear();
    activeScrollKey = null;
    scrollDir = 0;
    scrollLastTs = 0;
    if (scrollRAF !== null) {
      cancelAnimationFrame(scrollRAF);
      scrollRAF = null;
    }
  }

  function releaseScrollKey(key: "j" | "k") {
    pressedScrollKeys.delete(key);
    if (activeScrollKey !== key) return;

    if (pressedScrollKeys.has("j")) {
      activeScrollKey = "j";
    } else if (pressedScrollKeys.has("k")) {
      activeScrollKey = "k";
    } else {
      activeScrollKey = null;
    }

    updateScrollDirection();
    if (scrollDir === 0) stopScroll();
  }

  function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
  }

  function jumpToHeading(direction: "prev" | "next") {
    const headings = document.querySelectorAll("article h1[id], article h2[id], article h3[id], article h4[id], article h5[id], article h6[id]");
    if (headings.length === 0) return;
    const offset = 80;
    const scrollY = window.scrollY + offset;

    if (direction === "next") {
      for (const h of headings) {
        const top = (h as HTMLElement).offsetTop;
        if (top > scrollY + 5) {
          window.scrollTo({ top: top - offset, behavior: "smooth" });
          return;
        }
      }
    } else {
      const arr = Array.from(headings).reverse();
      for (const h of arr) {
        const top = (h as HTMLElement).offsetTop;
        if (top < scrollY - 5) {
          window.scrollTo({ top: top - offset, behavior: "smooth" });
          return;
        }
      }
    }
  }

  // Move the active tab by `delta` positions through the visible tab order
  // ([Home, ...file tabs]), wrapping around at both ends.
  function cycleTab(delta: number) {
    const order = [HOME_TAB_ID, ...$tabs.map((t) => t.id)];
    if (order.length <= 1) return;
    const current = order.indexOf($activeTabId ?? HOME_TAB_ID);
    const base = current === -1 ? 0 : current;
    const next = (base + delta + order.length) % order.length;
    const nextId = order[next];
    if (nextId === HOME_TAB_ID) {
      tabStore.goHome();
    } else {
      tabStore.switchTab(nextId);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // Cmd+1-9 tab switching
    if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      if ($tabs[idx]) {
        tabStore.switchTab($tabs[idx].id);
      }
      return;
    }

    // macOS: Cmd+Shift+[ / Cmd+Shift+] cycle tabs (standard macOS convention).
    // Use e.code because Shift turns "["/"]" into "{"/"}" in e.key.
    if (
      e.metaKey
      && e.shiftKey
      && (e.code === "BracketLeft" || e.code === "BracketRight")
    ) {
      e.preventDefault();
      cycleTab(e.code === "BracketRight" ? 1 : -1);
      return;
    }

    // Windows/Linux: Ctrl+Tab / Ctrl+Shift+Tab (browser convention),
    // and Ctrl+PageDown / Ctrl+PageUp (VS Code convention, also in Chrome).
    if (e.ctrlKey && (e.key === "Tab" || e.code === "PageUp" || e.code === "PageDown")) {
      e.preventDefault();
      const forward = e.key === "Tab" ? !e.shiftKey : e.code === "PageDown";
      cycleTab(forward ? 1 : -1);
      return;
    }

    // Cmd+Plus / Cmd+= zoom in (works on both macOS and Windows)
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      settings.update((s) => ({ ...s, fontSize: Math.min(s.fontSize + 1, 32) }));
      return;
    }

    // Cmd+Minus zoom out
    if ((e.metaKey || e.ctrlKey) && e.key === "-") {
      e.preventDefault();
      settings.update((s) => ({ ...s, fontSize: Math.max(s.fontSize - 1, 10) }));
      return;
    }

    // Cmd+0 reset zoom
    if ((e.metaKey || e.ctrlKey) && e.key === "0") {
      e.preventDefault();
      settings.update((s) => ({ ...s, fontSize: 17 }));
      return;
    }

    // Cmd+E toggle edit mode
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "e") {
      e.preventDefault();
      handleEditToggle();
      return;
    }

    // Cmd+S save (works whenever the active tab has unsaved changes,
    // even from reader mode after toggling out of edit)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "s") {
      e.preventDefault();
      if (activeTab?.dirty) {
        handleSave(activeTab);
      }
      return;
    }

    // Cmd+U raw toggle (disabled in edit mode)
    if ((e.metaKey || e.ctrlKey) && e.key === "u") {
      e.preventDefault();
      handleRawToggle();
      return;
    }

    // Cmd+T new document (blank tab, opens in the editor — #63)
    if ((e.metaKey || e.ctrlKey) && e.key === "t") {
      e.preventDefault();
      newDocument();
      return;
    }

    // Cmd+, open settings (macOS Preferences convention)
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      settingsVisible = !settingsVisible;
      return;
    }

    // Cmd+W close tab (with dirty confirm). Usually dead code: the File menu
    // binds the same accelerator and native menus consume the key before the
    // webview sees it. Kept as the fallback for any platform where it doesn't.
    if ((e.metaKey || e.ctrlKey) && e.key === "w") {
      e.preventDefault();
      void closeActiveTab();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
      e.preventDefault();
      zenMode = !zenMode;
      return;
    }

    // Escape — close panels, then optionally close-tab-on-ESC
    if (e.key === "Escape") {
      if (zenMode) { zenMode = false; return; }

      // Exit the Marp slideshow before any modal/close-tab handling (#44).
      if (presenting) { presenting = false; return; }

      // Modals/overlays consume ESC first. Inner handlers stopPropagation when focus
      // is inside them; this guard covers the focus-outside case (modal visible but
      // user clicked elsewhere) so we don't nuke the tab while a modal is still up.
      // Add new modals to `anyModalVisible` (see top of script) to keep this safe.
      if (anyModalVisible) return;

      // Close-on-ESC: opt-in setting. Ignore in edit mode and when an input is focused
      // (so users typing in search/paste/etc. don't accidentally trigger it).
      if ($settings.closeOnEscape && !activeTab?.isEditing && !isInputFocused()) {
        // handleCloseTab is async (native dirty-confirm dialog), so the
        // quit-on-last-tab decision runs in an async helper.
        closeActiveTabOnEscape();
      }
      return;
    }

    // Vim-style keys — only when no input is focused and not in edit mode
    if (isInputFocused() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (activeTab?.isEditing) return;
    if (!$docStore.renderedHtml) return;

    const now = Date.now();

    switch (e.key) {
      case "j":
        e.preventDefault();
        // Ignore OS key-repeat — the rAF loop drives continuous motion until keyup.
        if (e.repeat) break;
        startScroll("j");
        break;
      case "k":
        e.preventDefault();
        if (e.repeat) break;
        startScroll("k");
        break;
      case "d":
        // half page down
        e.preventDefault();
        window.scrollBy({ top: window.innerHeight / 2, behavior: "smooth" });
        break;
      case "u":
        // half page up
        e.preventDefault();
        window.scrollBy({ top: -window.innerHeight / 2, behavior: "smooth" });
        break;
      case "G":
        // Shift+G — go to bottom
        e.preventDefault();
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        break;
      case "g":
        // gg — go to top (double tap g within 500ms)
        if (lastKey === "g" && now - lastKeyTime < 500) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: "smooth" });
          lastKey = "";
          return;
        }
        break;
      case "/":
        e.preventDefault();
        searchVisible = true;
        break;
      case "n":
        // next search match (handled by SearchOverlay if visible)
        break;
      case "]":
        e.preventDefault();
        jumpToHeading("next");
        break;
      case "[":
        e.preventDefault();
        jumpToHeading("prev");
        break;
    }

    lastKey = e.key;
    lastKeyTime = now;
  }

  function handleKeyup(e: KeyboardEvent) {
    // Stop the continuous j/k scroll loop when the key is released.
    if (e.key === "j" || e.key === "k") releaseScrollKey(e.key);
  }

  // Sync tab switching with document store — only reads $activeTabId and $tabs
  let prevTabId: string | null = null;

  $effect(() => {
    const id = $activeTabId;
    const allTabs = $tabs;

    // Skip if same tab
    if (id === prevTabId) return;

    // Save reading progress for the tab we're leaving.
    // At this point in the $effect, $activeTabId has changed but the DOM still
    // shows the previous tab's content (docStore.set happens below), so
    // getCurrentSourceLine reads the correct article elements. We flush the
    // debounce to ensure nothing is lost on rapid tab switches.
    if (prevTabId && prevTabId !== HOME_TAB_ID) {
      const prevTab = allTabs.find((t) => t.id === prevTabId);
      if (prevTab && !prevTab.isEditing && !prevTab.filePath.startsWith("paste://")) {
        clearTimeout(scrollSaveTimer);
        if (document.documentElement.scrollHeight > window.innerHeight) {
          const line = getCurrentSourceLine("viewer");
          saveProgress(prevTab.filePath, line);
        }
      }
    }

    prevTabId = id;

    if (!id || id === HOME_TAB_ID) {
      rawMode = false;
      presenting = false;
      splitMode = false;
      docStore.set({
        filePath: null,
        fileName: null,
        content: "",
        renderedHtml: "",
        frontmatter: null,
        wordCount: 0,
        loading: false,
        error: null,
      });
      tocVisible.set(false);
      tocEntries.set([]);
      getCurrentWindow().setTitle("MDHero").catch(() => {});
      return;
    }

    const tab = allTabs.find((t) => t.id === id);
    if (!tab) return;

    docStore.set({
      filePath: tab.filePath,
      fileName: tab.fileName,
      content: tab.content,
      renderedHtml: tab.renderedHtml,
      frontmatter: tab.frontmatter,
      wordCount: tab.wordCount,
      loading: false,
      error: null,
    });

    // Auto-present a Marp deck on activation when the setting is on and we're not
    // mid-edit (#44). Runs once per tab switch, so an explicit exit (Esc) sticks.
    presenting = isMarpDoc(tab.frontmatter) && get(settings).autoPresentMarp && !tab.isEditing;

    getCurrentWindow().setTitle(`${tab.fileName} — MDHero`).catch(() => {});

    const savedScroll = tab.scrollTop;
    tick().then(() => {
      requestAnimationFrame(() => {
        window.scrollTo(0, savedScroll);
        // Restore reading progress (smooth-scroll to saved source line)
        // Only if the tab is at scroll 0 (freshly opened or re-opened)
        if (savedScroll === 0) {
          restoreProgress(tab.filePath);
        }
      });
    });
  });

  // Start/stop the file watcher as the active document changes.
  //
  // The stop half matters: closing the last tab leaves docStore.filePath null,
  // and without an explicit teardown the watcher for the file just closed kept
  // running. An external edit to it then fired reloadCurrentFile, which calls
  // docStore.set — so a document the user had closed reappeared on top of the
  // home screen. `url://` joins the sentinels here too: it is not a filesystem
  // path, so start_watching could never do anything useful with it.
  $effect(() => {
    const path = $docStore.filePath;
    const watchable =
      !!path
      && !path.startsWith("paste://")
      && !path.startsWith("new://")
      && !path.startsWith("url://");

    if (!watchable) {
      if (lastWatchedPath !== null) {
        lastWatchedPath = null;
        stopFileWatcher();
      }
      return;
    }

    if (path !== lastWatchedPath) {
      lastWatchedPath = path;
      startFileWatcher(path);
    }
  });
</script>

<div class="min-h-screen transition-colors page-root">
  {#if !zenMode}
    <ProgressBar />
    <Toolbar
      onOpen={() => (openVisible = true)}
      onPaste={() => { pasteDefaultMode = "paste"; pasteVisible = true; }}
      onUrl={() => { pasteDefaultMode = "url"; pasteVisible = true; }}
      {rawMode}
      onRawToggle={handleRawToggle}
      isEditing={activeTab?.isEditing ?? false}
      dirty={activeTab?.dirty ?? false}
      canEdit={canEditActive}
      editMode={activeEditMode}
      onSetMode={setMode}
      onSave={() => activeTab && handleSave(activeTab)}
      onOpenSettings={() => (settingsVisible = true)}
      canPresent={activeIsMarp}
      presenting={presenting}
      onTogglePresent={togglePresent}
    />
    <TabBar onCloseTab={handleCloseTab} />
  {/if}
  <DropZone />
  {#if !zenMode && !activeTab?.isEditing}
    <TableOfContents />
  {/if}
  <SearchOverlay bind:visible={searchVisible} />
  <PasteModal bind:visible={pasteVisible} defaultMode={pasteDefaultMode} />
  <OpenDialog bind:visible={openVisible} />
  <SettingsDialog bind:visible={settingsVisible} />
  <AboutDialog bind:visible={aboutVisible} />
  <CustomPromptModal bind:visible={customPromptVisible} selection={customPromptSelection} />

  {#if !rendererReady}
    <div class="state-center">
      <p class="state-text pulse">Loading renderer...</p>
    </div>
  {:else if $docStore.loading}
    <div class="state-center">
      <p class="state-text pulse">Opening file...</p>
    </div>
  {:else if $docStore.error}
    <div class="state-center">
      <div class="error-box">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff3b30" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p class="error-msg">{$docStore.error}</p>
      </div>
    </div>
  {:else if $docStore.filePath}
    <!-- Gate on filePath, not renderedHtml: an empty file renders to empty HTML,
         and gating on that dropped the user back to the home/recents view with no
         way to edit (#52). A real (even empty) file tab always shows here. -->
    {#if presenting && activeIsMarp}
      <PresentationView
        content={$docStore.content}
        baseDir={activeTab ? getBaseDir(activeTab.filePath) : ""}
        paginate={activePaginate}
        onExit={() => (presenting = false)}
        onLocalLink={handleLocalLink}
      />
    {:else if activeTab?.isEditing && splitMode}
      <!-- Split (#19): editor left, live preview right. Both panes are fixed
           half-width; the Editor's own fixed positioning takes the `split` prop
           to yield the left half. -->
      <Editor
        value={activeTab.editContent}
        onChange={(v) => tabStore.updateEditContent(activeTab!.id, v)}
        fontSize={$settings.fontSize}
        lineHeight={$settings.lineHeight}
        maxWidth="100%"
        showLineNumbers={$settings.showLineNumbers}
        split
      />
      <main class="split-preview">
        <MarkdownRenderer
          html={splitPreviewHtml}
          onImageClick={(src, all, idx) => { lightboxImages = all; lightboxIndex = idx; lightboxVisible = true; }}
          onLocalLink={handleLocalLink}
        />
      </main>
    {:else if activeTab?.isEditing}
      <Editor
        value={activeTab.editContent}
        onChange={(v) => tabStore.updateEditContent(activeTab!.id, v)}
        fontSize={$settings.fontSize}
        lineHeight={$settings.lineHeight}
        maxWidth={contentMaxWidth}
        showLineNumbers={$settings.showLineNumbers}
      />
    {:else if rawMode}
      <main class="content-main" class:toc-spaced={$tocVisible && $tocEntries.length > 0}>
        <pre
          class="raw-source"
          style="font-size: {$settings.fontSize}px; line-height: {$settings.lineHeight}; max-width: {contentMaxWidth};"
        ><code>{$docStore.content}</code></pre>
      </main>
    {:else}
      <main class="content-main" class:toc-spaced={$tocVisible && $tocEntries.length > 0}>
        <FrontmatterBar />
        <MarkdownRenderer
          html={$docStore.renderedHtml}
          onImageClick={(src, all, idx) => { lightboxImages = all; lightboxIndex = idx; lightboxVisible = true; }}
          onLocalLink={handleLocalLink}
        />
      </main>
    {/if}
    {#if !zenMode && !activeTab?.isEditing && !presenting}
      <StatusBar />
      <ScrollToTop />
    {/if}
    <ImageLightbox bind:visible={lightboxVisible} src="" images={lightboxImages} bind:index={lightboxIndex} />
  {:else}
    <EmptyState onOpenUrl={() => { pasteDefaultMode = "url"; pasteVisible = true; }} />
  {/if}
  <UpdateToast />
  <Toast />
</div>

<style>
  .page-root {
    background: #fafafa;
    color: #1c1c1e;
  }

  :global(html.dark) .page-root {
    background: #161618;
    color: #e5e5e7;
  }

  .state-center {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 75vh;
  }

  .state-text {
    font-size: 14px;
    color: #aeaeb2;
  }

  .pulse {
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }

  .error-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    max-width: 400px;
  }

  .error-msg {
    font-size: 13px;
    color: #8e8e93;
    line-height: 1.5;
  }

  .content-main {
    padding-bottom: 4rem;
    transition: padding-left 0.15s ease;
  }

  /* Split preview pane (#19): fixed right half, mirroring the editor's fixed
     left half. Scrolls independently. Sits below the toolbar+tabbar (75px). */
  .split-preview {
    position: fixed;
    top: 75px;
    right: 0;
    left: 50%;
    bottom: 0;
    overflow-y: auto;
    padding-bottom: 4rem;
    z-index: 1;
    background: #fafafa;
  }

  :global(html.dark) .split-preview {
    background: #161618;
  }

  .content-main.toc-spaced {
    padding-left: 240px;
  }

  .raw-source {
    margin: 0 auto;
    padding: 24px 32px;
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    color: #1c1c1e;
    white-space: pre-wrap;
    word-break: break-word;
    background: transparent;
    border: none;
  }

  :global(html.dark) .raw-source {
    color: #d1d1d6;
  }
</style>
