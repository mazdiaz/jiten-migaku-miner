interface Leaf {
  pos: number;
  node: Text;
  offset: number;
}

interface VisibleText {
  leaves: Leaf[];
  text: string;
}

function isSkipTag(tag: string): boolean {
  return tag === "RT" || tag === "RP" || tag === "SCRIPT" || tag === "STYLE";
}

function isMigakuSpacer(element: Element): boolean {
  return /migaku-spacer/.test(element.className || "");
}

function collectVisibleText(root: Element): VisibleText {
  const leaves: Leaf[] = [];
  let text = "";
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (parent === null || isMigakuSpacer(parent)) return;
      for (let index = 0; index < textNode.data.length; index += 1) {
        const char = textNode.data[index];
        if (char === "​") continue;
        leaves.push({ pos: text.length, node: textNode, offset: index });
        text += char;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (isSkipTag(element.tagName)) return;
    for (const child of element.childNodes) visit(child);
  };
  visit(root);
  return { leaves, text };
}

function unwrapThWraps(sentence: Element): void {
  for (const element of [...sentence.querySelectorAll("span.th-wrap, .th-live")]) {
    if (element.classList.contains("th-wrap")) {
      const parent = element.parentNode;
      if (parent !== null) {
        while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
        parent.removeChild(element);
        parent.normalize();
      }
    } else {
      element.classList.remove("th-live", "th-first", "th-last");
    }
  }
}

function isParsedSentence(sentence: Element): boolean {
  return [...sentence.querySelectorAll("span, a, ruby, b")].some((element) =>
    !element.className || !/(target-highlight|th-run|th-wrap|th-live)/.test(element.className),
  );
}

function markSentence(sentence: Element, surface: string, word: string): void {
  unwrapThWraps(sentence);
  if (!isParsedSentence(sentence)) return;

  const { leaves, text } = collectVisibleText(sentence);
  let index = text.indexOf(surface);
  let target = surface;
  if (index === -1 && word) {
    let stem = "";
    const max = Math.min(surface.length, word.length);
    for (let position = 0; position < max && surface[position] === word[position]; position += 1) {
      stem += surface[position];
    }
    if (stem.length >= 2) {
      index = text.indexOf(stem);
      target = stem;
    }
  }
  if (index === -1) {
    sentence.querySelector(".target-highlight")?.classList.add("th-live");
    return;
  }

  const end = index + target.length;
  const marked: HTMLElement[] = [];
  const push = (element: HTMLElement): void => {
    if (!marked.includes(element)) marked.push(element);
  };

  const inRange = leaves.filter((leaf) => leaf.pos >= index && leaf.pos < end);
  const byNode = new Map<Text, { node: Text; first: number; last: number }>();
  for (const leaf of inRange) {
    let record = byNode.get(leaf.node);
    if (record === undefined) {
      record = { node: leaf.node, first: leaf.offset, last: leaf.offset };
      byNode.set(leaf.node, record);
    }
    record.first = Math.min(record.first, leaf.offset);
    record.last = Math.max(record.last, leaf.offset);
  }
  for (const record of byNode.values()) {
    try {
      const range = document.createRange();
      range.setStart(record.node, record.first);
      range.setEnd(record.node, record.last + 1);
      const wrapper = document.createElement("span");
      wrapper.className = "th-wrap";
      range.surroundContents(wrapper);
      push(wrapper);
    } catch {
      // Ranges that cross element boundaries cannot be wrapped; partial coverage is acceptable.
    }
  }

  if (marked.length === 1) {
    marked[0]?.classList.add("th-first", "th-last");
  } else if (marked.length > 1) {
    marked[0]?.classList.add("th-first");
    marked[marked.length - 1]?.classList.add("th-last");
  }
}

export interface HighlightAdapter {
  reconcile(root: Element): void;
  destroy(): void;
}

export function createHighlightAdapter(root: Element): HighlightAdapter {
  let frame: number | null = null;
  let suppressCount = 0;
  let disposed = false;

  const reconcileRoot = (target: Element): void => {
    if (disposed) return;
    suppressCount += 1;
    try {
      for (const sentence of [...target.querySelectorAll<HTMLElement>(".sentence[data-surface]")]) {
        markSentence(sentence, sentence.dataset.surface ?? "", sentence.dataset.word ?? "");
      }
    } finally {
      queueMicrotask(() => {
        suppressCount -= 1;
      });
    }
  };

  const observer = new MutationObserver(() => {
    if (disposed || suppressCount > 0) return;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      reconcileRoot(root);
    });
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  return {
    reconcile(target: Element): void {
      reconcileRoot(target);
    },
    destroy(): void {
      disposed = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      observer.disconnect();
    },
  };
}
