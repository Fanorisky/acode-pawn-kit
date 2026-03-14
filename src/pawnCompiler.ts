/**
 * Pawn Compiler Module
 *
 * Reads .pawn/compile.json, mounts source + includes into the pawncc WASM
 * virtual filesystem, runs the compiler, and returns structured output.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface CompileTask {
    label: string;
    args: string[];
    includes?: string[];
    group?: {
        kind: "build" | "test";
        isDefault?: boolean;
    };
}

export interface CompileConfig {
    version: string;
    tasks: CompileTask[];
}

export interface CompileDiagnostic {
    /** WASM FS path of the file */
    file: string;
    /** 1-based line number */
    line: number;
    /** "error" | "warning" | "fatal error" */
    type: string;
    /** Numeric code, e.g. "001" */
    code: string;
    /** Human-readable message */
    message: string;
}

export interface CompileResult {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    diagnostics: CompileDiagnostic[];
    /** Acode URL of the saved .amx file, if compilation succeeded */
    outputUrl?: string;
    /** Size of the .amx file in bytes */
    outputSize?: number;
}

// ── File mount cache ──────────────────────────────────────────────────────
// Persists across compile runs (singleton lifetime = WASM module lifetime).
// Key: acodeUrl, Value: { size, wasmPath } — skip re-mount if size unchanged.
interface MountCacheEntry { size: number; mtime: number; wasmPath: string; data: Uint8Array }

// Persistent file cache: acodeUrl → entry. Never cleared — survives across compiles.
// Allows skip-remount for unchanged include files on subsequent compiles.
const _mountCache = new Map<string, MountCacheEntry>();

// Tracks which wasmPaths are currently in WASM FS. Cleared when FS is reset.
const _wasmFsFiles = new Set<string>();

// lsDir result cache — keyed by acodeDir URL.
// Entries expire after LS_CACHE_TTL_MS to pick up include dir changes
// (e.g. user adds a new .inc file), while still skipping redundant lsDir
// calls within a single compile run.
const LS_CACHE_TTL_MS = 30_000; // 30 seconds
const _lsDirCache = new Map<string, { entries: any[]; ts: number }>();

function lsDirCached(fsOperation: FsOperation, url: string): Promise<any[]> {
    const now = Date.now();
    const hit = _lsDirCache.get(url);
    if (hit && now - hit.ts < LS_CACHE_TTL_MS) return Promise.resolve(hit.entries);
    return fsOperation(url).lsDir().then((entries: any[]) => {
        _lsDirCache.set(url, { entries, ts: now });
        return entries;
    });
}

// Whether WASM FS has been initialized with include dirs this session.
// If true, we skip full remount and only patch changed files.

// Last source WASM directory mounted — cleaned when switching to a different source file.
let _lastSourceWasmDir: string | null = null;

// ── Debug logger ───────────────────────────────────────────────────────────
// Collects debug lines during a compile run and flushes them into compile.log
// alongside the pawncc output. Use log() instead of console.log/warn.
const _debugLines: string[] = [];

function log(msg: string): void {
    _debugLines.push(msg);
}

function flushDebugLog(): string {
    const out = _debugLines.join("\n");
    _debugLines.length = 0;
    return out;
}

// ── URL helpers ────────────────────────────────────────────────────────────

/**
 * Get the parent directory URL for both file:// and content:// schemes.
 */
function parentUrl(url: string): string {
    // Remove trailing slash
    url = url.endsWith("/") ? url.slice(0, -1) : url;

    if (url.startsWith("content://")) {
        // content:// format: ...::primary:path/to/file → ...::primary:path/to
        const dColonIdx = url.lastIndexOf("::");
        if (dColonIdx === -1) return url;
        const prefix = url.slice(0, dColonIdx + 2);
        const rest = url.slice(dColonIdx + 2);
        const parts = rest.split(":");
        if (parts.length < 2) return url;
        const root = parts[0];
        const pathPart = parts.slice(1).join(":");
        const pathSegments = pathPart.split("/");
        if (pathSegments.length <= 1) return url;
        const newPath = pathSegments.slice(0, -1).join("/");
        return `${prefix}${root}:${newPath}`;
    }

    // file:// or plain path
    const sep = url.lastIndexOf("/");
    if (sep === -1) return url;
    return url.slice(0, sep) || url;
}

/**
 * Join a URL with additional path segments.
 * Handles file:// and content:// correctly.
 */
function joinUrl(base: string, ...parts: string[]): string {
    let result = base.endsWith("/") ? base.slice(0, -1) : base;

    for (const part of parts) {
        const segment = part.startsWith("/") ? part.slice(1) : part;
        if (!segment) continue;

        if (result.startsWith("content://")) {
            const dColonIdx = result.lastIndexOf("::");
            if (dColonIdx !== -1) {
                // append to docId path
                result = `${result}/${segment}`;
            } else {
                result = `${result}/${segment}`;
            }
        } else {
            result = `${result}/${segment}`;
        }
    }

    return result;
}

/**
 * Extract the path suffix of `fileUrl` relative to `baseUrl`.
 * Returns null if `fileUrl` does not start with `baseUrl`.
 */
function getRelativePath(baseUrl: string, fileUrl: string): string | null {
    const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    if (!fileUrl.startsWith(base)) return null;
    return fileUrl.slice(base.length);
}

// ── Workspace resolution ───────────────────────────────────────────────────

/**
 * Find the workspace root by looking for `.pawn/compile.json` starting from
 * the active file's location and walking up the directory tree.
 * Falls back to window.addedFolder.url if set.
 */
export async function findWorkspaceRoot(): Promise<string | null> {
    const fsOperation = acode.require("fsOperation") as FsOperation;

    // First: try addedFolder
    const addedFolder = (window as any).addedFolder;
    const addedUrl: string | null = addedFolder?.url ?? null;

    // Second: start from activeFile location
    let dir: string | null = editorManager?.activeFile?.location ?? null;

    const maxDepth = 10;
    let depth = 0;

    while (dir && depth < maxDepth) {
        const configUrl = joinUrl(dir, ".pawn", "compile.json");
        try {
            const exists = await fsOperation(configUrl).exists();
            if (exists) return dir;
        } catch {
            // continue
        }

        const parent = parentUrl(dir);
        if (parent === dir) break; // reached root
        dir = parent;
        depth++;
    }

    // Fallback: try addedFolder directly
    if (addedUrl) {
        const configUrl = joinUrl(addedUrl, ".pawn", "compile.json");
        try {
            const exists = await fsOperation(configUrl).exists();
            if (exists) return addedUrl;
        } catch {
            // ignore
        }
    }

    return null;
}

// ── Config reader ──────────────────────────────────────────────────────────

/**
 * Read and parse `.pawn/compile.json` from the workspace root.
 */
export async function readCompileConfig(
    workspaceUrl: string
): Promise<CompileConfig | null> {
    const fsOperation = acode.require("fsOperation") as FsOperation;
    const configUrl = joinUrl(workspaceUrl, ".pawn", "compile.json");

    try {
        const raw = await fsOperation(configUrl).readFile("utf-8");
        if (typeof raw !== "string") return null;
        return JSON.parse(raw) as CompileConfig;
    } catch (e) {
        log("[PawnCompiler] Failed to read compile.json:" + " " + String(e));
        return null;
    }
}

