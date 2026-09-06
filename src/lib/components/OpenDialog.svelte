<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { MOD } from "$lib/utils/platform";
  import { open as openDirDialog } from "@tauri-apps/plugin-dialog";
  import { openFile, openFileDialog } from "$lib/tauri/files";
  import { recentFiles, removeRecentFile } from "$lib/stores/recents";
  import { pinnedFolders } from "$lib/stores/pinned";
  import { isUrl, toRawUrl, urlToFileName } from "$lib/utils/url";
  import { renderFull } from "$lib/renderer/pipeline";
  import { tabStore } from "$lib/stores/tabs";
  import { document as docStore } from "$lib/stores/document";
  import { basename, shortenHomePath } from "$lib/utils/path";

  let { visible = $bindable(false) }: { visible: boolean } = $props();

  let urlInput = $state("");
  let urlLoading = $state(false);
  let urlError = $state("");

  interface PlanFile {
    name: string;
    path: string;
    modified: number;
  }

  interface MdFile {
    name: string;
    path: string;
    rel_path: string;
    modified: number;
  }

  let plans = $state<PlanFile[]>([]);
  let plansLoading = $state(false);
  let activeTab = $state<"recent" | "plans" | "folders">("recent");
  let folderFiles = $state<Record<string, MdFile[]>>({});
  let expandedDialogFolders = $state<Set<string>>(new Set());

  function toggleDialogFolder(path: string) {
    const next = new Set(expandedDialogFolders);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    expandedDialogFolders = next;
  }

  async function loadPlans() {
    plansLoading = true;
    try {
      plans = await invoke<PlanFile[]>("list_claude_plans");
    } catch {
      plans = [];
    }
    plansLoading = false;
  }

  async function handleFetchUrl() {
    const trimmed = urlInput.trim();
    if (!trimmed || !isUrl(trimmed)) {
      urlError = "Please enter a valid URL";
      return;
    }
    urlLoading = true;
    urlError = "";
    try {
      const rawUrl = toRawUrl(trimmed);
      const res = await fetch(rawUrl);
      if (!res.ok) {
        urlError = res.status === 404 ? "File not found." : res.status === 403 ? "Access denied." : `Failed (${res.status})`;
        urlLoading = false;
        return;
      }
      const markdown = await res.text();
      if (markdown.trim().startsWith("<!DOCTYPE") || markdown.trim().startsWith("<html")) {
        urlError = "URL returned HTML, not markdown.";
        urlLoading = false;
        return;
      }
      const result = renderFull(markdown);
      const fileName = urlToFileName(trimmed);
      const urlPath = `url://${trimmed}`;
      tabStore.addTab(urlPath, fileName, markdown, result.html, result.frontmatter, result.wordCount);
      docStore.set({ filePath: urlPath, fileName, content: markdown, renderedHtml: result.html, frontmatter: result.frontmatter, wordCount: result.wordCount, loading: false, error: null });
      urlInput = "";
      visible = false;
    } catch (err) {
      urlError = `Network error: ${err instanceof Error ? err.message : "Could not reach URL"}`;
    }
    urlLoading = false;
  }

  function handleOpenSystem() {
    visible = false;
    openFileDialog();
  }

  function handleOpenFile(path: string) {
    visible = false;
    openFile(path);
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      visible = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      visible = false;
    }
  }

  function formatTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }


  function formatPlanName(name: string): string {
    return name.replace(/\.md$/, "").replace(/[-_]/g, " ");
  }

  async function loadFolderFiles() {
    for (const folder of $pinnedFolders) {
      if (!(folder in folderFiles)) {
        try {
          const files = await invoke<MdFile[]>("list_folder_md_files", { folder });
          folderFiles = { ...folderFiles, [folder]: files };
        } catch {
          folderFiles = { ...folderFiles, [folder]: [] };
        }
      }
    }
  }

  async function handleAddFolder() {
    try {
      const selected = await openDirDialog({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        pinnedFolders.add(selected);
        const files = await invoke<MdFile[]>("list_folder_md_files", { folder: selected });
        folderFiles = { ...folderFiles, [selected]: files };
      }
    } catch {}
  }


  $effect(() => {
    if (visible && activeTab === "plans") {
      loadPlans();
    }
  });

  $effect(() => {
    if (visible && activeTab === "folders") {
      loadFolderFiles();
    }
  });

  $effect(() => {
    if (visible) {
      activeTab = "recent";
      urlInput = "";
      urlError = "";
      // Auto-expand all folders
      expandedDialogFolders = new Set($pinnedFolders);
      // Preload in background
      loadPlans();
      loadFolderFiles();
    }
  });
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown}>
    <div class="dialog">
      <!-- Header -->
      <div class="dialog-header">
        <h2 class="dialog-title">Open</h2>
        <button onclick={() => (visible = false)} class="dialog-close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>
        </button>
      </div>

      <!-- Browse button -->
      <div class="browse-section">
        <button onclick={handleOpenSystem} class="browse-btn">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 5l4-3h8v11H2V5z"/><line x1="2" y1="5" x2="6" y2="5"/>
          </svg>
          <span>Browse Files...</span>
          <span class="browse-hint">{MOD}+O</span>
        </button>
        <div class="url-row">
          <input
            type="text"
            bind:value={urlInput}
            placeholder="Paste a URL to open..."
            class="url-input-sm"
            onkeydown={(e) => e.key === 'Enter' && handleFetchUrl()}
          />
          <button onclick={handleFetchUrl} disabled={urlLoading || !urlInput.trim()} class="url-fetch-btn">
            {urlLoading ? "..." : "Fetch"}
          </button>
        </div>
        {#if urlError}
          <div class="url-error-sm">{urlError}</div>
        {/if}
      </div>

      <!-- Tabs -->
      <div class="dialog-tabs">
        <button
          class="dialog-tab"
          class:active={activeTab === "recent"}
          onclick={() => (activeTab = "recent")}
        >
          Recent
          {#if $recentFiles.length > 0}
            <span class="tab-count">{$recentFiles.length}</span>
          {/if}
        </button>
        <button
          class="dialog-tab"
          class:active={activeTab === "folders"}
          onclick={() => { activeTab = "folders"; loadFolderFiles(); }}
        >
          Folders
          {#if $pinnedFolders.length > 0}
            <span class="tab-count">{$pinnedFolders.length}</span>
          {/if}
        </button>
        <button
          class="dialog-tab"
          class:active={activeTab === "plans"}
          onclick={() => { activeTab = "plans"; loadPlans(); }}
        >
          Plans
          {#if plans.length > 0}
            <span class="tab-count">{plans.length}</span>
          {/if}
        </button>
      </div>

      <!-- Content -->
      <div class="dialog-content">
        {#if activeTab === "recent"}
          {#if $recentFiles.length === 0}
            <div class="empty-list">
              <p>No recent files</p>
            </div>
          {:else}
            {#each $recentFiles as file (file.path)}
              <button class="file-item" onclick={() => handleOpenFile(file.path)}>
                <div class="file-icon">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="2" y="1" width="10" height="12" rx="1.5"/><line x1="4.5" y1="4" x2="9.5" y2="4"/><line x1="4.5" y1="6.5" x2="8" y2="6.5"/><line x1="4.5" y1="9" x2="9" y2="9"/></svg>
                </div>
                <div class="file-info">
                  <span class="file-name">{file.name}</span>
                  <span class="file-path">{shortenHomePath(file.path)}</span>
                </div>
                <span class="file-time">{formatTime(file.openedAt)}</span>
              </button>
            {/each}
          {/if}
        {:else if activeTab === "folders"}
          {#if $pinnedFolders.length === 0}
            <div class="empty-list">
              <p>No pinned folders</p>
              <button class="add-folder-btn" onclick={handleAddFolder}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="7" y1="3" x2="7" y2="11"/><line x1="3" y1="7" x2="11" y2="7"/></svg>
                Pin a folder
              </button>
            </div>
          {:else}
            {#each $pinnedFolders as folder (folder)}
              <div class="folder-section">
                <button class="folder-header" onclick={() => toggleDialogFolder(folder)}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" class="folder-chevron" class:expanded={expandedDialogFolders.has(folder)}>
                    <path d="M3 1l4 4-4 4"/>
                  </svg>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1.5 4.5l3-2.5h8v9H1.5V4.5z"/><line x1="1.5" y1="4.5" x2="4.5" y2="4.5"/>
                  </svg>
                  <span class="folder-name">{basename(folder)}</span>
                  <span class="folder-file-count">{folderFiles[folder]?.length ?? '...'}</span>
                  <span class="folder-path">{shortenHomePath(folder)}</span>
                </button>
                {#if expandedDialogFolders.has(folder)}
                  {#if folderFiles[folder]}
                    {#each folderFiles[folder] as file (file.path)}
                      <button class="file-item file-item-nested" onclick={() => handleOpenFile(file.path)}>
                        <div class="file-icon">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="2" y="1" width="10" height="12" rx="1.5"/><line x1="4.5" y1="4" x2="9.5" y2="4"/><line x1="4.5" y1="6.5" x2="8" y2="6.5"/><line x1="4.5" y1="9" x2="9" y2="9"/></svg>
                        </div>
                        <div class="file-info">
                          <span class="file-name">{file.name}</span>
                          {#if file.rel_path !== file.name}
                            <span class="file-path">{file.rel_path}</span>
                          {/if}
                        </div>
                        <span class="file-time">{formatTime(file.modified)}</span>
                      </button>
                    {/each}
                  {:else}
                    <div class="folder-loading-inline">Loading...</div>
                  {/if}
                {/if}
              </div>
            {/each}
            <button class="add-folder-inline" onclick={handleAddFolder}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>
              Add folder
            </button>
          {/if}
        {:else}
          {#if plansLoading}
            <div class="empty-list">
              <p>Loading plans...</p>
            </div>
          {:else if plans.length === 0}
            <div class="empty-list">
              <p>No Claude Code plans found</p>
              <span class="empty-hint">Plans are stored in ~/.claude/plans/</span>
            </div>
          {:else}
            {#each plans as plan (plan.path)}
              <button class="file-item" onclick={() => handleOpenFile(plan.path)}>
                <div class="file-icon plan-icon">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="2" y="1" width="10" height="12" rx="1.5"/><polyline points="5,5 6.5,6.5 9,4"/><line x1="4.5" y1="8.5" x2="9.5" y2="8.5"/><line x1="4.5" y1="10.5" x2="8" y2="10.5"/></svg>
                </div>
                <div class="file-info">
                  <span class="file-name">{formatPlanName(plan.name)}</span>
                  <span class="file-path">{shortenHomePath(plan.path)}</span>
                </div>
                <span class="file-time">{formatTime(plan.modified)}</span>
              </button>
            {/each}
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    background: rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }

  .dialog {
    width: 480px;
    max-height: 70vh;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  :global(html.dark) .dialog {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid #f2f2f7;
  }

  :global(html.dark) .dialog-header {
    border-bottom-color: #3a3a3c;
  }

  .dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: #1c1c1e;
    margin: 0;
  }

  :global(html.dark) .dialog-title {
    color: #e5e5e7;
  }

  .dialog-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    color: #aeaeb2;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s;
  }

  .dialog-close:hover {
    background: #f2f2f7;
    color: #636366;
  }

  :global(html.dark) .dialog-close:hover {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  .browse-section {
    padding: 12px 16px;
  }

  .browse-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 500;
    color: #1c1c1e;
    background: #f2f2f7;
    border: 1px solid #e5e5ea;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.12s;
  }

  :global(html.dark) .browse-btn {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .browse-btn:hover {
    background: #e5e5ea;
  }

  :global(html.dark) .browse-btn:hover {
    background: #2c2c2e;
  }

  .browse-hint {
    margin-left: auto;
    font-size: 11px;
    color: #aeaeb2;
    font-weight: 400;
  }

  .url-row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .url-input-sm {
    flex: 1;
    padding: 8px 10px;
    font-size: 12px;
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    background: #f9f9fb;
    border: 1px solid #e5e5ea;
    border-radius: 7px;
    outline: none;
    color: #1c1c1e;
    transition: border-color 0.15s;
  }

  :global(html.dark) .url-input-sm {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .url-input-sm:focus {
    border-color: #0891B2;
  }

  .url-input-sm::placeholder {
    color: #aeaeb2;
    font-family: -apple-system, sans-serif;
  }

  .url-fetch-btn {
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 500;
    background: #0891B2;
    color: white;
    border: none;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    white-space: nowrap;
  }

  .url-fetch-btn:hover {
    background: #0E7490;
  }

  .url-fetch-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .url-error-sm {
    margin-top: 6px;
    font-size: 11px;
    color: #ff3b30;
  }

  .dialog-tabs {
    display: flex;
    border-bottom: 1px solid #e5e5ea;
    padding: 0 16px;
  }

  :global(html.dark) .dialog-tabs {
    border-bottom-color: #3a3a3c;
  }

  .dialog-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    margin-right: 20px;
    font-size: 12px;
    font-weight: 500;
    color: #8e8e93;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.12s;
  }

  .dialog-tab:hover {
    color: #636366;
  }

  :global(html.dark) .dialog-tab:hover {
    color: #aeaeb2;
  }

  .dialog-tab.active {
    color: #0891B2;
    border-bottom-color: #0891B2;
  }

  :global(html.dark) .dialog-tab.active {
    color: #22D3EE;
    border-bottom-color: #22D3EE;
  }

  .tab-count {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: #e5e5ea;
    color: #636366;
  }

  :global(html.dark) .tab-count {
    background: #3a3a3c;
    color: #aeaeb2;
  }

  .dialog-content {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    max-height: 50vh;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 16px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
  }

  .file-item:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .file-item:hover {
    background: #1c1c1e;
  }

  .file-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: #E5F5F8;
    color: #0891B2;
    flex-shrink: 0;
  }

  :global(html.dark) .file-icon {
    background: #0A1E2E;
    color: #22D3EE;
  }

  .plan-icon {
    background: #e3f8e8;
    color: #34a853;
  }

  :global(html.dark) .plan-icon {
    background: #1a3a1f;
    color: #4ade80;
  }

  .file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .file-name {
    font-size: 13px;
    font-weight: 500;
    color: #1c1c1e;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(html.dark) .file-name {
    color: #e5e5e7;
  }

  .file-path {
    font-size: 11px;
    color: #aeaeb2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-time {
    font-size: 11px;
    color: #c7c7cc;
    white-space: nowrap;
    flex-shrink: 0;
  }

  :global(html.dark) .file-time {
    color: #48484a;
  }

  .empty-list {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    gap: 4px;
  }

  .empty-list p {
    font-size: 13px;
    color: #8e8e93;
    margin: 0;
  }

  .empty-hint {
    font-size: 11px;
    color: #aeaeb2;
  }

  /* Folder sections */
  .folder-section {
    border-bottom: 1px solid #f2f2f7;
  }
  :global(html.dark) .folder-section { border-bottom-color: #3a3a3c; }
  .folder-section:last-of-type { border-bottom: none; }

  .folder-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 16px;
    font-size: 11px;
    font-weight: 600;
    color: #8e8e93;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
  }

  .folder-header:hover {
    background: #f8f8fa;
  }

  :global(html.dark) .folder-header:hover {
    background: #1c1c1e;
  }

  .folder-chevron {
    transition: transform 0.15s;
    flex-shrink: 0;
  }

  .folder-chevron.expanded {
    transform: rotate(90deg);
  }

  .folder-file-count {
    font-size: 10px;
    padding: 0 5px;
    border-radius: 6px;
    background: #e5e5ea;
    color: #636366;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }
  :global(html.dark) .folder-file-count { background: #3a3a3c; color: #aeaeb2; }

  .folder-name {
    color: #636366;
  }
  :global(html.dark) .folder-name { color: #aeaeb2; }

  .folder-path {
    color: #8e8e93;
    margin-left: auto;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }

  .file-item-nested {
    padding-left: 28px;
  }

  .folder-loading-inline {
    padding: 8px 28px;
    font-size: 11px;
    color: #aeaeb2;
  }

  .add-folder-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 6px 14px;
    font-size: 12px;
    color: #0891B2;
    background: none;
    border: 1px dashed #d1d1d6;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .add-folder-btn:hover {
    background: #f2f2f7;
    border-color: #0891B2;
  }

  :global(html.dark) .add-folder-btn {
    color: #22D3EE;
    border-color: #3a3a3c;
  }

  :global(html.dark) .add-folder-btn:hover {
    background: #2c2c2e;
    border-color: #22D3EE;
  }

  .add-folder-inline {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 10px 16px;
    font-size: 12px;
    color: #aeaeb2;
    background: none;
    border: none;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }

  .add-folder-inline:hover {
    color: #0891B2;
    background: #f2f2f7;
  }

  :global(html.dark) .add-folder-inline:hover {
    color: #22D3EE;
    background: #1c1c1e;
  }

  @media print {
    .dialog-backdrop { display: none !important; }
  }
</style>
