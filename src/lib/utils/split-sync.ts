import {
  fractionalLineAtOffset,
  measureLineOffsets,
  pixelAtLine,
  readBlockLineIn,
  scrollBlocksToLineIn,
} from "./scroll-sync";

/**
 * Two-way scroll sync between the split-mode editor and its live preview (#74).
 *
 * Both panes speak "fractional source line": the editor maps its scrollTop
 * through the wrap-aware line offsets, the preview through the renderer's
 * `data-source-line` stamps. Whichever pane the user scrolls drives the other.
 *
 * The one thing that goes wrong with two-way sync is the echo: driving pane B
 * fires B's own scroll event, which would drive A back, which fires A's scroll
 * event… so after driving a pane its scroll events are ignored for a short
 * window. A user scroll on that pane inside the window is dropped, which is
 * invisible; a feedback loop is not.
 */

export interface SyncPane {
  /** Fractional source line at the top of this pane's viewport. */
  readLine(): number;
  /** Scroll this pane so `line` sits at the top of its viewport. */
  scrollToLine(line: number): void;
}

export interface SplitSync {
  onEditorScroll(): void;
  onPreviewScroll(): void;
  /** Force preview to follow the editor, e.g. right after the preview re-rendered. */
  syncFromEditor(): void;
  dispose(): void;
}

/** How long a pane's own scroll events are ignored after it was driven. */
export const ECHO_WINDOW_MS = 150;

export function createSplitSync(
  editor: SyncPane,
  preview: SyncPane,
  now: () => number = () => performance.now()
): SplitSync {
  let muteEditorUntil = 0;
  let mutePreviewUntil = 0;
  let disposed = false;

  function drive(from: SyncPane, to: SyncPane, target: "editor" | "preview") {
    const line = from.readLine();
    if (target === "preview") mutePreviewUntil = now() + ECHO_WINDOW_MS;
    else muteEditorUntil = now() + ECHO_WINDOW_MS;
    to.scrollToLine(line);
  }

  return {
    onEditorScroll() {
      if (disposed || now() < muteEditorUntil) return;
      drive(editor, preview, "preview");
    },
    onPreviewScroll() {
      if (disposed || now() < mutePreviewUntil) return;
      drive(preview, editor, "editor");
    },
    syncFromEditor() {
      if (disposed) return;
      drive(editor, preview, "preview");
    },
    dispose() {
      disposed = true;
    },
  };
}

/**
 * Wire a textarea and a scrolling preview container together. Returns the
 * controller; call `dispose()` when leaving split mode.
 *
 * Line offsets for the textarea come from an off-screen mirror (see
 * `measureLineOffsets`) and are cached until the text or the pane width
 * changes, so a scroll costs one binary search, not a layout pass.
 */
export function attachSplitSync(textarea: HTMLTextAreaElement, preview: HTMLElement): SplitSync {
  let cachedText: string | null = null;
  let cachedWidth = -1;
  let cachedOffsets: number[] = [];
  const offsets = (): number[] => {
    const text = textarea.value;
    const width = textarea.clientWidth;
    if (text !== cachedText || width !== cachedWidth) {
      cachedText = text;
      cachedWidth = width;
      cachedOffsets = measureLineOffsets(textarea, text);
    }
    return cachedOffsets;
  };

  const editorPane: SyncPane = {
    readLine: () => fractionalLineAtOffset(offsets(), textarea.scrollTop),
    scrollToLine: (line) => {
      textarea.scrollTop = Math.round(pixelAtLine(offsets(), line));
    },
  };
  const previewPane: SyncPane = {
    readLine: () => readBlockLineIn(preview),
    scrollToLine: (line) => scrollBlocksToLineIn(preview, line),
  };

  const sync = createSplitSync(editorPane, previewPane);
  const onEditor = () => sync.onEditorScroll();
  const onPreview = () => sync.onPreviewScroll();
  textarea.addEventListener("scroll", onEditor, { passive: true });
  preview.addEventListener("scroll", onPreview, { passive: true });

  return {
    ...sync,
    dispose() {
      textarea.removeEventListener("scroll", onEditor);
      preview.removeEventListener("scroll", onPreview);
      sync.dispose();
    },
  };
}
