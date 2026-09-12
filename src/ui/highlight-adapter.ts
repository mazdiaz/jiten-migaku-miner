interface Leaf {
  pos: number;
  node: Text;
  offset: number;
}

interface VisibleText {
  leaves: Leaf[];
  text: string;
}

interface TextSegment {
  node: Text;
  first: number;
  last: number;
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): boolean;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

interface CustomHighlightApi {
  Highlight: HighlightConstructor;
  registry: HighlightRegistryLike;
}

interface HighlightRealm {
  Highlight?: unknown;
  CSS?: { highlights?: unknown };
}

const JITEN_HIGHLIGHT_NAME = "jiten-target";

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
  return [...sentence.querySelectorAll("span, a, ruby, b")].some(
    (element) =>
      !element.className || !/(target-highlight|th-run|th-wrap|th-live)/.test(element.className),
  );
}

function findTargetSegments(
  sentence: HTMLElement,
  surface: string,
  word: string,
): TextSegment[] | null {
  const { leaves, text } = collectVisibleText(sentence);
  const ordinalRaw = Number(sentence.dataset.surfaceIndex ?? 0);
  const ordinal = Number.isFinite(ordinalRaw) ? ordinalRaw : 0;
  let index = -1;

  if (surface) {
    let cursor = text.indexOf(surface);
    let seen = 0;
    while (cursor !== -1) {
      if (seen === ordinal) {
        index = cursor;
        break;
      }
      seen += 1;
      cursor = text.indexOf(surface, cursor + 1);
    }
    // Defensive: fewer occurrences than the ordinal asks for -> first match.
    if (index === -1 && seen > 0) index = text.indexOf(surface);
  }

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

  if (index === -1) return null;

  const end = index + target.length;
  const inRange = leaves.filter((leaf) => leaf.pos >= index && leaf.pos < end);
  const byNode = new Map<Text, TextSegment>();
  for (const leaf of inRange) {
    let segment = byNode.get(leaf.node);
    if (segment === undefined) {
      segment = { node: leaf.node, first: leaf.offset, last: leaf.offset };
      byNode.set(leaf.node, segment);
    }
    segment.first = Math.min(segment.first, leaf.offset);
    segment.last = Math.max(segment.last, leaf.offset);
  }
  return [...byNode.values()];
}

function createRange(segment: TextSegment): Range | null {
  try {
    const ownerDocument = segment.node.ownerDocument ?? document;
    const range = ownerDocument.createRange();
    range.setStart(segment.node, segment.first);
    range.setEnd(segment.node, segment.last + 1);
    return range;
  } catch {
    return null;
  }
}

function hasMeaningfulBox(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function isVisibleRange(range: Range, sentence: HTMLElement): boolean {
  const sentenceRect = sentence.getBoundingClientRect();
  // DOM-only test environments do not provide layout. In that case, avoid
  // treating missing geometry as proof that otherwise valid text is hidden.
  if (!hasMeaningfulBox(sentenceRect)) return true;

  const getClientRects = (range as Range & { getClientRects?: () => DOMRectList }).getClientRects;
  if (typeof getClientRects !== "function") return true;

  let rects: DOMRectList;
  try {
    rects = getClientRects.call(range);
  } catch {
    return true;
  }

  for (const rect of Array.from(rects)) {
    if (hasMeaningfulBox(rect) && intersects(rect, sentenceRect)) return true;
  }
  return false;
}

function renderLegacySegments(segments: TextSegment[]): void {
  const marked: HTMLElement[] = [];
  for (const segment of segments) {
    const range = createRange(segment);
    if (range === null) continue;
    try {
      const wrapper = document.createElement("span");
      wrapper.className = "th-wrap";
      range.surroundContents(wrapper);
      marked.push(wrapper);
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

function getCustomHighlightApi(root: Element): CustomHighlightApi | null {
  const view = root.ownerDocument.defaultView as unknown as HighlightRealm | null;
  const globalRealm = globalThis as unknown as HighlightRealm;
  const Highlight = view?.Highlight ?? globalRealm.Highlight;
  // Browsers expose CSS on the document window. Some DOM/test realms expose
  // Highlight there but keep CSS on the global object, so use a safe fallback.
  const registry = (view?.CSS?.highlights ?? globalRealm.CSS?.highlights) as
    | Partial<HighlightRegistryLike>
    | undefined;
  if (
    typeof Highlight !== "function" ||
    registry === undefined ||
    typeof registry.set !== "function" ||
    typeof registry.delete !== "function"
  ) {
    return null;
  }
  return {
    Highlight: Highlight as HighlightConstructor,
    registry: registry as HighlightRegistryLike,
  };
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
      const customHighlight = getCustomHighlightApi(target);
      const ranges: Range[] = [];

      for (const sentence of [...target.querySelectorAll<HTMLElement>(".sentence[data-surface]")]) {
        unwrapThWraps(sentence);
        if (!isParsedSentence(sentence)) continue;

        const segments = findTargetSegments(
          sentence,
          sentence.dataset.surface ?? "",
          sentence.dataset.word ?? "",
        );
        if (segments === null) {
          sentence.querySelector(".target-highlight")?.classList.add("th-live");
          continue;
        }

        if (customHighlight === null) {
          renderLegacySegments(segments);
          continue;
        }

        for (const segment of segments) {
          const range = createRange(segment);
          if (range !== null && isVisibleRange(range, sentence)) ranges.push(range);
        }
      }

      if (customHighlight !== null) {
        customHighlight.registry.set(
          JITEN_HIGHLIGHT_NAME,
          new customHighlight.Highlight(...ranges),
        );
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
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

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
      getCustomHighlightApi(root)?.registry.delete(JITEN_HIGHLIGHT_NAME);
      observer.disconnect();
    },
  };
}