/**
 * Pick the default build task from the config.
 */
export function getDefaultTask(config: CompileConfig): CompileTask | null {
    // Prefer tasks with isDefault=true in build group
    const defaultTask = config.tasks.find(
        (t) => t.group?.kind === "build" && t.group?.isDefault === true
    );
    if (defaultTask) return defaultTask;

    // Otherwise first build task
    const buildTask = config.tasks.find((t) => t.group?.kind === "build");
    if (buildTask) return buildTask;

    // Otherwise first task
    return config.tasks[0] ?? null;
}

// ── Variable resolution ────────────────────────────────────────────────────

interface TaskVars {
    /** WASM FS absolute path of the source file, e.g. "/workspace/gamemodes/main.pwn" */
    file: string;
    fileBasename: string;
    fileDirname: string;
    workspaceRoot: string;
}

function resolveVar(str: string, vars: TaskVars): string {
    return str
        .replace(/\$\{file\}/g, vars.file)
        .replace(/\$\{fileBasename\}/g, vars.fileBasename)
        .replace(/\$\{fileDirname\}/g, vars.fileDirname)
        .replace(/\$\{workspaceRoot\}/g, vars.workspaceRoot)
        // VSCode compat aliases
        .replace(/\$\{workspaceFolder\}/g, vars.workspaceRoot);
}

function resolveArgs(task: CompileTask, vars: TaskVars): string[] {
    return task.args.map((arg) => resolveVar(arg, vars));
}

function resolveIncludes(task: CompileTask, vars: TaskVars): string[] {
    return (task.includes ?? []).map((inc) => resolveVar(inc, vars));
}

// ── WASM FS path mapping ───────────────────────────────────────────────────

const WASM_WORKSPACE = "/workspace";

/**
 * Map an Acode URL to its corresponding WASM FS path.
 * Files are placed under /workspace/ preserving their relative path.
 */
function toWasmPath(acodePath: string, workspaceUrl: string): string {
    const rel = getRelativePath(workspaceUrl, acodePath);
    if (rel !== null) {
        return `${WASM_WORKSPACE}/${rel}`;
    }
    // Fallback: just use basename
    const basename = acodePath.split("/").pop() ?? "file.pwn";
    return `${WASM_WORKSPACE}/${basename}`;
}

// ── WASM loader ────────────────────────────────────────────────────────────

let _compilerModule: any | null = null;
let _compilerLoading: Promise<any> | null = null;

/**
 * Mutable output callback holders.
 * These are set BEFORE the module is created so the Emscripten closures
 * (`out` / `err`) capture a delegate that reads from them at call time.
 * Reassigning `module.print` after init has NO effect — the internal
 * `out` variable in the module closure is fixed at creation time.
 */
let _printCallback: (line: string) => void = () => { };
let _printErrCallback: (line: string) => void = () => { };

/**
 * Load and initialize the pawncc WASM module. Singleton — only loaded once.
 */
export async function loadCompiler(wasmBaseUrl: string): Promise<any> {
    if (_compilerModule) return _compilerModule;
    if (_compilerLoading) return _compilerLoading;

    _compilerLoading = (async () => {
        const scriptUrl = wasmBaseUrl + "pawncc/pawncc.js";
        await loadScript(scriptUrl);

        const factory = (window as any).createPawnCompiler;
        if (typeof factory !== "function") {
            throw new Error("[PawnCompiler] createPawnCompiler not found after loading pawncc.js");
        }

        const module = await factory({
            noInitialRun: true,
            locateFile: (path: string) => wasmBaseUrl + "pawncc/" + path,
            // Use delegate functions so we can update the target per-run
            // WITHOUT needing to re-create the module each time.
            print: (line: string) => _printCallback(line),
            printErr: (line: string) => _printErrCallback(line),
        });

        _compilerModule = module;
        return module;
    })();

    return _compilerLoading;
}

function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

// ── File mounting ──────────────────────────────────────────────────────────

/**
 * Recursively remove all files and directories inside a WASM FS path.
 * Fully recursive — handles arbitrarily nested project structures.
 */
function cleanWasmDirRecursive(FS: any, dirPath: string): void {
    let entries: string[];
    try {
        entries = FS.readdir(dirPath) as string[];
    } catch {
        return; // dir doesn't exist
    }
    for (const name of entries) {
        if (name === "." || name === "..") continue;
        const fullPath = `${dirPath}/${name}`;
        try {
            FS.unlink(fullPath);
        } catch {
            // it's a directory — recurse then rmdir
            cleanWasmDirRecursive(FS, fullPath);
            try { FS.rmdir(fullPath); } catch { /* ignore */ }
        }
    }
}

/**
 * Clean the WASM workspace before each compile run.
 * Also clears the mount cache so stale entries don't linger.
 */
/**
 * Full workspace clean — called only when compiler module is reloaded.
 * Resets all FS state tracking so next compile does a full remount.
 */
function cleanWasmWorkspace(FS: any): void {
    cleanWasmDirRecursive(FS, WASM_WORKSPACE);
    _wasmFsFiles.clear();
    _lsDirCache.clear(); // full clear on FS reset
    _lastSourceWasmDir = null;
    // _mountCache data is kept — reused even after FS reset to skip readFile()
}



/**
 * Ensure a directory path exists in the WASM FS (mkdir -p).
 */
/**
 * Get the current in-memory content of a file from the Acode editor session.
 * Returns null if the file is not open in the editor (fall back to disk read).
 * This ensures unsaved changes are compiled, not the stale on-disk version.
 */
function getEditorSessionContent(acodeUrl: string): string | null {
    try {
        const files: any[] = editorManager?.files ?? [];
        for (const f of files) {
            if (f.uri === acodeUrl || f.url === acodeUrl) {
                // Get content from the Ace/CodeMirror session
                const session = f.session;
                if (session?.getValue) return session.getValue();   // Ace
                if (session?.doc?.toString) return session.doc.toString(); // CodeMirror
            }
        }
    } catch { /* ignore */ }
    return null;
}

function ensureWasmDir(FS: any, dirPath: string): void {
    const parts = dirPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current += "/" + part;
        try {
            FS.mkdir(current);
        } catch {
            // already exists
        }
    }
}

/**
 * Mount a single file from Acode FS into WASM FS.
 * Returns the decoded text content on success (reused by caller for scanning),
 * or null on failure. Uses a single readFile() — no separate exists() call.
 */
