import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const sourceIcon = resolve(root, "assets/icon-256.png");
const iconsetDir = resolve(root, "build/icon.iconset");
const outputIcns = resolve(root, "build/icon.icns");

function run(command) {
  execSync(command, { stdio: "inherit" });
}

function writeSize(size) {
  const out = resolve(iconsetDir, `icon_${size}x${size}.png`);
  run(`sips -z ${size} ${size} "${sourceIcon}" --out "${out}"`);
}

function writeRetinaSize(size) {
  const out = resolve(iconsetDir, `icon_${size}x${size}@2x.png`);
  const retina = size * 2;
  run(`sips -z ${retina} ${retina} "${sourceIcon}" --out "${out}"`);
}

function main() {
  if (process.platform !== "darwin") {
    console.log("[prepare-macos-icon] Non-macOS host; skipping icon generation.");
    return;
  }

  if (!existsSync(sourceIcon)) {
    console.warn(`[prepare-macos-icon] Missing source icon: ${sourceIcon}`);
    return;
  }

  rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });

  writeSize(16);
  writeRetinaSize(16);
  writeSize(32);
  writeRetinaSize(32);
  writeSize(128);
  writeRetinaSize(128);
  writeSize(256);
  writeRetinaSize(256);
  writeSize(512);
  writeRetinaSize(512);

  run(`iconutil -c icns "${iconsetDir}" -o "${outputIcns}"`);
  console.log(`[prepare-macos-icon] Wrote ${outputIcns}`);
}

main();
