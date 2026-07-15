import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { API_MUTATION_INVENTORY } from "../../test/api-mutation-inventory";

const MUTATION_EXPORT =
  /export\s+(?:(?:async\s+)?function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  });
}

function routePath(file: string, apiRoot: string): string {
  const directory = relative(apiRoot, dirname(file));
  return `/api/${directory.split(sep).join("/")}`;
}

function sourceMutations(): string[] {
  const apiRoot = resolve("app/api");
  return routeFiles(apiRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(
      /export\s*\{[^}]*\b(?:POST|PUT|PATCH|DELETE)\b[^}]*\}/,
    );
    return [...source.matchAll(MUTATION_EXPORT)].map(
      (match) => `${match[1]} ${routePath(file, apiRoot)}`,
    );
  }).sort();
}

describe("security-sensitive API mutation inventory", () => {
  test("enumerates every exported mutation exactly once", () => {
    const inventory = API_MUTATION_INVENTORY.map(
      ({ method, path }) => `${method} ${path}`,
    ).sort();

    expect(new Set(inventory).size).toBe(inventory.length);
    expect(inventory).toEqual(sourceMutations());
  });

  test("classifies every mutation behind one explicit authorization boundary", () => {
    expect(API_MUTATION_INVENTORY).toEqual([
      {
        boundary: "owner_business",
        id: "annotations.create",
        method: "POST",
        path: "/api/annotations",
      },
      {
        boundary: "owner_business",
        id: "annotations.delete",
        method: "DELETE",
        path: "/api/annotations",
      },
      {
        boundary: "owner_business",
        id: "chat.create",
        method: "POST",
        path: "/api/chat",
      },
      {
        boundary: "owner_business",
        id: "feedback.create",
        method: "POST",
        path: "/api/feedback",
      },
      {
        boundary: "owner_business",
        id: "feedback.redeem",
        method: "POST",
        path: "/api/feedback/redeem",
      },
      {
        boundary: "owner_password_login",
        id: "auth.login",
        method: "POST",
        path: "/api/auth/login",
      },
      {
        boundary: "caller_session_logout",
        id: "auth.logout",
        method: "POST",
        path: "/api/auth/logout",
      },
    ]);
  });
});