async function mountFile(
    fsOperation: FsOperation,
    FS: any,
    acodeUrl: string,
    wasmPath: string,
    knownSize?: number,  // from lsDir entry — if matches cache, skip readFile + writeFile
    isSourceFile = false // source files: always read fresh, never use persistent cache
): Promise<string | null> {
    try {
        let data: Uint8Array;
        let text: string | null = null;

        if (isSourceFile) {
            // Always read fresh for source files — they may have unsaved changes in editor.
            // Try in-memory editor session first (captures unsaved edits).
            const sessionContent = getEditorSessionContent(acodeUrl);
            if (sessionContent !== null) {
                text = sessionContent;
                data = new TextEncoder().encode(sessionContent);
            } else {
                // File not open in editor — read from disk
                const raw = await fsOperation(acodeUrl).readFile(undefined);
                if (raw instanceof ArrayBuffer) data = new Uint8Array(raw);
                else if (raw instanceof Blob) data = new Uint8Array(await raw.arrayBuffer());
                else if (typeof raw === "string") { text = raw; data = new TextEncoder().encode(raw); }
                else return null;
            }
            // Do NOT update _mountCache for source files — cache is for include-only files
            ensureWasmDir(FS, wasmPath.split("/").slice(0, -1).join("/"));
            FS.writeFile(wasmPath, data);
            _wasmFsFiles.add(wasmPath);
            if (text === null) text = new TextDecoder().decode(data);
            return text;
        }

        // ── Include file path (persistent cache eligible) ──────────────────
        //
        // Cache validation strategy (no extra I/O unless necessary):
        //   1. knownSize from lsDir entry matches cached.size
        //      → size unchanged → trust cache, skip stat() + readFile + writeFile
        //      → this is the hot path for 549 include files on every compile
        //   2. knownSize missing or different → file may have changed
        //      → readFile fresh, update cache
        //
        // We intentionally skip stat()/mtime for include files — they are never
        // edited by the user, so size change is sufficient as a change signal.
        // (Source files use isSourceFile=true path above, which always reads fresh.)
        const cached = _mountCache.get(acodeUrl);

        if (cached && cached.wasmPath === wasmPath && cached.data.length > 0) {
            const sizeMatch = knownSize !== undefined && knownSize === cached.size;

            if (sizeMatch && _wasmFsFiles.has(wasmPath)) {
                // Hot path: in WASM FS, size unchanged → nothing to do
                return new TextDecoder().decode(cached.data);
            }
            if (sizeMatch) {
                // FS was reset (e.g. module reload) — re-write from cache, no readFile
                ensureWasmDir(FS, wasmPath.split("/").slice(0, -1).join("/"));
                FS.writeFile(wasmPath, cached.data);
                _wasmFsFiles.add(wasmPath);
                return new TextDecoder().decode(cached.data);
            }
            // Size changed — fall through to readFile
        }

        // Cache miss or size changed: read file fresh
        const raw = await fsOperation(acodeUrl).readFile(undefined);

        if (raw instanceof ArrayBuffer) data = new Uint8Array(raw);
        else if (raw instanceof Blob) data = new Uint8Array(await raw.arrayBuffer());
        else if (typeof raw === "string") { text = raw; data = new TextEncoder().encode(raw); }
        else return null;

        _mountCache.set(acodeUrl, { size: data.length, mtime: 0, wasmPath, data });
        ensureWasmDir(FS, wasmPath.split("/").slice(0, -1).join("/"));
        FS.writeFile(wasmPath, data);
        _wasmFsFiles.add(wasmPath);

        if (text === null) text = new TextDecoder().decode(data);
        return text;
    } catch {
        return null;
    }
}

/**
 * Recursively list and mount all .pwn/.inc files from an Acode directory URL
 * into the WASM FS, preserving the relative path structure.
 *
 * Uses parallel I/O within each directory level (Promise.all) for a large
 * speedup on projects with many files — typically 5–10× faster than sequential.
 */
async function mountDirRecursive(
    fsOperation: FsOperation,
    FS: any,
    acodeDir: string,
    wasmDir: string,
    depth = 0,
    maxDepth = 8,
    state = { count: 0 },
    isSourceFile = false
): Promise<number> {
    if (depth > maxDepth) return state.count;

    let entries: any[];
    try {
        entries = await lsDirCached(fsOperation, acodeDir);
    } catch {
        return state.count;
    }

    const SKIP_DIRS = new Set([".git", "node_modules", ".github", ".vscode", "build", "dist"]);

    // Separate dirs and files for parallel processing
    const subdirs: Array<{ acodeUrl: string; wasmPath: string }> = [];
    const files: Array<{ acodeUrl: string; wasmPath: string }> = [];

    for (const entry of entries) {
        if (!entry?.name) continue;
        const name: string = entry.name;

        if (entry.isDirectory) {
            if (SKIP_DIRS.has(name)) continue;
            const subAcodeUrl = entry.url ?? joinUrl(acodeDir, name);
            const subWasmPath = `${wasmDir}/${name}`;
            ensureWasmDir(FS, subWasmPath);
            subdirs.push({ acodeUrl: subAcodeUrl, wasmPath: subWasmPath });
        } else if (entry.isFile && (name.endsWith(".pwn") || name.endsWith(".inc"))) {
            const fileUrl = entry.url ?? joinUrl(acodeDir, name);
            const knownSize: number | undefined = typeof entry.size === "number" ? entry.size : undefined;
            files.push({ acodeUrl: fileUrl, wasmPath: `${wasmDir}/${name}`, knownSize });
        }
    }

    // Mount all files in this directory in parallel
    const fileResults = await Promise.all(
        files.map(({ acodeUrl, wasmPath, knownSize }) =>
            mountFile(fsOperation, FS, acodeUrl, wasmPath, isSourceFile ? undefined : knownSize, isSourceFile)
        )
    );
    state.count += fileResults.filter(r => r !== null).length;

    // Recurse into subdirectories in parallel
    await Promise.all(
        subdirs.map(({ acodeUrl, wasmPath }) =>
            mountDirRecursive(fsOperation, FS, acodeUrl, wasmPath, depth + 1, maxDepth, state, isSourceFile)
        )
    );

    return state.count;
}

// ── Static include scanner ─────────────────────────────────────────────────

/**
 * Parse all #include directives from raw Pawn source text.
 * Returns two lists:
 *   - relative: quoted includes like #include "src/utils.inc"
 *   - system:   angled includes like #include <a_samp>
 */
/**
 * Normalize an include path:
 *  - backslash → forward slash
 *  - strip leading ./ or .\ prefix (relative-same-dir markers)
 */
function normalizeIncludePath(p: string): string {
    // Only strip leading ./ prefix — backslash paths are handled by pawncc itself
    return p.replace(/^\.\//, "").replace(/^\.\\/, "");
}

function parseIncludes(source: string): { relative: string[]; system: string[] } {
    const relative: string[] = [];
    const system: string[] = [];
    // Match #include and #tryinclude, both "..." and <...> forms
    const RE = /^\s*#\s*(?:try)?include\s+(?:"([^"]+)"|<([^>]+)>)/gm;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(source)) !== null) {
        if (m[1]) relative.push(normalizeIncludePath(m[1]));
        else if (m[2]) system.push(normalizeIncludePath(m[2]));
    }
    return { relative, system };
}

/**
 * Recursively collect the full set of Acode URLs that `rootUrl` depends on
 * by scanning #include directives. Only follows relative includes —
 * system includes (<a_samp>) are resolved separately via the include dirs.
 *
 * Returns a Map of acodeUrl → wasmPath for every file in the dependency tree.
 */
