import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadConfig } from "../../src/config.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.each([
  { field: "dataDir", override: "BRIDGE_DATA_DIR" },
  { field: "tokenFile", override: "BRIDGE_TOKEN_FILE" },
] as const)("configuration $field", ({ field, override }) => {
  it.each(["", "relative/path"])("rejects an invalid persisted path %j before startup", value => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
    directories.push(dir);
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ [field]: value }));
    expect(() => loadConfig({ BRIDGE_CONFIG: file })).toThrow(ZodError);
  });

  it("rejects a relative environment override", () => {
    expect(() => loadConfig({ [override]: "relative/path" })).toThrow(ZodError);
  });

  it("allows an absolute environment override to replace the file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
    directories.push(dir);
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ [field]: "relative/path" }));
    const absolute = join(dir, "selected-path");
    expect(loadConfig({ BRIDGE_CONFIG: file, [override]: absolute })[field]).toBe(absolute);
  });
});
