import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import taskLists from "markdown-it-task-lists";
import anchor from "markdown-it-anchor";
import texmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import { convertFileSrc } from "@tauri-apps/api/core";

// Register common languages
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import shell from "highlight.js/lib/languages/shell";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("toml", ini);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("tsx", typescript);

export interface RenderResult {
  html: string;
  frontmatter: Record<string, unknown> | null;
  wordCount: number;
  /**
   * Absolute on-disk paths of every local image the document references, after
   * resolution against `baseDir`. The caller hands these to the `allow_assets`
   * command, which is the only way a file becomes fetchable by the webview's
   * asset protocol (issue #31) — and which serves only files inside the
   * document's own folder tree or a pinned folder, whatever this list says.
   */
  assetPaths: string[];
  /** True when the frontmatter declares `marp: true` — a Marp slide deck (#44). */
  isMarp: boolean;
}

/**
 * Whether a parsed frontmatter block marks the document as a Marp deck. The
 * naive frontmatter parser stores values as strings, so `marp: true` arrives as
 * the string `"true"`; accept both that and a real boolean.
 */
export function isMarpDoc(frontmatter: Record<string, unknown> | null): boolean {
  const v = frontmatter?.marp;
  return v === true || v === "true";
}

/** Matches a leading `---\n…\n---\n` frontmatter block (same shape renderFull strips). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Return the markdown body with any leading YAML-ish frontmatter block removed.
 * `renderFull` strips frontmatter internally, but the stored document content
 * keeps it — Marp slide splitting needs the body without it (#44).
 */
export function stripFrontmatter(markdown: string): string {
  const m = markdown.match(FRONTMATTER_RE);
  return m ? m[2] : markdown;
}

let md: MarkdownIt | null = null;
let initialized = false;

/**
 * Stamp top-level block elements with `data-source-line="N"` (0-indexed line in
 * source markdown). Used by the scroll-sync logic to map view ↔ raw ↔ editor.
 */
function addSourceLinePlugin(mdInstance: MarkdownIt) {
  mdInstance.core.ruler.push("source-line", (state) => {
    for (const token of state.tokens) {
      if (token.map && token.level === 0 && token.type.endsWith("_open")) {
        token.attrSet("data-source-line", String(token.map[0]));
      }
    }
  });
}

// Text-bearing blocks that should auto-detect direction. Code and math are
// deliberately excluded — they must stay LTR regardless of surrounding text.
const DIR_AUTO_BLOCKS = new Set([
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "list_item_open",
  "td_open",
  "th_open",
]);

/**
 * Stamp `dir="auto"` on each text-bearing block so it picks its own base
 * direction from its first strong-directional character — RTL paragraphs
 * (Hebrew/Arabic) then right-align on their own, like the browser and VSCode,
 * without forcing a whole-document direction (#64). Mixed LTR/RTL docs resolve
 * per block. `dir` is a standard global attribute, so DOMPurify keeps it.
 */
function addDirAutoPlugin(mdInstance: MarkdownIt) {
  mdInstance.core.ruler.push("dir-auto", (state) => {
    for (const token of state.tokens) {
      if (DIR_AUTO_BLOCKS.has(token.type)) {
        token.attrSet("dir", "auto");
      }
    }
  });
}

export async function initRenderer(): Promise<void> {
  if (initialized) return;

  md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (str, lang) => {
      if (lang && lang !== "mermaid" && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value;
        } catch {}
      }
      try {
        return hljs.highlightAuto(str).value;
      } catch {}
      return "";
    },
  });

  md.use(texmath, {
    engine: katex,
    delimiters: "dollars",
  });

  md.use(taskLists, { enabled: false, label: true });
  md.use(anchor, {
    permalink: false,
    slugify: (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-"),
  });
  addSourceLinePlugin(md);
  addDirAutoPlugin(md);

  initialized = true;
}

export function render(markdown: string, baseDir?: string): string {
  return renderFull(markdown, baseDir).html;
}

