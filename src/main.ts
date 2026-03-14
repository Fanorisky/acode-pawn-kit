import plugin from "../plugin.json";
import { getCurrentFileType } from "./helpers";
import { snippets, Snippet } from "./snippets";
import {
    codeMirrorSnippets,
    CodeMirrorSnippet,
    CODEMIRROR_FILE_NAME_TOKEN,
} from "./codemirrorSnippets";
import {
    registerAcePawnMode,
    applyAcePawnModeIfNeeded,
    buildCodeMirrorPawnLanguage,
} from "./pawnHighlight";
import { CompilerOutputPanel } from "./compilerOutput";
import { preloadWorkspaceIncludes, type PreloadCallbacks } from "./pawnCompiler";


const appSettings = acode.require("settings");

const ACE_DOC_STYLE_ID = "overideCompletionDocs";
const CM_COMPLETION_STYLE_ID = "reactSnippetCodeMirrorStyles";

const CODEMIRROR_DONT_COMPLETE = [
    "TemplateString",
    "String",
    "RegExp",
    "LineComment",
    "BlockComment",
    "VariableDefinition",
    "TypeDefinition",
    "Label",
    "PropertyDefinition",
    "PropertyName",
    "PrivatePropertyDefinition",
    "PrivatePropertyName",
    "JSXText",
    "JSXAttributeValue",
    "JSXOpenTag",
    "JSXCloseTag",
    "JSXSelfClosingTag",
    ".",
    "?.",
];

function getAceSnippetManager(): any {
    try {
        if (typeof ace === "undefined") {
            return null;
        }
        return ace.require("ace/snippets")?.snippetManager ?? null;
    } catch {
        return null;
    }
}

const aceSnippetManager = getAceSnippetManager();

function getCodeMirrorAutocompleteApi(): any {
    try {
        return (
            acode.require("@codemirror/autocomplete") ||
            acode.require("codemirror")?.autocomplete ||
            null
        );
    } catch {
        try {
            return acode.require("codemirror")?.autocomplete || null;
        } catch {
            return null;
        }
    }
}

function getCodeMirrorStateApi(): any {
    try {
        return (
            acode.require("@codemirror/state") ||
            acode.require("codemirror")?.state ||
            null
        );
    } catch {
        try {
            return acode.require("codemirror")?.state || null;
        } catch {
            return null;
        }
    }
}

declare var extraSyntaxHighlightsInstalled: boolean;

class ReactSnippet {
    public baseUrl: string | undefined;

    private reactCompleter: any = null;
    private sourceSnippets: Snippet[] = [];
    private codeMirrorSourceSnippets: CodeMirrorSnippet[] = [];

    private codeMirrorCompletionCompartment: any = null;
    private codeMirrorLanguageCompartment: any = null;
    private hasCodeMirrorCompletionAttached = false;
    private attachedCodeMirrorState: any = null;
    private hasEditorLifecycleListeners = false;
    private codeMirrorAttachTimers: ReturnType<typeof setTimeout>[] = [];
    private readonly codeMirrorSourceCache = new Map<string, any>();

    private autocompletionInitialized = false;

    // ── Compiler ─────────────────────────────────────────────────────────
    private compilerPanel: CompilerOutputPanel | null = null;
    private compilerPage: WCPage | null = null;
    private compileBtn: HTMLElement | null = null;
    private readonly onKeyDown = (e: KeyboardEvent) => {
        // Ctrl+Shift+B
        if (e.ctrlKey && e.shiftKey && e.key === 'B') {
            e.preventDefault();
            e.stopPropagation();
            this.openCompilerPanel();
            this.compilerPanel?.run();
        }
    };

    private readonly codeMirrorLifecycleEvents: FileEvent[] = [
        "switch-file",
        "file-loaded",
    ];

    private readonly onCodeMirrorLifecycleChange = () => {
        this.syncAutocompletionForCurrentEditor();
        // Re-apply syntax highlight on file switch
        if (!this.isCodeMirrorEditor) {
            applyAcePawnModeIfNeeded();
        } else {
            this.applyCodeMirrorPawnLanguage();
        }
        // Register F5 run hook for the newly active file
        if (this.settings.enableCompiler) {
            this._registerPawnRunHook();
        }
    };

    private readonly codeMirrorCompletionSource = (context: any) => {
        const completionSource = this.createCodeMirrorCompletionSource();
        return completionSource ? completionSource(context) : null;
    };

