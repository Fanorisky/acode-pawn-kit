/**
 * Pawn language syntax highlighting for Acode (ACE + CodeMirror)
 *
 * Color mapping (based on Acode default ACE theme — keyword.control = RED):
 *   keyword.control   → RED   (#define, #include, public, stock, if, for, Float:, static, const...)
 *   storage.type      → BLUE  (new, enum, char)
 *   support.function  → BLUE  (function CALLS, built-in functions)
 *   entity.name.function → GREEN  (function DEFINITION names only, after modifier)
 *   constant.numeric  → PURPLE/AMBER (numbers)
 *   string            → YELLOW (string literals)
 *   comment           → GRAY  (comments)
 *   constant.language → BLUE/TEAL (true, false, constants)
 */

// ── Token sets ────────────────────────────────────────────────────────────

/** Control flow keywords → RED */
const CTRL =
    "if|else|for|while|do|switch|case|default|break|continue|" +
    "return|goto|exit|sleep|state|assert";

/** Function specifiers → RED (trigger after_modifier state) */
const MODIFIERS =
    "public|forward|native|stock|hook|task|ptask|timer|ALS|" +
    "CMD|COMMAND|inline|using|operator|DialogCreate|DialogResponse|DialogInterrupt";

/** Declarations → BLUE (storage.type) */
const STORAGE_KW = "new|enum|char";

/** Other red keywords */
const OTHER_KW = "static|const|sizeof|tagof|defined";

/** Language constants */
const LANG_CONST = "true|false|INVALID_PLAYER_ID|INVALID_VEHICLE_ID|cellmin|cellmax";

/** Built-in functions → BLUE */
const BUILTINS =
    "print|printf|format|strlen|strcopy|strcat|strcmp|strfind|strdel|" +
    "strins|strpack|strunpack|strval|valstr|numargs|getarg|setarg|" +
    "random|min|max|clamp|floatstr|float|floatround|floatabs|floatsqroot|" +
    "IsPlayerConnected|SendClientMessage|GetTickCount|" +
    "SetTimer|SetTimerEx|KillTimer|CallLocalFunction|CallRemoteFunction";

const BUILTIN_SET = new Set(BUILTINS.split("|"));
const STORAGE_SET = new Set(STORAGE_KW.split("|"));
const KW_SET = new Set(
    [...CTRL.split("|"), ...MODIFIERS.split("|"), ...OTHER_KW.split("|"), ...LANG_CONST.split("|")]
);

const ALL_KW_RE_STR = [
    ...CTRL.split("|"), ...MODIFIERS.split("|"), ...STORAGE_KW.split("|"),
    ...OTHER_KW.split("|"), ...LANG_CONST.split("|"), ...BUILTINS.split("|")
].join("|");

// ── ACE Mode ──────────────────────────────────────────────────────────────

