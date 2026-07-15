#!/usr/bin/env node
/* global console, process */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

function xmlText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const [templatePath, outputPath, projectDirectory, nodePath] = process.argv.slice(2);
if (!templatePath || !outputPath || !projectDirectory || !nodePath) {
  console.error("usage: render-launchd-plist.mjs TEMPLATE OUTPUT PROJECT_DIR NODE_PATH");
  process.exit(64);
}
if (!isAbsolute(projectDirectory) || !isAbsolute(nodePath)) {
  console.error("project and Node paths must be absolute");
  process.exit(64);
}

const template = readFileSync(templatePath, "utf8");
for (const placeholder of ["__PROJECT_DIR__", "__NODE_PATH__"]) {
  if (!template.includes(placeholder)) {
    throw new Error(`LaunchAgent template is missing ${placeholder}`);
  }
}

const rendered = template
  .replaceAll("__PROJECT_DIR__", xmlText(projectDirectory))
  .replaceAll("__NODE_PATH__", xmlText(nodePath));
writeFileSync(outputPath, rendered, { encoding: "utf8", flag: "wx", mode: 0o644 });
