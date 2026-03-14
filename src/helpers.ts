const PAWN_EXTENSIONS = ["pwn", "inc"];

function getFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf(".");
    if (lastDotIndex === -1 || lastDotIndex === fileName.length - 1) {
        return "";
    }
    return fileName.slice(lastDotIndex + 1).toLowerCase();
}

function isPawnExtension(ext: string): boolean {
    return PAWN_EXTENSIONS.includes(ext.toLowerCase());
}

function getTypeFromMode(modeName: string): string {
    const normalizedModeName = modeName.toLowerCase();
    if (normalizedModeName.includes("pawn")) return "pwn";
    if (normalizedModeName.includes("pwn")) return "pwn";
    if (normalizedModeName.includes("inc")) return "inc";
    const modeNameParts = normalizedModeName.split("/");
    return modeNameParts[modeNameParts.length - 1];
}

export function getCurrentFileType(session?: any): string {
    /*
    Priority:
    1. Extension dari filename aktif (.pwn / .inc) — paling reliable di Acode
    2. Session mode ID
    3. activeFile mode
    */

    // 1. Cek extension file aktif DULU (paling reliable)
    const activeFile = editorManager?.activeFile;
    const ext = getFileExtension(activeFile?.filename || "");
    if (isPawnExtension(ext)) {
        return ext; // "pwn" atau "inc"
    }

    // 2. Cek session mode
    const sessionModeId =
        session?.getMode?.()?.$id ||
        session?.$mode?.$id ||
        "";
    if (sessionModeId) {
        const fromMode = getTypeFromMode(sessionModeId);
        if (isPawnExtension(fromMode)) return fromMode;
    }

    // 3. Fallback ke activeFile mode
    const activeFileMode =
        (activeFile as any)?.currentMode || (activeFile as any)?.mode || "";
    if (activeFileMode) {
        const modeType = getTypeFromMode(activeFileMode);
        if (isPawnExtension(modeType)) return modeType;
    }

    // 4. Return extension mentah (biarkan getRelevantSnippets filter)
    if (ext) return ext;
    if (sessionModeId) return getTypeFromMode(sessionModeId);
    if (activeFileMode) return getTypeFromMode(activeFileMode);

    return "";
}
