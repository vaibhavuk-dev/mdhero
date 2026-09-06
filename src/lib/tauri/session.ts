import { get } from "svelte/store";
import { tabStore } from "../stores/tabs";
import { openFile, pathExists } from "./files";

/**
 * Reopen the previous run's tabs (#72): same files, same order, same active
 * tab. Files that no longer exist are skipped silently, and a file that fails
 * to open does not stop the rest. Returns how many tabs came back.
 *
 * Runs before any "Open With" / CLI file so that one lands on top, active, the
 * way a browser handles a link clicked while it restores a session.
 */
export async function restoreSession(): Promise<number> {
  const saved = tabStore.getSavedSession();
  if (!saved || saved.paths.length === 0) return 0;

  let restored = 0;
  for (const path of saved.paths) {
    try {
      if (!(await pathExists(path))) continue;
      await openFile(path);
      restored++;
    } catch {}
  }
  if (restored === 0) return 0;

  const tabs = get(tabStore.tabs);
  const active = saved.activePath ? tabs.find((t) => t.filePath === saved.activePath) : undefined;
  if (active) {
    tabStore.switchTab(active.id);
  } else if (saved.activePath === null) {
    tabStore.goHome();
  }
  // Else: the active file is gone; stay on the last one that came back.
  return restored;
}
