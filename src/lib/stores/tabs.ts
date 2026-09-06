import { writable, get } from "svelte/store";

export interface Tab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  renderedHtml: string;
  frontmatter: Record<string, unknown> | null;
  wordCount: number;
  scrollTop: number;
  isEditing: boolean;
  editContent: string;
  dirty: boolean;
  lastSavedAt: number;
  /**
   * The file changed on disk while this tab had unsaved edits (#97). The edits
   * are kept; this flag marks the tab and makes Save ask before overwriting.
   * Cleared by a save, or once the tab is no longer dirty.
   */
  diskChanged: boolean;
}

export const HOME_TAB_ID = "__home__";

/**
 * What survives a restart (#72): the on-disk files that were open, in tab
 * order, and which of them was active (`null` when the home tab was). Nothing
 * else — unsaved edits, scroll offsets and the `paste://` / `url://` / `new://`
 * tabs have no file to come back from.
 */
export interface SavedSession {
  paths: string[];
  activePath: string | null;
}

const SESSION_KEY = "mdhero-session";

function isRestorablePath(filePath: string): boolean {
  return !!filePath
    && !filePath.startsWith("paste://")
    && !filePath.startsWith("url://")
    && !filePath.startsWith("new://");
}

function loadSession(): SavedSession | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.paths)) return null;
    return {
      paths: parsed.paths.filter((p: unknown) => typeof p === "string" && isRestorablePath(p)),
      activePath: typeof parsed.activePath === "string" ? parsed.activePath : null,
    };
  } catch {
    return null;
  }
}

function saveSession(session: SavedSession) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}
}

