<script lang="ts">
  import { onMount } from "svelte";
  import { X } from "@lucide/svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import appIcon from "$lib/assets/mdhero-icon.png";

  let { visible = $bindable(false) }: { visible: boolean } = $props();
  let appVersion = $state("");

  onMount(async () => {
    try {
      appVersion = await getVersion();
    } catch {
      appVersion = "unknown";
    }
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) visible = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      visible = false;
    }
  }
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-backdrop" onclick={handleBackdropClick} onkeydown={handleKeydown}>
    <div class="dialog">
      <div class="dialog-header">
        <h2 class="dialog-title">About MDHero</h2>
        <button onclick={() => (visible = false)} class="dialog-close" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div class="dialog-body">
        <div class="about-content">
          <img src={appIcon} class="app-icon" alt="MDHero" width="48" height="48" />
          <h3 class="app-name">MDHero</h3>
          <p class="app-version">Version {appVersion}</p>
          <p class="app-description">A beautiful, fast Markdown viewer for your desktop.</p>
          <a
            class="app-link"
            href="https://github.com/vaibhav-kakde-in/mdhero"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/vaibhav-kakde-in/mdhero
          </a>
        </div>
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
    width: 360px;
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

  .dialog-body {
    padding: 24px 16px 28px;
  }

  .about-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
  }

  .app-icon {
    width: 48px;
    height: 48px;
    margin-bottom: 4px;
    border-radius: 10px;
  }

  .app-name {
    font-size: 18px;
    font-weight: 700;
    color: #1c1c1e;
    margin: 0;
  }

  :global(html.dark) .app-name {
    color: #e5e5e7;
  }

  .app-version {
    font-size: 13px;
    color: #8e8e93;
    margin: 0;
  }

  .app-description {
    font-size: 13px;
    color: #636366;
    margin: 8px 0 0;
    line-height: 1.4;
  }

  :global(html.dark) .app-description {
    color: #aeaeb2;
  }

  .app-link {
    font-size: 12px;
    color: #0891B2;
    text-decoration: none;
    margin-top: 8px;
    transition: opacity 0.12s;
  }

  .app-link:hover {
    opacity: 0.75;
  }
</style>
