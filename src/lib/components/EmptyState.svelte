<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { MOD } from "$lib/utils/platform";
  import { open } from "@tauri-apps/plugin-dialog";
  import { openFileDialog, openFile, newDocument } from "../tauri/files";
  import { recentFiles, clearRecentFiles } from "../stores/recents";
  import { pinnedFolders } from "../stores/pinned";
  import { settings } from "../stores/settings";
  import UpdateBanner from "./UpdateBanner.svelte";
  import { basename, shortenHomePath } from "$lib/utils/path";
  import brandLogo from "$lib/assets/mdhero-icon.png";

  let { onOpenUrl = () => {} }: { onOpenUrl?: () => void } = $props();

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
  let folderFiles = $state<Record<string, MdFile[]>>({});
  let plansHidden = $state(localStorage.getItem("mdhero_plans_hidden") === "true");

  function hidePlans() {
    plansHidden = true;
    localStorage.setItem("mdhero_plans_hidden", "true");
  }

  function showPlans() {
    plansHidden = false;
    localStorage.removeItem("mdhero_plans_hidden");
  }

  $effect(() => {
    invoke<PlanFile[]>("list_claude_plans").then((p) => { plans = p; }).catch(() => {});
  });

  $effect(() => {
    const folders = $pinnedFolders;
    for (const folder of folders) {
      if (!(folder in folderFiles)) {
        invoke<MdFile[]>("list_folder_md_files", { folder }).then((files) => {
          folderFiles = { ...folderFiles, [folder]: files };
        }).catch(() => {
          folderFiles = { ...folderFiles, [folder]: [] };
        });
      }
    }
  });

  async function addPinnedFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        pinnedFolders.add(selected);
        invoke<MdFile[]>("list_folder_md_files", { folder: selected }).then((files) => {
          folderFiles = { ...folderFiles, [selected]: files };
        }).catch(() => {});
      }
    } catch {}
  }

  function removePinnedFolder(e: MouseEvent, path: string) {
    e.stopPropagation();
    pinnedFolders.remove(path);
    const { [path]: _, ...rest } = folderFiles;
    folderFiles = rest;
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

  // Scale home screen UI based on font size setting (17px = 1.0)
  let scale = $derived($settings.fontSize / 17);
</script>

<div class="empty-root" style="zoom: {scale};">
  <!-- Hero bar -->
  <div class="hero-bar">
    <img src={brandLogo} alt="MDHero" width="48" height="48" class="hero-logo" />
    <div class="hero-text">
      <h1 class="hero-title">MDHero</h1>
      <p class="hero-desc">A native Markdown reader and editor.</p>
    </div>
  </div>

  <!-- Update banner (renders nothing when no update available or dismissed) -->
  <UpdateBanner />

  <!-- Shared list row: icon tile + two-line name/path + time -->
  {#snippet fileRow(name: string, path: string, time: string, onClick: () => void, variant: 'file' | 'plan')}
    <button class="item" onclick={onClick}>
      <div class="item-icon {variant}">
        {#if variant === 'plan'}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="2" y="1" width="10" height="12" rx="1.5"/><polyline points="5,5 6.5,6.5 9,4"/><line x1="4.5" y1="8.5" x2="9.5" y2="8.5"/><line x1="4.5" y1="10.5" x2="8" y2="10.5"/></svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="2" y="1" width="10" height="12" rx="1.5"/><line x1="4.5" y1="4" x2="9.5" y2="4"/><line x1="4.5" y1="6.5" x2="8" y2="6.5"/><line x1="4.5" y1="9" x2="9" y2="9"/></svg>
        {/if}
      </div>
      <div class="item-info">
        <span class="item-name">{name}</span>
        {#if path}<span class="item-path">{path}</span>{/if}
      </div>
      <span class="item-time">{time}</span>
    </button>
  {/snippet}

  <!-- Quick actions -->
  <div class="quick-actions">
    <button class="qa-btn qa-primary" onclick={newDocument}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1.5h6l3 3v9H3V1.5z"/><line x1="7.5" y1="6" x2="7.5" y2="11"/><line x1="5" y1="8.5" x2="10" y2="8.5"/></svg>
      New Document
    </button>
    <button class="qa-btn" onclick={openFileDialog}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5l3-2.5h9v10H1.5V5z"/><line x1="1.5" y1="5" x2="4.5" y2="5"/></svg>
      Browse Files
    </button>
    <button class="qa-btn" onclick={onOpenUrl}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="7.5" r="5.5"/><ellipse cx="7.5" cy="7.5" rx="2.5" ry="5.5"/><line x1="2" y1="7.5" x2="13" y2="7.5"/></svg>
      Open URL
    </button>
    <button class="qa-btn" onclick={addPinnedFolder}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><line x1="7.5" y1="3" x2="7.5" y2="12"/><line x1="3" y1="7.5" x2="12" y2="7.5"/></svg>
      Pin Folder
    </button>
  </div>

  <!-- Recents section (reused: standalone 2-col, or as one grid cell) -->
  {#snippet recentsSection(twoCol: boolean)}
    <div class="section recents-section">
      <div class="section-header">
        <h2 class="section-title">Recent Files</h2>
        <button class="section-action" onclick={() => { clearRecentFiles(); }}>Clear</button>
      </div>
      <div class="card card-scroll uniform-card">
        <div class="recents-grid" class:two-col={twoCol}>
          {#each $recentFiles as file (file.path)}
            {@render fileRow(file.name, shortenHomePath(file.path), formatTime(file.openedAt), () => openFile(file.path), 'file')}
          {/each}
        </div>
      </div>
    </div>
  {/snippet}

  <!-- No folders pinned: recents owns the width in 2 columns -->
  {#if $recentFiles.length > 0 && $pinnedFolders.length === 0}
    {@render recentsSection(true)}
  {/if}

  <!-- Uniform card grid: recents (single-col) + plans + folders, all equal cells -->
  {#if (plans.length > 0 && !plansHidden) || $pinnedFolders.length > 0}
    <div class="panels-grid">
      {#if $recentFiles.length > 0 && $pinnedFolders.length > 0}
        {@render recentsSection(false)}
      {/if}
      {#if plans.length > 0 && !plansHidden}
        <div class="section">
          <div class="section-header">
            <h2 class="section-title">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="2" y="1" width="10" height="12" rx="1.5"/><polyline points="5,5 6.5,6.5 9,4"/><line x1="4.5" y1="8.5" x2="9.5" y2="8.5"/><line x1="4.5" y1="10.5" x2="8" y2="10.5"/></svg>
              Claude Plans
            </h2>
            <span class="section-count">{plans.length}</span>
            <button class="section-close" onclick={hidePlans} title="Hide Claude Plans">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
            </button>
          </div>
          <div class="card card-scroll uniform-card">
            {#each plans as plan (plan.path)}
              {@render fileRow(formatPlanName(plan.name), shortenHomePath(plan.path), formatTime(plan.modified), () => openFile(plan.path), 'plan')}
            {/each}
          </div>
        </div>
      {/if}

      {#each $pinnedFolders as folder (folder)}
        <div class="section">
          <div class="section-header">
            <h2 class="section-title">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.5l3-2.5h8v9H1.5V4.5z"/><line x1="1.5" y1="4.5" x2="4.5" y2="4.5"/></svg>
              {basename(folder)}
            </h2>
            <span class="section-count">{folderFiles[folder]?.length ?? '...'}</span>
            <button class="section-action unpin" onclick={(e) => removePinnedFolder(e, folder)} title="Unpin">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
            </button>
          </div>
          <div class="card card-scroll uniform-card">
            {#if !folderFiles[folder]}
              <div class="card-empty">Loading...</div>
            {:else if folderFiles[folder].length === 0}
              <div class="card-empty">No markdown files</div>
            {:else}
              {#each folderFiles[folder] as file (file.path)}
                {@render fileRow(file.name, file.rel_path !== file.name ? file.rel_path : '', formatTime(file.modified), () => openFile(file.path), 'file')}
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Footer -->
  <div class="footer-row">
    <div class="footer-hint">
      <kbd>{MOD}+O</kbd> browse &middot; <kbd>{MOD}+Shift+V</kbd> paste &middot; <kbd>{MOD}+T</kbd> new tab
      {#if plansHidden && plans.length > 0}
        &middot; <button class="footer-link" onclick={showPlans}>Show Claude Plans</button>
      {/if}
    </div>
    <div class="zoom-controls">
      <button class="zoom-btn" onclick={() => settings.update((s) => ({ ...s, fontSize: Math.max(s.fontSize - 1, 10) }))} title="Zoom out">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="6" x2="10" y2="6"/></svg>
      </button>
      <span class="zoom-label">{$settings.fontSize}px</span>
      <button class="zoom-btn" onclick={() => settings.update((s) => ({ ...s, fontSize: Math.min(s.fontSize + 1, 32) }))} title="Zoom in">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>
      </button>
    </div>
  </div>
</div>

<style>
  .empty-root {
    display: flex;
    flex-direction: column;
    padding: 24px 32px;
    max-width: 1040px;
    margin: 0 auto;
    min-height: calc(100vh - 80px);
    gap: 16px;
  }

  /* Hero bar */
  .hero-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 4px 0 8px;
  }

  .hero-logo {
    flex-shrink: 0;
    border-radius: 10px;
  }

  .hero-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hero-title {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: #1c1c1e;
    margin: 0;
  }
  :global(html.dark) .hero-title { color: #e5e5e7; }

  .hero-desc {
    font-size: 13px;
    color: #8e8e93;
    margin: 0;
  }

  /* Quick actions */
  .quick-actions {
    display: flex;
    gap: 6px;
  }

  .qa-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    font-size: 12px;
    font-weight: 500;
    color: #636366;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }

  :global(html.dark) .qa-btn {
    background: #1c1c1e;
    border-color: #2c2c2e;
    color: #8e8e93;
  }

  .qa-btn:hover {
    background: #f2f2f7;
    border-color: #d1d1d6;
    color: #1c1c1e;
  }

  :global(html.dark) .qa-btn:hover {
    background: #2c2c2e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .qa-primary,
  :global(html.dark) .qa-primary {
    background: #0891B2;
    border-color: #0891B2;
    color: white;
  }

  .qa-primary:hover,
  :global(html.dark) .qa-primary:hover {
    background: #0E7490;
    border-color: #0E7490;
    color: white;
  }

  /* Sections */
  .section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 2px;
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #8e8e93;
    margin: 0;
    flex: 1;
  }

  .section-count {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: #e5e5ea;
    color: #636366;
  }
  :global(html.dark) .section-count { background: #3a3a3c; color: #aeaeb2; }

  .section-action {
    font-size: 11px;
    color: #aeaeb2;
    background: none;
    border: none;
    cursor: pointer;
    transition: color 0.12s;
  }

  .section-action:hover {
    color: #ff3b30;
  }

  .section-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: #aeaeb2;
    background: none;
    border: none;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }

  .section-close:hover {
    color: #ff3b30;
    background: #f2f2f7;
  }

  :global(html.dark) .section-close:hover {
    background: #2c2c2e;
  }

  .section-action.unpin {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: #c7c7cc;
    opacity: 0;
    transition: opacity 0.12s, color 0.12s;
  }

  .section-header:hover .unpin {
    opacity: 1;
  }

  .section-action.unpin:hover {
    color: #ff3b30;
  }

  /* Cards */
  .card {
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 10px;
    overflow: hidden;
  }
  :global(html.dark) .card { background: #1c1c1e; border-color: #2c2c2e; }

  .card-scroll {
    overflow-y: auto;
  }

  /* Every card in the grid is the same fixed height and scrolls internally */
  .uniform-card { height: 300px; }

  /* 2 columns when no folders are pinned; row-flow so it scrolls vertically */
  .recents-grid.two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .recents-grid.two-col .item:nth-child(even) {
    border-left: 1px solid #f2f2f7;
  }
  :global(html.dark) .recents-grid.two-col .item:nth-child(even) {
    border-left-color: #2c2c2e;
  }
  @media (max-width: 720px) {
    .recents-grid.two-col { grid-template-columns: 1fr; }
    .recents-grid.two-col .item:nth-child(even) { border-left: none; }
  }

  .card-empty {
    padding: 16px;
    font-size: 12px;
    color: #aeaeb2;
    text-align: center;
  }

  /* List items — icon tile + two-line name/path + time */
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-bottom: 1px solid #f2f2f7;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  :global(html.dark) .item { border-bottom-color: #2c2c2e; }

  .item:last-of-type { border-bottom: none; }

  .item:hover { background: #f2f2f7; }
  :global(html.dark) .item:hover { background: #2c2c2e; }


  .item-icon {
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
  :global(html.dark) .item-icon { background: #0A1E2E; color: #22D3EE; }

  .item-icon.plan { background: #e3f8e8; color: #34a853; }
  :global(html.dark) .item-icon.plan { background: #1a3a1f; color: #4ade80; }

  .item-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .item-name {
    font-size: 13px;
    font-weight: 500;
    color: #1c1c1e;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(html.dark) .item-name { color: #e5e5e7; }

  .item-path {
    font-size: 11px;
    color: #aeaeb2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(html.dark) .item-path { color: #636366; }

  .item-time {
    font-size: 11px;
    color: #c7c7cc;
    white-space: nowrap;
    flex-shrink: 0;
  }
  :global(html.dark) .item-time { color: #48484a; }

  /* Panels grid — recents + plans + folders, 2 columns max */
  .panels-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  @media (max-width: 720px) {
    .panels-grid { grid-template-columns: 1fr; }
  }

  /* Footer */
  .footer-row {
    margin-top: auto;
    padding-top: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .footer-hint {
    font-size: 11px;
    color: #aeaeb2;
  }

  .footer-link {
    font-size: 11px;
    color: #0891B2;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  :global(html.dark) .footer-link { color: #22D3EE; }
  .footer-link:hover { text-decoration: none; }

  .footer-hint kbd {
    display: inline-block;
    padding: 1px 5px;
    font-size: 10px;
    font-family: -apple-system, sans-serif;
    background: #e5e5ea;
    border-radius: 4px;
    color: #636366;
  }
  :global(html.dark) .footer-hint kbd { background: #2c2c2e; color: #aeaeb2; }

  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .zoom-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 5px;
    color: #636366;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  :global(html.dark) .zoom-btn {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #8e8e93;
  }

  .zoom-btn:hover {
    background: #f2f2f7;
    color: #1c1c1e;
  }

  :global(html.dark) .zoom-btn:hover {
    background: #2c2c2e;
    color: #e5e5e7;
  }

  .zoom-label {
    font-size: 10px;
    color: #8e8e93;
    min-width: 28px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