    constructor() {
        if (!appSettings.value[plugin.id]) {
            appSettings.value[plugin.id] = {
                snippetDocs: false,
                enableCompiler: false,
            };
            appSettings.update(false);
        } else if (appSettings.value[plugin.id].enableCompiler === undefined) {
            appSettings.value[plugin.id].enableCompiler = false;
            appSettings.update(false);
        }
    }

    private get editorInstance(): any {
        return editorManager.editor as any;
    }

    private get isCodeMirrorEditor(): boolean {
        return editorManager.isCodeMirror === true;
    }

    private get fileNameWithoutExtension(): string {
        const fileNameWithExtension = editorManager?.activeFile?.filename || "";
        const lastDotIndex = fileNameWithExtension.lastIndexOf(".");
        if (lastDotIndex === -1) {
            return fileNameWithExtension;
        }
        return fileNameWithExtension.slice(0, lastDotIndex);
    }

    private getTypeAliases(fileType: string): string[] {
        const normalized = String(fileType || "").toLowerCase();
        const aliases = new Set<string>([normalized]);

        if (normalized === "javascript" || normalized === "js") aliases.add("jsx");
        if (normalized === "typescript" || normalized === "ts") aliases.add("tsx");
        if (normalized === "javascriptreact") aliases.add("jsx");
        if (normalized === "typescriptreact") aliases.add("tsx");

        return Array.from(aliases);
    }

    private getRelevantSnippets<T extends { fileTypes: string[] }>(
        sourceSnippets: T[],
        fileType?: string
    ): T[] {
        const currentFileType = (fileType || getCurrentFileType()).toLowerCase();
        const aliases = this.getTypeAliases(currentFileType);

        return sourceSnippets.filter(snippet =>
            snippet.fileTypes.some(type => aliases.includes(type.toLowerCase()))
        );
    }

    private setAceVariables() {
        const variables = aceSnippetManager?.variables;
        if (!variables) return;

        variables.FILE_NAME = () => {
            return this.fileNameWithoutExtension;
        };
    }

    private removeAceAutocompletion() {
        const editor = this.editorInstance;
        if (!editor?.completers || !this.reactCompleter) {
            return;
        }
        editor.completers = editor.completers.filter(
            (completer: any) => completer !== this.reactCompleter
        );
        this.reactCompleter = null;
    }

    private initializeAceAutocompletion(): void {
        this.setAceVariables();

        const editor = this.editorInstance;
        if (!Array.isArray(editor?.completers)) {
            return;
        }

        this.removeAceAutocompletion();

        this.reactCompleter = {
            getCompletions: (
                _editor: AceAjax.Editor,
                session: any,
                _pos: AceAjax.Position,
                _prefix: string,
                callback: (err: any, results: AceAjax.Completion[]) => void
            ) => {
                const currentFileType = getCurrentFileType(session);
                const relevantSnippets = this.getRelevantSnippets(
                    this.sourceSnippets,
                    currentFileType
                );

                callback(
                    null,
                    relevantSnippets.map(snippet => {
                        const baseSnippet = {
                            caption: snippet.prefix,
                            snippet: snippet.snippet,
                            meta: snippet.type,
                            value: snippet.snippet,
                            type: "snippet",
                            docHTML: snippet.description || ""
                        };

                        if (
                            typeof extraSyntaxHighlightsInstalled !== "undefined" &&
                            extraSyntaxHighlightsInstalled
                        ) {
                            return {
                                ...baseSnippet,
                                icon: "icon pawn-snippet-icon"
                            };
                        }

                        return baseSnippet;
                    })
                );
            }
        };

        editor.completers.unshift(this.reactCompleter);
    }

    private createCodeMirrorInfo(description: string): () => HTMLElement {
        return () => {
            const infoElement = document.createElement("div");
            infoElement.innerHTML = description;
            return infoElement;
        };
    }

    private getCodeMirrorCompletionCacheKey(fileType: string): string {
        return [
            fileType.toLowerCase(),
            this.fileNameWithoutExtension,
            this.settings.snippetDocs ? "docs" : "nodocs",
        ].join("|");
    }

    private resolveCodeMirrorTemplate(template: string): string {
        return template
            .split(CODEMIRROR_FILE_NAME_TOKEN)
            .join(this.fileNameWithoutExtension);
    }

