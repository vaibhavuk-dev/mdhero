import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const pinned = ["/vault/attachments"];

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("../../src/lib/stores/pinned", () => ({
  pinnedFolders: { subscribe: (run: (v: string[]) => void) => (run(pinned), () => {}) },
}));
vi.mock("../../src/lib/stores/recents", () => ({ addRecentFile: vi.fn() }));

const { allowAssets } = await import("../../src/lib/tauri/files");

// The Rust command decides what the webview may fetch; this side's job is to
// tell it which document is asking and which folders the user trusts, and to
// make a refusal visible instead of silent (L10).
describe("allowAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue([]);
  });

  it("sends the document path and the pinned folders alongside the image paths", async () => {
    await allowAssets(["/repo/assets/a.png", "/repo/docs/b.png"], "/repo/docs/guide.md");

    expect(invoke).toHaveBeenCalledWith("allow_assets", {
      documentPath: "/repo/docs/guide.md",
      pinnedFolders: ["/vault/attachments"],
      paths: ["/repo/assets/a.png", "/repo/docs/b.png"],
    });
  });

  it("does not round-trip when the document references no local images", async () => {
    await allowAssets([], "/repo/docs/guide.md");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("warns with the paths the backend refused to serve", async () => {
    invoke.mockResolvedValue(["/etc/passwd"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await allowAssets(["/etc/passwd"], "/repo/docs/guide.md");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual(["/etc/passwd"]);
    warn.mockRestore();
  });

  it("swallows a backend failure so the document still renders", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await expect(allowAssets(["/x.png"], "/repo/x.md")).resolves.toBeUndefined();
  });
});
