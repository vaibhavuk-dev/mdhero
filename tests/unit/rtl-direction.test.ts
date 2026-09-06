import { describe, it, expect, vi } from "vitest";

// The unit env is node (no DOM), so DOMPurify can't run. It only sanitizes —
// the dir="auto" stamping happens in the markdown-it layer before it — so we
// stub it as a passthrough and assert the stamping itself. `dir` surviving
// sanitization (a standard global attr in DOMPurify's default allowlist) is
// covered by running the real app.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

const { render } = await import("../../src/lib/renderer/pipeline");

// #64: RTL sections (Hebrew/Arabic) rendered left-aligned because the pipeline
// emitted no direction info. Each text-bearing block now carries dir="auto" so
// the browser picks its base direction per block — LTR and RTL coexist in one
// document, matching VSCode.
describe("dir=auto for bidirectional text", () => {
  it("stamps dir=auto on paragraphs and headings", () => {
    const html = render("# חלק השלישי\n\nזהו החלק השלישי.");
    // Other attrs (id, data-source-line) may precede dir, so match loosely.
    expect(html).toMatch(/<h1[^>]*\bdir="auto"/);
    expect(html).toMatch(/<p[^>]*\bdir="auto"/);
  });

  it("stamps dir=auto on list items", () => {
    const html = render("- פריט אחד\n- פריט שתיים");
    expect(html).toContain('<li dir="auto"');
  });

  it("stamps dir=auto on table cells", () => {
    const html = render("| a | b |\n|---|---|\n| ג | ד |");
    expect(html).toContain('<th dir="auto"');
    expect(html).toContain('<td dir="auto"');
  });

  it("leaves code blocks LTR (no dir on pre/code)", () => {
    const html = render("```\nconst x = 1;\n```");
    expect(html).not.toContain('<pre dir="auto"');
    expect(html).not.toContain('<code dir="auto"');
  });
});

// #95: RTL authors wrap sections in `<div dir="rtl">` … `</div>` the way GitHub
// renders them. Raw HTML stays off, so the renderer recognises exactly those
// wrapper lines, drops them, and gives every block inside the explicit
// direction — which also fixes what dir="auto" gets wrong on its own.
describe("<div dir> wrapper lines (#95)", () => {
  it("drops the wrapper lines and stamps the explicit direction inside", () => {
    const html = render('<div dir="rtl">\n\n# سلام\n\nمتن.\n\n</div>\n\nAfter.');
    expect(html).not.toContain("&lt;div");
    expect(html).not.toContain("&lt;/div&gt;");
    expect(html).toMatch(/<h1[^>]*\bdir="rtl"/);
    expect(html).toMatch(/<p[^>]*\bdir="rtl"[^>]*>متن\./);
    expect(html).toMatch(/<p[^>]*\bdir="auto"[^>]*>After\./);
  });

  it("tolerates other attributes in any order, as the reporter writes it", () => {
    const a = render('<div dir="rtl" align="right">\n\nمتن.\n\n</div>');
    const b = render("<div align='right' dir='rtl'>\n\nمتن.\n\n</div>");
    for (const html of [a, b]) {
      expect(html).not.toContain("&lt;div");
      expect(html).toMatch(/<p[^>]*\bdir="rtl"/);
    }
  });

  it("forces RTL on a paragraph that begins with a Latin word, which auto gets wrong", () => {
    const html = render('<div dir="rtl">\n\nWindows 11 در این نسخه پشتیبانی می‌شود.\n\n</div>');
    expect(html).toMatch(/<p[^>]*\bdir="rtl"[^>]*>Windows 11/);
  });

  it("applies to lists and table cells inside the wrapper", () => {
    const html = render('<div dir="rtl">\n\n- یک\n\n| ستون |\n|---|\n| یک |\n\n</div>');
    expect(html).toContain('<li dir="rtl"');
    expect(html).toContain('<th dir="rtl"');
    expect(html).toContain('<td dir="rtl"');
  });

  it("supports ltr wrappers and nesting, popping back to the outer direction", () => {
    const html = render('<div dir="rtl">\n\nاول\n\n<div dir="ltr">\n\nEnglish inside.\n\n</div>\n\nدوم\n\n</div>');
    expect(html).toMatch(/<p[^>]*\bdir="rtl"[^>]*>اول/);
    expect(html).toMatch(/<p[^>]*\bdir="ltr"[^>]*>English inside\./);
    expect(html).toMatch(/<p[^>]*\bdir="rtl"[^>]*>دوم/);
  });

  it("leaves a stray </div> and any other tag as text", () => {
    expect(render("</div>")).toContain("&lt;/div&gt;");
    expect(render('<div class="x">\n\nمتن.\n\n</div>')).toContain("&lt;div");
    expect(render('<span dir="rtl">\n\nمتن.\n\n</span>')).toContain("&lt;span");
  });

  it("leaves code blocks LTR even inside an rtl wrapper", () => {
    const html = render('<div dir="rtl">\n\n```\nconst x = 1;\n```\n\n</div>');
    expect(html).not.toContain('<pre dir=');
    expect(html).not.toContain('<code dir=');
    expect(html).toContain("<pre><code>");
  });
});
