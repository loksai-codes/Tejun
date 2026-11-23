// Compiler diagnostics -> editor markers (red squiggles with hover text).
// Pure, so it is unit-tested without a browser.

import type { Diagnostic, SourceFile } from "@tejun/compiler";
import type { Lang } from "./i18n.js";

/** The fields of a Monaco marker we set (Monaco columns are 1-based UTF-16 offsets). */
export interface Marker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  code: string;
}

export function toMarkers(diagnostics: readonly Diagnostic[], source: SourceFile, lang: Lang): Marker[] {
  return diagnostics.map((d) => {
    const startColumn = d.span.start - source.lineStart(d.span.line) + 1;
    let endColumn = d.span.end - source.lineStart(d.span.endLine) + 1;
    // A zero-width span (e.g. a missing `;`) still needs one visible character.
    if (d.span.endLine === d.span.line && endColumn <= startColumn) endColumn = startColumn + 1;
    return {
      startLineNumber: d.span.line,
      startColumn,
      endLineNumber: d.span.endLine,
      endColumn,
      message: markerMessage(d, lang),
      code: d.code,
    };
  });
}

/** Hover text: the message in the chosen language, notes, help, and the other language. */
export function markerMessage(d: Diagnostic, lang: Lang): string {
  const main = lang === "ja" ? d.messageJa : d.message;
  const other = lang === "ja" ? `English: ${d.message}` : `日本語: ${d.messageJa}`;
  return [
    main,
    ...(d.label ? [`→ ${d.label}`] : []),
    ...(d.notes ?? []),
    ...(d.help ? [`help: ${d.help}`] : []),
    other,
  ].join("\n");
}
