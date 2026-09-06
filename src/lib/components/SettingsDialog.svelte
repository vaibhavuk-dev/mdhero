<script lang="ts">
  import { X } from "@lucide/svelte";
  import { settings } from "$lib/stores/settings";
  import AILookupSettings from "./AILookupSettings.svelte";

  let { visible = $bindable(false) }: { visible: boolean } = $props();

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
        <h2 class="dialog-title">Settings</h2>
        <button onclick={() => (visible = false)} class="dialog-close" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div class="dialog-body">
        <section class="settings-section">
          <h3 class="section-title">Behavior</h3>

          <label class="setting-row">
            <div class="setting-text">
              <span class="setting-label">Close on Escape</span>
              <span class="setting-hint">Press ESC to close the current tab. App quits after the last tab.</span>
            </div>
            <input
              type="checkbox"
              checked={$settings.closeOnEscape}
              onchange={(e) => settings.update((s) => ({ ...s, closeOnEscape: e.currentTarget.checked }))}
              class="setting-switch"
            />
          </label>

          <label class="setting-row">
            <div class="setting-text">
              <span class="setting-label">Restore tabs on launch</span>
              <span class="setting-hint">Reopen the files that were open last time, in the same order.</span>
            </div>
            <input
              type="checkbox"
              checked={$settings.restoreTabsOnLaunch}
              onchange={(e) => settings.update((s) => ({ ...s, restoreTabsOnLaunch: e.currentTarget.checked }))}
              class="setting-switch"
            />
          </label>

          <label class="setting-row">
            <div class="setting-text">
              <span class="setting-label">Auto-present Marp decks</span>
              <span class="setting-hint">Open documents with <code>marp: true</code> frontmatter as a slideshow.</span>
            </div>
            <input
              type="checkbox"
              checked={$settings.autoPresentMarp}
              onchange={(e) => settings.update((s) => ({ ...s, autoPresentMarp: e.currentTarget.checked }))}
              class="setting-switch"
            />
          </label>
        </section>

        <section class="settings-section">
          <h3 class="section-title">Editor</h3>

          <label class="setting-row">
            <div class="setting-text">
              <span class="setting-label">Line numbers</span>
              <span class="setting-hint">Show a line-number gutter in the editor.</span>
            </div>
            <input
              type="checkbox"
              checked={$settings.showLineNumbers}
              onchange={(e) => settings.update((s) => ({ ...s, showLineNumbers: e.currentTarget.checked }))}
              class="setting-switch"
            />
          </label>
        </section>

        <section class="settings-section">
          <h3 class="section-title">AI Lookup</h3>
          <p class="section-hint">Right-click selected text in the viewer to send it to an AI tool. Manage providers and saved prompts below.</p>
          <AILookupSettings />
        </section>
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
    width: 640px;
    max-height: 75vh;
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
    padding: 8px 16px 16px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .settings-section {
    padding-top: 12px;
  }

  .settings-section + .settings-section {
    border-top: 1px solid #f2f2f7;
    margin-top: 16px;
  }

  :global(html.dark) .settings-section + .settings-section {
    border-top-color: #3a3a3c;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: #aeaeb2;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 10px;
  }

  .section-hint {
    font-size: 11.5px;
    color: #8e8e93;
    margin: -6px 0 12px;
    line-height: 1.4;
    max-width: 52ch;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 0;
    cursor: pointer;
  }

  .setting-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }

  .setting-label {
    font-size: 13px;
    color: #1c1c1e;
    font-weight: 500;
  }

  :global(html.dark) .setting-label {
    color: #e5e5e7;
  }

  .setting-hint {
    font-size: 11px;
    color: #8e8e93;
    line-height: 1.4;
  }

  :global(html.dark) .setting-hint {
    color: #8e8e93;
  }

  .setting-switch {
    -webkit-appearance: none;
    appearance: none;
    width: 36px;
    height: 20px;
    background: #e5e5ea;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    transition: background 0.15s;
    flex-shrink: 0;
    margin: 0;
  }

  :global(html.dark) .setting-switch {
    background: #3a3a3c;
  }

  .setting-switch::before {
    content: "";
    position: absolute;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    top: 2px;
    left: 2px;
    transition: transform 0.15s;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  }

  .setting-switch:checked,
  :global(html.dark) .setting-switch:checked {
    background: #0891B2;
  }

  .setting-switch:checked::before {
    transform: translateX(16px);
  }
</style>
