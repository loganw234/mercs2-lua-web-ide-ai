/* entry.js -- everything the IDE needs from CodeMirror 6, re-exported under one global (window.CM),
 * plus luaparse (as CM.luaparse) for the lint guardrails and lz-string (as CM.LZString) for share-link
 * compression. Bundled by esbuild (see package.json).
 * Keep this list tight: every export here is payload in the single-file dist/index.html. */

export { EditorState, EditorSelection, StateEffect, StateField, Compartment } from "@codemirror/state";
export {
  EditorView, keymap, lineNumbers, drawSelection, dropCursor,
  highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  placeholder, tooltips, hoverTooltip
} from "@codemirror/view";
export {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, indentSelection
} from "@codemirror/commands";
export {
  StreamLanguage, syntaxHighlighting, HighlightStyle, indentUnit,
  bracketMatching, indentOnInput, foldGutter, foldKeymap
} from "@codemirror/language";
export { tags } from "@lezer/highlight";
export { lua } from "@codemirror/legacy-modes/mode/lua";
export {
  searchKeymap, highlightSelectionMatches, openSearchPanel, search
} from "@codemirror/search";
export {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
  snippet, startCompletion, acceptCompletion
} from "@codemirror/autocomplete";
export { linter, lintGutter, forceLinting, setDiagnostics } from "@codemirror/lint";

import luaparse from "luaparse";
export { luaparse };

import LZString from "lz-string";
export { LZString };
