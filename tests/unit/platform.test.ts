import { describe, expect, it } from "vitest";
import { modifierKeyLabel } from "../../src/lib/utils/platform";

// Every shortcut label used to be hardcoded "Cmd" (#62's Ubuntu screenshot
// shows `Cmd+O` on the Linux home screen). The label is now derived from the
// platform string, which is what these pin down.
describe("modifierKeyLabel", () => {
  it("is Cmd on macOS", () => {
    expect(modifierKeyLabel("MacIntel")).toBe("Cmd");
    expect(modifierKeyLabel("macOS")).toBe("Cmd");
  });

  it("is Ctrl on Windows and Linux", () => {
    expect(modifierKeyLabel("Win32")).toBe("Ctrl");
    expect(modifierKeyLabel("Linux x86_64")).toBe("Ctrl");
    expect(modifierKeyLabel("Linux aarch64")).toBe("Ctrl");
  });

  it("falls back to Ctrl when the platform is unknown", () => {
    // An unknown platform must not claim a Command key it may not have.
    expect(modifierKeyLabel("")).toBe("Ctrl");
  });
});
