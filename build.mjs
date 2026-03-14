import * as esbuild from "esbuild";
import { exec } from 'child_process';
import * as fs from 'fs';

let result = await esbuild.build({
    entryPoints: ["./src/main.ts"],
    bundle: true,
    loader: {
        ".ts": "ts"
    },
    splitting: true,
    format: "esm",
    minify: true,
    logLevel: 'info',
    color: true,
    outdir: "dist"
});

// Copy pawncc WASM files to dist/
if (fs.existsSync("./kit/pawncc")) {
    fs.cpSync("./kit/pawncc", "../dist/pawncc", { recursive: true });
    console.log("[build] Copied kit/pawncc/ → dist/pawncc/");
}

exec("node .vscode/pack-zip.js", (err, stdout, stderr) => {
    if (err) {
        console.error(err);
        return;
    }
    console.log(stdout);
});