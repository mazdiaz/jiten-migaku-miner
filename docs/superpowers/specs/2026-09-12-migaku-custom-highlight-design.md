# Migaku Custom Highlight Compatibility Design

## Goal

Make Jiten Migaku Miner's target-word highlighting coexist reliably with Migaku Full Power parsing, including Review mode, without inserting Jiten wrapper elements into Migaku's rewritten sentence DOM.

## Problem

Migaku Full Power rewrites Japanese sentence markup into spans, ruby, helper nodes, and other parser-owned elements. The existing highlight adapter reconstructs visible text correctly, but its final step calls `Range.surroundContents()` and inserts Jiten-owned `span.th-wrap` wrappers inside the Migaku-owned DOM. This can paint helper/layout nodes and produce detached-looking highlight rectangles even though lookup and `Q` instant mining still work.

The compatibility boundary should therefore be: Migaku owns sentence markup; Jiten observes the resulting visible text and paints a highlight without mutating that markup.

## Design

### Primary rendering path: CSS Custom Highlight API

When the browser exposes the CSS Custom Highlight API, the adapter shall:

1. Observe the existing results/review surface exactly as today.
2. Reconstruct visible sentence text while ignoring ruby readings (`rt`/`rp`), scripts/styles, zero-width spaces, and Migaku spacer elements.
3. Locate the configured target surface and occurrence using the existing surface-index and shared-stem fallback behavior.
4. Build `Range` objects over the existing text nodes instead of wrapping those nodes.
5. Reject a candidate range when browser layout information proves that it has no visible rendered geometry inside the sentence bounds.
6. Register all valid ranges in a named CSS highlight, `jiten-target`.
7. Rebuild the named highlight after observed DOM mutations so stale ranges are never retained after Migaku reparses a sentence.

The visual style shall be applied with `::highlight(jiten-target)` and preserve the current yellow target-highlight appearance.

### Geometry guard

The adapter shall use `Range.getClientRects()` when the browser provides layout data. A range is valid when at least one non-zero client rect intersects the sentence's client rect. This prevents helper text that exists in the DOM but does not render as visible glyphs from receiving the Jiten highlight.

Environments without layout information, such as Happy DOM tests, shall not reject ranges solely because geometry APIs are missing or return no usable sentence box.

### Legacy fallback

If the CSS Custom Highlight API is unavailable, keep the current `th-wrap` wrapper behavior as a compatibility fallback. The fallback is not the preferred path and should remain isolated so modern browsers never mutate Migaku-owned text for Jiten highlighting.

### Cleanup

Every reconciliation shall replace the previous `jiten-target` highlight with ranges built against the current DOM. `destroy()` shall remove the named highlight, cancel scheduled animation frames, and disconnect the observer.

### Migaku independence

Do not call undocumented Migaku extension APIs and do not depend on Migaku token class names. Existing special handling for `migaku-spacer` remains because it is already part of the miner's compatibility layer, but the primary algorithm is based on visible text and browser ranges.

Review mode continues to reuse the same `#resultsList` surface introduced by PR #3. `Q`, click lookup, Migaku colors, and furigana remain fully owned by Migaku.

## CSS behavior

Modern path:

```css
::highlight(jiten-target) {
  background-color: rgba(255, 255, 0, 0.22);
}

body.hl-pill ::highlight(jiten-target) {
  background-color: rgba(139, 167, 255, 0.1);
  text-decoration: underline rgba(139, 167, 255, 0.55);
}
```

The legacy `.th-wrap` and `.th-live` styles remain for unsupported browsers and the existing surface-not-found fallback.

## Testing

Unit tests shall provide a fake Highlight registry/constructor and verify that:

- parsed Migaku-like text creates ranges but no `th-wrap` elements;
- targets split across text nodes produce multiple registered ranges;
- ruby readings, Migaku spacers, and zero-width spaces are excluded;
- repeated occurrences honor `data-surface-index`;
- mutations replace stale highlights;
- destroy deletes the named highlight;
- absence of Custom Highlight support falls back to existing wrappers;
- suspicious zero-geometry ranges are excluded when real geometry data is supplied.

Existing Review-mode tests remain responsible for proving the shared Migaku-facing results surface and that `Q` is not consumed by Jiten Miner.

## Non-goals

- Reimplementing Migaku's parser.
- Depending on undocumented Migaku token markup.
- Triggering or controlling Migaku card creation.
- Changing decision/review workflow behavior.
- Removing legacy fallback support in this change.