async function collectDependencies(
    fsOperation: FsOperation,
    rootUrl: string,
    workspaceUrl: string,
    sourceDir: string,
    extraSearchDirs: string[] = [],
    visited = new Set<string>()
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (visited.has(rootUrl)) return result;
    visited.add(rootUrl);

    result.set(rootUrl, toWasmPath(rootUrl, workspaceUrl));

    let source: string;
    try {
        const raw = await fsOperation(rootUrl).readFile(undefined);
        if (raw instanceof ArrayBuffer || raw instanceof Blob) {
            source = new TextDecoder().decode(
                raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw)
            );
        } else if (typeof raw === "string") {
            source = raw;
        } else {
            return result;
        }
    } catch {
        return result;
    }

    const { relative } = parseIncludes(source);
    const fileDir = parentUrl(rootUrl);

    // Resolve each relative include and recurse in parallel.
    //
    // pawncc resolves #include "src/raknet/player.pwn" relative to the
    // gamemodes/ root (workspaceUrl), NOT relative to the file containing
    // the directive. So header.inc in gamemodes/src/raknet/ writing
    //   #include "src/raknet/player.pwn"
    // expects the file at gamemodes/src/raknet/player.pwn, not at
    // gamemodes/src/raknet/src/raknet/player.pwn.
    //
    // Priority: workspace-root first, then file-dir as fallback.
    const subMaps = await Promise.all(
        relative.map(async (inc) => {
            const withExt = (base: string): string[] => [
                joinUrl(base, inc),
                ...(inc.includes(".") ? [] : [
                    joinUrl(base, inc + ".inc"),
                    joinUrl(base, inc + ".pwn"),
                ]),
            ];

            // Priority: sourceDir > fileDir > extraSearchDirs > workspaceUrl
            const candidates = [
                ...withExt(sourceDir),
                ...withExt(fileDir),
                ...([] as string[]).concat(...extraSearchDirs.map(d => withExt(d))),
                ...withExt(workspaceUrl),
            ];

            for (const candidate of candidates) {
                try {
                    const exists = await fsOperation(candidate).exists();
                    if (exists) {
                        return collectDependencies(fsOperation, candidate, workspaceUrl, sourceDir, extraSearchDirs, visited);
                    }
                } catch { /* try next */ }
            }
            return new Map<string, string>();
        })
    );

    for (const sub of subMaps) {
        for (const [k, v] of sub) result.set(k, v);
    }

    return result;
}


/**
 * Recursively collect all system include names (#include <name>) referenced
 * across the entire dependency tree. Returns a Set of bare names like
 * "a_samp", "a_players", etc. (without angle brackets or extension).
 */
async function collectSystemIncludes(
    fsOperation: FsOperation,
    rootUrl: string,
    workspaceUrl: string,
    sourceDir: string,
    extraSearchDirs: string[] = [],
    visited = new Set<string>()
): Promise<Set<string>> {
    const result = new Set<string>();
    if (visited.has(rootUrl)) return result;
    visited.add(rootUrl);

    let source: string;
    try {
        const raw = await fsOperation(rootUrl).readFile(undefined);
        if (raw instanceof ArrayBuffer || raw instanceof Blob) {
            source = new TextDecoder().decode(
                raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw)
            );
        } else if (typeof raw === "string") {
            source = raw;
        } else {
            return result;
        }
    } catch {
        return result;
    }

    const { relative, system } = parseIncludes(source);
    // Add system includes (strip extension if present)
    for (const s of system) {
        // Normalize backslash (Windows-style paths in YSI etc.) → forward slash
        result.add(s.replace(/\.(inc|pwn)$/i, "").replace(/\\/g, "/"));
    }

    // Recurse into relative includes
    const withExt = (base: string, inc: string): string[] => [
        joinUrl(base, inc),
        ...(inc.includes(".") ? [] : [
            joinUrl(base, inc + ".inc"),
            joinUrl(base, inc + ".pwn"),
        ]),
    ];

    const subSets = await Promise.all(
        relative.map(async (inc) => {
            const fileDir = parentUrl(rootUrl);
            const candidates = [
                ...withExt(sourceDir, inc),
                ...withExt(fileDir, inc),
                ...([] as string[]).concat(...extraSearchDirs.map(d => withExt(d, inc))),
                ...withExt(workspaceUrl, inc),
            ];
            for (const candidate of candidates) {
                try {
                    const exists = await fsOperation(candidate).exists();
                    if (exists) {
                        return collectSystemIncludes(fsOperation, candidate, workspaceUrl, sourceDir, extraSearchDirs, visited);
                    }
                } catch { /* try next */ }
            }
            return new Set<string>();
        })
    );

    for (const sub of subSets) {
        for (const s of sub) result.add(s);
    }
    return result;
}

/**
 * Mount only the files from an include directory that match names in `needed`.
 * Checks both <name>.inc and <name>.pwn. Much faster than mounting everything.
 */
async function mountSystemIncludeDir(
    fsOperation: FsOperation,
    FS: any,
    acodeDir: string,
    wasmDir: string,
    needed: Set<string>
): Promise<number> {
    // Normalize all names: backslash → forward slash
    const normalized = [...needed].map(n => n.replace(/\\/g, "/"));

    // Split into flat files and subdir includes
    // e.g. "a_samp" → flat, "YSI_Coding/y_hooks" → subdir "YSI_Coding"
    const flatNames = new Set<string>();
    const subdirNames = new Set<string>(); // unique top-level subdir names

    for (const name of normalized) {
        const slashIdx = name.indexOf("/");
        if (slashIdx === -1) {
            flatNames.add(name);
        } else {
            subdirNames.add(name.slice(0, slashIdx));
        }
    }

    let count = 0;
    const jobs: Promise<void>[] = [];

    // 1. Mount flat files directly (e.g. a_samp.inc, open.mp.inc)
    for (const name of flatNames) {
        for (const filename of [`${name}.inc`, `${name}.pwn`]) {
            jobs.push((async () => {
                const acodeUrl = joinUrl(acodeDir, filename);
                const wasmPath = `${wasmDir}/${filename}`;
                const text = await mountFile(fsOperation, FS, acodeUrl, wasmPath);
                if (text !== null) count++;
            })());
        }
    }

    // 2. Mount only the specific subdirs needed (e.g. YSI_Coding/, H-Libs/)
    //    recursively — but skip subdirs not in the needed set.
    for (const subdir of subdirNames) {
        jobs.push((async () => {
            const subAcodeUrl = joinUrl(acodeDir, subdir);
            const subWasmPath = `${wasmDir}/${subdir}`;
            try {
                ensureWasmDir(FS, subWasmPath);
                const n = await mountDirRecursive(fsOperation, FS, subAcodeUrl, subWasmPath);
                count += n;
            } catch { /* not found */ }
        })());
    }

    await Promise.all(jobs);
    return count;
}

/**
 * Like mountDirRecursive but also appends every successfully mounted Acode URL
 * to `collectedUrls` — used to track files for transitive include scanning.
 */