export function renderFull(markdown: string, baseDir?: string): RenderResult {
  if (!md) {
    // Auto-init synchronously if not yet initialized
    md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (str, lang) => {
      if (lang && lang !== "mermaid" && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value;
        } catch {}
      }
      try {
        return hljs.highlightAuto(str).value;
      } catch {}
      return "";
    },
  });
    md.use(texmath, { engine: katex, delimiters: "dollars" });
    md.use(taskLists, { enabled: false, label: true });
    md.use(anchor, {
      permalink: false,
      slugify: (s: string) => s.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-"),
    });
    addSourceLinePlugin(md);
    addDirAutoPlugin(md);
    initialized = true;
  }

  // Extract frontmatter
  let content = markdown;
  let frontmatter: Record<string, unknown> | null = null;
  const fmMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    try {
      const data: Record<string, unknown> = {};
      fmMatch[1].split("\n").forEach((line) => {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let val: unknown = line.slice(colonIdx + 1).trim();
          if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
            val = val.slice(1, -1).split(",").map((s) => s.trim());
          }
          if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
            val = val.slice(1, -1);
          }
          if (key) data[key] = val;
        }
      });
      if (Object.keys(data).length > 0) {
        frontmatter = data;
        content = fmMatch[2];
      }
    } catch {
      // Not valid frontmatter
    }
  }

  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;

  const raw = md.render(content);
  let html = DOMPurify.sanitize(raw, {
    ADD_TAGS: [
      "pre", "code", "math", "mrow", "mi", "mo", "mn", "msup", "msub",
      "mfrac", "mover", "munder", "msqrt", "mtable", "mtr", "mtd",
      "annotation", "semantics", "mspace", "mtext", "mpadded",
      "svg", "path", "line", "rect", "circle", "g", "text", "defs",
      "marker", "polygon", "polyline", "foreignObject",
    ],
    ADD_ATTR: [
      "class", "style", "xmlns", "viewBox", "d", "fill", "stroke",
      "stroke-width", "transform", "x", "y", "width", "height",
      "text-anchor", "dominant-baseline", "font-size", "font-family",
      "marker-end", "id", "aria-hidden", "focusable", "role",
      "mathvariant", "encoding",
    ],
  });

  const assetPaths: string[] = [];
  if (baseDir) {
    html = resolveRelativeImages(html, baseDir, assetPaths);
  }

  return { html, frontmatter, wordCount, assetPaths, isMarp: isMarpDoc(frontmatter) };
}

function resolveRelativeImages(html: string, baseDir: string, collected: string[]): string {
  return html.replace(
    /(<img\s[^>]*?\bsrc=")(?!https?:\/\/|data:|blob:|asset:|file:)([^"]+)(")/gi,
    (_match, before, src, after) => {
      const imagePath = resolveLocalPath(src, baseDir);
      try {
        const url = `${before}${convertFileSrc(imagePath)}${after}`;
        collected.push(imagePath);
        return url;
      } catch {
        return `${before}${src}${after}`;
      }
    }
  ).replace(
    /(<(?:img|source)\s[^>]*?\bsrcset=")([^"]+)(")/gi,
    (_match, before, srcset, after) => `${before}${resolveSrcset(srcset, baseDir, collected)}${after}`
  );
}

function resolveSrcset(srcset: string, baseDir: string, collected: string[]): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return trimmed;

      const [src, ...descriptor] = trimmed.split(/\s+/);
      if (isExternalSrc(src)) return trimmed;

      try {
        const imagePath = resolveLocalPath(src, baseDir);
        const converted = convertFileSrc(imagePath);
        collected.push(imagePath);
        return [converted, ...descriptor].join(" ");
      } catch {
        return trimmed;
      }
    })
    .join(", ");
}

function isExternalSrc(src: string): boolean {
  return /^(?:https?:\/\/|data:|blob:|asset:|file:)/i.test(src);
}
/**
 * Resolve a local path (image src or markdown link href) against `baseDir`.
 * Decodes `%20`, passes absolute/Windows paths through, and normalizes `./`,
 * `../`, and mixed separators. Shared by image rendering and local-file links
 * (issue #30) so there's a single resolution implementation.
 */
export function resolveLocalPath(src: string, baseDir: string): string {
  const decodedSrc = decodeImageSrc(src);
  if (isAbsolutePath(decodedSrc)) return decodedSrc;
  return normalizePath(`${baseDir}/${decodedSrc}`);
}

function decodeImageSrc(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function normalizePath(path: string): string {
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const separator = isWindowsPath ? "\\" : "/";
  const normalized = path.replace(/[\\/]+/g, separator);
  const prefix = normalized.startsWith(separator) ? separator : "";
  const parts = normalized.split(separator);
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === ".." && stack.length > 0 && stack[stack.length - 1] !== "..") {
      stack.pop();
    } else if (part !== ".." || !prefix) {
      stack.push(part);
    }
  }

  return `${prefix}${stack.join(separator)}`;
}

export function isInitialized(): boolean {
  return initialized;
}