export function registerAcePawnMode(): void {
    if (typeof ace === "undefined") return;
    try {
        if ((ace as any).__pawnModeRegistered) return;
        (ace as any).__pawnModeRegistered = true;

        (ace as any).define(
            "ace/mode/pawn_highlight_rules",
            ["require", "exports", "module", "ace/lib/oop", "ace/mode/text_highlight_rules"],
            function (require: any, exports: any) {
                const oop = require("ace/lib/oop");
                const TextHighlightRules =
                    require("ace/mode/text_highlight_rules").TextHighlightRules;

                const PawnHighlightRules = function (this: any) {
                    // Shared lex rules reused in every state
                    const lexRules = [
                        // Line comment
                        { token: "comment", regex: /\/\/.*$/ },
                        // Block comment start
                        { token: "comment", regex: /\/\*/, next: "block_comment" },
                        // String
                        { token: "string", regex: /"/, next: "string_lit" },
                        // Char literal
                        { token: "string", regex: /'(?:[^'\\]|\\.)*'/ },
                        // Hex / Binary / Float / Integer
                        { token: "constant.numeric", regex: /0x[0-9a-fA-F]+\b/ },
                        { token: "constant.numeric", regex: /0b[01]+\b/ },
                        { token: "constant.numeric", regex: /[+-]?\d+\.\d*/ },
                        { token: "constant.numeric", regex: /\d+\b/ },
                        // Operators
                        { token: "keyword.operator", regex: /===|!==|==|!=|<=|>=|&&|\|\||<<|>>|\+\+|--|[+\-*/%&|^~<>=!?]/ },
                        // Punctuation
                        { token: "punctuation", regex: /[;,.]/ },
                        { token: "paren.lparen", regex: /[([{]/ },
                        { token: "paren.rparen", regex: /[)\]}]/ },
                    ];

                    const macroRules: any[] = [
                        // Macro params (%0, %1, etc.) → ORANGE pattern
                        { token: "variable.parameter", regex: /%[0-9]/ },
                        // Keywords inside macro
                        { token: "keyword.control", regex: new RegExp(`\\b(?:${MODIFIERS}|${CTRL}|${OTHER_KW})\\b`) },
                        { token: "storage.type", regex: new RegExp(`\\b(?:${STORAGE_KW})\\b`) },
                        { token: "constant.language", regex: new RegExp(`\\b(?:${LANG_CONST})\\b`) },
                        // Namespaces and Tags inside macro
                        { token: "keyword.control", regex: /[A-Za-z_@]\w*::|::/ },
                        { token: "keyword.control", regex: /[A-Za-z_]\w*:(?!:)/ },
                        { token: "keyword.control", regex: /:/ },
                        // Built-ins inside macro
                        { token: "support.function", regex: new RegExp(`\\b(?:${BUILTINS})\\b`) },
                        // NO function call rule here, so custom macros like amba(%0) remain white
                        ...lexRules,
                        { token: "identifier", regex: /[A-Za-z_@]\w*/ },
                        { token: "text", regex: /\s+/ }
                    ];

                    this.$rules = {
                        // ── start: top-level ──────────────────────────────
                        start: [
                            // Top-level function definition (col 0) without modifier (e.g. main()) → GREEN
                            {
                                token: ["entity.name.function", "paren.lparen"],
                                regex: new RegExp(`^(?!(?:${ALL_KW_RE_STR})\\b)([A-Za-z_@]\\w*)(\\s*\\()`),
                            },

                            // ── Preprocessor ───────────────────────────
                            // #define MACRONAME  → RED directive + GREEN macro
                            {
                                token: ["keyword.control", "text", "entity.name.function"],
                                regex: /(#\s*define)(\s+)([A-Za-z_@]\w*)/,
                                next: "macro_directive",
                            },
                            // #include <path> or "path"  → RED + string color
                            {
                                token: ["keyword.control", "text", "string"],
                                regex: /(#\s*include|#\s*tryinclude)(\s+)(<[^>]*>|"[^"]*")/,
                            },
                            // Other preprocessor directives or standalone # → RED
                            {
                                token: "keyword.control",
                                regex: /#\s*[A-Za-z_]\w*\b|#/,
                            },

                            // ── Keywords ────────────────────────────────
                            // Modifiers that precede a function name → RED + switch to after_modifier
                            {
                                token: "keyword.control",
                                regex: new RegExp(`\\b(?:${MODIFIERS})\\b`),
                                next: "after_modifier",
                            },
                            // new, enum, char → BLUE (storage.type)
                            {
                                token: "storage.type",
                                regex: new RegExp(`\\b(?:${STORAGE_KW})\\b`),
                            },
                            // Control flow, static, const, sizeof, etc → RED
                            {
                                token: "keyword.control",
                                regex: new RegExp(`\\b(?:${CTRL}|${OTHER_KW})\\b`),
                            },
                            // Language constants
                            {
                                token: "constant.language",
                                regex: new RegExp(`\\b(?:${LANG_CONST})\\b`),
                            },

                            // ── Function definitions & Namespaces ────────────────
                            // Function definition with prefix tag (e.g. anu:nama(...) or FUNC::nama(...)) → RED:GREEN
                            // Must be before the standalone tag rule!
                            {
                                token: ["keyword.control", "entity.name.function", "paren.lparen"],
                                regex: /^(\s*[A-Za-z_@]\w*(?:::|:)\s*)([A-Za-z_@]\w*)(\s*\()/,
                            },
                            // Namespace (e.g. SDB::) → RED (entire word + ::)
                            { token: "keyword.control", regex: /[A-Za-z_@]\w*::|::/ },
                            // Tags: Float: bool: WEAPON: → RED (whole Word: token)
                            { token: "keyword.control", regex: /[A-Za-z_]\w*:(?!:)/ },
                            // Standalone colon (case 0:, return type, etc.) → RED
                            { token: "keyword.control", regex: /:/ },

                            // Built-ins → BLUE (no lookahead, just the word)
                            {
                                token: "support.function",
                                regex: new RegExp(`\\b(?:${BUILTINS})\\b`),
                            },
                            // User-defined FUNCTION CALLS: identifier + ( → BLUE
                            {
                                token: ["support.function", "paren.lparen"],
                                regex: /([A-Za-z_@]\w*)(\s*\()/,
                            },
                            // Plain identifiers (variables) → default/no color
                            {
                                token: "identifier",
                                regex: /[A-Za-z_@]\w*/,
                            },

                            ...lexRules,
                        ],

                        // ── after_modifier: expect function name ─────────
                        // Entered after: public, stock, forward, native, hook, CMD, etc.
                        after_modifier: [
                            // Skip whitespace
                            { token: "text", regex: /\s+/ },
                            // Line comment (stay in modifier state)
                            { token: "comment", regex: /\/\/.*$/ },
                            // Namespace :: → RED
                            { token: "keyword.control", regex: /[A-Za-z_@]\w*::|::/ },
                            // Colon (e.g. CMD:anu) → RED
                            { token: "keyword.control", regex: /:/ },
                            // Tag before function name (Float:, bool:, etc.) → RED
                            { token: "keyword.control", regex: /[A-Za-z_]\w*:(?!:)/ },
                            // Function name (identifier before `(`) → GREEN
                            {
                                token: "entity.name.function",
                                regex: /[A-Za-z_@]\w*(?=\s*[({])/,
                                next: "start",
                            },
                            // If no match (e.g. `static name = ...`), fall back
                            { token: "text", regex: /(?=\S)/, next: "start" },
                        ],

                        // ── macro_directive: inside #define ──────────────
                        macro_directive: [
                            // If we didn't end with \ on the previous line, reset state on new line!
                            { token: "empty", regex: /^/, next: "start" },
                            // Line continuation (\ at EOL) -> go to continued macro state
                            { token: "keyword.control", regex: /\\(?:\s*)$/, next: "macro_directive_continued" },
                            ...macroRules
                        ],
                        macro_directive_continued: [
                            // Line continuation inside an already continued macro
                            { token: "keyword.control", regex: /\\(?:\s*)$/, next: "macro_directive_continued" },
                            // If no line continuation at the end of THIS line, the NEXT line should reset!
                            { token: "empty", regex: /$/, next: "macro_directive" },
                            ...macroRules
                        ],

                        // ── Block comment ─────────────────────────────────
                        block_comment: [
                            { token: "comment", regex: /\*\//, next: "start" },
                            { token: "comment", regex: /[^*]+/ },
                            { token: "comment", regex: /\*(?!\/)/ },
                        ],

                        // ── String literal ───────────────────────────────
                        string_lit: [
                            { token: "string", regex: /"/, next: "start" },
                            { token: "constant.language.escape", regex: /\\(?:n|t|r|\\|"|'|%|0|\d+)/ },
                            { token: "constant.character.escape", regex: /%[0-9]*\.?[0-9]*[a-zA-Z]/ }, // format specifier %s %d %02d %.2f
                            { token: "string", regex: /[^"\\%]+/ },
                            { token: "string", regex: /%/ },
                        ],
                    };
                };

                oop.inherits(PawnHighlightRules, TextHighlightRules);
                exports.PawnHighlightRules = PawnHighlightRules;
            }
        );

        (ace as any).define(
            "ace/mode/pawn",
            ["require", "exports", "module", "ace/lib/oop", "ace/mode/text", "ace/mode/pawn_highlight_rules"],
            function (require: any, exports: any) {
                const oop = require("ace/lib/oop");
                const TextMode = require("ace/mode/text").Mode;
                const PawnHighlightRules =
                    require("ace/mode/pawn_highlight_rules").PawnHighlightRules;

                const Mode = function (this: any) {
                    this.HighlightRules = PawnHighlightRules;
                    this.$behaviour = this.$defaultBehaviour;
                    this.lineCommentStart = "//";
                    this.blockComment = { start: "/*", end: "*/" };
                };
                oop.inherits(Mode, TextMode);
                exports.Mode = Mode;
            }
        );
    } catch (e) {
        console.warn("[Pawn Plugin] ACE mode registration failed:", e);
    }
}

export function applyAcePawnModeIfNeeded(): void {
    if (typeof ace === "undefined") return;
    try {
        const activeFile = editorManager?.activeFile;
        const ext = (activeFile?.filename || "").split(".").pop()?.toLowerCase();
        if (ext !== "pwn" && ext !== "inc") return;

        const session = (editorManager.editor as any)?.session;
        if (!session) return;

        const currentMode = session.getMode?.()?.$id || "";
        if (currentMode === "ace/mode/pawn") return;

        const PawnMode = ace.require("ace/mode/pawn")?.Mode;
        if (!PawnMode) return;
        session.setMode(new PawnMode());
    } catch (e) {
        console.warn("[Pawn Plugin] Failed to apply ACE pawn mode:", e);
    }
}

// ── CodeMirror StreamLanguage ─────────────────────────────────────────────

export function buildCodeMirrorPawnLanguage(languageApi: any): any {
    if (!languageApi?.StreamLanguage) return null;

    const tokenizer = {
        name: "pawn",
        token(stream: any, state: any) {
            if (stream.sol()) {
                if (!state.macroContinue) {
                    state.inMacro = false;
                }
                state.macroContinue = false;
            }

            if (state.inBlockComment) {
                if (stream.match(/.*?\*\//)) state.inBlockComment = false;
                else stream.skipToEnd();
                return "comment";
            }

            if (stream.eatSpace()) return null;

            if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
            if (stream.match("/*")) { state.inBlockComment = true; return "comment"; }

            if (stream.match(/\\\s*$/)) {
                state.macroContinue = true;
                return "keyword";
            }

            // Preprocessor
            if (stream.sol() && stream.peek() === "#") {
                stream.next();
                stream.eatSpace();
                const dir = stream.match(/[a-zA-Z]+/);
                if (dir && dir[0] === "define") {
                    state.inMacro = true;
                }
                return "keyword";
            }

            // String
            if (stream.match('"')) {
                while (!stream.eol()) {
                    if (stream.eat("\\")) { stream.next(); continue; }
                    if (stream.eat('"')) break;
                    stream.next();
                }
                return "string";
            }

            if (stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";

            // Numbers
            if (stream.match(/0x[0-9a-fA-F]+/)) return "number";
            if (stream.match(/0b[01]+/)) return "number";
            if (stream.match(/\d+\.?\d*/)) return "number";

            // Macro parameters (%0, %1, etc.)
            if (stream.match(/%[0-9]/)) return "variableName"; // mapped to var (orange-ish depending on theme) or just atom

            // Tag (Word:)
            if (stream.match(/[A-Za-z_]\w*:(?!:)/)) return "keyword";

            // Word
            const word = stream.match(/[A-Za-z_@]\w*/);
            if (word) {
                const w = word[0];
                if (KW_SET.has(w)) return "keyword";
                if (STORAGE_SET.has(w)) return "atom";
                if (BUILTIN_SET.has(w)) return "builtin";
                if (!state.inMacro && stream.match(/^\s*\(/, false)) return "builtin";
                return null; // plain identifier → no color
            }

            if (stream.match(/[+\-*/%&|^~<>=!?:]+/)) return "operator";
            stream.next();
            return null;
        },
        startState() { return { inBlockComment: false, inMacro: false, macroContinue: false }; },
        copyState(s: any) { return { ...s }; },
        languageData: {
            commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
            closeBrackets: { brackets: ["(", "[", "{", '"', "'"] },
        },
    };

    return languageApi.StreamLanguage.define(tokenizer);
}
