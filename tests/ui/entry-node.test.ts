// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { renderEntryNode, renderReviewEntryNode } from "../../src/ui/renderer";
import { createInitialAppState } from "../../src/app/state";
import type { EntryWithKnown } from "../../src/domain/types";

function makeEntry(overrides: Partial<EntryWithKnown> = {}): EntryWithKnown {
  return {
    id: "entry-1",
    originalIndex: 0,
    word: "言葉",
    normalizedWord: "言葉",
    occurrences: 3,
    sentenceRaw: "**言葉**が好き。",
    hasSentence: true,
    definitions: "word, term, expression, phrase",
    furiganaRuns: [],
    known: false,
    knownByMigaku: false,
    knownByDecision: false,
    decision: "unreviewed",
    ...overrides,
  };
}

const view = createInitialAppState("memory").view;

const childClasses = (article: HTMLElement): string[] =>
  [...article.children].map((child) => (child as HTMLElement).className);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderEntryNode structure", () => {
  it("orders entry children header, sentence, definitions, actions", () => {
    const article = renderEntryNode(makeEntry(), 1, view);
    const classes = childClasses(article);
    const indexes = [
      classes.findIndex((name) => name.includes("entry-header")),
      classes.findIndex((name) => name.includes("sentence")),
      classes.findIndex((name) => name.includes("entry-definitions")),
      classes.findIndex((name) => name.includes("entry-actions")),
    ];
    for (const index of indexes) expect(index).toBeGreaterThanOrEqual(0);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(classes[0]).toBe("entry-header");
    expect(classes[classes.length - 1]).toBe("entry-actions");
  });

  it("skips the definitions node when hidden or absent", () => {
    const hidden = renderEntryNode(makeEntry(), 1, { ...view, showDefinitions: false });
    expect(hidden.querySelector(".entry-definitions")).toBeNull();

    const bare = renderEntryNode(
      makeEntry({ definitions: "", hasSentence: false, sentenceRaw: "" }),
      1,
      view,
    );
    expect(bare.querySelector(".entry-definitions")).toBeNull();
    expect(bare.querySelector(".sentence")).toBeNull();
    expect(childClasses(bare).join(" ")).toBe("entry-header entry-actions");
  });

  it("merges decisions and the queue toggle into one toolbar", () => {
    const article = renderEntryNode(makeEntry(), 1, view);
    const toolbars = [...article.querySelectorAll<HTMLElement>(".entry-actions")];
    expect(toolbars).toHaveLength(1);

    const actions = article.querySelector<HTMLElement>(".entry-actions")!;
    expect(actions.getAttribute("role")).toBe("toolbar");
    expect(actions.getAttribute("aria-label")).toBe("Actions for 言葉");
    expect(article.querySelectorAll(".entry-decision")).toHaveLength(0);
    expect(article.querySelectorAll(".entry-queue")).toHaveLength(0);

    const decisions = [...actions.querySelectorAll<HTMLButtonElement>("[data-decision-action]")];
    expect(decisions.map((button) => button.dataset.decisionAction)).toEqual([
      "known",
      "mined",
      "skip",
      "later",
      "unreviewed",
    ]);
    for (const button of decisions) {
      expect(button.dataset.word).toBe("言葉");
    }
    for (const status of ["known", "mined", "skip", "later"]) {
      expect(actions.querySelector(`[data-decision-action='${status}']`)?.getAttribute("aria-pressed")).toBe("false");
    }
    const reset = actions.querySelector<HTMLButtonElement>("[data-decision-action='unreviewed']");
    expect(reset?.getAttribute("aria-pressed")).toBeNull();
    expect(reset?.disabled).toBe(true);

    const toggle = actions.querySelector<HTMLButtonElement>("[data-queue-action='toggle']");
    expect(toggle).not.toBeNull();
    expect(toggle?.dataset.word).toBe("言葉");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders the pressed queue toggle inside the merged toolbar", () => {
    const article = renderEntryNode(makeEntry(), 1, view, { queued: true });
    const toggle = article.querySelector<HTMLButtonElement>(".entry-actions [data-queue-action='toggle']");
    expect(toggle?.textContent).toBe("✓ Queued");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps pressed decision state on the merged buttons", () => {
    const article = renderEntryNode(makeEntry({ decision: "mined" }), 1, view);
    const pressed = article.querySelector<HTMLButtonElement>(".entry-actions [data-decision-action='mined']");
    expect(pressed?.getAttribute("aria-pressed")).toBe("true");
    const reset = article.querySelector<HTMLButtonElement>(".entry-actions [data-decision-action='unreviewed']");
    expect(reset?.disabled).toBe(false);
  });

  it("uses one actions toolbar in queue mode with remove and no toggle", () => {
    const article = renderEntryNode(makeEntry(), 1, view, { queueMode: true });
    const toolbars = [...article.querySelectorAll<HTMLElement>(".entry-actions")];
    expect(toolbars).toHaveLength(1);

    const actions = article.querySelector<HTMLElement>(".entry-actions")!;
    expect(actions.getAttribute("role")).toBe("toolbar");
    expect(actions.getAttribute("aria-label")).toBe("Actions for 言葉");
    expect(actions.querySelector("[data-queue-action='toggle']")).toBeNull();

    const decisions = [...actions.querySelectorAll<HTMLButtonElement>("[data-decision-action]")];
    expect(decisions.map((button) => button.dataset.decisionAction)).toEqual([
      "known",
      "mined",
      "skip",
      "later",
    ]);
    const remove = actions.querySelector<HTMLButtonElement>("[data-queue-action='remove']");
    expect(remove).not.toBeNull();
    expect(remove?.dataset.word).toBe("言葉");
    expect(remove?.classList.contains("queue-remove")).toBe(true);
  });

  it("keeps badges in the header and definitions out of it", () => {
    const article = renderEntryNode(
      makeEntry({ knownByMigaku: true, decision: "mined" }),
      1,
      view,
    );
    const header = article.querySelector<HTMLElement>(".entry-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector(".entry-badge-migaku")?.textContent).toBe("Migaku known");
    expect(header?.querySelector(".entry-badge-decision")?.textContent).toBe("Mined");
    expect(header?.querySelector(".entry-definitions")).toBeNull();
    expect(article.querySelector(".entry-definitions")).not.toBeNull();
  });

  it("keeps definition truncation with a title fallback", () => {
    const article = renderEntryNode(makeEntry(), 1, view);
    const definitions = article.querySelector<HTMLElement>(".entry-definitions");
    expect(definitions?.textContent).toBe("word, term, expression, …");
    expect(definitions?.getAttribute("title")).toBe("word, term, expression, phrase");
  });
});

describe("renderReviewEntryNode structure", () => {
  it("orders review children header, sentence, definitions with no actions", () => {
    const article = renderReviewEntryNode(makeEntry(), view);
    const classes = childClasses(article);
    expect(classes.join(" ")).toBe("entry-header sentence entry-definitions");
    expect(article.querySelector(".entry-actions")).toBeNull();
    expect(article.querySelector(".entry-header .entry-number")).toBeNull();
  });
});