    private mapCodeMirrorCompletion(
        snippet: CodeMirrorSnippet,
        snippetCompletion?: any
    ): any {
        const completion = {
            label: snippet.prefix,
            type: "pawn-snippet",
            detail: snippet.type,
            ...(this.settings.snippetDocs &&
                snippet.description && {
                info: this.createCodeMirrorInfo(snippet.description),
            }),
        };

        if (typeof snippetCompletion === "function") {
            try {
                return snippetCompletion(
                    this.resolveCodeMirrorTemplate(snippet.codeMirrorSnippet),
                    completion
                );
            } catch (error) {
                console.warn(
                    `Failed to create CodeMirror snippet completion for ${snippet.prefix}`,
                    error
                );
            }
        }

        return {
            ...completion,
            apply: (view: any, _completion: any, from: number, to: number) => {
                const expandedSnippet = this.resolveCodeMirrorTemplate(
                    snippet.fallbackSnippet
                );
                view.dispatch({
                    changes: { from, to, insert: expandedSnippet },
                    selection: {
                        anchor: from + expandedSnippet.length,
                        head: from + expandedSnippet.length
                    }
                });
            },
        };
    }

    private buildCodeMirrorCompletionSource(fileType: string): any {
        const autocompleteApi = getCodeMirrorAutocompleteApi();
        const relevantSnippets = this.getRelevantSnippets(
            this.codeMirrorSourceSnippets,
            fileType
        );

        if (
            !autocompleteApi ||
            !relevantSnippets.length ||
            typeof autocompleteApi.completeFromList !== "function"
        ) {
            return null;
        }

        const completions = relevantSnippets.map(snippet =>
            this.mapCodeMirrorCompletion(
                snippet,
                autocompleteApi.snippetCompletion
            )
        );

        let completionSource = autocompleteApi.completeFromList(completions);
        if (typeof autocompleteApi.ifNotIn === "function") {
            completionSource = autocompleteApi.ifNotIn(
                CODEMIRROR_DONT_COMPLETE,
                completionSource
            );
        }

        return completionSource;
    }

    private createCodeMirrorCompletionSource(): any {
        const currentFileType = getCurrentFileType();
        const cacheKey = this.getCodeMirrorCompletionCacheKey(currentFileType);
        const cachedSource = this.codeMirrorSourceCache.get(cacheKey);
        if (cachedSource) {
            return cachedSource;
        }

        const completionSource = this.buildCodeMirrorCompletionSource(currentFileType);
        if (!completionSource) {
            return null;
        }

        this.codeMirrorSourceCache.set(cacheKey, completionSource);
        return completionSource;
    }

    private addEditorLifecycleListeners() {
        if (this.hasEditorLifecycleListeners) {
            return;
        }
        this.codeMirrorLifecycleEvents.forEach(eventName => {
            editorManager.on(eventName, this.onCodeMirrorLifecycleChange);
        });
        this.hasEditorLifecycleListeners = true;
    }

    private removeEditorLifecycleListeners() {
        if (!this.hasEditorLifecycleListeners) {
            return;
        }
        this.codeMirrorLifecycleEvents.forEach(eventName => {
            editorManager.off(eventName, this.onCodeMirrorLifecycleChange);
        });
        this.hasEditorLifecycleListeners = false;
    }

    private clearCodeMirrorAttachTimers() {
        this.codeMirrorAttachTimers.forEach(timer => clearTimeout(timer));
        this.codeMirrorAttachTimers = [];
    }

    private queueInitialAutocompletionSync() {
        this.clearCodeMirrorAttachTimers();
        [0, 300, 900, 1800, 3500, 7000].forEach(delay => {
            const timer = setTimeout(() => {
                this.syncAutocompletionForCurrentEditor();
            }, delay);
            this.codeMirrorAttachTimers.push(timer);
        });
    }

