import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn();
const invoke = vi.fn();
const reloadFile = vi.fn();
const getLastSavedAt = vi.fn((_path: string) => 0);

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../src/lib/tauri/files", () => ({ reloadFile }));
vi.mock("../../src/lib/stores/tabs", () => ({ tabStore: { getLastSavedAt } }));

const { initFileWatcher, stopFileWatcher } = await import("../../src/lib/tauri/watcher");

// #97: one session-wide listener; the backend says which file changed and the
// reload goes to that file, whichever tab owns it.
describe("file watcher (all tabs)", () => {
  let handler: ((e: { payload: { path: string } }) => void) | null = null;
  const unlistenFn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    // stopFileWatcher awaits invoke("stop_watching"); an unconfigured vi.fn()
    // returns undefined, not a promise, so configure it before the teardown.
    invoke.mockResolvedValue(undefined);
    stopFileWatcher();
    vi.clearAllMocks();
    getLastSavedAt.mockReturnValue(0);
    invoke.mockResolvedValue(undefined);
    listen.mockImplementation(async (_name: string, cb: typeof handler) => {
      handler = cb;
      return unlistenFn;
    });
  });
  afterEach(() => vi.useRealTimers());

  it("registers exactly one listener no matter how often it is initialised", async () => {
    await initFileWatcher();
    await initFileWatcher();
    await initFileWatcher();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0][0]).toBe("file-changed");
  });

  it("reloads the file named in the event, after coalescing a burst", async () => {
    await initFileWatcher();
    handler!({ payload: { path: "/docs/a.md" } });
    handler!({ payload: { path: "/docs/a.md" } });
    handler!({ payload: { path: "/docs/a.md" } });
    vi.advanceTimersByTime(150);
    expect(reloadFile).toHaveBeenCalledTimes(1);
    expect(reloadFile).toHaveBeenCalledWith("/docs/a.md");
  });

  it("keeps two files' reloads independent — a background tab's change is not lost", async () => {
    await initFileWatcher();
    handler!({ payload: { path: "/docs/a.md" } });
    handler!({ payload: { path: "/docs/b.md" } });
    vi.advanceTimersByTime(150);
    expect(reloadFile.mock.calls.map((c) => c[0]).sort()).toEqual(["/docs/a.md", "/docs/b.md"]);
  });

  it("skips the event caused by our own save of that file, and only that file", async () => {
    await initFileWatcher();
    getLastSavedAt.mockImplementation((p: string) => (p === "/docs/a.md" ? Date.now() : 0));
    handler!({ payload: { path: "/docs/a.md" } });
    handler!({ payload: { path: "/docs/b.md" } });
    vi.advanceTimersByTime(150);
    expect(reloadFile).toHaveBeenCalledTimes(1);
    expect(reloadFile).toHaveBeenCalledWith("/docs/b.md");
  });

  it("ignores an event without a path", async () => {
    await initFileWatcher();
    handler!({ payload: {} as any });
    vi.advanceTimersByTime(150);
    expect(reloadFile).not.toHaveBeenCalled();
  });

  it("stops on both sides: unlistens, cancels pending reloads, tells the backend", async () => {
    await initFileWatcher();
    handler!({ payload: { path: "/docs/a.md" } });
    stopFileWatcher();
    vi.advanceTimersByTime(150);
    expect(unlistenFn).toHaveBeenCalledTimes(1);
    expect(reloadFile).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("stop_watching");
  });
});
