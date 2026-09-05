import { writeFileSync } from "node:fs";

const [outputPath] = process.argv.slice(2);
if (typeof outputPath !== "string" || outputPath.length === 0) {
  console.error("Usage: node tests/fixtures/generate-100k.mjs <output-path>");
  process.exit(1);
}

const ROW_COUNT = 100_000;
const header = "Word,Occurences,ExampleSentence,Definitions,ReadingFurigana\n";
const lines = [header];
let checksum = 0;

for (let index = 0; index < ROW_COUNT; index += 1) {
  const word = `語${index}`;
  const occurrences = (index * 17) % 500;
  const sentence = index % 3 === 0 ? `これは**${word}**の例文です。` : "";
  const definitions = `definition ${index % 11}`;
  const furigana = `${word}[ご${index}]`;
  checksum += occurrences;
  lines.push(`"${word}","${occurrences}","${sentence}","${definitions}","${furigana}"\n`);
}

if (lines.length !== ROW_COUNT + 1) {
  console.error(`Generator produced ${lines.length - 1} data rows instead of ${ROW_COUNT}.`);
  process.exit(1);
}

writeFileSync(outputPath, lines.join(""), { encoding: "utf8", flag: "w" });
console.log(`Wrote ${ROW_COUNT} data rows (occurrence checksum ${checksum}) to ${outputPath}`);
