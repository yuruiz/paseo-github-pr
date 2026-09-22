import { tmpdir } from "node:os";
// Exercise the exact beta client loader with the bundle compiled by the 0.8 daemon.
// Platform UI services are fixtures; this is not a full browser/app acceptance run.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import assert from "node:assert/strict";
const sourceRoot = process.env.PASEO_SOURCE_ROOT;
const installed = process.env.PASEO_TEST_CLI_ROOT;
assert.ok(sourceRoot, "Set PASEO_SOURCE_ROOT to a Paseo checkout with the selected beta tag");
assert.ok(installed, "Set PASEO_TEST_CLI_ROOT to the installed @getpaseo/cli 0.8.0 directory");
const clientVersion = process.argv[2] ?? "0.9.0-beta.2";
assert.match(clientVersion, /^0\.9\.0-beta\.[12]$/);
const root = await mkdtemp(`${tmpdir()}/paseo-github-beta-client-`);
const source = execFileSync(
  "git",
  ["-C", sourceRoot, "show", `v${clientVersion}:packages/app/src/plugins/evaluate.ts`],
  { encoding: "utf8" },
);
const checker = execFileSync(
  "git",
  ["-C", sourceRoot, "show", `v${clientVersion}:packages/protocol/src/plugin-requirements.ts`],
  { encoding: "utf8" },
);
const shims = {
  "@/utils/open-external-url":
    "export const openExternalUrl=()=>{throw new Error('Unused platform opener')};",
  "./react-native/ui": "export {};",
  "./settings/use-settings": "export const useSettings=()=>{throw new Error('Unused settings')};",
  "@tanstack/react-query": "export {};",
  "./icons": "export const resolvePluginIcon=(name)=>name;",
  "./react-native/runtime":
    "import {ScrollView} from 'react-native-web'; export const pluginReactNativeRuntime={ScrollView};",
  "./themes":
    "export const parsePluginThemeContribution=()=>{throw new Error('Unused theme parser')};",
};
await build({
  stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: `${root}/evaluate.cjs`,
  alias: { "react-native": "react-native-web" },
  plugins: [
    {
      name: "platform-fixtures",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) =>
          a.path in shims ? { path: a.path, namespace: "fixture" } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
          contents: shims[a.path],
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
await build({
  stdin: { contents: checker, resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: `${root}/requirements.cjs`,
});
const require = createRequire(import.meta.url);
const { runPluginClientBundle } = require(`${root}/evaluate.cjs`);
const { assertPluginCompatibility } = require(`${root}/requirements.cjs`);
const manifest = JSON.parse(await readFile("paseo-plugin.json", "utf8"));
assertPluginCompatibility({ ...manifest, runtime: "app", version: clientVersion });
const serverRoot = `${installed}/node_modules/@getpaseo/server`;
assert.equal(JSON.parse(await readFile(`${serverRoot}/package.json`, "utf8")).version, "0.8.0");
const { compilePlugin } = await import(`${serverRoot}/dist/server/server/plugins/compiler.js`);
const { clientBundle } = await compilePlugin({
  client: `${process.cwd()}/index.client.tsx`,
  server: `${process.cwd()}/index.server.ts`,
});
let opened;
const runtime = {
  paseo: {},
  rpc: () => {},
  openSettings: () => {},
  openPanel: () => {},
  openSurface: (id) => {
    opened = id;
  },
  hosts: { getSnapshot: () => [], subscribe: () => () => {} },
};
const evaluated = runPluginClientBundle("github-pr", clientBundle, runtime);
assert.equal(evaluated.surfaces.length, 1);
assert.equal(evaluated.sidebarItems[0].title, "GitHub PRs");
assert.deepEqual(evaluated.workspacePanels[0].locations, ["workspace", "explorer"]);
assert.equal(evaluated.commandCenterItems[0].title, "Open GitHub PRs");
evaluated.commandCenterItems[0].onSelect(runtime);
assert.equal(opened, "inbox");
await evaluated.cleanup();
assert.equal(evaluated.surfaces.length, 0);
const report = {
  passed: true,
  daemonVersion: "0.8.0",
  clientVersion,
  checks: [
    "exact beta manifest validator",
    "actual beta bundle evaluator",
    "sidebar/surface/workspace-panel registration",
    "command center navigation",
    "cleanup",
  ],
};
await writeFile(`${root}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, root }, null, 2));
