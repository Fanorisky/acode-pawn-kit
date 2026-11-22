import plugin from '../plugin.json';
import { snippets } from './snippets';
import { buildCodeMirrorPawnLanguage } from './pawnHighlight';
import { CompilerOutputPanel } from './compilerOutput';
import { preloadWorkspaceIncludes, type PreloadCallbacks } from './pawnCompiler';

const MODE = 'pawn-kit';
const COMMAND = 'fanorisky.pawn.kit.compile';
const SETTINGS_DEFAULT = { snippetDocs: false, enableCompiler: false };
const PAWN_FILE = /\.(pwn|inc)$/i;

type Settings = typeof SETTINGS_DEFAULT;

class PawnKit {
  baseUrl = '';
  private page: any = null;
  private appSettings: any;
  private editorLanguages: any = null;
  private registered = false;
  private language: any = null;
  private cm: any;
  private commands: any = null;
  private panel: CompilerOutputPanel | null = null;
  private completionOptions: any[] | null = null;
  private readonly onFileChange = () => this.syncOpenPawnFiles();

  constructor() {
    this.appSettings = acode.require('settings');
    const old = this.appSettings.value[plugin.id] || {};
    if (!this.appSettings.value[plugin.id] ||
        typeof old.snippetDocs !== 'boolean' || typeof old.enableCompiler !== 'boolean') {
      this.appSettings.value[plugin.id] = { ...SETTINGS_DEFAULT, ...old };
      this.appSettings.update(false);
    }
  }

  private get settings(): Settings { return this.appSettings.value[plugin.id]; }

  private getAutocompleteOptions(): any[] {
    if (this.completionOptions) return this.completionOptions;
    const snippetFn = this.cm.autocomplete.snippet;
    this.completionOptions = snippets
      .filter(item => item.fileTypes.some(ext => ext === 'pwn' || ext === 'inc'))
      .map(item => {
        const template = item.snippet;
        const label = item.prefix;
        const plain = template.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
        let apply: any;
        try { apply = snippetFn(template); }
        catch { apply = (view: any, _: any, from: number, to: number) =>
          view.dispatch({ changes: { from, to, insert: plain } }); }
        const option: any = { label, type: 'function', detail: item.type, apply };
        if (this.settings.snippetDocs && item.description) {
          const doc = item.description.replace(/<[^>]*>/g, '');
          option.info = () => { const el = document.createElement('div'); el.textContent = doc; return el; };
        }
        return option;
      });
    return this.completionOptions;
  }

