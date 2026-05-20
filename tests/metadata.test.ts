import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const oldScope = "@mario" + "zechner/";

/** Читает файл репозитория в UTF-8 для метаданных и простых регрессий. */
function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("package metadata and TypeScript sources do not use the old Pi scope", () => {
  "Проверяет отсутствие устаревшего scope в метаданных пакета и исходниках TypeScript.";
  const filesToCheck = [
    "package.json",
    "src/index.ts",
    "src/runtime.ts",
    "tests/runtime.test.ts",
  ];

  for (const relativePath of filesToCheck) {
    assert.equal(
      readRepoFile(relativePath).includes(oldScope),
      false,
      `Найден устаревший scope в ${relativePath}`,
    );
  }
});
