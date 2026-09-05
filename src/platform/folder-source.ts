import type { FileSource, FolderSource } from "../app/state";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FolderSourceOptions {
  fetch?: Fetcher;
  protocol?: string;
  baseUrl?: string | URL;
}

class TextResponseFileSource implements FileSource {
  constructor(
    readonly name: string,
    private readonly response: Response,
  ) {}

  text(): Promise<string> {
    return this.response.text();
  }
}

function decodeName(value: string): string | null {
  try {
    return decodeURIComponent(value).split("/").pop() ?? null;
  } catch {
    return null;
  }
}

function listingNames(html: string): string[] {
  const names: string[] = [];
  const parserConstructor = globalThis.DOMParser;
  if (typeof parserConstructor === "function") {
    const document = new parserConstructor().parseFromString(html, "text/html");
    for (const anchor of [...document.querySelectorAll("a[href]")]) {
      const href = anchor.getAttribute("href");
      const name = href === null ? null : decodeName(href);
      if (name !== null && name.length > 0) names.push(name);
    }
    return names;
  }

  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3];
    if (href === undefined) continue;
    const name = decodeName(href);
    if (name !== null && name.length > 0) names.push(name);
  }
  return names;
}

function isHttpUrl(value: URL): boolean {
  return value.protocol === "http:" || value.protocol === "https:";
}

class BrowserFolderSource implements FolderSource {
  private readonly fetcher: Fetcher | null;
  private readonly protocol: string;
  private readonly baseUrl: URL | null;
  private readonly baseOrigin: string | null;

  constructor(options: FolderSourceOptions = {}) {
    this.fetcher = options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    this.protocol = options.protocol ?? (typeof globalThis.location === "object" ? globalThis.location.protocol : "");
    const configuredBase = options.baseUrl ?? (typeof globalThis.location === "object" ? globalThis.location.href : null);
    try {
      const parsedBase = configuredBase === null ? null : new URL(configuredBase);
      if (parsedBase === null || !isHttpUrl(parsedBase)) throw new Error("A same-origin HTTP(S) page base is required");
      this.baseUrl = parsedBase;
      this.baseOrigin = this.baseUrl?.origin ?? null;
    } catch {
      this.baseUrl = null;
      this.baseOrigin = null;
    }
  }

  async newest(directory: string, extension: string): Promise<FileSource | null> {
    if (this.protocol.toLowerCase() === "file:") return null;
    if (this.fetcher === null) return null;

    try {
      const listingUrl = this.resolveDirectory(directory);
      if (listingUrl === null) return null;
      const listing = await this.fetcher(listingUrl, { cache: "no-store" });
      if (!listing.ok || !this.isAllowedResponse(listing)) return null;

      const suffix = extension.toLowerCase();
      const names = listingNames(await listing.text()).filter((name) => name.toLowerCase().endsWith(suffix));
      if (names.length === 0) return null;

      let best: string | null = null;
      let bestDate = 0;
      for (const name of names.slice(0, 20)) {
        try {
          const candidateUrl = this.resolveFile(listingUrl, name);
          if (candidateUrl === null) continue;
          const head = await this.fetcher(candidateUrl, {
            method: "HEAD",
            cache: "no-store",
          });
          if (!head.ok || !this.isAllowedResponse(head)) continue;
          const modified = Date.parse(head.headers.get("Last-Modified") ?? "");
          if (Number.isFinite(modified) && modified > bestDate) {
            bestDate = modified;
            best = name;
          }
        } catch {
          // One unavailable candidate must not hide other files.
        }
      }

      if (best === null) best = [...names].sort().pop() ?? null;
      if (best === null) return null;

       const fileUrl = this.resolveFile(listingUrl, best);
       if (fileUrl === null) return null;
       const fileResponse = await this.fetcher(fileUrl, { cache: "no-store" });
      if (!fileResponse.ok || !this.isAllowedResponse(fileResponse)) return null;
      return new TextResponseFileSource(best, fileResponse);
    } catch {
      return null;
    }
  }

  private resolveDirectory(directory: string): string | null {
    if (this.baseUrl === null || this.baseOrigin === null) return null;

    let resolved: URL;
    try {
      resolved = new URL(directory, this.baseUrl);
    } catch {
      return null;
    }
    if (resolved.origin !== this.baseOrigin) return null;
    if (!resolved.pathname.endsWith("/")) resolved.pathname += "/";
    return resolved.href;
  }

  private resolveFile(listingUrl: string, name: string): string | null {
    if (this.baseUrl === null || this.baseOrigin === null) return null;
    try {
      const resolved = new URL(encodeURIComponent(name), listingUrl);
      return resolved.origin === this.baseOrigin ? resolved.href : null;
    } catch {
      return null;
    }
  }

  private isAllowedResponse(response: Response): boolean {
    if (this.baseOrigin === null || response.redirected) return false;
    if (typeof response.url !== "string" || response.url.length === 0) return false;
    try {
      return new URL(response.url).origin === this.baseOrigin;
    } catch {
      return false;
    }
  }
}

export function createFolderSource(options: FolderSourceOptions = {}): FolderSource {
  return new BrowserFolderSource(options);
}

export { BrowserFolderSource };