    private configureCodeMirrorAutocompletion() {
        const editor = this.editorInstance;
        const codeMirrorState = getCodeMirrorStateApi();
        const EditorState = codeMirrorState?.EditorState;
        const StateEffect = codeMirrorState?.StateEffect;
        const Compartment = codeMirrorState?.Compartment;

        if (
            !editor?.state ||
            !editor?.dispatch ||
            !EditorState?.languageData?.of ||
            !StateEffect?.appendConfig?.of ||
            !Compartment
        ) {
            return;
        }

        const extension = EditorState.languageData.of(() => [
            { autocomplete: this.codeMirrorCompletionSource },
        ]);

        if (!this.codeMirrorCompletionCompartment) {
            this.codeMirrorCompletionCompartment = new Compartment();
        }

        if (this.attachedCodeMirrorState !== editor.state) {
            this.hasCodeMirrorCompletionAttached = false;
        }

        if (this.hasCodeMirrorCompletionAttached) {
            try {
                editor.dispatch({
                    effects: this.codeMirrorCompletionCompartment.reconfigure(
                        extension
                    ),
                });
                this.attachedCodeMirrorState = editor.state;
                return;
            } catch {
                this.hasCodeMirrorCompletionAttached = false;
            }
        }

        editor.dispatch({
            effects: StateEffect.appendConfig.of(
                this.codeMirrorCompletionCompartment.of(extension)
            ),
        });
        this.hasCodeMirrorCompletionAttached = true;
        this.attachedCodeMirrorState = editor.state;
    }

    private removeCodeMirrorAutocompletion() {
        if (!this.hasCodeMirrorCompletionAttached) {
            return;
        }

        if (!this.codeMirrorCompletionCompartment) {
            this.hasCodeMirrorCompletionAttached = false;
            this.attachedCodeMirrorState = null;
            return;
        }

        const editor = this.editorInstance;
        if (!editor?.dispatch) {
            this.hasCodeMirrorCompletionAttached = false;
            this.attachedCodeMirrorState = null;
            return;
        }

        try {
            editor.dispatch({
                effects: this.codeMirrorCompletionCompartment.reconfigure([]),
            });
        } finally {
            this.hasCodeMirrorCompletionAttached = false;
            this.attachedCodeMirrorState = null;
        }
    }

    private initializeCodeMirrorAutocompletion(): void {
        this.removeAceAutocompletion();
        this.configureCodeMirrorAutocompletion();
    }

    private syncAutocompletionForCurrentEditor(): void {
        if (this.isCodeMirrorEditor) {
            this.initializeCodeMirrorAutocompletion();
            return;
        }

        this.clearCodeMirrorAttachTimers();
        this.removeCodeMirrorAutocompletion();
        this.initializeAceAutocompletion();
    }

    private initializeAutocompletion(sourceSnippets: Snippet[] | []): void {
        this.sourceSnippets = [...sourceSnippets];
        this.codeMirrorSourceSnippets = [...codeMirrorSnippets];
        this.codeMirrorSourceCache.clear();
        this.addEditorLifecycleListeners();
        this.syncAutocompletionForCurrentEditor();
        this.queueInitialAutocompletionSync();
    }

    private setStyle(styleId: string, content: string): void {
        let styleNode = document.getElementById(styleId) as
            | HTMLStyleElement
            | null;
        if (!styleNode) {
            styleNode = document.createElement("style");
            styleNode.id = styleId;
            document.head.append(styleNode);
        }
        styleNode.textContent = content;
    }

    private removeStyle(styleId: string): void {
        document.getElementById(styleId)?.remove();
    }

    private syncCompletionStyles(): void {
        if (this.settings.snippetDocs) {
            this.setStyle(
                ACE_DOC_STYLE_ID,
                `
                .ace_tooltip.ace_doc-tooltip {
                    display: flex !important;
                    background-color: var(--secondary-color);
                    color: var(--secondary-text-color);
                    max-width: 68%;
                    white-space: pre-wrap;
                }
                .cm-tooltip.cm-completionInfo {
                    background-color: var(--secondary-color);
                    color: var(--secondary-text-color);
                    max-width: 68%;
                    white-space: pre-wrap;
                }
                `
            );
        } else {
            this.removeStyle(ACE_DOC_STYLE_ID);
        }

        this.setStyle(
            CM_COMPLETION_STYLE_ID,
            `
            .cm-tooltip-autocomplete .cm-completionIcon-pawn-snippet:after,
            .cm-tooltip-autocomplete .cm-completionIcon-pawn-snippet::after {
                content: "[P]";
                color: var(--active-color);
                font-size: 0.75rem;
                line-height: 1;
                font-weight: 700;
                font-family: monospace;
            }
            `
        );
    }

