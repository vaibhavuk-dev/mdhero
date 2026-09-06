/**
 * Scroll synchronization across viewer / raw / editor modes.
 *
 * Strategy: anchor on the source markdown's line number. The renderer stamps
 * `data-source-line="N"` (0-indexed) on every top-level block element. The
 * viewer reads/writes those stamps directly via getBoundingClientRect.
 *
 * Raw and editor have no per-line DOM, so we map source line ↔ pixel offset
 * through `measureLineOffsets`: an off-screen mirror that replicates the
 * element's content width, font, and wrapping rules and reports each line's
 * real `offsetTop`. This is wrap-aware — a flat `line * lineHeight` is wrong
 * the moment a long line wraps to multiple visual rows (issue #21), which is
 * exactly the case both panes hit since they `white-space: pre-wrap`.
 */

export type ViewMode = "viewer" | "raw" | "editor";

const TOOLBAR_TABBAR_HEIGHT = 80; // approximate sticky chrome at top

/** Read the source line currently anchored at the top of the viewport. */
export function getCurrentSourceLine(mode: ViewMode): number {
  if (mode === "viewer") return readViewerLine();
  if (mode === "raw") return readRawLine();
  return readEditorLine();
}

/** Scroll the destination mode so source `line` is anchored at the top. */
export function scrollToSourceLine(mode: ViewMode, line: number): void {
  if (line <= 0) {
    if (mode === "editor") {
      const ta = getEditorEl();
      if (ta) ta.scrollTop = 0;
    } else {
      window.scrollTo(0, 0);
    }
    return;
  }
  if (mode === "viewer") scrollViewerToLine(line);
  else if (mode === "raw") scrollRawToLine(line);
  else scrollEditorToLine(line);
}

// --- Viewer (rendered HTML with data-source-line stamps) ---

function readViewerLine(): number {
  const article = document.querySelector("article.prose");
  if (!article) return 0;
  const elements = article.querySelectorAll<HTMLElement>("[data-source-line]");
  if (elements.length === 0) return 0;

  // Topmost block whose bottom is below the chrome line is the one "in view".
  // Return its start line PLUS the fraction of the block scrolled above the
  // chrome line — the fraction is what keeps your place when one block wraps
  // across many rows (issue #21); without it, deep-in-a-block positions snap
  // back to the block's first line on a mode switch.
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > TOOLBAR_TABBAR_HEIGHT) {
      const frac =
        rect.height > 0 ? clamp01((TOOLBAR_TABBAR_HEIGHT - rect.top) / rect.height) : 0;
      return lineOf(el) + frac;
    }
  }
  // Past the end — return the last block's line
  return lineOf(elements[elements.length - 1]);
}

function scrollViewerToLine(anchor: number): void {
  const article = document.querySelector("article.prose");
  if (!article) return;
  const elements = Array.from(article.querySelectorAll<HTMLElement>("[data-source-line]"));
  if (elements.length === 0) return;

  const floor = Math.floor(anchor);
  const frac = anchor - floor;

  // The block at or just before the target line; the fraction then positions
  // the viewport within that block to mirror the source mode.
  let target = elements[0];
  for (const el of elements) {
    if (lineOf(el) <= floor) target = el;
    else break;
  }

  const rect = target.getBoundingClientRect();
  window.scrollTo(0, window.scrollY + rect.top + frac * rect.height - TOOLBAR_TABBAR_HEIGHT);
}

function lineOf(el: HTMLElement): number {
  return parseInt(el.getAttribute("data-source-line") || "0", 10);
}

// --- Rendered blocks inside a scroll container (split-mode preview, #74) ---
//
// Same anchoring as the viewer above, but relative to a container that scrolls
// itself instead of the window, so the reference line is the container's top
// edge rather than the sticky chrome.

/** Fractional source line anchored at the top of `container`'s viewport. */
export function readBlockLineIn(container: HTMLElement): number {
  const top = container.getBoundingClientRect().top;
  const elements = container.querySelectorAll<HTMLElement>("[data-source-line]");
  if (elements.length === 0) return 0;
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top) {
      const frac = rect.height > 0 ? clamp01((top - rect.top) / rect.height) : 0;
      return lineOf(el) + frac;
    }
  }
  return lineOf(elements[elements.length - 1]);
}

/** Scroll `container` so the block holding fractional `anchor` sits at its top. */
export function scrollBlocksToLineIn(container: HTMLElement, anchor: number): void {
  if (anchor <= 0) {
    container.scrollTop = 0;
    return;
  }
  const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-source-line]"));
  if (elements.length === 0) return;
  const floor = Math.floor(anchor);
  const frac = anchor - floor;
  let target = elements[0];
  for (const el of elements) {
    if (lineOf(el) <= floor) target = el;
    else break;
  }
  const rect = target.getBoundingClientRect();
  const top = container.getBoundingClientRect().top;
  container.scrollTop += rect.top - top + frac * rect.height;
}

// --- Raw (window-scrolled <pre class="raw-source">) ---

