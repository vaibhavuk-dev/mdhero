import { describe, expect, it, vi } from "vitest";
import { createSplitSync, ECHO_WINDOW_MS, type SyncPane } from "../../src/lib/utils/split-sync";
import { fractionalLineAtOffset, lineAtOffset, pixelAtLine } from "../../src/lib/utils/scroll-sync";

function pane(line = 0): SyncPane & { line: number; scrolls: number[] } {
  const p = {
    line,
    scrolls: [] as number[],
    readLine: () => p.line,
    scrollToLine: vi.fn((l: number) => {
      p.line = l;
      p.scrolls.push(l);
    }),
  };
  return p;
}

// #74: the split panes follow each other without fighting.
describe("createSplitSync", () => {
  it("drives the preview to the editor's line when the editor scrolls", () => {
    let t = 0;
    const editor = pane(12.5);
    const preview = pane(0);
    const sync = createSplitSync(editor, preview, () => t);

    sync.onEditorScroll();

    expect(preview.scrolls).toEqual([12.5]);
    expect(editor.scrolls).toEqual([]);
  });

  it("drives the editor when the preview scrolls", () => {
    let t = 0;
    const editor = pane(0);
    const preview = pane(40.25);
    const sync = createSplitSync(editor, preview, () => t);

    sync.onPreviewScroll();

    expect(editor.scrolls).toEqual([40.25]);
  });

  it("ignores the echo scroll a driven pane fires back, so the panes never loop", () => {
    let t = 0;
    const editor = pane(7);
    const preview = pane(0);
    const sync = createSplitSync(editor, preview, () => t);

    sync.onEditorScroll(); // drives preview → preview's own scroll event follows
    t += 16;
    sync.onPreviewScroll(); // the echo

    expect(editor.scrolls).toEqual([]);
    expect(preview.scrolls).toEqual([7]);
  });

  it("accepts a real scroll on the driven pane once the echo window has passed", () => {
    let t = 0;
    const editor = pane(7);
    const preview = pane(0);
    const sync = createSplitSync(editor, preview, () => t);

    sync.onEditorScroll();
    t += ECHO_WINDOW_MS + 1;
    preview.line = 30;
    sync.onPreviewScroll();

    expect(editor.scrolls).toEqual([30]);
  });

  it("keeps following the editor through a continuous scroll", () => {
    let t = 0;
    const editor = pane(0);
    const preview = pane(0);
    const sync = createSplitSync(editor, preview, () => t);

    for (const line of [1, 2, 3, 4]) {
      editor.line = line;
      sync.onEditorScroll();
      t += 16;
      sync.onPreviewScroll(); // echo each frame
    }

    expect(preview.scrolls).toEqual([1, 2, 3, 4]);
    expect(editor.scrolls).toEqual([]);
  });

  it("syncFromEditor re-lands the preview after a re-render and mutes its echo", () => {
    let t = 0;
    const editor = pane(99);
    const preview = pane(3);
    const sync = createSplitSync(editor, preview, () => t);

    sync.syncFromEditor();
    sync.onPreviewScroll();

    expect(preview.scrolls).toEqual([99]);
    expect(editor.scrolls).toEqual([]);
  });

  it("does nothing after dispose", () => {
    const editor = pane(5);
    const preview = pane(0);
    const sync = createSplitSync(editor, preview, () => 0);
    sync.dispose();
    sync.onEditorScroll();
    sync.onPreviewScroll();
    sync.syncFromEditor();
    expect(preview.scrolls).toEqual([]);
    expect(editor.scrolls).toEqual([]);
  });
});

// The line ↔ pixel mapping both panes rely on. Offsets are the top of each
// source line's first visual row; a wrapped line spans more than one row.
describe("fractional line ↔ pixel mapping", () => {
  const offsets = [0, 20, 40, 100, 120]; // line 2 wraps across 3 rows (40→100)

  it("finds the line at a pixel by binary search", () => {
    expect(lineAtOffset(offsets, 0)).toBe(0);
    expect(lineAtOffset(offsets, 39)).toBe(1);
    expect(lineAtOffset(offsets, 40)).toBe(2);
    expect(lineAtOffset(offsets, 99)).toBe(2);
    expect(lineAtOffset(offsets, 500)).toBe(4);
  });

  it("reports how far into a wrapped line the viewport is", () => {
    expect(fractionalLineAtOffset(offsets, 70)).toBeCloseTo(2.5);
    expect(fractionalLineAtOffset(offsets, 40)).toBe(2);
  });

  it("round-trips pixel → line → pixel", () => {
    for (const y of [0, 10, 40, 70, 99, 110]) {
      expect(pixelAtLine(offsets, fractionalLineAtOffset(offsets, y))).toBeCloseTo(y);
    }
  });

  it("is safe on empty input and out-of-range lines", () => {
    expect(fractionalLineAtOffset([], 50)).toBe(0);
    expect(pixelAtLine([], 3)).toBe(0);
    expect(pixelAtLine(offsets, 400)).toBe(120);
    expect(pixelAtLine(offsets, -5)).toBe(0);
  });
});
