import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { expect, test } from "vitest";

const webRoot = resolve("web");
const productionRoots = ["app", "components", "lib"]
  .map((directory) => resolve(webRoot, directory))
  .concat([resolve(webRoot, "proxy.ts")]);

function filesBelow(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesBelow(resolve(path, name)));
}

test("Web production modules do not escape the deployable web root", () => {
  const escapes: string[] = [];
  for (const file of productionRoots.flatMap(filesBelow)) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      const pathFromWeb = relative(webRoot, target);
      if (pathFromWeb === ".." || pathFromWeb.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        escapes.push(`${relative(webRoot, file)} -> ${specifier}`);
      }
    }
  }
  expect(escapes).toEqual([]);
});
