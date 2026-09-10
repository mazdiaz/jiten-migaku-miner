import { describe, expect, it } from "vitest";
import {
  buildAnkiBaseSearch,
  createAnkiConnectPort,
  quoteAnkiSearchValue,
} from "../../src/platform/anki-connect";

function jsonFetch(result: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ result, error: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AnkiConnect adapter", () => {
  it("quotes note and deck values without allowing search syntax injection", () => {
    expect(quoteAnkiSearchValue('Diaz "Mine"')).toBe('"Diaz \\"Mine\\""');
    expect(
      buildAnkiBaseSearch({
        noteType: 'Diaz "Mine"',
        deckScope: { kind: "deck", name: "MAIN::Mining" },
      }),
    ).toBe('note:"Diaz \\"Mine\\"" deck:"MAIN::Mining"');
  });

  it("escapes backslashes inside quoted search values", () => {
    expect(quoteAnkiSearchValue('folder\\name"value')).toBe('"folder\\\\name\\"value"');
  });

  it("uses API version 6 and the local default endpoint for every request", async () => {
    let request: { input: RequestInfo | URL; init: RequestInit | undefined } | undefined;
    const port = createAnkiConnectPort({
      fetchFn: async (input, init) => {
        request = { input, init };
        return response({ result: ["MAIN::Mining"], error: null });
      },
    });

    await expect(port.deckNames()).resolves.toEqual(["MAIN::Mining"]);

    expect(request?.input).toBe("http://127.0.0.1:8765");
    expect(request?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      action: "deckNames",
      version: 6,
    });
  });

  it("returns validated read-only discovery and card data", async () => {
    const responses = new Map<string, unknown>([
      ["requestPermission", { permission: "granted" }],
      ["deckNames", ["MAIN::Mining"]],
      ["modelNames", ["Diaz Custom Mine"]],
      ["modelFieldNames", ["Target Word (no syntax)"]],
      ["findCards", [11, 12]],
      [
        "cardsInfo",
        [
          {
            cardId: 11,
            fields: {
              Word: { value: " word ", order: 0 },
              Extra: { value: "ignored", order: 1 },
            },
            note: 99,
          },
        ],
      ],
    ]);
    const port = createAnkiConnectPort({
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { action: string };
        return response({ result: responses.get(body.action), error: null });
      },
    });

    await expect(port.requestPermission()).resolves.toBeUndefined();
    await expect(port.deckNames()).resolves.toEqual(["MAIN::Mining"]);
    await expect(port.modelNames()).resolves.toEqual(["Diaz Custom Mine"]);
    await expect(port.modelFieldNames("Diaz Custom Mine")).resolves.toEqual([
      "Target Word (no syntax)",
    ]);
    await expect(port.findCards('note:"Diaz Custom Mine"')).resolves.toEqual([11, 12]);
    await expect(port.cardsInfo([11])).resolves.toEqual([
      { cardId: 11, fields: { Word: " word ", Extra: "ignored" } },
    ]);
  });

  it("rejects permission denial and API-key-required responses", async () => {
    const denied = createAnkiConnectPort({ fetchFn: jsonFetch({ permission: "denied" }) });
    await expect(denied.requestPermission()).rejects.toMatchObject({ code: "permission-denied" });

    const keyRequired = createAnkiConnectPort({
      fetchFn: jsonFetch({ permission: "unauthorized", requireApiKey: true }),
    });
    await expect(keyRequired.requestPermission()).rejects.toMatchObject({
      code: "api-key-required",
    });
  });

  it("maps AnkiConnect errors to typed adapter errors", async () => {
    const port = createAnkiConnectPort({
      fetchFn: async () => response({ result: null, error: "unsupported action" }),
    });

    await expect(port.deckNames()).rejects.toMatchObject({
      code: "anki-error",
      message: "unsupported action",
    });
  });

  it("batches cardsInfo at 500 and rejects malformed envelopes", async () => {
    const calls: unknown[][] = [];
    const port = createAnkiConnectPort({
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          action: string;
          params?: { cards: number[] };
        };
        if (body.action === "cardsInfo") calls.push(body.params?.cards ?? []);
        return response({ result: [], error: null });
      },
    });
    await port.cardsInfo(Array.from({ length: 501 }, (_, index) => index + 1));
    expect(calls.map((batch) => batch.length)).toEqual([500, 1]);
    const malformed = createAnkiConnectPort({
      fetchFn: jsonFetch({ result: "wrong", error: null }),
    });
    await expect(malformed.deckNames()).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects malformed results for each read operation", async () => {
    const invalidResults: Array<[string, () => Promise<unknown>]> = [
      ["modelNames", () => createAnkiConnectPort({ fetchFn: jsonFetch([1]) }).modelNames()],
      [
        "modelFieldNames",
        () => createAnkiConnectPort({ fetchFn: jsonFetch([1]) }).modelFieldNames("Mine"),
      ],
      [
        "findCards",
        () => createAnkiConnectPort({ fetchFn: jsonFetch(["1"]) }).findCards("note:Mine"),
      ],
      [
        "cardsInfo",
        () =>
          createAnkiConnectPort({
            fetchFn: jsonFetch([{ cardId: 1, fields: { Word: 2 } }]),
          }).cardsInfo([1]),
      ],
    ];

    for (const [operation, call] of invalidResults) {
      await expect(call(), operation).rejects.toMatchObject({ code: "protocol-error" });
    }
  });

  it("maps connection failures and timeouts to typed adapter errors", async () => {
    const failed = createAnkiConnectPort({
      fetchFn: async () => {
        throw new TypeError("refused");
      },
    });
    await expect(failed.deckNames()).rejects.toMatchObject({ code: "connection-failed" });

    const timeout = createAnkiConnectPort({
      timeoutMs: 1,
      fetchFn: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    });
    await expect(timeout.deckNames()).rejects.toMatchObject({ code: "timeout" });
  });

  it("has no Anki mutation methods", () => {
    const port = createAnkiConnectPort({ fetchFn: jsonFetch({ result: [], error: null }) });
    expect("addNote" in port).toBe(false);
    expect("updateNoteFields" in port).toBe(false);
    expect("changeDeck" in port).toBe(false);
    expect("suspend" in port).toBe(false);
    expect("unsuspend" in port).toBe(false);
    expect("forgetCards" in port).toBe(false);
    expect("setDueDate" in port).toBe(false);
  });
});
