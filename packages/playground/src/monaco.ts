// Monaco, trimmed to what a Tejun editor needs. The full `monaco-editor`
// entry bundles language services for CSS, HTML, JSON and TypeScript
// (several MB) that Tejun never uses. This loads the core editor plus the
// features the playground relies on: error hovers and navigation, find,
// brackets, comments, and the usual editing commands.
//
// `monaco-esm/` is a Vite alias for monaco-editor's esm/vs folder (the
// package's export map cannot serve its CSS files).

import "monaco-esm/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-esm/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import "monaco-esm/editor/browser/coreCommands.js";
import "monaco-esm/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-esm/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-esm/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-esm/editor/contrib/comment/browser/comment.js";
import "monaco-esm/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-esm/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-esm/editor/contrib/find/browser/findController.js";
import "monaco-esm/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-esm/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-esm/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-esm/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-esm/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-esm/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-esm/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-esm/features/find/register.js";
import "monaco-esm/editor/common/standaloneStrings.js";

export * from "monaco-esm/editor/editor.api.js";