async function collectAndMountDir(
    fsOperation: FsOperation,
    FS: any,
    acodeDir: string,
    wasmDir: string,
    collectedUrls: string[],
    mountedWasmPaths: Set<string>,
    depth = 0,
    maxDepth = 8,
    collectedTexts?: Map<string, string>
): Promise<void> {
    if (depth > maxDepth) return;

    let entries: any[];
    try {
        entries = await lsDirCached(fsOperation, acodeDir);
    } catch {
        return;
    }

    const SKIP_DIRS = new Set([".git", "node_modules", ".github", ".vscode", "build", "dist"]);
    const jobs: Promise<void>[] = [];

    for (const entry of entries) {
        if (!entry?.name) continue;
        const name: string = entry.name;

        if (entry.isDirectory) {
            if (SKIP_DIRS.has(name)) continue;
            const subAcodeUrl = entry.url ?? joinUrl(acodeDir, name);
            const subWasmPath = `${wasmDir}/${name}`;
            ensureWasmDir(FS, subWasmPath);
            jobs.push(collectAndMountDir(
                fsOperation, FS, subAcodeUrl, subWasmPath,
                collectedUrls, mountedWasmPaths, depth + 1, maxDepth, collectedTexts
            ));
        } else if (entry.isFile && (name.endsWith(".pwn") || name.endsWith(".inc"))) {
            const fileUrl = entry.url ?? joinUrl(acodeDir, name);
            const wasmPath = `${wasmDir}/${name}`;
            const knownSize: number | undefined = typeof entry.size === "number" ? entry.size : undefined;
            jobs.push((async () => {
                const text = await mountFile(fsOperation, FS, fileUrl, wasmPath, knownSize);
                if (text !== null) {
                    mountedWasmPaths.add(wasmPath);
                    collectedUrls.push(fileUrl);
                    if (collectedTexts) collectedTexts.set(fileUrl, text);
                }
            })());
        }
    }

    await Promise.all(jobs);
}

// ── Mount strategy ─────────────────────────────────────────────────────────

/**
 * Mount source + includes into WASM FS using smart dependency scanning.
 *
 * Strategy:
 *  - If the source file has few direct includes (≤ SIMPLE_THRESHOLD), only
 *    mount the exact dependency tree (fast path for files like maingun.pwn).
 *  - If it has many includes, fall back to full recursive directory mount
 *    (correct for modular gamemodes like main.pwn that use dynamic patterns).
 *  - System include dirs are always mounted recursively into /workspace/include/.
 */
const SIMPLE_THRESHOLD = 20; // files in dependency tree

async function mountSourceAndIncludes(
    fsOperation: FsOperation,
    FS: any,
    sourceAcodeUrl: string,
    includeAcodeUrls: string[],
    workspaceUrl: string
): Promise<{ sourcePath: string; includePaths: string[] }> {
    ensureWasmDir(FS, WASM_WORKSPACE);

    const sourcePath = toWasmPath(sourceAcodeUrl, workspaceUrl);

    // 1. Scan dependency tree of the active source file
    const t = performance.now();
    const sourceDir = parentUrl(sourceAcodeUrl);
    const depMap = await collectDependencies(fsOperation, sourceAcodeUrl, workspaceUrl, sourceDir, includeAcodeUrls);
    log(`[PawnCompiler] Include scan: ${(performance.now() - t).toFixed(0)}ms, found ${depMap.size} files`);

    if (depMap.size <= SIMPLE_THRESHOLD) {
        // Fast path: mount only the exact files needed (e.g. gungame.pwn with 1-5 includes)
        // All are treated as source files → always read fresh from editor session or disk.
        const mountJobs = Array.from(depMap.entries()).map(([acodeUrl, wasmPath]) =>
            mountFile(fsOperation, FS, acodeUrl, wasmPath, undefined, true)
        );
        const results = await Promise.all(mountJobs);
        log(`[PawnCompiler] Fast-path mount: ${results.filter(r => r !== null).length} files`);
    } else {
        // Full path: mount entire source directory tree for modular gamemodes.
        // All source files always read fresh (isSourceFile=true).
        const sourceAcodeDir = parentUrl(sourceAcodeUrl);
        const sourceWasmDir = sourcePath.split("/").slice(0, -1).join("/") || WASM_WORKSPACE;
        ensureWasmDir(FS, sourceWasmDir);
        const mounted = await mountDirRecursive(fsOperation, FS, sourceAcodeDir, sourceWasmDir, 0, 10, { count: 0 }, true);
        log(`[PawnCompiler] Full recursive mount: ${mounted} files`);
    }

    // 2. Mount system include directories → /workspace/include/
    //
    // Strategy: iterative BFS expansion — no round limit, no arbitrary MAX_ROUNDS.
    // Each iteration mounts the current pending set, then scans every newly-mounted
    // file (including those from source project) for transitive system includes.
    // Terminates naturally when no new names are discovered.
    //
    // Handles:
    //   - chains:       gungame.pwn → open.mp → _open_mp
    //   - subdirs:      YSI_Coding/y_hooks → mount YSI_Coding/ subtree
    //   - dot-prefix:   .\omp-stdlib\_open_mp  (normalized by parseIncludes)
    //   - source files: script.pwn with new #include <x> found after dep scan

    // Derive wasmIncDir from the actual WASM path of the first include dir.
    // e.g. includeAcodeUrls[0] = ".../Server/qawno/include"
    //   → toWasmPath → "/workspace/qawno/include"
    // This must match where collectAndMountDir actually places files.
    const wasmIncDir = includeAcodeUrls.length > 0
        ? toWasmPath(includeAcodeUrls[0], workspaceUrl).replace(/\/$/, "")
        : `${WASM_WORKSPACE}/include`;
    ensureWasmDir(FS, wasmIncDir);

    // Track mounted wasmPaths and mounted subdir names to prevent re-mounting
    const mountedWasmPaths = new Set<string>();
    const mountedSubdirs = new Set<string>();

    // Helper: read source text from an Acode URL
    async function readSource(acodeUrl: string): Promise<string> {
        try {
            const raw = await fsOperation(acodeUrl).readFile(undefined);
            if (raw instanceof ArrayBuffer || raw instanceof Blob) {
                return new TextDecoder().decode(
                    raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw)
                );
            }
            return typeof raw === "string" ? raw : "";
        } catch { return ""; }
    }

    // Helper: extract system include names from source text, strip extensions
    function extractSystemNames(src: string): string[] {
        const { system } = parseIncludes(src);
        return system.map(s => s.replace(/\.(inc|pwn)$/i, ""));
    }

    // Seed: collect system includes from all source files (dep tree + includeAcodeUrls scan)
    const initialNames = await collectSystemIncludes(
        fsOperation, sourceAcodeUrl, workspaceUrl, sourceDir, includeAcodeUrls
    );
    log(`[PawnCompiler] System includes needed: [${[...initialNames].join(", ")}]`);

    // Also seed from all dep-tree source files already found (catches script.pwn etc.)
    const depSources = await Promise.all([...depMap.keys()].map(readSource));
    for (const src of depSources) {
        for (const name of extractSystemNames(src)) initialNames.add(name);
    }

    let pending = initialNames;
    let iteration = 0;

    while (pending.size > 0) {
        iteration++;
        const newlyMountedAcodeUrls: string[] = [];
        const mountedTexts = new Map<string, string>(); // acodeUrl → text, reused for scanning
        let iterCount = 0;

        // Split pending into flat files and top-level subdirs.
        // Normalize backslash here for scanner logic only — the actual filename
        // sent to joinUrl keeps the original form pawncc uses.
        const flatNames = new Set<string>();
        const subdirNames = new Set<string>();
        for (const name of pending) {
            const normalized = name.replace(/\\/g, "/");
            const slash = normalized.indexOf("/");
            if (slash === -1) flatNames.add(normalized);
            else subdirNames.add(normalized.slice(0, slash));
        }

        // Mount flat files from all include dirs in parallel.
        // If a name has no slash, it might be a flat .inc/.pwn file OR a directory.
        // Try file first; if not found as file, treat as subdir.
        const flatJobs: Promise<void>[] = [];
        for (const name of flatNames) {
            // Try as file (.inc / .pwn)
            for (const ext of [".inc", ".pwn"]) {
                const filename = name + ext;
                const wasmPath = `${wasmIncDir}/${filename}`;
                if (mountedWasmPaths.has(wasmPath)) continue;
                for (const incDir of includeAcodeUrls) {
                    flatJobs.push((async () => {
                        if (mountedWasmPaths.has(wasmPath)) return;
                        const acodeUrl = joinUrl(incDir, filename);
                        // No exists() check — mountFile returns null if not found
                        const text = await mountFile(fsOperation, FS, acodeUrl, wasmPath);
                        if (text !== null) {
                            mountedWasmPaths.add(wasmPath);
                            mountedTexts.set(acodeUrl, text);
                            newlyMountedAcodeUrls.push(acodeUrl);
                            iterCount++;
                        }
                    })());
                }
            }
            // Also try as a directory (e.g. "YSI_Server" queued without slash)
            if (!mountedSubdirs.has(name)) {
                subdirNames.add(name);
            }
        }
        await Promise.all(flatJobs);

        // Mount needed subdirs (once per subdir name across all include dirs)
        // Also collect all Acode URLs of files inside for transitive scanning.
        const subdirJobs: Promise<void>[] = [];
        for (const subdir of subdirNames) {
            if (mountedSubdirs.has(subdir)) continue;
            mountedSubdirs.add(subdir); // mark immediately to prevent parallel re-mount
            for (const incDir of includeAcodeUrls) {
                subdirJobs.push((async () => {
                    const subAcodeUrl = joinUrl(incDir, subdir);
                    const subWasmPath = `${wasmIncDir}/${subdir}`;
                    try {
                        ensureWasmDir(FS, subWasmPath);
                        await collectAndMountDir(
                            fsOperation, FS, subAcodeUrl, subWasmPath,
                            newlyMountedAcodeUrls, mountedWasmPaths,
                            0, 8, mountedTexts
                        );
                        mountedWasmPaths.add(subWasmPath);
                    } catch { /* not found in this dir */ }
                })());
            }
        }
        await Promise.all(subdirJobs);

        log(`[PawnCompiler] System includes iter ${iteration}: ${newlyMountedAcodeUrls.length} files`);

        // Scan newly mounted flat files for transitive includes.
        // Also resolve relative ".." paths — e.g. y_hooks_entry.inc uses
        // #include "..\YSI_Core\y_utils" which references a sibling subdir
        // in qawno/include. We detect these and queue the target subdir for mount.
        const nextPending = new Set<string>();

        await Promise.all(newlyMountedAcodeUrls.map(async (acodeUrl) => {
            const src = mountedTexts.get(acodeUrl) ?? await readSource(acodeUrl);

            // System includes → queue as before
            for (const name of extractSystemNames(src)) {
                if (
                    !mountedWasmPaths.has(`${wasmIncDir}/${name}.inc`) &&
                    !mountedWasmPaths.has(`${wasmIncDir}/${name}.pwn`) &&
                    !mountedSubdirs.has(name.replace(/\\/g, "/").split("/")[0])
                ) {
                    nextPending.add(name);
                }
            }

            // Relative includes with ".." — resolve using the file's WASM path
            // (always forward-slash, no content:// encoding issues).
            // e.g. /workspace/include/YSI_Coding/y_hooks/y_hooks_entry.inc
            //   + ../../YSI_Core/y_utils
            //   = /workspace/include/YSI_Core/y_utils
            // → top-level subdir under /workspace/include/ = "YSI_Core" → queue it.
            const wasmFilePath = toWasmPath(acodeUrl, workspaceUrl);
            const wasmFileDir = wasmFilePath.split("/").slice(0, -1).join("/");

            const { relative } = parseIncludes(src);
            for (const rel of relative) {
                const norm = rel.replace(/\\/g, "/");
                if (!norm.includes("..")) continue;

                // Resolve ".." segments from the file's WASM dir
                const parts = (wasmFileDir + "/" + norm).split("/");
                const resolved: string[] = [];
                for (const p of parts) {
                    if (p === "..") resolved.pop();
                    else if (p && p !== ".") resolved.push(p);
                }
                const resolvedWasm = "/" + resolved.join("/");

                // Check if resolved path is under wasmIncDir
                const relToInc = getRelativePath(wasmIncDir, resolvedWasm) ??
                                 getRelativePath(wasmIncDir, resolvedWasm + ".inc") ??
                                 getRelativePath(wasmIncDir, resolvedWasm + ".pwn");
                if (relToInc === null) continue;

                // Queue the top-level subdir
                const topDir = relToInc.split("/")[0];
                if (topDir && !mountedSubdirs.has(topDir)) {
                    nextPending.add(topDir);
                }
            }
        }));

        if (nextPending.size > 0) {
            log(`[PawnCompiler] System includes discovered: [${[...nextPending].join(", ")}]`);
        }
        pending = nextPending;
    }

    const mountedIncludeDirs = new Set<string>([wasmIncDir]);

    return {
        sourcePath,
        includePaths: Array.from(mountedIncludeDirs),
    };
}


