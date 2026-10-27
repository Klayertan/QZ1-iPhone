// Packs the viewer (web/) for the Core2's SD card:
//
//   node tools/pack-sd.mjs [outDir]          (default: dist/www)
//
// Copy the resulting folder to the SD card as /www (the firmware serves /www), or send it over the
// USB cable with tools/upload-sd.py. Text files are gzipped (name.gz): the firmware sends them with
// Content-Encoding: gzip. version.txt (git commit + date) is the page's cache key.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "web");
const OUT = resolve(process.argv[2] ?? join(ROOT, "dist", "www"));
const TEXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

let version = "nogit";
try {
  version = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain", "web"], { cwd: ROOT, encoding: "utf8" }).trim()) version += "+local";
} catch {
  // not a git checkout
}
version += ` ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

rmSync(OUT, { recursive: true, force: true });
let raw = 0;
let stored = 0;
let count = 0;
for (const file of walk(SOURCE)) {
  const rel = relative(SOURCE, file).split("\\").join("/");
  const body = readFileSync(file);
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  const target = join(OUT, rel);
  mkdirSync(dirname(target), { recursive: true });
  raw += body.length;
  count += 1;
  if (TEXT.has(ext)) {
    const zipped = gzipSync(body, { level: 9 });
    writeFileSync(`${target}.gz`, zipped);
    stored += zipped.length;
  } else {
    writeFileSync(target, body);
    stored += body.length;
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "version.txt"), `${version}\n`);
console.log(`packed ${count} files, version "${version}": ${(raw / 1024).toFixed(1)} KB -> ${(stored / 1024).toFixed(1)} KB`);
console.log(OUT);
console.log("Copy it to the SD card as /www (or: python tools/upload-sd.py <serial port> " + OUT + ")");