  private readonly complete = (context: any) => {
    // Avoid allocating 1,946 snippet objects on every keystroke.
    const word = context.matchBefore(/#?[A-Za-z_@][\w@]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options: this.getAutocompleteOptions(), validFor: /^#?[A-Za-z_@][\w@]*$/ };
  };

  private registerLanguage() {
    this.editorLanguages = acode.require('editorLanguages');
    this.cm = {
      language: acode.require('@codemirror/language'),
      autocomplete: acode.require('@codemirror/autocomplete'),
    };
    if (!this.editorLanguages?.register || !this.cm?.language?.StreamLanguage?.define ||
        !this.cm?.autocomplete?.snippet) throw new Error('Acode CodeMirror 6 API is missing');

    // Build only once, then let Acode handle file language selection.
    this.language = buildCodeMirrorPawnLanguage(this.cm.language, this.complete);
    if (this.editorLanguages.get?.(MODE)) {
      // Another instance may still own the registration after a hot reload.
      // Avoid removing a language owned by another plugin.
      console.warn('[Pawn-Kit] Existing language registration:', MODE);
    } else {
      this.editorLanguages.register(MODE, ['pwn', 'inc'], 'Pawn', () => this.language);
      this.registered = true;
    }
    this.syncOpenPawnFiles();
  }

  private syncOpenPawnFiles() {
    if (!this.editorLanguages) return;
    for (const file of editorManager.files || []) {
      if (file?.type && file.type !== 'editor') continue;
      if (!PAWN_FILE.test(file?.filename || '') || typeof file.setMode !== 'function') continue;
      if (file.currentMode === MODE) continue;
      const mode = String(file.currentMode || '').toLowerCase();
      if (mode && mode !== 'text' && mode !== 'plain_text') continue;
      try { file.setMode(); }
      catch (err) { console.warn('[Pawn-Kit] Failed applying Pawn mode', err); }
    }
  }

  private installCompilerCommand() {
    if (!this.settings.enableCompiler || !this.baseUrl || !this.page) return;
    if (!this.panel) this.panel = new CompilerOutputPanel(this.page, { wasmBaseUrl: this.baseUrl });
    if (!this.commands) {
      this.commands = acode.require('commands');
      this.commands.addCommand({
        name: COMMAND,
        description: 'Compile Pawn (.pwn) with pawncc WASM',
        bindKey: { win: 'Ctrl-Shift-B', mac: 'Command-Shift-B' },
        exec: () => {
          if (!PAWN_FILE.test(editorManager.activeFile?.filename || '')) return false;
          this.panel?.show();
          this.panel?.run();
          return true;
        },
      });
      preloadWorkspaceIncludes(this.baseUrl, this.preloadCallbacks());
    }
  }

  private preloadCallbacks(): PreloadCallbacks {
    return {
      onStart: () => console.info('[Pawn-Kit] Loading includes'),
      onDone: (count, ms) => console.info(`[Pawn-Kit] ${count} includes loaded in ${ms}ms`),
      onError: err => console.warn('[Pawn-Kit] Include preload failed:', err),
    };
  }

  private removeCompilerCommand() {
    if (this.commands) {
      try { this.commands.removeCommand(COMMAND); } catch (err) { console.warn(err); }
      this.commands = null;
    }
    this.panel?.destroy();
    this.panel = null;
  }

  get settingsObj(): any {
    return {
      list: [
        { key: 'snippetDocs', text: 'Show docs in Pawn autocomplete', checkbox: !!this.settings.snippetDocs },
        { key: 'enableCompiler', text: 'Enable Pawn Compiler (Ctrl+Shift+B)', checkbox: !!this.settings.enableCompiler },
      ],
      cb: (key: keyof Settings, value: boolean) => {
        this.settings[key] = Boolean(value);
        this.appSettings.update();
        if (key === 'snippetDocs') this.completionOptions = null;
        if (key === 'enableCompiler') {
          if (value) this.installCompilerCommand();
          else this.removeCompilerCommand();
        }
      },
    };
  }

  async init(baseUrl: string, page: any) {
    if (editorManager.isCodeMirror !== true) {
      throw new Error('Pawn-Kit 1.0.7 requires Acode CodeMirror 6');
    }
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.page = page;
    this.registerLanguage();
    for (const event of ['switch-file', 'file-loaded', 'new-file', 'rename-file'])
      editorManager.on(event, this.onFileChange);
    this.installCompilerCommand();
  }

  destroy() {
    for (const event of ['switch-file', 'file-loaded', 'new-file', 'rename-file'])
      editorManager.off(event, this.onFileChange);
    this.removeCompilerCommand();
    if (this.registered) {
      this.editorLanguages?.unregister?.(MODE);
      this.registered = false;
      // Let Acode re-detect the default mode after unloading this plugin.
      for (const file of editorManager.files || []) {
        if (file?.currentMode === MODE && typeof file.setMode === 'function') {
          try { file.setMode(); } catch (err) { console.warn(err); }
        }
      }
    }
    this.editorLanguages = null;
    this.language = null;
    this.completionOptions = null;
  }
}

if ((window as any).acode) {
  const kit = new PawnKit();
  acode.setPluginInit(plugin.id, (baseUrl: string, page: any) => kit.init(baseUrl, page), kit.settingsObj);
  acode.setPluginUnmount(plugin.id, () => kit.destroy());
}
