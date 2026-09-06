<script lang="ts">
  import { isLlmEscaped, unescapeLlmOutput } from "$lib/utils/llm";
  import { MOD } from "$lib/utils/platform";
  import { isUrl, toRawUrl, urlToFileName } from "$lib/utils/url";
  import { renderFull } from "$lib/renderer/pipeline";
  import { tabStore } from "$lib/stores/tabs";
  import { document as docStore } from "$lib/stores/document";

  let { visible = $bindable(false), defaultMode = "paste" }: { visible: boolean; defaultMode?: "paste" | "url" } = $props();

  let mode = $state<"paste" | "url">("paste");
  let text = $state("");
  let urlInput = $state("");
  let llmMode = $state(true);
  let autoDetected = $state(false);
  let urlLoading = $state(false);
  let urlError = $state("");

  function handleRender() {
    if (!text.trim()) return;

    let markdown = text;
    if (llmMode && isLlmEscaped(text)) {
      markdown = unescapeLlmOutput(text);
    }

    const result = renderFull(markdown);
    const now = new Date();
    const timeLabel = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const fileName = `Pasted — ${timeLabel}`;

    const pastePath = `paste://${Date.now()}`;
    tabStore.addTab(pastePath, fileName, markdown, result.html, result.frontmatter, result.wordCount);

    docStore.set({
      filePath: pastePath,
      fileName,
      content: markdown,
      renderedHtml: result.html,
      frontmatter: result.frontmatter,
      wordCount: result.wordCount,
      loading: false,
      error: null,
    });

    text = "";
    visible = false;
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
        if (res.status === 404) {
          urlError = "File not found. Check the URL or ensure the repo is public.";
        } else if (res.status === 403) {
          urlError = "Access denied. This may be a private repository.";
        } else {
          urlError = `Failed to fetch (${res.status})`;
        }
        urlLoading = false;
        return;
      }

      const markdown = await res.text();

      // Check if it looks like markdown/text (not HTML or binary)
      if (markdown.trim().startsWith("<!DOCTYPE") || markdown.trim().startsWith("<html")) {
        urlError = "URL returned HTML, not markdown. Try a raw/direct link.";
        urlLoading = false;
        return;
      }

      const result = renderFull(markdown);
      const fileName = urlToFileName(trimmed);
      const urlPath = `url://${trimmed}`;

      tabStore.addTab(urlPath, fileName, markdown, result.html, result.frontmatter, result.wordCount);

      docStore.set({
        filePath: urlPath,
        fileName,
        content: markdown,
        renderedHtml: result.html,
        frontmatter: result.frontmatter,
        wordCount: result.wordCount,
        loading: false,
        error: null,
      });

      urlInput = "";
      visible = false;
    } catch (err) {
      urlError = `Network error: ${err instanceof Error ? err.message : "Could not reach URL"}`;
    }

    urlLoading = false;
  }

  function handleInput() {
    if (text.length > 10) {
      autoDetected = isLlmEscaped(text);
    } else {
      autoDetected = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      visible = false;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (mode === "paste") {
        handleRender();
      } else {
        handleFetchUrl();
      }
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      visible = false;
    }
  }

  $effect(() => {
    if (visible) {
      text = "";
      urlInput = "";
      urlError = "";
      autoDetected = false;
      mode = defaultMode;
    }
  });
