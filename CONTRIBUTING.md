# Contributing to MDHero

Thanks for your interest in MDHero! This is a side project, so response times may vary — but contributions are very welcome.

---

## Ways to Contribute

- **Report bugs** — Open an issue with clear reproduction steps and your OS/version.
- **Suggest features** — Open an issue describing the problem you're solving (not just the solution).
- **Submit PRs** — Bug fixes are welcome anytime. For features, please open an issue first to discuss.
- **Improve docs** — README, keyboard shortcuts, install instructions — PRs for typos and clarifications are always welcome.

---

## Before You Start a Large PR

**Please open an issue first.** This saves everyone time:

- The feature may already be in progress
- It may not fit the project's direction
- We can discuss the approach before you write code

Small PRs (bug fixes, typos, minor tweaks) don't need an issue first.

---

## Development Setup

### Requirements
- **Node.js** 22+
- **pnpm** 10+
- **Rust** stable toolchain
- **Xcode Command Line Tools** (macOS) or **MSVC Build Tools** (Windows)

### Setup

```bash
# Clone
git clone https://github.com/vaibhav-kakde-in/mdhero.git
cd mdhero

# Install dependencies
pnpm install

# Run dev server with hot reload
pnpm tauri dev
```

Port 1420 is used for dev. If it's stuck, free it with:
```bash
lsof -ti:1420 | xargs kill -9
```

### Common Commands

```bash
pnpm tauri dev          # Dev with hot reload (frontend + Rust)
pnpm tauri build        # Production build (outputs DMG/MSI)
pnpm build              # Build frontend only (SvelteKit static)
pnpm check              # TypeScript type checking
```

---

## Code Style

### General
- **Keep changes focused.** Don't bundle unrelated changes in one PR.
- **Match existing patterns.** Read nearby code before introducing new conventions.
- **Prefer editing over creating.** Only add new files when there's a clear reason.
- **No unnecessary abstractions.** Three similar lines is better than a premature abstraction.

### Frontend (Svelte / TypeScript)
- Svelte 5 runes syntax: `$state()`, `$props()`, `$effect()`, `$derived()`. No legacy APIs.
- Tailwind CSS v4 — use utility classes; reserve `<style>` blocks for `:global()` markdown targeting.
- TypeScript strict mode. Avoid `any` unless interfacing with untyped external code.
- No external state libraries — use Svelte stores.

### Backend (Rust / Tauri)
- Tauri v2 commands via `#[tauri::command]`.
- New IPC commands need matching permissions in `src-tauri/capabilities/default.json`.
- Non-critical Tauri calls should use `.catch(() => {})` on the frontend to prevent failures from breaking the main flow.

### Comments
- **Default to writing no comments.** Only add a comment when the *why* is non-obvious.
- Don't explain what the code does — well-named identifiers already do that.

---

## Architecture Overview

```
src/
├── lib/
│   ├── components/   # Svelte components
│   ├── stores/       # Svelte writable stores (document, tabs, theme, etc.)
│   ├── renderer/     # markdown-it + highlight.js + KaTeX pipeline
│   ├── tauri/        # IPC wrappers (file ops, watcher)
│   └── utils/        # Helpers (llm parsing, url conversion)
└── routes/
    └── +page.svelte  # Main page, handles tabs + keyboard shortcuts

src-tauri/
├── src/
│   ├── lib.rs        # Tauri setup, plugins, state
│   ├── commands.rs   # IPC command handlers
│   ├── menu.rs       # Native menu bar
│   └── watcher.rs    # File watcher (notify crate)
├── tauri.conf.json   # Window/bundle/plugin config
└── capabilities/     # Tauri permissions
```

---

## Testing Your Changes

Before submitting a PR:

1. **Type check:** `pnpm check` passes
2. **Build:** `pnpm tauri build` succeeds on your platform
3. **Manual test:** Use the feature in dev mode, test edge cases, verify in both light and dark mode
4. **No regressions:** Confirm existing features (file open, tabs, search, etc.) still work

---

## Commit Messages

- Write clear, descriptive commit messages
- Focus on *why* the change was made, not *what* (the diff shows what)
- Reference issue numbers when applicable: `Fix race condition on file open (#42)`
- Keep the first line under 72 characters

---

## Security

If you find a security issue, please email **vaibhavuk.dev@gmail.com** instead of opening a public issue.

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
