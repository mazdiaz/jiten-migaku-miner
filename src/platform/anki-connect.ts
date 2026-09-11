import type { AnkiDeckScope } from "../domain/anki";

export const ANKI_CONNECT_ENDPOINT = "http://127.0.0.1:8765";
export const ANKI_CONNECT_VERSION = 6;
export const ANKI_CARDS_INFO_BATCH_SIZE = 500;

const DEFAULT_TIMEOUT_MS = 10_000;

export type AnkiConnectErrorCode =
  | "connection-failed"
  | "timeout"
  | "permission-denied"
  | "api-key-required"
  | "protocol-error"
  | "anki-error";

export class AnkiConnectError extends Error {
  constructor(
    public readonly code: AnkiConnectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnkiConnectError";
  }
}

export interface AnkiCardInfo {
  cardId: number;
  fields: { [fieldName: string]: string };
}

export interface AnkiConnectPort {
  requestPermission(): Promise<void>;
  deckNames(): Promise<string[]>;
  modelNames(): Promise<string[]>;
  modelFieldNames(noteType: string): Promise<string[]>;
  findCards(search: string): Promise<number[]>;
  cardsInfo(cardIds: number[]): Promise<AnkiCardInfo[]>;
}

export interface AnkiConnectOptions {
  fetchFn?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

export interface AnkiBaseSearchInput {
  noteType: string;
  deckScope: AnkiDeckScope;
}

export function quoteAnkiSearchValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")}"`;
}

export function buildAnkiBaseSearch({ noteType, deckScope }: AnkiBaseSearchInput): string {
  const terms = [`note:${quoteAnkiSearchValue(noteType)}`];
  if (deckScope.kind === "deck") terms.push(`deck:${quoteAnkiSearchValue(deckScope.name)}`);
  return terms.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(message: string): never {
  throw new AnkiConnectError("protocol-error", message);
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isApiKeyRequiredMessage(message: string): boolean {
  return /api\s*key\s+(?:is\s+)?required|api\s*key\s+must\s+be\s+provided/i.test(message);
}

function parseEnvelope(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "result")) {
    return protocolError("AnkiConnect response must contain a result property");
  }
  if (!Object.hasOwn(value, "error")) {
    return protocolError("AnkiConnect response must contain an error property");
  }
  if (value.error !== null) {
    const message = errorText(value.error);
    if (isApiKeyRequiredMessage(message)) {
      throw new AnkiConnectError(
        "api-key-required",
        `AnkiConnect requires an API key; API-key-protected AnkiConnect is unsupported in v1: ${message}`,
      );
    }
    throw new AnkiConnectError("anki-error", message);
  }
  return value.result;
}

function parseStringArray(value: unknown, action: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return protocolError(`${action} result must be an array of strings`);
  }
  return [...value];
}

function parseNumberArray(value: unknown, action: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))
  ) {
    return protocolError(`${action} result must be an array of card IDs`);
  }
  return [...value];
}

function parseCardsInfo(value: unknown): AnkiCardInfo[] {
  if (!Array.isArray(value)) return protocolError("cardsInfo result must be an array");

  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.cardId !== "number" || !Number.isSafeInteger(item.cardId)) {
      return protocolError(`cardsInfo[${index}] must contain a valid cardId`);
    }
    if (!isRecord(item.fields)) {
      return protocolError(`cardsInfo[${index}].fields must be an object`);
    }

    const fields: { [fieldName: string]: string } = {};
    for (const [fieldName, field] of Object.entries(item.fields)) {
      if (
        !isRecord(field) ||
        typeof field.value !== "string" ||
        typeof field.order !== "number" ||
        !Number.isSafeInteger(field.order)
      ) {
        return protocolError(`cardsInfo[${index}].fields.${fieldName} is malformed`);
      }
      fields[fieldName] = field.value;
    }

    return { cardId: item.cardId, fields };
  });
}

export function createAnkiConnectPort(options: AnkiConnectOptions = {}): AnkiConnectPort {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? ANKI_CONNECT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(action: string, params?: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new AnkiConnectError("timeout", "AnkiConnect request timed out"));
      }, timeoutMs);
    });

    try {
      const body = JSON.stringify({
        action,
        version: ANKI_CONNECT_VERSION,
        ...(params === undefined ? {} : { params }),
      });
      let httpResponse: Response;
      try {
        httpResponse = await Promise.race([
          fetchFn(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch {
        if (timedOut) throw new AnkiConnectError("timeout", "AnkiConnect request timed out");
        throw new AnkiConnectError(
          "connection-failed",
          "Unable to connect to AnkiConnect. Ensure AnkiConnect is installed and enabled.",
        );
      }

      if (httpResponse.status < 200 || httpResponse.status >= 300) {
        throw new AnkiConnectError(
          "connection-failed",
          `AnkiConnect returned HTTP ${httpResponse.status}`,
        );
      }

      let responseBody: string;
      try {
        responseBody = await Promise.race([httpResponse.text(), timeoutPromise]);
      } catch {
        if (timedOut) throw new AnkiConnectError("timeout", "AnkiConnect request timed out");
        throw new AnkiConnectError(
          "connection-failed",
          "Unable to read AnkiConnect response. Ensure AnkiConnect is installed and enabled.",
        );
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(responseBody);
      } catch {
        return protocolError("AnkiConnect response was not valid JSON");
      }
      return parseEnvelope(envelope);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  return {
    async requestPermission(): Promise<void> {
      const result = await request("requestPermission");
      if (!isRecord(result) || typeof result.permission !== "string") {
        return protocolError("requestPermission result must contain a permission");
      }
      if (Object.hasOwn(result, "requireApiKey") && typeof result.requireApiKey !== "boolean") {
        return protocolError("requestPermission requireApiKey must be a boolean");
      }
      if (Object.hasOwn(result, "requireApikey") && typeof result.requireApikey !== "boolean") {
        return protocolError("requestPermission requireApikey must be a boolean");
      }
      if (result.requireApiKey === true || result.requireApikey === true) {
        throw new AnkiConnectError(
          "api-key-required",
          "AnkiConnect requires an API key; API-key-protected AnkiConnect is unsupported in v1",
        );
      }
      if (result.permission === "granted") return;
      if (result.permission === "denied" || result.permission === "unauthorized") {
        throw new AnkiConnectError("permission-denied", "AnkiConnect permission denied");
      }
      return protocolError("requestPermission returned an unknown permission");
    },

    async deckNames(): Promise<string[]> {
      return parseStringArray(await request("deckNames"), "deckNames");
    },

    async modelNames(): Promise<string[]> {
      return parseStringArray(await request("modelNames"), "modelNames");
    },

    async modelFieldNames(noteType: string): Promise<string[]> {
      return parseStringArray(
        await request("modelFieldNames", { modelName: noteType }),
        "modelFieldNames",
      );
    },

    async findCards(search: string): Promise<number[]> {
      return parseNumberArray(await request("findCards", { query: search }), "findCards");
    },

    async cardsInfo(cardIds: number[]): Promise<AnkiCardInfo[]> {
      const cards: AnkiCardInfo[] = [];
      for (let start = 0; start < cardIds.length; start += ANKI_CARDS_INFO_BATCH_SIZE) {
        const batch = cardIds.slice(start, start + ANKI_CARDS_INFO_BATCH_SIZE);
        cards.push(...parseCardsInfo(await request("cardsInfo", { cards: batch })));
      }
      return cards;
    },
  };
}