// ── AMX output extraction ─────────────────────────────────────────────────

/**
 * Determine the expected .amx output path in WASM FS.
 * pawncc uses `-o<path>` for explicit output, otherwise derives from source.
 * `-D<dir>` sets the output *directory* (not full path).
 */
function findAmxWasmPath(resolvedArgs: string[], sourcePath: string): string {
    // Check for explicit -o flag
    const oArg = resolvedArgs.find((a) => a.startsWith("-o"));
    if (oArg) return oArg.slice(2).trim();

    // Derive from source path, apply -D if present
    const dArg = resolvedArgs.find((a) => a.startsWith("-D"));
    const sourceBasename = sourcePath.split("/").pop() ?? "output.pwn";
    const amxBasename = sourceBasename.replace(/\.(pwn|inc)$/i, ".amx");

    if (dArg) {
        const dir = dArg.slice(2).trim();
        return dir.endsWith("/") ? `${dir}${amxBasename}` : `${dir}/${amxBasename}`;
    }

    // Same dir as source
    const sourceDir = sourcePath.split("/").slice(0, -1).join("/") || WASM_WORKSPACE;
    return `${sourceDir}/${amxBasename}`;
}

/**
 * Read the compiled .amx from WASM FS and save it to the Acode filesystem.
 * Returns the Acode URL of the saved file, or null on failure.
 */
