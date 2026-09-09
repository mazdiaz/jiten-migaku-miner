import { canonicalWord } from "../../domain/text";
import type { EntryWithKnown, QueryState } from "../../domain/types";
import { type ControllerCore, errorMessage } from "./context";

const VIEWPORT_WINDOW_SIZE = 100;
const QUEUE_SAFETY_THRESHOLD = 5_000;

function orderByQueue(
  items: readonly EntryWithKnown[],
  queue: readonly string[],
): EntryWithKnown[] {
  const order = new Map(queue.map((word, index) => [canonicalWord(word), index]));
  return [...items].sort(
    (left, right) =>
      (order.get(canonicalWord(left.normalizedWord)) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(canonicalWord(right.normalizedWord)) ?? Number.MAX_SAFE_INTEGER) ||
      left.originalIndex - right.originalIndex,
  );
}

/**
 * Owns the session mining queue: membership edits, Queue Mode entry/exit,
 * and the neutral-filter queue query. Queue Mode ignores the normal list's
 * filters (they are hidden in the queue UI): the queue query is neutral and
 * membership is constrained solely by includeNormalizedWords, with this
 * service applying queue insertion order afterwards.
 */
export class MiningQueueService {
  constructor(private readonly core: ControllerCore) {}

  beginDataset(datasetId: string): void {
    // A newly activated dataset starts with a fresh queue association.
    this.core.state.queue = { datasetId, normalizedWords: [], mode: "normal" };
    this.core.sessionQueue.clear();
  }

  restoreSnapshot(active: { id: string } | null): void {
    if (active === null) return;
    const snapshot = this.core.sessionQueue.load();
    const words =
      snapshot !== null && snapshot.datasetId === active.id ? [...snapshot.normalizedWords] : [];
    this.core.state.queue = { datasetId: active.id, normalizedWords: words, mode: "normal" };
  }

  setQueueWords(datasetId: string, words: string[]): void {
    this.core.state.queue = { ...this.core.state.queue, datasetId, normalizedWords: words };
    this.core.sessionQueue.save({ version: 1, datasetId, normalizedWords: words });
    this.core.publish();
    if (this.core.state.queue.mode === "queue") void this.runQueueQuery();
  }

  toggleQueued(normalizedWord: string): void {
    const dataset = this.core.state.dataset;
    if (dataset === null) return;
    const word = canonicalWord(normalizedWord);
    if (word.length === 0) return;
    const words = this.core.state.queue.normalizedWords;
    // Adding an already-queued word leaves the queue unchanged; removal is a
    // separate explicit action.
    if (words.includes(word)) return;
    this.setQueueWords(dataset.id, [...words, word]);
  }

  removeQueued(normalizedWord: string): void {
    const dataset = this.core.state.dataset;
    if (dataset === null) return;
    const word = canonicalWord(normalizedWord);
    this.setQueueWords(
      dataset.id,
      this.core.state.queue.normalizedWords.filter((queued) => queued !== word),
    );
  }

  clearQueue(): void {
    const dataset = this.core.state.dataset;
    if (dataset === null) return;
    this.setQueueWords(dataset.id, []);
  }

  async startQueueMode(): Promise<void> {
    const state = this.core.state;
    const dataset = state.dataset;
    if (dataset === null || state.queue.mode === "queue") return;
    // An empty queue cannot enter mining mode.
    if (state.queue.normalizedWords.length === 0) return;
    state.queue = { ...state.queue, mode: "queue" };
    this.core.publish();
    await this.runQueueQuery();
  }

  stopQueueMode(): void {
    if (this.core.state.queue.mode !== "queue") return;
    this.core.state.queue = { ...this.core.state.queue, mode: "normal" };
    this.core.publish();
    void this.core.runQuery();
  }

  /** Force-exit queue mode without requerying (restore path). */
  exitWithoutRequery(): void {
    const queue = this.core.state.queue;
    if (queue.mode !== "queue") return;
    this.core.state.queue = { ...queue, mode: "normal" };
  }

  async runQueueQuery(): Promise<void> {
    const state = this.core.state;
    const dataset = state.dataset;
    if (dataset === null || state.queue.mode !== "queue") return;
    const words = state.queue.normalizedWords;
    // Above the safety threshold keep worker paging / the virtual list; the
    // simple path mounts every queued entry ordered by time added.
    const bounded = words.length > QUEUE_SAFETY_THRESHOLD;
    // Queue Mode ignores the normal list's filters: the filter controls and
    // chips are hidden in queue mode, so any filter narrowing the query here
    // would invisibly hide queued words. The queue query is neutral and
    // membership is constrained solely by includeNormalizedWords, with the
    // UI applying queue insertion order afterwards (orderByQueue).
    const queueQuery: QueryState = {
      search: "",
      hideKnown: false,
      hideKanaOnly: false,
      sentence: "any",
      minOccurrences: 0,
      decision: "all",
      sort: "original",
      ...(bounded
        ? { pageSize: state.query.pageSize, page: Math.max(1, state.query.page) }
        : { pageSize: "all" as const, page: 1 }),
    };
    const window =
      bounded && state.query.pageSize === "all"
        ? { start: this.core.getViewportStart(), size: VIEWPORT_WINDOW_SIZE }
        : undefined;
    const generation = this.core.bumpQueryGeneration();
    try {
      const result = await this.core.worker.query({
        datasetId: dataset.id,
        knownWords: [...state.knownWords],
        decisions: this.core.decisionTuples(),
        includeNormalizedWords: [...words],
        query: queueQuery,
        queryChannel: "queue",
        ...(window === undefined ? {} : { window }),
      });
      if (generation !== this.core.getQueryGeneration() || state.queue.mode !== "queue") return;
      this.core.state.result = {
        ...result,
        items: bounded ? result.items : orderByQueue(result.items, words),
      };
      this.core.setState({ status: "ready", errorMessage: this.core.getWarningMessage() });
    } catch (error) {
      if (generation !== this.core.getQueryGeneration()) return;
      this.core.setState({ status: "error", errorMessage: errorMessage(error) });
    }
  }
}