</script>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onkeydown={handleKeydown} onclick={handleBackdropClick}>
    <div class="modal">
      <div class="modal-header">
        <div class="modal-header-left">
          <div class="mode-tabs">
            <button class="mode-tab" class:active={mode === "paste"} onclick={() => (mode = "paste")}>Paste</button>
            <button class="mode-tab" class:active={mode === "url"} onclick={() => (mode = "url")}>Open URL</button>
          </div>
          {#if mode === "paste" && autoDetected}
            <span class="llm-badge">LLM detected</span>
          {/if}
        </div>
        <div class="modal-header-right">
          {#if mode === "paste"}
            <label class="llm-toggle">
              <input type="checkbox" bind:checked={llmMode} />
              <span>LLM Mode</span>
            </label>
          {/if}
          <button onclick={() => (visible = false)} class="modal-close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>
          </button>
        </div>
      </div>

      {#if mode === "paste"}
        <div class="modal-body">
          <textarea
            bind:value={text}
            oninput={handleInput}
            placeholder={'Paste markdown here...\n\nSupports raw markdown and LLM API responses with escaped \\n characters.'}
            class="modal-textarea"
          ></textarea>
        </div>

        <div class="modal-footer">
          <span class="modal-hint">{MOD}+Enter to render</span>
          <div class="modal-actions">
            <button onclick={() => (visible = false)} class="btn-cancel">Cancel</button>
            <button onclick={handleRender} disabled={!text.trim()} class="btn-render">Render</button>
          </div>
        </div>
      {:else}
        <div class="modal-body">
          <div class="url-input-row">
            <input
              type="text"
              bind:value={urlInput}
              placeholder="https://github.com/user/repo/blob/main/README.md"
              class="url-input"
            />
            <button onclick={handleFetchUrl} disabled={urlLoading || !urlInput.trim()} class="btn-render">
              {urlLoading ? "Fetching..." : "Fetch"}
            </button>
          </div>
          {#if urlError}
            <div class="url-error">{urlError}</div>
          {/if}
          <div class="url-hints">
            <p class="url-hints-title">Supported URLs:</p>
            <ul>
              <li>GitHub — <code>github.com/user/repo/blob/main/file.md</code></li>
              <li>Gist — <code>gist.github.com/user/id</code></li>
              <li>GitLab — <code>gitlab.com/user/repo/-/blob/main/file.md</code></li>
              <li>Bitbucket — <code>bitbucket.org/user/repo/src/main/file.md</code></li>
              <li>Any raw URL — <code>https://example.com/doc.md</code></li>
            </ul>
          </div>
        </div>

        <div class="modal-footer">
          <span class="modal-hint">{MOD}+Enter to fetch</span>
          <div class="modal-actions">
            <button onclick={() => (visible = false)} class="btn-cancel">Cancel</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }

  .modal {
    width: 600px;
    max-height: 80vh;
    background: white;
    border: 1px solid #e5e5ea;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  :global(html.dark) .modal {
    background: #2c2c2e;
    border-color: #3a3a3c;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid #e5e5ea;
  }

  :global(html.dark) .modal-header {
    border-bottom-color: #3a3a3c;
  }

  .modal-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .modal-header-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .modal-title {
    font-size: 14px;
    font-weight: 600;
    color: #1c1c1e;
    margin: 0;
  }

  :global(html.dark) .modal-title {
    color: #e5e5e7;
  }

  .llm-badge {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    background: #fff3cd;
    color: #856404;
    font-weight: 500;
  }

  :global(html.dark) .llm-badge {
    background: #3a2e00;
    color: #ffc107;
  }

  .llm-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: #636366;
    cursor: pointer;
  }

  :global(html.dark) .llm-toggle {
    color: #8e8e93;
  }

  .llm-toggle input {
    accent-color: #0891B2;
  }

  .modal-close {
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
    transition: background 0.15s;
  }

  .modal-close:hover {
    background: #f2f2f7;
    color: #636366;
  }

  :global(html.dark) .modal-close:hover {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  .modal-body {
    padding: 16px;
    flex: 1;
  }

  .modal-textarea {
    width: 100%;
    height: 240px;
    padding: 12px;
    font-size: 13px;
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    background: #f9f9fb;
    border: 1px solid #e5e5ea;
    border-radius: 8px;
    resize: none;
    outline: none;
    color: #1c1c1e;
    transition: border-color 0.15s;
  }

  :global(html.dark) .modal-textarea {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .modal-textarea:focus {
    border-color: #0891B2;
  }

  .modal-textarea::placeholder {
    color: #aeaeb2;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid #e5e5ea;
  }

  :global(html.dark) .modal-footer {
    border-top-color: #3a3a3c;
  }

  .modal-hint {
    font-size: 11px;
    color: #aeaeb2;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
  }

  .btn-cancel {
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    background: none;
    border: 1px solid #e5e5ea;
    border-radius: 7px;
    color: #636366;
    cursor: pointer;
    transition: background 0.15s;
  }

  :global(html.dark) .btn-cancel {
    border-color: #3a3a3c;
    color: #8e8e93;
  }

  .btn-cancel:hover {
    background: #f2f2f7;
  }

  :global(html.dark) .btn-cancel:hover {
    background: #3a3a3c;
  }

  .btn-render {
    padding: 6px 18px;
    font-size: 12px;
    font-weight: 500;
    background: #0891B2;
    color: white;
    border: none;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .btn-render:hover {
    background: #0E7490;
  }

  .btn-render:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Mode tabs */
  .mode-tabs {
    display: flex;
    gap: 2px;
    background: #f2f2f7;
    border-radius: 6px;
    padding: 2px;
  }

  :global(html.dark) .mode-tabs {
    background: #1c1c1e;
  }

  .mode-tab {
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 500;
    color: #636366;
    background: none;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  :global(html.dark) .mode-tab {
    color: #8e8e93;
  }

  .mode-tab.active {
    background: white;
    color: #1c1c1e;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }

  :global(html.dark) .mode-tab.active {
    background: #3a3a3c;
    color: #e5e5e7;
  }

  /* URL input */
  .url-input-row {
    display: flex;
    gap: 8px;
  }

  .url-input {
    flex: 1;
    padding: 10px 12px;
    font-size: 13px;
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    background: #f9f9fb;
    border: 1px solid #e5e5ea;
    border-radius: 8px;
    outline: none;
    color: #1c1c1e;
    transition: border-color 0.15s;
  }

  :global(html.dark) .url-input {
    background: #1c1c1e;
    border-color: #3a3a3c;
    color: #e5e5e7;
  }

  .url-input:focus {
    border-color: #0891B2;
  }

  .url-input::placeholder {
    color: #aeaeb2;
    font-size: 12px;
  }

  .url-error {
    margin-top: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: #ff3b30;
    background: #fff0f0;
    border-radius: 6px;
  }

  :global(html.dark) .url-error {
    background: #2c1a1a;
    color: #ff6b6b;
  }

  .url-hints {
    margin-top: 16px;
    padding: 12px;
    background: #f9f9fb;
    border-radius: 8px;
    font-size: 12px;
    color: #636366;
  }

  :global(html.dark) .url-hints {
    background: #1c1c1e;
    color: #8e8e93;
  }

  .url-hints-title {
    font-weight: 600;
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: #aeaeb2;
  }

  .url-hints ul {
    margin: 0;
    padding: 0 0 0 16px;
    list-style: disc;
  }

  .url-hints li {
    margin: 3px 0;
    line-height: 1.5;
  }

  .url-hints code {
    font-size: 11px;
    padding: 1px 4px;
    background: #e5e5ea;
    border-radius: 3px;
    color: #636366;
  }

  :global(html.dark) .url-hints code {
    background: #2c2c2e;
    color: #aeaeb2;
  }

  @media print {
    .modal-backdrop { display: none !important; }
  }
</style>
