import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "./json-store";

describe("json-store atomic writers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "json-store-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writeTextAtomic writes the text, creates the directory and leaves no temp file", () => {
    const path = join(dir, "sub", "weekly-2026-10-20.html");
    writeTextAtomic(path, "<p>hej å ä ö</p>\n");
    expect(readFileSync(path, "utf8")).toBe("<p>hej å ä ö</p>\n");
    expect(readdirSync(join(dir, "sub"))).toEqual(["weekly-2026-10-20.html"]);
  });

  it("writeJsonAtomic still writes pretty JSON with a trailing newline", () => {
    const path = join(dir, "x.json");
    writeJsonAtomic(path, { a: 1 });
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 1\n}\n');
    expect(readJsonIfExists(path)).toEqual({ a: 1 });
    expect(readJsonIfExists(join(dir, "missing.json"))).toBeNull();
  });
});
