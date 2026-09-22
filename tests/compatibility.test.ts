import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"));
test("supports the 0.8 daemon and the specifically verified 0.9 beta clients", () => {
  for (const [runtime, version] of [
    ["daemon", "0.8.0"],
    ["app", "0.8.0"],
    ["app", "0.9.0-beta.1"],
    ["app", "0.9.0-beta.2"],
  ] as const)
    expect(() => assertPluginCompatibility({ ...manifest, runtime, version })).not.toThrow();
});
test("does not accidentally authorize unverified client releases", () => {
  for (const version of ["0.7.9", "0.9.0-beta.3", "0.9.0", "0.10.0"])
    expect(() => assertPluginCompatibility({ ...manifest, runtime: "app", version })).toThrow();
});
