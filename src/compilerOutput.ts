/**
 * Compiler Output Panel
 *
 * A WCPage-based panel that shows pawncc compile results
 * with click-to-jump error/warning navigation.
 */

import type { CompileDiagnostic, CompileResult, RunCompileOptions, CompileStage } from "./pawnCompiler";
import { runCompile } from "./pawnCompiler";

const PANEL_TAG = "pawn-compiler-output";
const STYLE_ID = "pawn-compiler-output-styles";

const STYLES = `
#${PANEL_TAG} {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--primary-color, #1e1e2e);
    color: var(--primary-text-color, #cdd6f4);
    font-family: 'JetBrains Mono', 'Fira Code', monospace, sans-serif;
    font-size: 13px;
}
#${PANEL_TAG} .pco-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--secondary-color, #181825);
    border-bottom: 1px solid var(--border-color, #313244);
    flex-shrink: 0;
}
#${PANEL_TAG} .pco-toolbar-title {
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.75;
    flex: 1;
}
#${PANEL_TAG} .pco-btn {
    background: none;
    border: 1px solid var(--border-color, #313244);
    color: inherit;
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    opacity: 0.8;
    transition: opacity 0.15s, background 0.15s;
}
#${PANEL_TAG} .pco-btn:hover {
    opacity: 1;
    background: var(--highlight-color, rgba(255,255,255,0.08));
}
#${PANEL_TAG} .pco-btn:active {
    opacity: 0.6;
}
#${PANEL_TAG} .pco-status {
    padding: 8px 14px;
    font-size: 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #313244);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
}
#${PANEL_TAG} .pco-status.compiling { color: #89b4fa; }
#${PANEL_TAG} .pco-status.success   { color: #a6e3a1; }
#${PANEL_TAG} .pco-status.error     { color: #f44444ff; }
#${PANEL_TAG} .pco-status.warning   { color: #ffee00ff; }
#${PANEL_TAG} .pco-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
}
#${PANEL_TAG} .pco-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 14px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background 0.1s;
}
#${PANEL_TAG} .pco-item:hover {
    background: var(--highlight-color, rgba(255,255,255,0.06));
}
#${PANEL_TAG} .pco-item.type-error {
    border-left-color: #f44444ff;
}
#${PANEL_TAG} .pco-item.type-warning {
    border-left-color: #ffee00ff;
}
#${PANEL_TAG} .pco-item.type-fatal {
    border-left-color: #664392ff;
}

/* CSS Icons */
#${PANEL_TAG} .pco-icon-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 5px;
}
#${PANEL_TAG} .pco-icon-dot.fatal { background: #664392ff; box-shadow: 0 0 4px rgba(203, 166, 247, 0.4); }
#${PANEL_TAG} .pco-icon-dot.error { background: #f44444ff; box-shadow: 0 0 4px rgba(243, 139, 139, 0.4); }
#${PANEL_TAG} .pco-icon-dot.warning { background: #ffee00ff; }

#${PANEL_TAG} .pco-icon-file {
    width: 12px;
    height: 14px;
    border: 1.5px solid #a6e3a1;
    border-radius: 2px;
    position: relative;
    flex-shrink: 0;
    margin-top: 2px;
}
#${PANEL_TAG} .pco-icon-file::after {
    content: '';
    position: absolute;
    top: 3px; left: 2px; right: 2px; height: 1.5px;
    background: #a6e3a1; border-radius: 1px;
}

#${PANEL_TAG} .pco-meta {
    flex: 1;
    min-width: 0;
}
#${PANEL_TAG} .pco-location {
    font-size: 11px;
    opacity: 0.6;
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#${PANEL_TAG} .pco-msg {
    font-size: 12px;
    line-height: 1.4;
    word-break: break-word;
}
#${PANEL_TAG} .pco-code {
    font-size: 10px;
    opacity: 0.5;
    margin-top: 2px;
    font-weight: 600;
}
#${PANEL_TAG} .pco-raw {
    padding: 12px 14px;
    font-size: 12px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    white-space: pre;
    margin: 0;
    opacity: 0.9;
    line-height: 1.6;
    border-bottom: 1px solid var(--border-color, #313244);
    max-height: 55vh;
    overflow-x: auto;
    overflow-y: auto;
}
#${PANEL_TAG} .pco-diag-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border-bottom: 1px solid var(--border-color, #313244);
    user-select: none;
    opacity: 0.75;
    transition: opacity 0.15s;
}
#${PANEL_TAG} .pco-diag-header:hover { opacity: 1; }
#${PANEL_TAG} .pco-diag-arrow {
    width: 0; height: 0;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 6px solid currentColor;
    transition: transform 0.15s;
    flex-shrink: 0;
}
#${PANEL_TAG} .pco-diag-arrow.open { transform: rotate(90deg); }
#${PANEL_TAG} .pco-diag-hint {
    margin-left: auto;
    font-size: 10px;
    opacity: 0.45;
    font-weight: 400;
}
#${PANEL_TAG} .pco-diag-list { display: none; }
#${PANEL_TAG} .pco-divider {
    padding: 6px 14px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.45;
    border-bottom: 1px solid var(--border-color, #313244);
}
#${PANEL_TAG} .pco-output-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-left: 3px solid #a6e3a1;
    background: rgba(166,227,161,0.04);
    margin-bottom: 4px;
}
#${PANEL_TAG} .pco-empty {
    padding: 30px 20px;
    opacity: 0.6;
    font-size: 12px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
}
#${PANEL_TAG} .pco-empty-icon {
    width: 32px;
    height: 32px;
    border: 2px dashed rgba(255,255,255,0.3);
    border-radius: 50%;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
}
#${PANEL_TAG} .pco-empty-icon.success {
    border-color: #a6e3a1;
    border-style: solid;
}
#${PANEL_TAG} .pco-empty-icon.success::after {
    content: '';
    width: 6px; height: 12px;
    border-bottom: 2px solid #a6e3a1;
    border-right: 2px solid #a6e3a1;
    transform: rotate(45deg) translateY(-2px);
}
#${PANEL_TAG} .pco-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(137, 180, 250, 0.3);
    border-radius: 50%;
    border-top-color: #89b4fa;
    animation: pco-spin 0.8s cubic-bezier(0.5, 0.1, 0.4, 0.9) infinite;
    margin-top: 2px;
    flex-shrink: 0;
}
@keyframes pco-spin {
    to { transform: rotate(360deg); }
}
#${PANEL_TAG} .pco-copy-btn {
    opacity: 0;
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--border-color, #313244);
    color: inherit;
    border-radius: 3px;
    font-size: 10px;
    padding: 2px 6px;
    cursor: pointer;
    transition: opacity 0.15s, background 0.15s;
    align-self: flex-start;
    margin-top: 3px;
    white-space: nowrap;
}
#${PANEL_TAG} .pco-item:hover .pco-copy-btn {
    opacity: 0.7;
}
#${PANEL_TAG} .pco-copy-btn:hover {
    opacity: 1 !important;
    background: var(--highlight-color, rgba(255,255,255,0.08));
}
#${PANEL_TAG} .pco-copy-btn.copied {
    opacity: 1 !important;
    color: #a6e3a1;
    border-color: #a6e3a1;
}
`;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert an Acode URL to a short, human-readable path.
 * content://com.android.externalstorage.documents/tree/primary:foo/bar/file.amx
 *  → foo/bar/file.amx  (last N segments of the decoded docId path)
 * file:///sdcard/foo/bar/file.amx → foo/bar/file.amx
 */
