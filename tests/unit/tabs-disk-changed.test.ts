import { describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  const map = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  (globalThis as any).window = { scrollY: 0 };
  return (await import("../../src/lib/stores/tabs")).tabStore;
}

// #97: when a file changes on disk under a tab with unsaved edits, the edits
// are kept and the tab is marked so Save can ask before overwriting.
describe("diskChanged", () => {
  it("is raised when the disk moves under unsaved edits, and the edits survive", async () => {
    const store = await freshStore();
    const id = store.addTab("/docs/a.md", "a.md", "v1", "");
    store.setEditing(id, true);
    store.updateEditContent(id, "v1 plus my typing");

    store.updateTabContent("/docs/a.md", "v2 from someone else", "");

    const tab = store.getActiveTab()!;
    expect(tab.editContent).toBe("v1 plus my typing");
    expect(tab.content).toBe("v2 from someone else");
    expect(tab.dirty).toBe(true);
    expect(tab.diskChanged).toBe(true);
  });

  it("is not raised when the tab is not editing, or when the disk now matches the edits", async () => {
    const store = await freshStore();
    const id = store.addTab("/docs/a.md", "a.md", "v1", "");
    store.updateTabContent("/docs/a.md", "v2", "");
    expect(store.getActiveTab()!.diskChanged).toBe(false);

    store.setEditing(id, true);
    store.updateEditContent(id, "v3");
    store.updateTabContent("/docs/a.md", "v3", ""); // someone saved exactly what I typed
    expect(store.getActiveTab()!.dirty).toBe(false);
    expect(store.getActiveTab()!.diskChanged).toBe(false);
  });

  it("clears on save", async () => {
    const store = await freshStore();
    const id = store.addTab("/docs/a.md", "a.md", "v1", "");
    store.setEditing(id, true);
    store.updateEditContent(id, "mine");
    store.updateTabContent("/docs/a.md", "theirs", "");
    expect(store.getActiveTab()!.diskChanged).toBe(true);

    store.markSaved(id);
    expect(store.getActiveTab()!.diskChanged).toBe(false);
    expect(store.getActiveTab()!.dirty).toBe(false);
  });

  it("stays raised across a second disk change while still dirty", async () => {
    const store = await freshStore();
    const id = store.addTab("/docs/a.md", "a.md", "v1", "");
    store.setEditing(id, true);
    store.updateEditContent(id, "mine");
    store.updateTabContent("/docs/a.md", "theirs 1", "");
    store.updateTabContent("/docs/a.md", "theirs 2", "");
    expect(store.getActiveTab()!.diskChanged).toBe(true);
  });
});
