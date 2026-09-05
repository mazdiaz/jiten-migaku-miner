// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createHighlightAdapter } from "../../src/ui/highlight-adapter";

function text(value: string): Text {
  return document.createTextNode(value);
}

function sentence(surface: string, word: string, children: Node[]): HTMLElement {
  const p = document.createElement("p");
  p.className = "sentence";
  p.dataset.surface = surface;
  p.dataset.word = word;
  for (const child of children) p.appendChild(child);
  return p;
}

function targetSpan(content: Node | string): HTMLElement {
  const span = document.createElement("span");
  span.className = "target-highlight";
  if (typeof content === "string") span.textContent = content;
  else span.appendChild(content);
  return span;
}

function plain(value: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function flushFrames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await nextFrame();
}

describe("highlight adapter", () => {
  it("wraps a target that spans multiple text nodes with first/last classes", () => {
    const root = document.createElement("div");
    const node = sentence("気になる", "気になる", [
      plain("彼は"),
      targetSpan(text("気にな")),
      text("る"),
      text("。"),
    ]);
    root.appendChild(node);
    const adapter = createHighlightAdapter(root);

    adapter.reconcile(root);

    const wrappers = node.querySelectorAll("span.th-wrap");
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]?.classList.contains("th-first")).toBe(true);
    expect(wrappers[0]?.textContent).toBe("気にな");
    expect(wrappers[1]?.classList.contains("th-last")).toBe(true);
    expect(wrappers[1]?.textContent).toBe("る");
    expect(node.textContent).toBe("彼は気になる。");
    adapter.destroy();
  });

  it("skips visible text inside RT, RP, SCRIPT, STYLE, migaku spacers, and zero-width spaces", () => {
    const root = document.createElement("div");
    const ruby = document.createElement("ruby");
    const rb = document.createElement("rb");
    rb.textContent = "気";
    const rt = document.createElement("rt");
    rt.textContent = "き";
    ruby.append(rb, rt);
    const spacer = document.createElement("span");
    spacer.className = "migaku-spacer";
    spacer.textContent = "-";
    const script = document.createElement("script");
    script.textContent = "気になる";
    const style = document.createElement("style");
    style.textContent = "気になる";
    const rp = document.createElement("rp");
    rp.textContent = "気になる";
    const node = sentence("気になる", "気になる", [
      ruby,
      text("に​な​る"),
      spacer,
      script,
      style,
      rp,
    ]);
    root.appendChild(node);
    const adapter = createHighlightAdapter(root);

    adapter.reconcile(root);

    const wrappers = [...node.querySelectorAll("span.th-wrap")];
    const wrapped = wrappers.map((wrapper) => wrapper.textContent).join("");
    expect(wrapped.replace(/​/gu, "")).toBe("気になる");
    expect(wrappers.some((wrapper) => wrapper.querySelector("rt"))).toBe(false);
    adapter.destroy();
  });

  it("leaves fully parsed sentences untouched", () => {
    const root = document.createElement("div");
    const node = sentence("気になる", "気になる", [targetSpan("気になる")]);
    root.appendChild(node);
    const adapter = createHighlightAdapter(root);

    adapter.reconcile(root);

    expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
    expect(node.querySelector(".target-highlight")).not.toBeNull();
    adapter.destroy();
  });

  it("uses live fallback when the surface cannot be found", () => {
    const root = document.createElement("div");
    const span = targetSpan("別の語");
    const node = sentence("気になる", "気になる", [plain("全然違う文章です。"), span]);
    root.appendChild(node);
    const adapter = createHighlightAdapter(root);

    adapter.reconcile(root);

    expect(span.classList.contains("th-live")).toBe(true);
    expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
    adapter.destroy();
  });

  it("falls back to a shared stem between surface and word", () => {
    const root = document.createElement("div");
    const node = sentence("気になる", "気に", [plain("今日は気に障る。")]);
    root.appendChild(node);
    const adapter = createHighlightAdapter(root);

    adapter.reconcile(root);

    const wrappers = [...node.querySelectorAll("span.th-wrap")];
    expect(wrappers.map((wrapper) => wrapper.textContent).join("")).toBe("気に");
    adapter.destroy();
  });

  it("repeated reconciliation does not nest wrappers or duplicate classes", () => {
    const root = document.createElement("div");
    const node = sentence("気になる", "気になる", [
      plain("彼は"),
      targetSpan(text("気にな")),
      text("る"),
    ]);
    root.appendChild(node);
    const adapter = createHighlightAdapter(root);

    adapter.reconcile(root);
    adapter.reconcile(root);
    adapter.reconcile(root);

    const wrappers = [...node.querySelectorAll("span.th-wrap")];
    expect(wrappers.filter((wrapper) => wrapper.parentElement?.classList.contains("th-wrap"))).toHaveLength(0);
    expect(wrappers).toHaveLength(2);
    expect(node.textContent).toBe("彼は気になる");
    adapter.destroy();
  });

  it("reconciles observed mutations through a batched animation frame", async () => {
    const root = document.createElement("div");
    const adapter = createHighlightAdapter(root);

    const node = sentence("気になる", "気になる", [
      plain("彼は"),
      targetSpan(text("気にな")),
      text("る"),
    ]);
    root.appendChild(node);
    await flushFrames();

    expect(node.querySelectorAll("span.th-wrap")).toHaveLength(2);
    adapter.destroy();
  });

  it("destroy cancels scheduled work and disconnects the observer", async () => {
    const root = document.createElement("div");
    const adapter = createHighlightAdapter(root);
    adapter.destroy();

    const node = sentence("気になる", "気になる", [
      plain("彼は"),
      targetSpan(text("気にな")),
      text("る"),
    ]);
    root.appendChild(node);
    await flushFrames();

    expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
  });

  it("destroy cancels an already scheduled animation frame", async () => {
    const root = document.createElement("div");
    const adapter = createHighlightAdapter(root);
    const node = sentence("気になる", "気になる", [
      plain("彼は"),
      targetSpan(text("気にな")),
      text("る"),
    ]);
    root.appendChild(node);
    await Promise.resolve();
    adapter.destroy();
    await flushFrames();

    expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
  });
});