async function saveAmxToDevice(
    FS: any,
    fsOperation: FsOperation,
    amxWasmPath: string,
    sourceAcodeUrl: string
): Promise<{ url: string; size: number } | null> {
    // Read from WASM FS
    let amxData: Uint8Array;
    try {
        amxData = FS.readFile(amxWasmPath) as Uint8Array;
        if (!amxData?.length) return null;
    } catch (e) {
        log("[PawnCompiler] AMX not found in WASM FS at " + amxWasmPath + " " + String(e));
        return null;
    }

    // Determine save path: same dir + same name as source, but .amx
    const sourceDir = parentUrl(sourceAcodeUrl);
    const sourceName = sourceAcodeUrl.split("/").pop() ?? "output.pwn";
    const amxName = sourceName.replace(/\.(pwn|inc)$/i, ".amx");
    const amxAcodeUrl = joinUrl(sourceDir, amxName);

    // IMPORTANT: Emscripten Uint8Array may be a view into the large shared WASM
    // memory buffer with a non-zero byteOffset. Always slice() to get an
    // independent ArrayBuffer — Cordova FileWriter requires an owned buffer,
    // and Blob([sharedView]) on Android WebView can write garbage/2 bytes.
    const arrayBuffer: ArrayBuffer = amxData.buffer.slice(
        amxData.byteOffset,
        amxData.byteOffset + amxData.byteLength
    );

    // Write strategy: delete existing file first, then createFile with fresh data.
    // Avoids FileWriter partial-overwrite issues (no truncate before write = stale tail).
    try {
        const fs = fsOperation(amxAcodeUrl);
        const alreadyExists = await fs.exists().catch(() => false);
        if (alreadyExists) {
            try { await fs.delete(); } catch { /* ignore */ }
        }
        await fsOperation(sourceDir).createFile(amxName, arrayBuffer);
        return { url: amxAcodeUrl, size: amxData.length };
    } catch (e) {
        log("[PawnCompiler] Failed to save AMX:" + " " + String(e));
        return null;
    }
}


/**
 * Parse pawncc stdout/stderr into structured diagnostics.
 *
 * Expected line format:
 *   /workspace/main.pwn(42) : error 001: expected token: ";"
 *   /workspace/main.pwn(10) : warning 204: symbol is never used
 *   /workspace/main.pwn(5) : fatal error 100: cannot read from file: "a_samp"
 */
export function parsePawnccOutput(raw: string): CompileDiagnostic[] {
    const diagnostics: CompileDiagnostic[] = [];
    const lines = raw.split("\n");

    // Matches: <path>(<line>) : <type> <code>: <message>
    const DIAG_RE = /^(.+?)\((\d+)\)\s*:\s*(fatal error|error|warning)\s+(\d+):\s*(.+)$/;

    for (const line of lines) {
        const match = DIAG_RE.exec(line.trim());
        if (!match) continue;
        diagnostics.push({
            file: match[1].trim(),
            line: parseInt(match[2], 10),
            type: match[3].trim(),
            code: match[4].trim(),
            message: match[5].trim(),
        });
    }

    return diagnostics;
}

// ── Main compile function ──────────────────────────────────────────────────

export type CompileStage =
    | "waiting-preload"   // blocked on background preload
    | "mounting"          // writing files into WASM FS
    | "compiling";        // pawncc running

export interface RunCompileOptions {
    wasmBaseUrl: string;
    /** Called each time the compile pipeline moves to a new stage. */
    onStage?: (stage: CompileStage) => void;
}

/**
 * Main entry point. Finds workspace, reads config, mounts files,
 * runs pawncc WASM, and returns structured results.
 */
export async function runCompile(
    opts: RunCompileOptions
): Promise<CompileResult & { workspaceUrl?: string }> {
    const fsOperation = acode.require("fsOperation") as FsOperation;

    // 1. Find workspace root
    const workspaceUrl = await findWorkspaceRoot();
    if (!workspaceUrl) {
        return {
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: "",
            diagnostics: [],
            workspaceUrl: undefined,
        };
    }


    // 2. Read config
    const config = await readCompileConfig(workspaceUrl);
    if (!config) {
        return {
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: "Cannot read .pawn/compile.json",
            diagnostics: [],
            workspaceUrl,
        };
    }

    const task = getDefaultTask(config);
    if (!task) {
        return {
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: "No build task found in compile.json",
            diagnostics: [],
            workspaceUrl,
        };
    }

    // 3. Get active source file URL
    const activeFile = editorManager?.activeFile;
    const sourceAcodeUrl = activeFile?.uri ?? activeFile?.location;
    if (!sourceAcodeUrl || !sourceAcodeUrl.match(/\.(pwn|inc)$/i)) {
        return {
            success: false,
            exitCode: -1,
            stdout: "",
            stderr: "No active .pwn file",
            diagnostics: [],
            workspaceUrl,
        };
    }

    // 4. Load compiler (singleton)
    const module = await loadCompiler(opts.wasmBaseUrl);
    const FS = module.FS;

    // 5. Build variables for template resolution
    const sourcePath = toWasmPath(sourceAcodeUrl, workspaceUrl);
    const sourceBasename = sourcePath.split("/").pop() ?? "main.pwn";
    const sourceDirname = sourcePath.split("/").slice(0, -1).join("/") || WASM_WORKSPACE;

    const vars: TaskVars = {
        file: sourcePath,
        fileBasename: sourceBasename,
        fileDirname: sourceDirname,
        workspaceRoot: WASM_WORKSPACE,
    };

    // 6. Resolve include dirs (Acode URLs)
    const includeWasmTemplates = resolveIncludes(task, vars);
    // Map WASM include paths back to Acode URLs for reading
    const includeAcodeUrls: string[] = [];
    for (const incTemplate of (task.includes ?? [])) {
        const resolved = resolveVar(incTemplate, {
            ...vars,
            workspaceRoot: workspaceUrl,
            file: sourceAcodeUrl,
            fileDirname: parentUrl(sourceAcodeUrl),
            fileBasename: sourceBasename,
        });
        includeAcodeUrls.push(resolved);
    }

    // 7. Wait for any in-progress background preload to finish before mounting.
    // This prevents race conditions where preload and compile both write to WASM FS
    // simultaneously, which could result in corrupt or inconsistent file state.
    if (_preloadPromise) {
        log(`[PawnCompiler] Waiting for background preload to finish...`);
        opts.onStage?.("waiting-preload");
        try { await _preloadPromise; } catch { /* preload errors are non-fatal */ }
    }

    // Detect if WASM FS was reset (module reloaded) via sentinel file.
    // If reset: mark all state as dirty so next compile does full remount.
    const SENTINEL = `${WASM_WORKSPACE}/.pawn_sentinel`;
    try {
        FS.readFile(SENTINEL);
    } catch {
        // Sentinel missing — FS was reset (module reload or first run)
        _wasmFsFiles.clear();
            _lastSourceWasmDir = null;
        ensureWasmDir(FS, WASM_WORKSPACE);
        FS.writeFile(SENTINEL, new Uint8Array([1]));
    }

    // Clean previous source directory if switching files (e.g. main.pwn → gungame.pwn)
    const newSourceWasmDir = sourcePath.split("/").slice(0, -1).join("/") || WASM_WORKSPACE;
    if (_lastSourceWasmDir && _lastSourceWasmDir !== newSourceWasmDir) {
        try { cleanWasmDirRecursive(FS, _lastSourceWasmDir); } catch { /* ignore */ }
        // Remove old source files from _wasmFsFiles
        for (const p of _wasmFsFiles) {
            if (p.startsWith(_lastSourceWasmDir + "/")) _wasmFsFiles.delete(p);
        }
    }
    _lastSourceWasmDir = newSourceWasmDir;

    _compileInProgress = true;
    try {
    opts.onStage?.("mounting");
    const t0 = performance.now();
    // Do NOT clear _lsDirCache here — cached lsDir entries provide knownSize
    // used by mountFile to skip readFile for unchanged include files.
    // Cache is only cleared when FS is reset (sentinel check above).

    // 8. Mount files into WASM FS
    const { includePaths } = await mountSourceAndIncludes(
        fsOperation,
        FS,
        sourceAcodeUrl,
        includeAcodeUrls,
        workspaceUrl
    );
    log(`[PawnCompiler] Mount phase: ${(performance.now() - t0).toFixed(0)}ms`);

    // 9. Build args: resolve with WASM variables
    let resolvedArgs = resolveArgs(task, vars);

    // Inject -i flags for include dirs if not already present
    for (const incDir of includePaths) {
        if (!resolvedArgs.some((a) => a === `-i${incDir}` || a === incDir)) {
            resolvedArgs.push(`-i${incDir}`);
        }
    }

    // 10. Capture output — update the mutable holders BEFORE calling main.
    // The WASM module's internal `out`/`err` closures read from these via
    // the delegate functions registered at module creation time.
    let stdout = "";
    let stderr = "";
    _printCallback = (line: string) => { stdout += line + "\n"; };
    _printErrCallback = (line: string) => { stderr += line + "\n"; };

    // 11. Run compiler
    opts.onStage?.("compiling");
    const t1 = performance.now();
    let exitCode = 0;
    try {
        exitCode = module.callMain([...resolvedArgs]) ?? 0;
    } catch (e: any) {
        // pawncc may throw ExitStatus
        if (e?.name === "ExitStatus") {
            exitCode = e.status ?? 1;
        } else {
            exitCode = 1;
            stderr += String(e);
        }
    }
    log(`[PawnCompiler] Compile phase: ${(performance.now() - t1).toFixed(0)}ms`);

    // 12. Parse output
    const combined = stdout + "\n" + stderr;
    const diagnostics = parsePawnccOutput(combined);
    const success = exitCode === 0;

    // Save compiler output + debug log to .pawn/compile.log
    try {
        const debugOut = flushDebugLog();
        const separator = "\n── debug ─────────────────────────────────────────────\n";
        const fullLog = combined + (debugOut ? separator + debugOut + "\n" : "");
        const logData = new TextEncoder().encode(fullLog);
        const fsOp = acode.require("fsOperation");
        const pawnDir = joinUrl(workspaceUrl, ".pawn");
        const logPath = joinUrl(pawnDir, "compile.log");
        if (await fsOp(pawnDir).exists()) {
            if (await fsOp(logPath).exists()) {
                await fsOp(logPath).writeFile(logData.buffer);
            } else {
                await fsOp(pawnDir).createFile("compile.log", logData.buffer);
            }
        }
    } catch (e) { /* ignore */ }


    // 13. Save .amx to device if compilation succeeded
    let outputUrl: string | undefined;
    let outputSize: number | undefined;
    if (success) {
        const amxWasmPath = findAmxWasmPath(resolvedArgs, sourcePath);
        const saved = await saveAmxToDevice(FS, fsOperation, amxWasmPath, sourceAcodeUrl);
        if (saved) {
            outputUrl = saved.url;
            outputSize = saved.size;
        }
    }

    return {
        success,
        exitCode,
        stdout,
        stderr,
        diagnostics,
        outputUrl,
        outputSize,
        workspaceUrl,
    };
    } finally {
        _compileInProgress = false;
    }
}

