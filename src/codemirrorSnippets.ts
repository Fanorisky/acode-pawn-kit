import { Snippet, snippets } from "./snippets";

export const CODEMIRROR_FILE_NAME_TOKEN = "__CODEMIRROR_FILE_NAME__";

export interface CodeMirrorSnippet extends Snippet {
  codeMirrorSnippet: string;
  fallbackSnippet: string;
}

/**
 * Convert ACE snippet format to CodeMirror fallback
 * e.g. "${1:playerid}" → "playerid"
 */
function toFallback(snippet: string): string {
  return snippet.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\d+/g, "");
}

/**
 * Derive CodeMirror snippets from base snippets.
 * For Pawn, there is no FILE_NAME token, so codeMirrorSnippet == snippet.
 */
export const codeMirrorSnippets: CodeMirrorSnippet[] = snippets.map(s => ({
  ...s,
  codeMirrorSnippet: s.snippet,
  fallbackSnippet: toFallback(s.snippet),
}));
