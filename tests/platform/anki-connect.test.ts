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

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
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

  it("escapes Anki wildcard characters inside quoted search values", () => {
    expect(quoteAnkiSearchValue("Diaz_*")).toBe('"Diaz\\_\\*"');
    expect(
      buildAnkiBaseSearch({
        noteType: "Mine*",
        deckScope: { kind: "deck", name: "*" },
      }),
    ).toBe('note:"Mine\\*" deck:"\\*"');
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

  it("maps actual Anki API-key spelling and error responses", async () => {
    const protectedPermission = createAnkiConnectPort({
      fetchFn: jsonFetch({ permission: "granted", requireApikey: true }),
    });
    await expect(protectedPermission.requestPermission()).rejects.toMatchObject({
      code: "api-key-required",
    });

    const protectedRequest = createAnkiConnectPort({
      fetchFn: async () => response({ result: null, error: "valid api key must be provided" }),
    });
    await expect(protectedRequest.deckNames()).rejects.toMatchObject({
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

  it("rejects non-2xx responses and non-JSON bodies", async () => {
    const httpFailure = createAnkiConnectPort({
      fetchFn: async () => textResponse("AnkiConnect unavailable", 503),
    });
    await expect(httpFailure.deckNames()).rejects.toMatchObject({ code: "connection-failed" });

    const malformedBody = createAnkiConnectPort({
      fetchFn: async () => textResponse("not JSON"),
    });
    await expect(malformedBody.deckNames()).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("maps response body read failures to connection-failed", async () => {
    const bodyFailure = createAnkiConnectPort({
      fetchFn: async () =>
        ({
          status: 200,
          text: async () => {
            throw new TypeError("body stream failed");
          },
        }) as Response,
    });
    await expect(bodyFailure.deckNames()).rejects.toMatchObject({ code: "connection-failed" });
  });

  it("rejects arrays in envelopes, cards, and fields", async () => {
    const malformedEnvelope = createAnkiConnectPort({
      fetchFn: async () => response([]),
    });
    await expect(malformedEnvelope.deckNames()).rejects.toMatchObject({ code: "protocol-error" });

    const malformedCard = createAnkiConnectPort({
      fetchFn: async () => response({ result: [[]], error: null }),
    });
    await expect(malformedCard.cardsInfo([1])).rejects.toMatchObject({ code: "protocol-error" });

    const malformedFields = createAnkiConnectPort({
      fetchFn: async () => response({ result: [{ cardId: 1, fields: [] }], error: null }),
    });
    await expect(malformedFields.cardsInfo([1])).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects envelopes missing result or error properties", async () => {
    const missingResult = createAnkiConnectPort({
      fetchFn: async () => response({ error: null }),
    });
    await expect(missingResult.deckNames()).rejects.toMatchObject({ code: "protocol-error" });

    const missingError = createAnkiConnectPort({
      fetchFn: async () => response({ result: [] }),
    });
    await expect(missingError.deckNames()).rejects.toMatchObject({ code: "protocol-error" });
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

  it("enforces timeout when fetch ignores abort and resolves late", async () => {
    let resolveFetch: ((value: Response | PromiseLike<Response>) => void) | undefined;
    let aborted = false;
    const timeout = createAnkiConnectPort({
      timeoutMs: 1,
      fetchFn: (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    const pending = timeout.deckNames();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(aborted).toBe(true);
    resolveFetch?.(response({ result: [], error: null }));
  });

  it("enforces timeout when response body ignores abort and resolves late", async () => {
    let resolveBody: ((value: string) => void) | undefined;
    const timeout = createAnkiConnectPort({
      timeoutMs: 1,
      fetchFn: async () =>
        ({
          status: 200,
          text: () =>
            new Promise<string>((resolve) => {
              resolveBody = resolve;
            }),
        }) as Response,
    });

    const pending = timeout.deckNames();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    resolveBody?.('{"result":[],"error":null}');
  });

  it("has no Anki mutation methods", () => {
    const port = createAnkiConnectPort({ fetchFn: jsonFetch({ result: [], error: null }) });
    expect("addNote" in port).toBe(false);
    expect("request" in port).toBe(false);
    expect("updateNoteFields" in port).toBe(false);
    expect("changeDeck" in port).toBe(false);
    expect("suspend" in port).toBe(false);
    expect("unsuspend" in port).toBe(false);
    expect("forgetCards" in port).toBe(false);
    expect("setDueDate" in port).toBe(false);
  });
});
