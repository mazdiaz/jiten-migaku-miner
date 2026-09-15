import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportPanel } from "../../src/components/features/ImportPanel";
import { ResultsPanel } from "../../src/components/features/ResultsPanel";
import { ReviewPanel } from "../../src/components/features/ReviewPanel";
export function renderMinerShell(): string {
  return renderToStaticMarkup(
    createElement(
      "main",
      null,
      createElement(ImportPanel),
      createElement(ResultsPanel),
      createElement(ReviewPanel),
    ),
  );
}
