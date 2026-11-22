/** CodeMirror 6-only Pawn tokenizer for Acode 1.0.7.
 * No Ace aliases, direct editor mutations, DOM decorations, or custom highlights.
 */
const CONTROL = new Set('if else for while do switch case default break continue return goto exit sleep state assert'.split(' '));
const MODIFIERS = new Set('public forward native stock hook task ptask timer ALS CMD COMMAND inline using operator DialogCreate DialogResponse DialogInterrupt'.split(' '));
const DECLARATIONS = new Set('new enum char static const'.split(' '));
const KEYWORDS = new Set('sizeof tagof defined'.split(' '));
const CONSTANTS = new Set('true false INVALID_PLAYER_ID INVALID_VEHICLE_ID cellmin cellmax'.split(' '));
const BUILTINS = new Set(`print printf format strlen strcopy strcat strcmp strfind strdel
strins strpack strunpack strval valstr numargs getarg setarg random min max
clamp floatstr float floatround floatabs floatsqroot IsPlayerConnected
SendClientMessage GetTickCount SetTimer SetTimerEx KillTimer
CallLocalFunction CallRemoteFunction`.split(/\s+/));

export interface PawnTokenState {
  blockComment: boolean;
  quote: string | null;
  inMacro: boolean;
  continued: boolean;
  afterModifier: boolean;
  expectMacroName: boolean;
  includePath: boolean;
  depth: number;
}

export function makePawnStreamParser(completionSource?: (ctx: any) => any) {
  return {
    name: 'pawn',
    startState(): PawnTokenState {
      return { blockComment: false, quote: null, inMacro: false, continued: false,
        afterModifier: false, expectMacroName: false, includePath: false, depth: 0 };
    },
    copyState(s: PawnTokenState): PawnTokenState { return { ...s }; },
    token(stream: any, state: PawnTokenState): string | null {
      // Respect leading spaces before #. A CodeMirror stream's sol() becomes false
      // after eatSpace(), so process directives before whitespace.
      if (stream.sol()) {
        state.inMacro = state.continued;
        state.continued = false;
        state.includePath = false;
        if (!state.inMacro) {
          state.afterModifier = false;
          state.expectMacroName = false;
        }
      }
      if (state.blockComment) {
        if (stream.match(/^.*?\*\//)) state.blockComment = false;
        else stream.skipToEnd();
        return 'comment';
      }
      if (state.quote) {
        const quote = state.quote;
        while (!stream.eol()) {
          if (stream.eat('\\')) { if (!stream.eol()) stream.next(); continue; }
          if (stream.eat(quote)) { state.quote = null; break; }
          stream.next();
        }
        return 'string';
      }
      if (stream.sol() && stream.match(/^\s*#\s*[A-Za-z_]\w*/)) {
        const directive = stream.current().replace(/^\s*#\s*/, '');
        state.inMacro = directive === 'define';
        state.expectMacroName = state.inMacro;
        state.includePath = directive === 'include' || directive === 'tryinclude';
        return 'keyword';
      }
      if (stream.eatSpace()) return null;
      if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
      if (stream.match('/*')) { state.blockComment = true; return 'comment'; }
      if (stream.match(/^\\\s*$/)) {
        if (state.inMacro) state.continued = true;
        return 'keyword';
      }
      if (state.includePath && stream.match(/^<[^>\n]*>/)) {
        state.includePath = false;
        return 'string';
      }
      if (stream.match('"') || stream.match("'")) {
        const quote = stream.current();
        state.quote = quote;
        while (!stream.eol()) {
          if (stream.eat('\\')) { if (!stream.eol()) stream.next(); continue; }
          if (stream.eat(quote)) { state.quote = null; break; }
          stream.next();
        }
        return 'string';
      }
      if (stream.match(/^0x[\da-fA-F]+\b/) || stream.match(/^0b[01]+\b/) ||
          stream.match(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b/)) return 'number';
      if (state.inMacro && stream.match(/^%\d+/)) return 'variableName';
      if (stream.match(/^[A-Za-z_@]\w*::|^::/)) return 'namespace';
      if (stream.match(/^[A-Za-z_]\w*:(?!:)/)) return 'typeName';
      const name = stream.match(/^[A-Za-z_@]\w*/);
      if (name) {
        const word = name[0];
        if (state.expectMacroName) {
          state.expectMacroName = false;
          return 'macroName';
        }
        if (MODIFIERS.has(word)) { state.afterModifier = true; return 'keyword'; }
        if (CONTROL.has(word) || KEYWORDS.has(word)) { state.afterModifier = false; return 'keyword'; }
        if (DECLARATIONS.has(word)) return 'keyword';
        if (CONSTANTS.has(word)) return 'bool';
        if (BUILTINS.has(word)) { state.afterModifier = false; return 'builtin'; }
        const functionLike = stream.match(/^\s*\(/, false);
        if (state.afterModifier && functionLike) {
          state.afterModifier = false;
          return 'variableName.definition';
        }
        if (state.afterModifier && !functionLike && !stream.match(/^\s*(?:::|:)/, false))
          state.afterModifier = false;
        if (functionLike) {
          // Function at the beginning of a top-level line is a definition.
          if (state.depth === 0 && /^\s*[A-Za-z_@]\w*$/.test(stream.string.slice(0, stream.pos)))
            return 'variableName.definition';
          return state.inMacro ? 'variableName' : 'variableName.function';
        }
        return 'variableName';
      }
      if (stream.match('{')) { state.depth++; return 'punctuation'; }
      if (stream.match('}')) { state.depth = Math.max(0, state.depth - 1); return 'punctuation'; }
      if (stream.match(/^[()\[\]]/)) return 'punctuation';
      if (stream.match(/^(?:===|!==|==|!=|<=|>=|&&|\|\||<<|>>|\+\+|--|[+\-*/%&|^~<>=!?]+)/)) return 'operator';
      if (stream.match(/^[;,.#:]/)) return 'punctuation';
      stream.next();
      return null;
    },
    languageData: {
      commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
      closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
      ...(completionSource ? { autocomplete: completionSource } : {}),
    },
  };
}

export function buildCodeMirrorPawnLanguage(languageModule: any, completionSource?: (ctx: any) => any): any {
  if (!languageModule?.StreamLanguage?.define) throw new Error('Acode CodeMirror StreamLanguage unavailable');
  return languageModule.StreamLanguage.define(makePawnStreamParser(completionSource));
}
