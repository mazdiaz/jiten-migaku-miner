import { describe, expect, it } from "vitest";
import { BrowserFolderSource } from "../../src/platform/folder-source";

const BASE_URL = "http://127.0.0.1:8931/dist/index.html";
const CSV_BODY = [
  "Word,Occurences,ExampleSentence,Definitions,ReadingFurigana",
  "自動,5,\"これは**自動**の例文です。\",automatic,自動[じどう]",
].join("\n");

interface RecordedRequest {
  url: string;
  method: string;
}

function stubResponse(url: string, status: number, headers: Record<string, string>, body: string): Response {
  const response = new Response(status === 204 ? null : body, { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function createRecordingFetcher(log: RecordedRequest[]) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    log.push({ url, method });
    if (method === "HEAD") {
      return Promise.resolve(
        stubResponse(url, 200, { "Last-Modified": "Thu, 03 Sep 2026 00:00:00 GMT" }, ""),
      );
    }
    if (url.endsWith("/")) {
      return Promise.resolve(
        stubResponse(url, 200, { "Content-Type": "text/html" }, '<a href="vocab.csv">vocab.csv</a>'),
      );
    }
    return Promise.resolve(stubResponse(url, 200, { "Content-Type": "text/csv" }, CSV_BODY));
  };
}

describe("BrowserFolderSource directory resolution", () => {
  it("resolves an absolute discovery directory against the origin root, not the page directory", async () => {
    const log: RecordedRequest[] = [];
    const source = new BrowserFolderSource({ fetch: createRecordingFetcher(log), baseUrl: BASE_URL });

    const file = await source.newest("/WORDS TO MINE", ".csv");

    expect(file?.name).toBe("vocab.csv");
    expect(log[0]).toEqual({ url: "http://127.0.0.1:8931/WORDS%20TO%20MINE/", method: "GET" });
    expect(log).toContainEqual({
      url: "http://127.0.0.1:8931/WORDS%20TO%20MINE/vocab.csv",
      method: "HEAD",
    });
    expect(log).toContainEqual({
      url: "http://127.0.0.1:8931/WORDS%20TO%20MINE/vocab.csv",
      method: "GET",
    });
  });

  it("resolves a relative discovery directory against the page base (dev regression guard)", async () => {
    const log: RecordedRequest[] = [];
    const source = new BrowserFolderSource({ fetch: createRecordingFetcher(log), baseUrl: BASE_URL });

    const file = await source.newest("WORDS TO MINE", ".csv");

    expect(file?.name).toBe("vocab.csv");
    expect(log[0]).toEqual({ url: "http://127.0.0.1:8931/dist/WORDS%20TO%20MINE/", method: "GET" });
  });
});
