import type { FileSource } from "../app/state";

export class BrowserFileSource implements FileSource {
  constructor(private readonly file: Pick<File, "name" | "text">) {}

  get name(): string {
    return this.file.name;
  }

  text(): Promise<string> {
    return this.file.text();
  }
}

export function createFileSource(file: File): FileSource {
  return new BrowserFileSource(file);
}
