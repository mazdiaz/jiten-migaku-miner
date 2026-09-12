// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createHighlightAdapter } from "../../src/ui/highlight-adapter";

interface FakeHighlightRecord {
  ranges: Range[];
}

function installFakeHighlightApi(): {
  registry: Map<string, FakeHighlightRecord>;
  restore(): void;
} {
  const registry = new Map<string, FakeHighlightRecord>();
  const oldHighlight = Object.getOwnPropertyDescriptor(globalThis, "Highlight");
  const oldRegistry = Object.getOwnPropertyDescriptor(CSS, "highlights");

  class FakeHighlight implements FakeHighlightRecord {
    ranges: Range[];

    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }

  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: FakeHighlight,
  });
  Object.defineProperty(CSS, "highlights", {
    configurable: true,
    writable: true,
    value: {
      set(name: string, highlight: FakeHighlightRecord) {
        registry.set(name, highlight);
        return this;
      },
      get(name: string) {
        return registry.get(name);
      },
      delete(name: string) {
        return registry.delete(name);
      },
    },
  });

  return {
    registry,
    restore() {
      if (oldHighlight === undefined) delete (globalThis as { Highlight?: unknown }).Highlight;
      else Object.defineProperty(globalThis, "Highlight", oldHighlight);
      if (oldRegistry === undefined) delete (CSS as { highlights?: unknown }).highlights;
      else Object.defineProperty(CSS, "highlights", oldRegistry);
    },
  };
}

function sentence(surface: string, word: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "sentence";
  node.dataset.surface = surface;
  node.dataset.word = word;

  const prefix = document.createElement("span");
  prefix.textContent = "彼は";
  const target = document.createElement("span");
  target.className = "target-highlight";
  target.appendChild(document.createTextNode("気にな"));
  node.append(prefix, target, document.createTextNode("る。"));
  return node;
}

function rangeText(range: Range): string {
  return range.toString().replaceAll("​", "");
}

describe("CSS Custom Highlight compatibility", () => {
  it("highlights parsed Migaku-like text without inserting th-wrap elements", () => {
    const fake = installFakeHighlightApi();
    try {
      const root = document.createElement("div");
      const node = sentence("気になる", "気になる");
      root.appendChild(node);
      const adapter = createHighlightAdapter(root);

      adapter.reconcile(root);

      expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
      const ranges = fake.registry.get("jiten-target")?.ranges ?? [];
      expect(ranges).toHaveLength(2);
      expect(ranges.map(rangeText).join("")).toBe("気になる");
      expect(node.textContent).toBe("彼は気になる。");
      adapter.destroy();
    } finally {
      fake.restore();
    }
  });

  it("replaces stale registered ranges on repeated reconciliation and clears them on destroy", () => {
    const fake = installFakeHighlightApi();
    try {
      const root = document.createElement("div");
      const node = sentence("気になる", "気になる");
      root.appendChild(node);
      const adapter = createHighlightAdapter(root);

      adapter.reconcile(root);
      const first = fake.registry.get("jiten-target");
      expect(first?.ranges.map(rangeText).join("")).toBe("気になる");

      node.dataset.surface = "彼";
      node.dataset.word = "彼";
      adapter.reconcile(root);
      const second = fake.registry.get("jiten-target");
      expect(second).not.toBe(first);
      expect(second?.ranges.map(rangeText).join("")).toBe("彼");

      adapter.destroy();
      expect(fake.registry.has("jiten-target")).toBe(false);
    } finally {
      fake.restore();
    }
  });

  it("still ignores ruby readings, Migaku spacers, and zero-width spaces", () => {
    const fake = installFakeHighlightApi();
    try {
      const root = document.createElement("div");
      const node = document.createElement("p");
      node.className = "sentence";
      node.dataset.surface = "気になる";
      node.dataset.word = "気になる";

      const ruby = document.createElement("ruby");
      const rb = document.createElement("rb");
      rb.textContent = "気";
      const rt = document.createElement("rt");
      rt.textContent = "き";
      ruby.append(rb, rt);
      const spacer = document.createElement("span");
      spacer.className = "migaku-spacer";
      spacer.textContent = "helper";
      node.append(ruby, document.createTextNode("に​な​る"), spacer);
      root.appendChild(node);
      const adapter = createHighlightAdapter(root);

      adapter.reconcile(root);

      const ranges = fake.registry.get("jiten-target")?.ranges ?? [];
      expect(ranges.map(rangeText).join("")).toBe("気になる");
      expect(ranges.map(rangeText).join("")).not.toContain("き");
      expect(ranges.map(rangeText).join("")).not.toContain("helper");
      expect(node.querySelectorAll("span.th-wrap")).toHaveLength(0);
      adapter.destroy();
    } finally {
      fake.restore();
    }
  });

  it("rejects a target when real layout data says its ranges have no visible geometry", () => {
    const fake = installFakeHighlightApi();
    const rangePrototype = Range.prototype as Range & {
      getClientRects?: () => DOMRectList;
    };
    const oldGetClientRects = Object.getOwnPropertyDescriptor(rangePrototype, "getClientRects");
    try {
      Object.defineProperty(rangePrototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
      const root = document.createElement("div");
      const node = sentence("気になる", "気になる");
      node.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 240,
          bottom: 80,
          width: 240,
          height: 80,
          toJSON: () => ({}),
        }) as DOMRect;
      root.appendChild(node);
      const adapter = createHighlightAdapter(root);

      adapter.reconcile(root);

      expect(fake.registry.get("jiten-target")?.ranges ?? []).toHaveLength(0);
      adapter.destroy();
    } finally {
      if (oldGetClientRects === undefined) Reflect.deleteProperty(rangePrototype, "getClientRects");
      else Object.defineProperty(rangePrototype, "getClientRects", oldGetClientRects);
      fake.restore();
    }
  });
});
