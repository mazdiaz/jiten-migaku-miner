import type {
  Entry,
  FuriganaRun,
  QueryState,
  ViewState,
  WordDecision,
} from "../domain/types";
import type {
  AppStore,
  DatasetMetadata,
  DatasetStore,
  KnownWordStore,
  PreferencesStore,
  WordDecisionStore,
} from "./contracts";

interface StoredDataset {
  metadata: DatasetMetadata;
  chunks: Entry[][];
}

interface StoredKnownWords {
  id: string;
  name: string;
  words: Set<string>;
}

interface StoredPreferences {
  query: QueryState;
  view: ViewState;
  page: number;
}

function cloneFuriganaRun(run: FuriganaRun): FuriganaRun {
  return { text: run.text, reading: run.reading };
}

function cloneEntry(value: Entry): Entry {
  return { ...value, furiganaRuns: value.furiganaRuns.map(cloneFuriganaRun) };
}

function cloneEntries(values: readonly Entry[]): Entry[] {
  return values.map(cloneEntry);
}

function cloneMetadata(value: DatasetMetadata): DatasetMetadata {
  return { ...value, headers: [...value.headers] };
}

function cloneDecision(value: WordDecision): WordDecision {
  return { ...value };
}

class MemoryDatasetStore implements DatasetStore {
  private readonly records = new Map<string, StoredDataset>();
  private readonly stagingIds = new Set<string>();
  private activeDatasetId: string | null = null;

  async stage(
    metadata: DatasetMetadata,
    chunks: AsyncIterable<readonly Entry[]>,
  ): Promise<void> {
    if (this.records.has(metadata.id) || this.stagingIds.has(metadata.id)) {
      throw new Error(`Dataset already exists: ${metadata.id}`);
    }

    this.stagingIds.add(metadata.id);
    try {
      const stagedChunks: Entry[][] = [];

      for await (const chunk of chunks) {
        stagedChunks.push(cloneEntries(chunk));
      }

      this.records.set(metadata.id, {
        metadata: cloneMetadata(metadata),
        chunks: stagedChunks,
      });
    } finally {
      this.stagingIds.delete(metadata.id);
    }
  }

  async activate(datasetId: string): Promise<void> {
    if (!this.records.has(datasetId)) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    this.activeDatasetId = datasetId;
  }

  async getActive(): Promise<DatasetMetadata | null> {
    if (this.activeDatasetId === null) {
      return null;
    }

    const active = this.records.get(this.activeDatasetId);
    return active ? cloneMetadata(active.metadata) : null;
  }

  async list(): Promise<DatasetMetadata[]> {
    return [...this.records.values()]
      .sort((left, right) => left.metadata.id.localeCompare(right.metadata.id))
      .map((record) => cloneMetadata(record.metadata));
  }

  async *readChunks(
    datasetId: string,
    chunkSize: number,
  ): AsyncGenerator<Entry[], void, unknown> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError("chunkSize must be a positive integer");
    }

    const dataset = this.records.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    let pending: Entry[] = [];
    for (const storedChunk of dataset.chunks) {
      for (const value of storedChunk) {
        pending.push(cloneEntry(value));
        if (pending.length === chunkSize) {
          yield pending;
          pending = [];
        }
      }
    }

    if (pending.length > 0) {
      yield pending;
    }
  }

  async remove(datasetId: string): Promise<void> {
    this.records.delete(datasetId);
    if (this.activeDatasetId === datasetId) {
      this.activeDatasetId = null;
    }
  }

  clear(): void {
    this.records.clear();
    this.stagingIds.clear();
    this.activeDatasetId = null;
  }
}

class MemoryKnownWordStore implements KnownWordStore {
  private active: StoredKnownWords | null = null;

  async save(id: string, name: string, words: Iterable<string>): Promise<void> {
    this.active = { id, name, words: new Set(words) };
  }

  async getActive(): Promise<{ id: string; name: string; words: Set<string> } | null> {
    if (this.active === null) {
      return null;
    }

    return {
      id: this.active.id,
      name: this.active.name,
      words: new Set(this.active.words),
    };
  }

  remove(id: string): void {
    if (this.active?.id === id) this.active = null;
  }

  clear(): void {
    this.active = null;
  }
}

class MemoryPreferencesStore implements PreferencesStore {
  private value: StoredPreferences | null = null;

  async load(): Promise<StoredPreferences | null> {
    if (this.value === null) {
      return null;
    }

    return {
      query: { ...this.value.query },
      view: { ...this.value.view },
      page: this.value.page,
    };
  }

  async save(value: StoredPreferences): Promise<void> {
    this.value = {
      query: { ...value.query },
      view: { ...value.view },
      page: value.page,
    };
  }

  clear(): void {
    this.value = null;
  }
}

class MemoryWordDecisionStore implements WordDecisionStore {
  private readonly decisions = new Map<string, WordDecision>();

  async get(normalizedWord: string): Promise<WordDecision | null> {
    const decision = this.decisions.get(normalizedWord);
    return decision ? cloneDecision(decision) : null;
  }

  async list(): Promise<WordDecision[]> {
    return [...this.decisions.values()]
      .sort((left, right) => left.normalizedWord.localeCompare(right.normalizedWord))
      .map(cloneDecision);
  }

  async set(decision: WordDecision): Promise<void> {
    this.decisions.set(decision.normalizedWord, cloneDecision(decision));
  }

  async remove(normalizedWord: string): Promise<void> {
    this.decisions.delete(normalizedWord);
  }

  clear(): void {
    this.decisions.clear();
  }
}

export class MemoryAppStore implements AppStore {
  readonly datasets: DatasetStore;
  readonly knownWords: KnownWordStore;
  readonly wordDecisions: WordDecisionStore;
  readonly preferences: PreferencesStore;

  private readonly datasetStore: MemoryDatasetStore;
  private readonly knownWordStore: MemoryKnownWordStore;
  private readonly wordDecisionStore: MemoryWordDecisionStore;
  private readonly preferencesStore: MemoryPreferencesStore;

  constructor() {
    this.datasetStore = new MemoryDatasetStore();
    this.knownWordStore = new MemoryKnownWordStore();
    this.wordDecisionStore = new MemoryWordDecisionStore();
    this.preferencesStore = new MemoryPreferencesStore();
    this.datasets = this.datasetStore;
    this.knownWords = this.knownWordStore;
    this.wordDecisions = this.wordDecisionStore;
    this.preferences = this.preferencesStore;
  }

  async clearAll(): Promise<void> {
    this.datasetStore.clear();
    this.knownWordStore.clear();
    this.wordDecisionStore.clear();
    this.preferencesStore.clear();
  }
}

export function createMemoryAppStore(): MemoryAppStore {
  return new MemoryAppStore();
}