function createTabStore() {
  const tabs = writable<Tab[]>([]);
  const activeTabId = writable<string | null>(HOME_TAB_ID);

  // Captured once, before the persistence subscription below overwrites the
  // key with this (empty) session. `restoreSession` reads it on launch.
  const savedSession = loadSession();

  function persistSession() {
    const currentTabs = get(tabs);
    const active = currentTabs.find((t) => t.id === get(activeTabId));
    saveSession({
      paths: currentTabs.filter((t) => isRestorablePath(t.filePath)).map((t) => t.filePath),
      activePath: active && isRestorablePath(active.filePath) ? active.filePath : null,
    });
  }
  tabs.subscribe(persistSession);
  activeTabId.subscribe(persistSession);

  /** The session as it was when this store initialised — i.e. the previous run's. */
  function getSavedSession(): SavedSession | null {
    return savedSession;
  }

  function generateId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  function addTab(filePath: string, fileName: string, content: string, renderedHtml: string, frontmatter?: Record<string, unknown> | null, wordCount?: number): string {
    const currentTabs = get(tabs);

    // If file is already open, switch to it
    const existing = currentTabs.find((t) => t.filePath === filePath);
    if (existing) {
      activeTabId.set(existing.id);
      tabs.update((ts) =>
        ts.map((t) => {
          if (t.id !== existing.id) return t;
          // Preserve edit state on re-add — only refresh content/render if not dirty
          if (t.isEditing) {
            const dirty = t.editContent !== content;
            return { ...t, content, renderedHtml, frontmatter: frontmatter ?? null, wordCount: wordCount ?? 0, dirty };
          }
          return { ...t, content, renderedHtml, frontmatter: frontmatter ?? null, wordCount: wordCount ?? 0, editContent: content, dirty: false };
        })
      );
      return existing.id;
    }

    const id = generateId();
    const newTab: Tab = {
      id,
      filePath,
      fileName,
      content,
      renderedHtml,
      frontmatter: frontmatter ?? null,
      wordCount: wordCount ?? 0,
      scrollTop: 0,
      isEditing: false,
      editContent: content,
      dirty: false,
      lastSavedAt: 0,
      diskChanged: false,
    };

    tabs.update((ts) => [...ts, newTab]);
    activeTabId.set(id);
    return id;
  }

  function closeTab(id: string) {
    if (id === HOME_TAB_ID) return; // Can't close home tab
    saveScrollPosition();
    const currentTabs = get(tabs);
    const idx = currentTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    const newTabs = currentTabs.filter((t) => t.id !== id);
    tabs.set(newTabs);

    // If closing the active tab, switch to adjacent or home
    if (get(activeTabId) === id) {
      if (newTabs.length === 0) {
        activeTabId.set(HOME_TAB_ID);
      } else {
        const newIdx = Math.min(idx, newTabs.length - 1);
        activeTabId.set(newTabs[newIdx].id);
      }
    }
  }

  function goHome() {
    saveScrollPosition();
    activeTabId.set(HOME_TAB_ID);
  }

  function saveScrollPosition() {
    const currentId = get(activeTabId);
    if (currentId) {
      const scrollTop = window.scrollY;
      tabs.update((ts) =>
        ts.map((t) => (t.id === currentId ? { ...t, scrollTop } : t))
      );
    }
  }

  function switchTab(id: string) {
    if (get(activeTabId) === id) return;
    saveScrollPosition();
    activeTabId.set(id);
  }

  function updateTabContent(filePath: string, content: string, renderedHtml: string, frontmatter?: Record<string, unknown> | null, wordCount?: number) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.filePath !== filePath) return t;
        const next: Tab = {
          ...t,
          content,
          renderedHtml,
          frontmatter: frontmatter ?? t.frontmatter,
          wordCount: wordCount ?? t.wordCount,
        };
        // Preserve in-progress edits when content updates from external sources (file watcher)
        if (t.isEditing) {
          next.dirty = t.editContent !== content;
          // Remember that the disk moved under unsaved edits, so the tab can
          // show it and Save can ask first (#97). Not raised when the disk
          // now matches what the user typed — there is nothing to lose then.
          next.diskChanged = next.dirty && (t.diskChanged || content !== t.content);
        } else {
          next.editContent = content;
          next.dirty = false;
          next.diskChanged = false;
        }
        return next;
      })
    );
  }

  function getActiveTab(): Tab | null {
    const id = get(activeTabId);
    if (!id) return null;
    return get(tabs).find((t) => t.id === id) ?? null;
  }

  function reorderTabs(fromIndex: number, toIndex: number) {
    tabs.update((ts) => {
      const arr = [...ts];
      const [moved] = arr.splice(fromIndex, 1);
      arr.splice(toIndex, 0, moved);
      return arr;
    });
  }

  function setEditing(id: string, editing: boolean) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        // When entering edit mode, sync editContent to current content if not already dirty
        if (editing && !t.isEditing && !t.dirty) {
          return { ...t, isEditing: true, editContent: t.content };
        }
        return { ...t, isEditing: editing };
      })
    );
  }

  function updateEditContent(id: string, newContent: string) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        return { ...t, editContent: newContent, dirty: newContent !== t.content };
      })
    );
  }

  function markSaved(id: string) {
    tabs.update((ts) =>
      ts.map((t) => {
        if (t.id !== id) return t;
        return { ...t, content: t.editContent, dirty: false, diskChanged: false, lastSavedAt: Date.now() };
      })
    );
  }

  function getLastSavedAt(filePath: string): number {
    const t = get(tabs).find((x) => x.filePath === filePath);
    return t?.lastSavedAt ?? 0;
  }

  // Re-point a tab at a real filesystem path + name. Used when an unsaved
  // `new://` document gets a location on its first save (#63).
  function rebindPath(id: string, filePath: string, fileName: string) {
    tabs.update((ts) =>
      ts.map((t) => (t.id === id ? { ...t, filePath, fileName } : t))
    );
  }

  return {
    tabs,
    activeTabId,
    addTab,
    closeTab,
    switchTab,
    updateTabContent,
    getActiveTab,
    reorderTabs,
    goHome,
    setEditing,
    updateEditContent,
    markSaved,
    getLastSavedAt,
    rebindPath,
    saveScrollPosition,
    getSavedSession,
  };
}

export const tabStore = createTabStore();