    async init(
        $page: WCPage,
        cacheFile: any,
        cacheFileUrl: string
    ): Promise<void> {
        if (!this.autocompletionInitialized) {
            this.initializeAutocompletion(snippets || []);
            this.autocompletionInitialized = true;
        } else {
            this.syncAutocompletionForCurrentEditor();
            this.queueInitialAutocompletionSync();
        }

        // ── Syntax Highlighting ──
        registerAcePawnMode();
        applyAcePawnModeIfNeeded();
        this.applyCodeMirrorPawnLanguage();

        this.syncCompletionStyles();
        if (this.baseUrl) {
            acode.addIcon("pawn-snippet-icon", this.baseUrl + "icon.png");
        }

        // ── Compiler ──
        if (this.settings.enableCompiler) {
            this.initCompiler($page);
        }
    }

    private applyCodeMirrorPawnLanguage(): void {
        if (!this.isCodeMirrorEditor) return;
        try {
            const activeFile = editorManager?.activeFile;
            const filename = activeFile?.filename || "";
            const ext = filename.split(".").pop()?.toLowerCase();
            if (ext !== "pwn" && ext !== "inc") return;

            const langApi = (() => {
                try { return acode.require("@codemirror/language") || (acode.require("codemirror") as any)?.language || null; }
                catch { try { return (acode.require("codemirror") as any)?.language || null; } catch { return null; } }
            })();

            const stateApi = getCodeMirrorStateApi();
            const pawnLang = buildCodeMirrorPawnLanguage(langApi);
            if (!pawnLang || !stateApi) return;

            const Compartment = stateApi.Compartment;
            const StateEffect = stateApi.StateEffect;
            if (!Compartment || !StateEffect) return;

            const editor = this.editorInstance;
            if (!editor?.dispatch) return;

            if (!this.codeMirrorLanguageCompartment) {
                this.codeMirrorLanguageCompartment = new Compartment();
                editor.dispatch({
                    effects: StateEffect.appendConfig.of(
                        this.codeMirrorLanguageCompartment.of(pawnLang)
                    )
                });
            } else {
                editor.dispatch({
                    effects: this.codeMirrorLanguageCompartment.reconfigure(pawnLang)
                });
            }
        } catch (e) {
            console.warn("[Pawn Plugin] CodeMirror language apply failed:", e);
        }
    }

    public get settingsObj() {
        return {
            list: [
                {
                    key: "snippetDocs",
                    text: "Enable snippet docs",
                    checkbox: !!this.settings.snippetDocs,
                    info: `To show brief docs about the snippets`,
                },
                {
                    key: "enableCompiler",
                    text: "Enable Pawn Compiler (Ctrl+Shift+B)",
                    checkbox: !!this.settings.enableCompiler,
                    info: `Compile .pwn files using pawncc WASM. Requires .pawn/compile.json in project root.`,
                },
            ],
            cb: (key: string, value: boolean | string) => {
                this.settings[key] = value;
                appSettings.update();

                if (key === "snippetDocs") {
                    this.codeMirrorSourceCache.clear();
                    if (this.isCodeMirrorEditor) {
                        this.configureCodeMirrorAutocompletion();
                    }
                    this.syncCompletionStyles();
                }

                if (key === "enableCompiler") {
                    if (value && this.compilerPage) {
                        this.initCompiler(this.compilerPage);
                    } else {
                        this.destroyCompiler();
                    }
                }
            },
        };
    }

    private initCompiler($page: WCPage): void {
        if (!this.baseUrl) return;
        this.compilerPage = $page;

        if (!this.compilerPanel) {
            this.compilerPanel = new CompilerOutputPanel($page, {
                wasmBaseUrl: this.baseUrl,
            });
        }

        document.addEventListener("keydown", this.onKeyDown, true);
        this._injectCompileButton();

        // Preload include dirs into WASM FS in background so first compile is fast.
        preloadWorkspaceIncludes(this.baseUrl, this._preloadCallbacks());

        // Register F5 hook for whichever .pwn file is currently active
        this._registerPawnRunHook();
    }

    /** Returns notification callbacks for preloadWorkspaceIncludes. */
    private _preloadCallbacks(): PreloadCallbacks {
        return {
            onStart: () => {
                this._toast("⚙ Pawn: Loading includes...", 2000);
            },
            onDone: (fileCount, elapsedMs) => {
                this._notify(
                    "Pawn Compiler",
                    `✓ ${fileCount} include files ready (${elapsedMs}ms)`,
                    "success"
                );
            },
            onError: (err) => {
                this._notify(
                    "Pawn Compiler",
                    `⚠ Preload failed: ${String(err)}`,
                    "error"
                );
            },
        };
    }

