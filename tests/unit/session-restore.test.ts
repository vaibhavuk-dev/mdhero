import { beforeEach, describe, expect, it, vi } from "vitest";

const openFile = vi.fn();
const pathExists = vi.fn();
const switchTab = vi.fn();
const goHome = vi.fn();
let saved: { paths: string[]; activePath: string | null } | null = null;
let tabs: { id: string; filePath: string }[] = [];

vi.mock("../../src/lib/tauri/files", () => ({ openFile, pathExists }));
vi.mock("../../src/lib/stores/tabs", () => ({
  tabStore: {
    getSavedSession: () => saved,
    tabs: { subscribe: (run: (v: unknown) => void) => (run(tabs), () => {}) },
    switchTab,
    goHome,
  },
}));

const { restoreSession } = await import("../../src/lib/tauri/session");

describe("restoreSession (#72)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathExists.mockResolvedValue(true);
    openFile.mockImplementation(async (p: string) => {
      tabs = [...tabs, { id: `id:${p}`, filePath: p }];
    });
    tabs = [];
    saved = null;
  });

  it("does nothing when there is no saved session", async () => {
    expect(await restoreSession()).toBe(0);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("reopens the files in their saved order and re-activates the saved tab", async () => {
    saved = { paths: ["/d/a.md", "/d/b.md", "/d/c.md"], activePath: "/d/b.md" };

    expect(await restoreSession()).toBe(3);
    expect(openFile.mock.calls.map((c) => c[0])).toEqual(["/d/a.md", "/d/b.md", "/d/c.md"]);
    expect(switchTab).toHaveBeenCalledWith("id:/d/b.md");
    expect(goHome).not.toHaveBeenCalled();
  });

  it("skips files that no longer exist without touching the rest", async () => {
    saved = { paths: ["/d/a.md", "/d/gone.md", "/d/c.md"], activePath: "/d/gone.md" };
    pathExists.mockImplementation(async (p: string) => p !== "/d/gone.md");

    expect(await restoreSession()).toBe(2);
    expect(openFile.mock.calls.map((c) => c[0])).toEqual(["/d/a.md", "/d/c.md"]);
    // The active file is gone: stay on the last one that came back.
    expect(switchTab).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
  });

  it("returns to the home tab when that is where the user was", async () => {
    saved = { paths: ["/d/a.md"], activePath: null };

    await restoreSession();
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it("carries on when one file fails to open", async () => {
    saved = { paths: ["/d/a.md", "/d/bad.md", "/d/c.md"], activePath: "/d/c.md" };
    openFile.mockImplementation(async (p: string) => {
      if (p === "/d/bad.md") throw new Error("boom");
      tabs = [...tabs, { id: `id:${p}`, filePath: p }];
    });

    expect(await restoreSession()).toBe(2);
    expect(switchTab).toHaveBeenCalledWith("id:/d/c.md");
  });
});
