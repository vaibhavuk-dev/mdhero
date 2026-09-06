import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { document } from "../stores/document";
import { tabStore } from "../stores/tabs";
import { renderFull } from "../renderer/pipeline";
import { addRecentFile } from "../stores/recents";
import { pinnedFolders } from "../stores/pinned";
import { basename } from "../utils/path";

export async function readMarkdownFile(path: string): Promise<string> {
  return invoke<string>("read_markdown_file", { path });
}

export async function saveFile(path: string, content: string): Promise<void> {
  await invoke("write_markdown_file", { path, content });
}

export async function openFile(path: string): Promise<void> {
  const absolutePath = await resolvePath(path);
  const fileName = basename(absolutePath);
  const baseDir = getBaseDir(absolutePath);

  document.set({
    filePath: absolutePath,
    fileName,
    content: "",
    renderedHtml: "",
    frontmatter: null,
    wordCount: 0,
    loading: true,
    error: null,
  });

  try {
    const content = await readMarkdownFile(absolutePath);
    const result = renderFull(content, baseDir);

    // Whitelist the document's local images with the asset protocol before the
    // HTML hits the DOM, so images outside the static $HOME scope load (#31).
    await allowAssets(result.assetPaths, absolutePath);

    const tabId = tabStore.addTab(absolutePath, fileName, content, result.html, result.frontmatter, result.wordCount);

    // An empty file has nothing to read — drop straight into the editor so the
    // user can start writing, instead of staring at a blank viewer (#52).
    if (content.trim() === "") tabStore.setEditing(tabId, true);

    document.set({
      filePath: absolutePath,
      fileName,
      content,
      renderedHtml: result.html,
      frontmatter: result.frontmatter,
      wordCount: result.wordCount,
      loading: false,
      error: null,
    });

    addRecentFile(absolutePath, fileName);
    getCurrentWindow().setTitle(`${fileName} — MDHero`).catch(() => {});
  } catch (err) {
    document.set({
      filePath: absolutePath,
      fileName,
      content: "",
      renderedHtml: "",
      frontmatter: null,
      wordCount: 0,
      loading: false,
      error: `Failed to open file: ${err}`,
    });
  }
}

let newDocCounter = 0;

/**
 * Start a fresh, unsaved markdown document in a new tab, opened straight into
 * the editor — the "new tab" behavior the UI already advertised (#63). It has
 * no filesystem path yet (a `new://` sentinel, like `paste://`); the location
 * is chosen on the first save via `saveAsNewDocument`. The watcher and
 * copy-path/link resolution skip `new://` tabs until they're saved.
 */
export function newDocument(): void {
  const filePath = `new://${Date.now()}-${newDocCounter++}`;
  const result = renderFull("");
  const tabId = tabStore.addTab(
    filePath,
    "Untitled",
    "",
    result.html,
    result.frontmatter,
    result.wordCount
  );
  tabStore.setEditing(tabId, true);
}

/**
 * First-save flow for a `new://` document: prompt for a location, write the
 * content, then re-point the tab at the chosen real path (watch + recents +
 * title). Returns the chosen absolute path, or null if the user cancelled the
 * dialog (caller should leave the tab dirty and in the editor).
 */
export async function saveAsNewDocument(tabId: string, content: string): Promise<string | null> {
  const chosen = await save({
    defaultPath: "Untitled.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
  });
  if (!chosen) return null;

  const fileName = basename(chosen);
  await saveFile(chosen, content);
  tabStore.rebindPath(tabId, chosen, fileName);
  addRecentFile(chosen, fileName);
  getCurrentWindow().setTitle(`${fileName} — MDHero`).catch(() => {});
  return chosen;
}

export async function openFileDialog(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Markdown",
          extensions: ["md", "markdown", "mdown", "mkd", "txt"],
        },
      ],
    });

    if (selected) {
      // selected can be string or string[] depending on version
      const path = typeof selected === "string" ? selected : (selected as any)?.path ?? String(selected);
      await openFile(path);
    }
  } catch (err) {
    console.error("File dialog error:", err);
  }
}

export async function reloadCurrentFile(path: string): Promise<void> {
  try {
    const absolutePath = await resolvePath(path);
    const content = await readMarkdownFile(absolutePath);
    const baseDir = getBaseDir(absolutePath);
    const result = renderFull(content, baseDir);
    const fileName = basename(absolutePath);

    await allowAssets(result.assetPaths, absolutePath);

    tabStore.updateTabContent(absolutePath, content, result.html, result.frontmatter, result.wordCount);

    document.set({
      filePath: absolutePath,
      fileName,
      content,
      renderedHtml: result.html,
      frontmatter: result.frontmatter,
      wordCount: result.wordCount,
      loading: false,
      error: null,
    });
  } catch (err) {
    console.error("Failed to reload file:", err);
  }
}

export function getBaseDir(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : ".";
}

export async function resolvePath(path: string): Promise<string> {
  return invoke<string>("resolve_path", { path });
}

/** Whether a path exists on disk (for the local-file-link existence check, #30). */
export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** Open a non-markdown local file in the OS default app (#30). */
export async function openWithSystem(path: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

/**
 * Whitelist a document's resolved local image paths with the webview's asset
 * protocol (issue #31). The Rust side serves only files inside the document's
 * own folder tree (its git checkout, if it is in one) or a pinned folder — see
 * `allow_assets` in commands.rs — and hands back whatever it refused, which is
 * logged so a broken image is diagnosable. A failure here must not block text
 * rendering — a broken image is acceptable degradation, a blank document is
 * not — so errors are swallowed.
 */
export async function allowAssets(paths: string[], documentPath: string): Promise<void> {
  if (paths.length === 0) return;
  try {
    const rejected = await invoke<string[]>("allow_assets", {
      documentPath,
      pinnedFolders: get(pinnedFolders),
      paths,
    });
    if (rejected.length > 0) {
      console.warn(
        `MDHero will not serve ${rejected.length} image(s) outside the document's folder tree. Pin the folder they live in to allow them:`,
        rejected
      );
    }
  } catch {}
}
