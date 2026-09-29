import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8"));
test("admits releases from the minimum API version without a future-version whitelist", () => {
  for (const runtime of ["app", "daemon"] as const)
    for (const version of ["0.8.0", "0.8.1", "0.9.0", "0.9.1", "0.10.0", "0.11.0", "1.0.0"])
      expect(() => assertPluginCompatibility({ ...manifest, runtime, version })).not.toThrow();
});
test("rejects releases below the minimum API version on both runtimes", () => {
  for (const runtime of ["app", "daemon"] as const)
    for (const version of ["0.6.0", "0.7.0", "0.7.9"])
      expect(() => assertPluginCompatibility({ ...manifest, runtime, version })).toThrow();
});