function readRawLine(): number {
  const pre = document.querySelector<HTMLPreElement>(".raw-source");
  if (!pre) return 0;
  const preTop = pre.getBoundingClientRect().top;
  // pixels of the pre's content that have scrolled above the chrome line
  const hidden = TOOLBAR_TABBAR_HEIGHT - preTop;
  if (hidden <= 0) return 0;
  return fractionalLineAtOffset(measureLineOffsets(pre, pre.textContent || ""), hidden);
}

function scrollRawToLine(anchor: number): void {
  const pre = document.querySelector<HTMLPreElement>(".raw-source");
  if (!pre) return;
  const offsets = measureLineOffsets(pre, pre.textContent || "");
  const preTopAbsolute = pre.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, preTopAbsolute + pixelAtLine(offsets, anchor) - TOOLBAR_TABBAR_HEIGHT);
}

// --- Editor (textarea with internal scroll) ---

function getEditorEl(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(".editor");
}

function readEditorLine(): number {
  const ta = getEditorEl();
  if (!ta) return 0;
  return fractionalLineAtOffset(measureLineOffsets(ta, ta.value), ta.scrollTop);
}

function scrollEditorToLine(anchor: number): void {
  const ta = getEditorEl();
  if (!ta) return;
  const offsets = measureLineOffsets(ta, ta.value);
  ta.scrollTop = Math.round(pixelAtLine(offsets, anchor));
}

// --- Wrap-aware, fractional line ↔ pixel mapping ---
//
// Anchors are fractional: the integer part is the 0-based source line at the
// top, the fractional part is how far the viewport has scrolled INTO that
// line's wrapped rows (0 = line top, →1 = next line top). The fraction is what
// preserves position inside a tall block across a mode switch (issue #21).

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampLine(line: number, count: number): number {
  if (count === 0) return 0;
  return Math.min(Math.max(line, 0), count - 1);
}

/** Largest index `i` with `offsets[i] <= y` (binary search). */
export function lineAtOffset(offsets: number[], y: number): number {
  if (offsets.length === 0 || y <= 0) return 0;
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= y) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Fractional source line at pixel `y`: integer line + fraction into its rows. */
export function fractionalLineAtOffset(offsets: number[], y: number): number {
  if (offsets.length === 0 || y <= 0) return 0;
  const floor = lineAtOffset(offsets, y);
  const base = offsets[floor];
  const next = floor + 1 < offsets.length ? offsets[floor + 1] : base + 1;
  const span = next - base;
  return floor + (span > 0 ? clamp01((y - base) / span) : 0);
}

/** Inverse of `fractionalLineAtOffset`: pixel offset for a fractional line. */
export function pixelAtLine(offsets: number[], anchor: number): number {
  if (offsets.length === 0) return 0;
  const floor = clampLine(Math.floor(anchor), offsets.length);
  const frac = anchor - Math.floor(anchor);
  const base = offsets[floor];
  const next = floor + 1 < offsets.length ? offsets[floor + 1] : base;
  return base + (frac > 0 ? frac * (next - base) : 0);
}

/**
 * Measure the top pixel offset of every source line as it actually wraps
 * inside `reference` (the raw <pre> or the editor <textarea>). Returns an array
 * where `offsets[i]` is the y of line `i`'s first visual row, relative to the
 * content's top.
 *
 * Why a mirror: a <textarea> exposes no per-line geometry, and a wrapped <pre>'s
 * lines don't map to `lineHeight`. We replicate the element's content width,
 * font metrics, and wrap rules off-screen and read each line's real `offsetTop`.
 * Called once per mode switch, so a single layout pass is fine. Split-mode
 * sync calls it per scroll but caches the result per (text, width).
 */
export function measureLineOffsets(reference: HTMLElement, text: string): number[] {
  const cs = getComputedStyle(reference);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const contentWidth = reference.clientWidth - padL - padR;

  const mirror = document.createElement("div");
  const s = mirror.style;
  s.position = "absolute";
  s.left = "-9999px";
  s.top = "0";
  s.visibility = "hidden";
  s.boxSizing = "border-box";
  s.margin = "0";
  s.padding = "0";
  s.border = "0";
  s.width = `${Math.max(0, contentWidth)}px`;
  // Replicate text metrics so wrapping matches the reference exactly.
  s.fontFamily = cs.fontFamily;
  s.fontSize = cs.fontSize;
  s.fontWeight = cs.fontWeight;
  s.fontStyle = cs.fontStyle;
  s.lineHeight = cs.lineHeight;
  s.letterSpacing = cs.letterSpacing;
  s.tabSize = cs.tabSize;
  s.whiteSpace = "pre-wrap";
  s.wordBreak = cs.wordBreak;
  s.overflowWrap = cs.overflowWrap;

  const lines = text.split("\n");
  const markers: HTMLElement[] = new Array(lines.length);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement("div");
    row.style.whiteSpace = "pre-wrap";
    row.style.wordBreak = cs.wordBreak;
    row.style.overflowWrap = cs.overflowWrap;
    // Empty lines must still occupy one row; a zero-width space forces a line box.
    row.textContent = lines[i].length ? lines[i] : "\u200b";
    frag.appendChild(row);
    markers[i] = row;
  }
  mirror.appendChild(frag);
  document.body.appendChild(mirror);
  const offsets = markers.map((m) => m.offsetTop);
  document.body.removeChild(mirror);
  return offsets;
}