// ── Workspace preloading ───────────────────────────────────────────────────

/**
 * Preload include directories into WASM FS in the background.
 * Call this from main.ts on plugin init / workspace open so the first compile
 * doesn't have to mount 500+ files from scratch.
 *
 * Safe to call multiple times — idempotent due to persistent mount cache.
 * Returns immediately; mounting happens asynchronously.
 */
export interface PreloadCallbacks {
    onStart?: () => void;
    onDone?: (fileCount: number, elapsedMs: number) => void;
    onError?: (err: unknown) => void;
}

export function preloadWorkspaceIncludes(wasmBaseUrl: string, callbacks?: PreloadCallbacks): void {
    // Run async in background — don't await
    _doPreload(wasmBaseUrl, callbacks).catch(() => { /* silent — preload is best-effort */ });
}

// Exported so runCompile can await it before mounting
let _preloadPromise: Promise<void> | null = null;

let _compileInProgress = false;


async function _doPreload(wasmBaseUrl: string, callbacks?: PreloadCallbacks): Promise<void> {
    // Only one preload at a time, and never during an active compile
    if (_preloadPromise) return _preloadPromise;
    if (_compileInProgress) return;

    _preloadPromise = (async () => {
        try {
            const fsOperation = acode.require("fsOperation") as FsOperation;
            const workspaceUrl = await findWorkspaceRoot();
            if (!workspaceUrl) return;
            const config = await readCompileConfig(workspaceUrl, fsOperation);
            if (!config) return;

            const task = getDefaultTask(config);
            if (!task) return;

            // Resolve include Acode URLs (same logic as runCompile)
            const includeAcodeUrls: string[] = [];
            for (const incTemplate of (task.includes ?? [])) {
                const resolved = resolveVar(incTemplate, {
                    workspaceRoot: workspaceUrl,
                    file: workspaceUrl,
                    fileDirname: workspaceUrl,
                    fileBasename: "",
                });
                includeAcodeUrls.push(resolved);
            }
            if (includeAcodeUrls.length === 0) return;

            // Load WASM compiler (singleton — cheap if already loaded)
            const module = await loadCompiler(wasmBaseUrl);
            const FS = module.FS;

            // Detect FS reset
            const SENTINEL = `${WASM_WORKSPACE}/.pawn_sentinel`;
            try { FS.readFile(SENTINEL); }
            catch {
                _wasmFsFiles.clear();
                ensureWasmDir(FS, WASM_WORKSPACE);
                FS.writeFile(SENTINEL, new Uint8Array([1]));
            }

            // lsDirCache cleared by sentinel check above if needed

            const wasmIncDir = toWasmPath(includeAcodeUrls[0], workspaceUrl).replace(/\/$/, "");
            ensureWasmDir(FS, wasmIncDir);

            // Quick-check: peek first include dir to see if any files are missing.
            // If _wasmFsFiles already has entries for this dir, skip notif + heavy work.
            const firstWasmDir = toWasmPath(includeAcodeUrls[0], workspaceUrl).replace(/\/$/, "");
            const alreadyMounted = [..._wasmFsFiles].some(p => p.startsWith(firstWasmDir + "/"));

            // Fire onStart only if we're actually going to do real work
            if (!alreadyMounted) callbacks?.onStart?.();

            log(`[PawnCompiler] Preload: mounting include dirs...`);
            const t = performance.now();
            let total = 0;
            for (const incDir of includeAcodeUrls) {
                const wasmDir = toWasmPath(incDir, workspaceUrl).replace(/\/$/, "");
                ensureWasmDir(FS, wasmDir);
                const n = await mountDirRecursive(fsOperation, FS, incDir, wasmDir);
                total += n;
            }
            const elapsed = Math.round(performance.now() - t);
            log(`[PawnCompiler] Preload: ${total} files in ${elapsed}ms`);
            // Only notify if we did meaningful work (>0 files actually mounted)
            if (total > 0) callbacks?.onDone?.(total, elapsed);
        } catch (e) {
            log(`[PawnCompiler] Preload failed: ${String(e)}`);
            callbacks?.onError?.(e);
        } finally {
            _preloadPromise = null;
        }
    })();

    return _preloadPromise;
}