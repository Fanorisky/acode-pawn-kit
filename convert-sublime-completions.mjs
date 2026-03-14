#!/usr/bin/env node
// convert-sublime-completions.mjs
// Converts all .sublime-completions files kit/completions/
// into src/snippets.ts format

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";

const COMPLETIONS_DIR = "./kit/completions";
const SNIPPETS_DIR = "./kit/snippets";
const OUTPUT_FILE = "./src/snippets.ts";

const FILE_TYPES = ["pwn", "inc"];

// Use the filename (annotation) directly as the category name
function getCategory(annotation) {
    return annotation || "Pawn";
}

// Convert sublime ${1:param} → same (already compatible with ACE)
// Only simple triggers without contents → just the trigger word (constant/define)
function buildSnippet(trigger, contents) {
    if (!contents) return trigger;
    // Sublime uses ${1:text} — compatible with ACE snippet format already
    return contents;
}

// Escape string for JS template literal / JSON string
function escapeStr(s) {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "")
        .replace(/\t/g, "\\t");
}

// Read all completions
const snippets = [];
const seen = new Set();

// ── 1. Read .sublime-completions files ──────────────────────────────
const files = readdirSync(COMPLETIONS_DIR).filter(f => f.endsWith(".sublime-completions"));

for (const file of files) {
    const annotation = basename(file, ".sublime-completions");
    const category = getCategory(annotation);
    const raw = readFileSync(join(COMPLETIONS_DIR, file), "utf-8");

    let data;
    try {
        // Strip block comments /* ... */ and line comments // ...
        const cleaned = raw
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "")
            // Remove trailing commas before ] or }
            .replace(/,(\s*[\]}])/g, "$1");
        data = JSON.parse(cleaned);
    } catch (e) {
        console.warn(`⚠ Failed to parse ${file}: ${e.message}`);
        continue;
    }

    for (const c of (data.completions || [])) {
        const trigger = c.trigger;
        const contents = c.contents || null;

        if (!trigger) continue;

        // Skip duplicates
        const key = trigger;
        if (seen.has(key)) continue;
        seen.add(key);

        const snippet = buildSnippet(trigger, contents);

        snippets.push({
            prefix: trigger,
            snippet,
            type: category,
            description: `<code>${escapeStr(trigger)}</code> — ${annotation}`,
            fileTypes: FILE_TYPES,
            _isConstant: !contents, // flag: no tab stops
        });
    }
}

// ── 2. Read .sublime-snippet files ──────────────────────────────────
const snippetFiles = readdirSync(SNIPPETS_DIR).filter(f => f.endsWith(".sublime-snippet"));

for (const file of snippetFiles) {
    const raw = readFileSync(join(SNIPPETS_DIR, file), "utf-8");

    // Extract fields from XML
    const descMatch = raw.match(/<description>(.*?)<\/description>/s);
    const contentMatch = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    const triggerMatch = raw.match(/<tabTrigger>(.*?)<\/tabTrigger>/);

    if (!contentMatch || !triggerMatch) continue;

    const trigger = triggerMatch[1].trim();
    const content = contentMatch[1];
    const description = descMatch ? descMatch[1].trim() : trigger;
    const category = "Snippet";

    if (seen.has(trigger)) continue;
    seen.add(trigger);

    snippets.push({
        prefix: trigger,
        snippet: content.trim(),
        type: category,
        description,
        fileTypes: FILE_TYPES,
        _isConstant: false,
    });
}

console.log(`✓ Total snippets collected: ${snippets.length}`);

// ── 3. Write snippets.ts ─────────────────────────────────────────────
// Separate: constants (no tab stops) vs function natives (has tab stops)
// Constants will be simple: prefix = snippet (just a word)
const lines = [];
lines.push(`export interface Snippet {`);
lines.push(`  prefix: string;`);
lines.push(`  snippet: string;`);
lines.push(`  type: string;`);
lines.push(`  description?: string;`);
lines.push(`  fileTypes: string[];`);
lines.push(`}`);
lines.push(``);
lines.push(`// Auto-generated from sublime-kit`);
lines.push(`// Total: ${snippets.length} snippets`);
lines.push(`export const snippets: Snippet[] = [`);

for (const s of snippets) {
    const desc = s.description ? `\n    description: "${escapeStr(s.description)}",` : "";
    lines.push(`  {`);
    lines.push(`    prefix: "${escapeStr(s.prefix)}",`);
    lines.push(`    snippet: "${escapeStr(s.snippet)}",`);
    lines.push(`    type: "${s.type}",${desc}`);
    lines.push(`    fileTypes: ["pwn", "inc"],`);
    lines.push(`  },`);
}

lines.push(`];`);
lines.push(``);

writeFileSync(OUTPUT_FILE, lines.join("\n"), "utf-8");
console.log(`✓ Written to ${OUTPUT_FILE}`);
