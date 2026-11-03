import { describe, expect, it } from "vitest";

import { escapeHtml } from "../public/escape.js";

describe("escapeHtml", () => {
  it("neutralises markup in user-supplied strings", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(escapeHtml("<script>alert('x')</script>")).toBe("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  });

  it("cannot break out of a quoted attribute", () => {
    const html = `<input value="${escapeHtml(`" autofocus onfocus="alert(1)`)}" />`;
    expect(html).toBe(`<input value="&quot; autofocus onfocus=&quot;alert(1)" />`);
  });

  it("escapes ampersands first so entities are not double-decoded", () => {
    expect(escapeHtml("&lt;b&gt;")).toBe("&amp;lt;b&amp;gt;");
  });

  it("renders null/undefined as empty and stringifies other values", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml("SOL/USDC Bot")).toBe("SOL/USDC Bot");
  });
});
