import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { reloadFile } from "./files";
import { tabStore } from "../stores/tabs";

/**
 * Frontend half of live reload (#97). One listener for the whole session; the
 * backend watches every open tab's file and says which one changed, and the
 * reload goes to that file's tab. Which files are watched is decided where
 * tabs are opened, closed and re-pathed (`watchFile` / `unwatchFile` in
 * files.ts), not here.
 */

let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;
// Per-path debounce: editors fire several events per save, and two files
// changing together must not cancel each other's reload.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

const OWN_SAVE_SUPPRESSION_MS = 1500;
const COALESCE_MS = 100;

export function initFileWatcher(): Promise<void> {
  if (unlisten) return Promise.resolve();
  if (starting) return starting;
  starting = listen<{ path: string }>("file-changed", (event) => {
    const path = event.payload?.path;
    if (!path) return;
    const prev = pending.get(path);
    if (prev) clearTimeout(prev);
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path);
        // Our own save just wrote this file; the tab already has that content.
        const lastSavedAt = tabStore.getLastSavedAt(path);
        if (lastSavedAt && Date.now() - lastSavedAt < OWN_SAVE_SUPPRESSION_MS) return;
        void reloadFile(path);
      }, COALESCE_MS)
    );
  }).then((un) => {
    unlisten = un;
    starting = null;
  });
  return starting;
}

/**
 * Tear the watcher down on both sides of the IPC boundary. Dropping only the
 * JS listener would leave the Rust debouncer and its OS watch handles alive.
 */
export function stopFileWatcher(): void {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  starting = null;
  invoke("stop_watching").catch(() => {});
}