    private _toast(msg: string, ms = 3000): void {
        try {
            const toastFn: ((msg: string, ms: number) => void) | undefined =
                (window as any).toast ?? (() => {
                    try { return acode.require("toast"); } catch { return undefined; }
                })();
            toastFn?.(msg, ms);
        } catch { /* silent */ }
    }

    private _notify(title: string, msg: string, type: "success" | "error" | "info" = "info"): void {
        try {
            (acode as any).pushNotification(title, msg, { autoClose: true, type });
        } catch {
            this._toast(`${title}: ${msg}`, 4000);
        }
    }

    /**
     * Register run hook on the active file if it's a .pwn/.inc file.
     * This makes F5 / the ▶ run button trigger our compiler instead of
     * Acode's default "open in browser" behaviour.
     * Safe to call multiple times — overwrites previous registration.
     */
    private _registerPawnRunHook(): void {
        const file = editorManager?.activeFile as any;
        if (!file) return;
        const ext = (file.filename || "").split(".").pop()?.toLowerCase();
        if (ext !== "pwn" && ext !== "inc") return;

        // Tell Acode this file can be run (shows ▶ button, enables F5)
        if (typeof file.writeCanRun === "function") {
            file.writeCanRun(() => true);
        }

        // Override run() on this file instance — called by Acode on F5
        file.run = () => {
            this.openCompilerPanel();
            this.compilerPanel?.run();
        };
    }

    private destroyCompiler(): void {
        document.removeEventListener("keydown", this.onKeyDown, true);
        this.compileBtn?.remove();
        this.compileBtn = null;
        this.compilerPanel?.destroy();
        this.compilerPanel = null;
    }

    private openCompilerPanel(): void {
        if (!this.compilerPanel && this.compilerPage) {
            this.initCompiler(this.compilerPage);
        }
        this.compilerPanel?.show();
    }

    private _injectCompileButton(): void {
        if (this.compileBtn) return;
        try {
            const header = document.querySelector(
                "#header .right, .header .quick-tools, header .actions"
            ) as HTMLElement | null;
            if (!header) return;

            const btn = document.createElement("span");
            btn.title = "Compile Pawn (Ctrl+Shift+B)";
            btn.className = "icon pawn-compile-btn";
            btn.style.cssText = "cursor:pointer;font-size:18px;margin:0 4px;opacity:0.85;user-select:none;";
            btn.textContent = "⚙";
            btn.onclick = (e) => {
                e.stopPropagation();
                this.openCompilerPanel();
                this.compilerPanel?.run();
            };
            header.appendChild(btn);
            this.compileBtn = btn;
        } catch {
            // ignore if header not found
        }
    }

    private get settings() {
        return appSettings.value[plugin.id];
    }

    async destroy() {
        this.removeAceAutocompletion();
        this.removeEditorLifecycleListeners();
        this.clearCodeMirrorAttachTimers();
        this.removeCodeMirrorAutocompletion();

        // Restore default language on CodeMirror
        if (this.codeMirrorLanguageCompartment) {
            try {
                const stateApi = (() => {
                    try { return acode.require("@codemirror/state") || acode.require("codemirror")?.state || null; }
                    catch { return null; }
                })();
                const editor = this.editorInstance;
                if (editor?.dispatch && stateApi) {
                    editor.dispatch({
                        effects: this.codeMirrorLanguageCompartment.reconfigure([])
                    });
                }
            } catch { /* ignore */ }
            this.codeMirrorLanguageCompartment = null;
        }

        this.removeStyle(ACE_DOC_STYLE_ID);
        this.removeStyle(CM_COMPLETION_STYLE_ID);
        this.destroyCompiler();
    }
}

if (window.acode) {
    const acodePlugin = new ReactSnippet();
    acode.setPluginInit(
        plugin.id,
        async (
            baseUrl: string,
            $page: WCPage,
            { cacheFileUrl, cacheFile }: any
        ) => {
            if (!baseUrl.endsWith("/")) {
                baseUrl += "/";
            }
            acodePlugin.baseUrl = baseUrl;
            await acodePlugin.init($page, cacheFile, cacheFileUrl);
        },
        acodePlugin.settingsObj
    );
    acode.setPluginUnmount(plugin.id, () => {
        acodePlugin.destroy();
    });
}