function readableUrl(url: string, segments = 3): string {
    try {
        if (url.startsWith("content://")) {
            const dColonIdx = url.lastIndexOf("::");
            if (dColonIdx !== -1) {
                const rest = url.slice(dColonIdx + 2);
                const pathPart = rest.split(":").slice(1).join(":");
                const parts = decodeURIComponent(pathPart).split("/").filter(Boolean);
                return parts.slice(-segments).join("/");
            }
        }
        // file:// or fallback
        const decoded = decodeURIComponent(url);
        const parts = decoded.split("/").filter(Boolean);
        return parts.slice(-segments).join("/");
    } catch {
        return url.split("/").pop() ?? url;
    }
}

/**
 * Format a Date as HH:MM:SS for the timestamp label.
 */
function formatTime(d: Date): string {
    const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Human-readable label for each compile stage. */
const STAGE_LABELS: Record<CompileStage, string> = {
    "waiting-preload": "Waiting for include preload...",
    "mounting":        "Mounting files...",
    "compiling":       "Compiling...",
};

// ── Panel class ────────────────────────────────────────────────────────────

export class CompilerOutputPanel {
    private $page: WCPage;
    private $root: HTMLElement | null = null;
    private $status!: HTMLElement;
    private $timestamp!: HTMLElement;
    private $list!: HTMLElement;
    private $rerunBtn!: HTMLButtonElement;
    private $clearBtn!: HTMLButtonElement;
    private _opts: RunCompileOptions;
    private _running = false;
    private _startTime = 0;

    constructor($page: WCPage, opts: RunCompileOptions) {
        this.$page = $page;
        this._opts = opts;
        this._injectStyles();
        this._build();
    }

    private _injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    private _build() {
        const root = document.createElement("div");
        root.id = PANEL_TAG;
        this.$root = root;

        // Toolbar
        const toolbar = document.createElement("div");
        toolbar.className = "pco-toolbar";

        const titleWrap = document.createElement("div");
        titleWrap.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

        const title = document.createElement("span");
        title.className = "pco-toolbar-title";
        title.textContent = "Pawn Compiler";

        // Last compile timestamp — shown after first run
        this.$timestamp = document.createElement("span");
        this.$timestamp.style.cssText =
            "font-size:10px;opacity:0.45;margin-top:1px;display:none;";

        titleWrap.append(title, this.$timestamp);

        this.$rerunBtn = document.createElement("button");
        this.$rerunBtn.className = "pco-btn";
        this.$rerunBtn.textContent = "Run";
        this.$rerunBtn.onclick = () => this.run();

        const clearBtn = document.createElement("button");
        clearBtn.className = "pco-btn";
        clearBtn.textContent = "Clear";
        clearBtn.onclick = () => this._clear();
        this.$clearBtn = clearBtn;

        toolbar.append(titleWrap, this.$rerunBtn, clearBtn);

        // Status bar
        this.$status = document.createElement("div");
        this.$status.className = "pco-status";
        this.$status.textContent = "Ready";

        // List
        this.$list = document.createElement("div");
        this.$list.className = "pco-list";

        root.append(toolbar, this.$status, this.$list);
        this.$page.body = root;
    }

    private _clear() {
        this.$list.innerHTML = "";
        this.$status.className = "pco-status";
        this.$status.textContent = "Ready";
    }

    private _setStatus(
        msg: string,
        cls: "compiling" | "success" | "error" | "warning" | ""
    ) {
        this.$status.className = `pco-status ${cls}`;
        this.$status.innerHTML = "";
        if (cls === "compiling") {
            const spinner = document.createElement("span");
            spinner.className = "pco-spinner";
            const label = document.createElement("span");
            label.textContent = msg;
            this.$status.append(spinner, label);
        } else {
            this.$status.textContent = msg;
        }
    }

    private _startTimer() {
        this._startTime = performance.now();
    }

    private _stopTimer(): number {
        return parseFloat(((performance.now() - this._startTime) / 1000).toFixed(2));
    }

    /** Called when runCompile reports a new pipeline stage. */
    private _onStage(stage: CompileStage) {
        this._setStatus(STAGE_LABELS[stage], "compiling");
    }

    private _renderDiagnostics(result: CompileResult) {
        this.$list.innerHTML = "";

        const rawOutput = [result.stdout, result.stderr]
            .map(s => s.trim()).filter(Boolean).join("\n").trim();

        // ── Raw pawncc output ──────────────────────────────────────────────
        // Always shown — this is the exact compiler output like qawno/Pawno.
        // max-height so it doesn't eat the whole screen when output is huge.
        if (rawOutput) {
            const pre = document.createElement("pre");
            pre.className = "pco-raw";
            pre.textContent = rawOutput;
            this.$list.appendChild(pre);
        } else if (!result.outputUrl && result.diagnostics.length === 0) {
            const empty = document.createElement("div");
            empty.className = "pco-empty";
            const icon = document.createElement("div");
            icon.className = result.success ? "pco-empty-icon success" : "pco-empty-icon";
            const text = document.createElement("div");
            text.textContent = result.success ? "No errors or warnings." : "No output.";
            empty.append(icon, text);
            this.$list.appendChild(empty);
            return;
        }

        // ── Output file card ───────────────────────────────────────────────
        if (result.outputUrl) {
            const card = document.createElement("div");
            card.className = "pco-output-card";
            const icon = document.createElement("div");
            icon.className = "pco-icon-file";
            const info = document.createElement("div");
            info.style.cssText = "flex:1;min-width:0;";
            const amxName = result.outputUrl.split("/").pop() ?? "output.amx";
            const nameEl = document.createElement("div");
            nameEl.style.cssText = "font-size:13px;font-weight:600;letter-spacing:0.02em;";
            nameEl.textContent = amxName;
            const readable = readableUrl(result.outputUrl, 3);
            const pathEl = document.createElement("div");
            pathEl.style.cssText =
                "font-size:11px;opacity:0.6;margin-top:2px;" +
                "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            pathEl.textContent = readable;
            pathEl.title = result.outputUrl;
            const metaEl = document.createElement("div");
            metaEl.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;";
            if (result.outputSize) {
                const badge = document.createElement("span");
                badge.style.cssText =
                    "font-size:10px;font-weight:600;letter-spacing:0.04em;color:#a6e3a1;";
                badge.textContent = (result.outputSize / 1024).toFixed(1) + " KB";
                metaEl.appendChild(badge);
            }
            const savedLabel = document.createElement("span");
            savedLabel.style.cssText = "font-size:10px;opacity:0.4;";
            savedLabel.textContent = "saved to device";
            metaEl.appendChild(savedLabel);
            info.append(nameEl, pathEl, metaEl);
            card.append(icon, info);
            this.$list.appendChild(card);
        }

        // ── Diagnostics — collapsible, lazy-rendered ───────────────────────
        // Shown below raw output as clickable jump-to-line shortcuts.
        // Auto-collapsed when there are many entries to avoid lag.
        if (result.diagnostics.length === 0) return;

        const errors = result.diagnostics.filter(d => d.type === "error" || d.type === "fatal error").length;
        const warnings = result.diagnostics.filter(d => d.type === "warning").length;
        const total = result.diagnostics.length;
        const LAZY_THRESHOLD = 10; // render all at once if small, lazy if large

        // Build summary label: "3 errors, 2 warnings" or "5 warnings"
        const parts: string[] = [];
        if (errors > 0) parts.push(`${errors} error${errors !== 1 ? "s" : ""}`);
        if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? "s" : ""}`);
        const summaryText = parts.join(", ") || `${total} diagnostic${total !== 1 ? "s" : ""}`;

        // Collapsible header
        const header = document.createElement("div");
        header.className = "pco-diag-header";
        const arrow = document.createElement("span");
        arrow.className = "pco-diag-arrow";
        const label = document.createElement("span");
        label.textContent = summaryText;
        const hint = document.createElement("span");
        hint.className = "pco-diag-hint";
        hint.textContent = "tap to jump";
        header.append(arrow, label, hint);

        // Diagnostics container
        const container = document.createElement("div");
        container.className = "pco-diag-list";

        let expanded = false;
        let rendered = false;

        const renderItems = () => {
            if (rendered) return;
            rendered = true;
            // Lazy: render in chunks to avoid blocking main thread for huge lists
            const CHUNK = 50;
            let i = 0;
            const renderChunk = () => {
                const end = Math.min(i + CHUNK, result.diagnostics.length);
                for (; i < end; i++) {
                    container.appendChild(this._renderItem(result.diagnostics[i]));
                }
                if (i < result.diagnostics.length) {
                    requestAnimationFrame(renderChunk);
                }
            };
            renderChunk();
        };

        const toggle = () => {
            expanded = !expanded;
            arrow.classList.toggle("open", expanded);
            container.style.display = expanded ? "block" : "none";
            hint.style.display = expanded ? "none" : "";
            if (expanded) renderItems();
        };

        header.addEventListener("click", toggle);

        // Auto-expand if small enough
        if (total <= LAZY_THRESHOLD) {
            toggle();
        } else {
            arrow.classList.remove("open");
            container.style.display = "none";
        }

        this.$list.appendChild(header);
        this.$list.appendChild(container);
    }

    private _renderItem(diag: CompileDiagnostic): HTMLElement {
        const item = document.createElement("div");
        const typeClass =
            diag.type === "fatal error"
                ? "type-fatal"
                : diag.type === "error"
                    ? "type-error"
                    : "type-warning";
        item.className = `pco-item ${typeClass}`;

        const icon = document.createElement("span");
        const typeStr = diag.type === "fatal error" ? "fatal" : diag.type === "error" ? "error" : "warning";
        icon.className = `pco-icon-dot ${typeStr}`;

        const meta = document.createElement("div");
        meta.className = "pco-meta";

        const location = document.createElement("div");
        location.className = "pco-location";
        const basename = diag.file.split("/").pop() ?? diag.file;
        location.textContent = `${basename}:${diag.line}`;
        location.title = diag.file;

        const msg = document.createElement("div");
        msg.className = "pco-msg";
        msg.textContent = diag.message;

        const code = document.createElement("div");
        code.className = "pco-code";
        code.textContent = `${diag.type} ${diag.code}`;

        meta.append(location, msg, code);

        // Copy button — visible on hover
        const copyBtn = document.createElement("button");
        copyBtn.className = "pco-copy-btn";
        copyBtn.textContent = "copy";
        copyBtn.title = "Copy to clipboard";
        copyBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // don't trigger _jumpTo
            const basename = diag.file.split("/").pop() ?? diag.file;
            const text = `${basename}:${diag.line} — ${diag.type} ${diag.code}: ${diag.message}`;
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = "copied";
                copyBtn.classList.add("copied");
                setTimeout(() => {
                    copyBtn.textContent = "copy";
                    copyBtn.classList.remove("copied");
                }, 1500);
            }).catch(() => {
                // Fallback for environments without clipboard API
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.cssText = "position:fixed;opacity:0;";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                ta.remove();
                copyBtn.textContent = "copied";
                copyBtn.classList.add("copied");
                setTimeout(() => {
                    copyBtn.textContent = "copy";
                    copyBtn.classList.remove("copied");
                }, 1500);
            });
        });

        item.append(icon, meta, copyBtn);

        item.addEventListener("click", () => this._jumpTo(diag));

        return item;
    }

    private async _jumpTo(diag: CompileDiagnostic) {
        const editor = editorManager.editor as any;
        if (!editor) return;

        const basename = diag.file.split("/").pop()?.toLowerCase();
        let targetFile = editorManager.files.find(
            (f: any) =>
                f.filename?.toLowerCase() === basename ||
                (f.uri ?? f.location ?? "")
                    .toLowerCase()
                    .endsWith("/" + basename)
        );

        if (targetFile) {
            editorManager.switchFile(targetFile.id);
        }
        await new Promise((r) => setTimeout(r, 50));

        const row = Math.max(0, diag.line - 1);
        try {
            if (editor.gotoLine) {
                editor.gotoLine(diag.line, 0, true);
            } else if (editor.scrollToRow) {
                editor.scrollToRow(row);
                editor.moveCursorTo(row, 0);
            }
        } catch (e) {
            console.warn("[PawnCompiler] gotoLine failed:", e);
        }
    }

    /** Public: trigger a compile run */
    async run() {
        if (this._running) return;
        this._running = true;
        this.$rerunBtn.style.display = "none";
        this.$clearBtn.style.display = "none";
        // Start with a neutral label — onStage will update it immediately
        this._setStatus("Starting...", "compiling");
        this._startTimer();
        this.$list.innerHTML = "";

        try {
            // Auto-save all unsaved files before compiling (like Sublime Text).
            // Saves in parallel — only files with a URI (i.e. on disk), skip untitled.
            const unsaved: any[] = (editorManager?.files ?? []).filter(
                (f: any) => f?.isUnsaved && f?.uri
            );
            if (unsaved.length > 0) {
                await Promise.allSettled(unsaved.map((f: any) => f.save()));
            }

            const result = await runCompile({
                ...this._opts,
                onStage: (stage) => this._onStage(stage),
            });
            const elapsed = this._stopTimer();
            const timeStr = ` — ${elapsed}s`;

            this.$timestamp.textContent = `Last compiled at ${formatTime(new Date())}`;
            this.$timestamp.style.display = "";

            if (!result.workspaceUrl) {
                this._setStatus(
                    "Workspace not found — create .pawn/compile.json",
                    "error"
                );
                return;
            }

            if (result.stderr.includes("Cannot read") || result.exitCode === -1) {
                this._setStatus((result.stderr.trim() || "Compile failed"), "error");
                return;
            }

            const errors = result.diagnostics.filter((d) =>
                d.type === "error" || d.type === "fatal error"
            ).length;
            const warnings = result.diagnostics.filter(
                (d) => d.type === "warning"
            ).length;

            if (result.success) {
                this._setStatus(
                    warnings > 0
                        ? `Compiled — ${warnings} warning${warnings !== 1 ? "s" : ""}${timeStr}`
                        : `Compiled successfully${timeStr}`,
                    warnings > 0 ? "warning" : "success"
                );
            } else {
                this._setStatus(
                    `${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}${timeStr}`,
                    "error"
                );
            }

            this._renderDiagnostics(result);
        } catch (e: any) {
            this._stopTimer();
            this._setStatus("Internal error: " + String(e), "error");
            console.error("[PawnCompiler] run error:", e);
        } finally {
            this._running = false;
            this.$rerunBtn.style.display = "";
            this.$clearBtn.style.display = "";
        }
    }

    show() {
        this.$page.show();
    }

    hide() {
        this.$page.hide();
    }

    /** Clean up DOM, styles, and timers on destroy */
    destroy() {
        this._stopTimer();
        if (this.$root) {
            // Clear children first (removes their addEventListener listeners from memory)
            this.$root.innerHTML = "";
            // Then detach root itself from the DOM
            this.$root.remove();
            this.$root = null;
        }

        // Clear page body reference
        try {
            this.$page.body = null as any;
        } catch { /* ignore if page already torn down */ }

        document.getElementById(STYLE_ID)?.remove();
    }
}