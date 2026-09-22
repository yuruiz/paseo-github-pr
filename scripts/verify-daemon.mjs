import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
// Run against a published, exact 0.8.0 server package, never the main daemon.
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { createPaseoClient } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
const root = await mkdtemp(`${tmpdir()}/paseo-github-daemon-`);
const installed = process.env.PASEO_TEST_CLI_ROOT;
const sourceRoot = process.env.PASEO_SOURCE_ROOT;
assert.ok(installed, "Set PASEO_TEST_CLI_ROOT to the installed @getpaseo/cli 0.8.0 directory");
assert.ok(sourceRoot, "Set PASEO_SOURCE_ROOT to a Paseo v0.8.0 source checkout");
const serverRoot = path.join(installed, "node_modules/@getpaseo/server");
assert.equal(
  JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8")).version,
  "0.8.0",
);
const { createPaseoDaemon } = await import(
  pathToFileURL(path.join(serverRoot, "dist/server/server/bootstrap.js"))
);
const { hashDaemonPassword } = await import(
  pathToFileURL(path.join(serverRoot, "dist/server/server/auth.js"))
);
const password = process.env.PASEO_TEST_AUTH === "1" ? randomUUID() : undefined;
const { default: pino } = await import(
  pathToFileURL(path.join(installed, "node_modules/pino/pino.js"))
);
await mkdir(path.join(root, "bin"));
await mkdir(path.join(root, "home"));
await mkdir(path.join(root, "static"));
const repo = path.join(root, "repository");
await mkdir(repo);
const git = (...args) =>
  execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("init", "-b", "main");
git("config", "user.name", "Integration");
git("config", "user.email", "integration@example.test");
await writeFile(path.join(repo, "file.txt"), "base\n");
git("add", ".");
git("commit", "-m", "base");
const base = git("rev-parse", "HEAD");
git("switch", "-c", "feature");
await writeFile(path.join(repo, "file.txt"), "feature\n");
git("commit", "-am", "feature");
const head = git("rev-parse", "HEAD");
git("remote", "add", "origin", "https://github.com/fixture/repo.git");
git("update-ref", "refs/pull/1/head", head);
git("update-ref", "refs/pull/2/head", head);
const repoInfo = { full_name: "fixture/repo", node_id: "R_fixture", default_branch: "main" };
const makePr = (number, author) => ({
  node_id: `PR_${number}`,
  number,
  title: `Fixture ${number}`,
  html_url: `https://github.com/fixture/repo/pull/${number}`,
  user: { login: author },
  state: "open",
  merged: false,
  mergeable: true,
  updated_at: new Date().toISOString(),
  head: { repo: repoInfo, ref: number === 1 ? "feature" : "review-feature", sha: head },
  base: { repo: repoInfo, ref: "main", sha: base },
});
const fixture = {
  prs: { 1: makePr(1, "integration-fixture"), 2: makePr(2, "another-author") },
  comments: { 1: [], 2: [] },
};
const fixturePath = path.join(root, "github.json");
const saveFixture = () => writeFile(fixturePath, JSON.stringify(fixture));
await saveFixture();
await writeFile(
  path.join(root, "bin/gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const f = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
const a = process.argv.slice(2);
if (a.includes("POST")) { fs.appendFileSync(${JSON.stringify(path.join(root, "posts.jsonl"))}, JSON.stringify({args:a,body:fs.readFileSync(0,"utf8")})+"\\n"); process.stdout.write("{}"); }
else if(a.includes("PATCH")) {
 const endpoint=a.find(x=>x.startsWith("repos/")); const number=endpoint.split("/").at(-1);
 const body=JSON.parse(fs.readFileSync(0,"utf8")); if(body.state!=="closed") throw new Error("Unexpected patch");
 f.prs[number].state="closed"; fs.writeFileSync(${JSON.stringify(fixturePath)},JSON.stringify(f));
 process.stdout.write(JSON.stringify(f.prs[number]));
}
else if(a.includes("user")) process.stdout.write(JSON.stringify({login:"integration-fixture"}));
else if(a.includes("graphql")) process.stdout.write(JSON.stringify({data:{viewer:{login:"integration-fixture",pullRequests:{nodes:[{url:f.prs[1].html_url}],pageInfo:{hasNextPage:false,endCursor:null}}}}}));
else {
 const endpoint=a.find(x=>x.startsWith("repos/"));
 const match=/\\/(?:pulls|issues)\\/(\\d+)/.exec(endpoint);
 const number=match?.[1];
 let value = endpoint.includes("check-runs") ? [{check_runs:[]}] : [[]];
 if (/\\/pulls\\/\\d+$/.test(endpoint)) value=f.prs[number];
 else if(endpoint.includes("/issues/") && endpoint.includes("/comments")) value=[f.comments[number]];
 process.stdout.write(JSON.stringify(value));
}
`,
  { mode: 0o755 },
);
await writeFile(
  path.join(root, "bin/git"),
  `#!/usr/bin/env node
const {spawnSync}=require("node:child_process");
const args=process.argv.slice(2).map(x=>x==="https://github.com/fixture/repo.git"?${JSON.stringify(repo)}:x);
if(args.includes("fetch") && args.includes("origin")) args[args.indexOf("origin")]=${JSON.stringify(repo)};
const r=spawnSync("/usr/bin/git",args,{stdio:"inherit"}); process.exit(r.status??1);
`,
  { mode: 0o755 },
);
await build({
  entryPoints: [
    path.join(sourceRoot, "packages/server/src/server/test-utils/fake-agent-client.ts"),
  ],
  nodePaths: [path.resolve("node_modules")],
  platform: "node",
  format: "esm",
  bundle: true,
  outfile: path.join(root, "fake-agent.mjs"),
});
const { createTestAgentClients } = await import(pathToFileURL(path.join(root, "fake-agent.mjs")));
let turns = 0;
const agentClients = createTestAgentClients({
  supportsMcpServers: true,
  onStartTurn: () => {
    turns++;
  },
});
// The fake provider reports the same policy metadata as the native Codex adapter.
// This validates plugin gates and SDK lifecycle, not native sandbox enforcement.
for (const name of ["createSession", "resumeSession"]) {
  const original = agentClients.codex[name].bind(agentClients.codex);
  agentClients.codex[name] = async (...args) => {
    const session = await original(...args);
    const config = args[name === "createSession" ? 0 : 1];
    const describe = session.describePersistence.bind(session);
    session.describePersistence = () => {
      const handle = describe();
      return (
        handle && {
          ...handle,
          metadata: { ...handle.metadata, providerOptions: config?.providerOptions },
        }
      );
    };
    return session;
  };
}
process.env.PATH = `${root}/bin:${process.env.PATH}`;
delete process.env.PASEO_GITHUB_CONFIG;
process.env.XDG_CONFIG_HOME = path.join(root, "config");
delete process.env.PASEO_SERVER_ID;
if (password) process.env.PASEO_PASSWORD = password;
else delete process.env.PASEO_PASSWORD;
process.env.PASEO_HOME = path.join(root, "home");
const config = {
  listen: "127.0.0.1:0",
  auth: password ? { password: hashDaemonPassword(password) } : undefined,
  daemonVersion: "0.8.0",
  paseoHome: path.join(root, "home"),
  corsAllowedOrigins: [],
  hostnames: true,
  mcpEnabled: false,
  mcpInjectIntoAgents: false,
  browserToolsEnabled: false,
  staticDir: path.join(root, "static"),
  mcpDebug: false,
  agentClients,
  agentStoragePath: path.join(root, "home/agents"),
  relayEnabled: false,
  appBaseUrl: "https://app.paseo.sh",
  skillSelection: { mode: "custom", skills: [] },
  autoArchiveAfterMerge: false,
  metadataGeneration: { providers: [] },
};
let daemon;
let client;
let sdk;
const results = [];
try {
  daemon = await createPaseoDaemon(config, pino({ level: "warn" }));
  await daemon.start();
  const target = daemon.getListenTarget();
  assert.equal(target?.type, "tcp");
  const url = `ws://127.0.0.1:${target.port}/ws`;
  await writeFile(
    path.join(config.paseoHome, "paseo.pid"),
    JSON.stringify({ pid: process.pid, listen: `127.0.0.1:${target.port}` }),
  );
  client = new DaemonClient({
    url,
    password,
    appVersion: "0.8.0",
    clientId: "github-pr-verification",
  });
  await client.connect();
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(process.cwd());
  const wait = async (fn, description) => {
    for (let n = 0; n < 160; n++) {
      const value = await fn();
      if (value) {
        results.push(description);
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out: ${description}`);
  };
  await wait(async () => {
    try {
      const state = JSON.parse(
        await readFile(path.join(config.paseoHome, "plugin-data/github-pr/state.json"), "utf8"),
      );
      return state.account === "integration-fixture";
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "background discovery ran before the first plugin RPC");
  const get = () => client.invokePluginRpc("github-pr", "github.snapshot", {});
  await wait(async () => {
    const s = await get();
    return s.connected && s.state.account === "integration-fixture";
  }, "plugin compiled, loaded, and background SDK connected without bootstrap");
  sdk = createPaseoClient({ url, password, appVersion: "0.8.0" });
  await sdk.connect();
  const workspace = await sdk.workspaces.create({
    source: { kind: "directory", path: repo },
    title: "Integration Workspace",
  });
  await client.invokePluginRpc("github-pr", "github.command", { action: "refresh" });
  await wait(
    async () => (await get()).workspaces.some((w) => w.id === workspace.id),
    "SDK-created Workspace observed by plugin",
  );
  const command = (input) => client.invokePluginRpc("github-pr", "github.command", input);
  await wait(
    async () => (await get()).state.bindings[workspace.id]?.prId === "PR_1",
    "authored PR mapped by repository and branch",
  );
  await command({
    action: "policy",
    workspaceId: workspace.id,
    policy: {
      enabled: true,
      comments: true,
      ci: false,
      conflict: false,
      provider: "codex/gpt-5.4-mini",
      hourlyLimit: 3,
    },
  });
  fixture.comments[1].push({
    id: 1,
    body: "Please verify the edge case",
    updated_at: new Date().toISOString(),
    html_url: "https://github.com/fixture/repo/pull/1#issuecomment-1",
    user: { login: "reviewer" },
  });
  await saveFixture();
  await command({ action: "refresh" });
  const repair = await wait(
    async () =>
      Object.values((await get()).state.tasks).find(
        (t) => t.kind === "repair" && t.status === "approval",
      ),
    "new comment dispatched once through actual SDK and agent result recovered",
  );
  assert.equal(turns, 1);
  await command({ action: "refresh" });
  assert.equal(Object.values((await get()).state.tasks).length, 1);
  await command({
    action: "prepare",
    taskId: repair.id,
    kind: "comment",
    body: "Verified fixture response",
  });
  let publication = Object.values((await get()).state.publications).find(
    (p) => p.status === "pending",
  );
  await writeFile(path.join(repo, "file.txt"), "changed after preview\n");
  await assert.rejects(
    command({
      action: "publish",
      publicationId: publication.id,
      fingerprint: publication.fingerprint,
    }),
  );
  await assert.rejects(readFile(path.join(root, "posts.jsonl")));
  await writeFile(path.join(repo, "file.txt"), "feature\n");
  await command({
    action: "prepare",
    taskId: repair.id,
    kind: "comment",
    body: "Verified fixture response",
  });
  publication = Object.values((await get()).state.publications).find((p) => p.status === "pending");
  await command({
    action: "publish",
    publicationId: publication.id,
    fingerprint: publication.fingerprint,
  });
  await assert.rejects(
    command({
      action: "publish",
      publicationId: publication.id,
      fingerprint: publication.fingerprint,
    }),
  );
  assert.equal(
    (await readFile(path.join(root, "posts.jsonl"), "utf8")).trim().split("\n").length,
    1,
  );
  results.push("changed preview blocked; confirmed publication sent once to GitHub fixture");
  await command({
    action: "review",
    url: fixture.prs[2].html_url,
    repositoryPath: repo,
    provider: "codex/gpt-5.4-mini",
    mode: "full",
    clone: false,
  });
  const review = await wait(
    async () =>
      Object.values((await get()).state.tasks).find(
        (t) => t.kind === "review" && t.status === "approval",
      ),
    "manual review created dedicated worktree and completed via SDK",
  );
  assert.equal(turns, 2);
  fixture.prs[2].head.sha = base;
  fixture.comments[2].push({
    id: 2,
    body: "New review comment",
    updated_at: new Date().toISOString(),
    html_url: fixture.prs[2].html_url,
    user: { login: "reviewer" },
  });
  await saveFixture();
  await command({ action: "refresh" });
  assert.equal((await get()).state.tasks[review.id].status, "obsolete");
  assert.equal(turns, 2);
  results.push("review head change invalidated result without automatic re-review");
  await command({
    action: "preparePRAction",
    prId: "PR_2",
    kind: "comment",
    body: "Manual fixture comment",
  });
  let manual = Object.values((await get()).state.prActions).find((a) => a.status === "pending");
  assert.equal(
    (await readFile(path.join(root, "posts.jsonl"), "utf8")).trim().split("\n").length,
    1,
  );
  await command({ action: "confirmPRAction", id: manual.id, fingerprint: manual.fingerprint });
  await assert.rejects(
    command({ action: "confirmPRAction", id: manual.id, fingerprint: manual.fingerprint }),
  );
  assert.equal(
    (await readFile(path.join(root, "posts.jsonl"), "utf8")).trim().split("\n").length,
    2,
  );
  await command({ action: "preparePRAction", prId: "PR_2", kind: "close", body: "" });
  const pendingClose = Object.values((await get()).state.prActions).find(
    (a) => a.status === "pending",
  );
  assert.equal((await get()).state.prs.PR_2.state, "open");
  results.push("manual comment required preview and published once through real plugin RPC");
  const before = await get();
  await client.invokePluginRpc("github-pr", "github.command", {
    action: "configure",
    config: { discoverySeconds: 600, pollSeconds: 120 },
    revision: before.state.revision,
  });
  await client.reloadPlugin("github-pr");
  await wait(async () => {
    const s = await get();
    return s.connected && s.state.config.pollSeconds === 120;
  }, "plugin reload restored persisted configuration without App");
  await sdk.close();
  sdk = undefined;
  await client.close();
  client = undefined;
  await daemon.stop();
  daemon = undefined;
  // Restart on a different port; storage belongs to the daemon identity, not its port.
  daemon = await createPaseoDaemon(
    {
      ...config,
      listen: "127.0.0.1:0",
      pluginsEnabled: true,
      plugins: {
        "github-pr": { source: "directory", path: process.cwd(), enabled: true },
      },
    },
    pino({ level: "warn" }),
  );
  await daemon.start();
  const restartedTarget = daemon.getListenTarget();
  await writeFile(
    path.join(config.paseoHome, "paseo.pid"),
    JSON.stringify({ pid: process.pid, listen: `127.0.0.1:${restartedTarget.port}` }),
  );
  const restartedUrl = `ws://127.0.0.1:${restartedTarget.port}/ws`;
  client = new DaemonClient({
    url: restartedUrl,
    password,
    appVersion: "0.8.0",
    clientId: "github-pr-verification",
  });
  await client.connect();
  await wait(async () => {
    const s = await get();
    return s.connected && s.state.config.pollSeconds === 120;
  }, "daemon restart restored plugin monitoring and configuration");
  assert.equal((await get()).state.prActions[pendingClose.id].status, "pending");
  await command({
    action: "confirmPRAction",
    id: pendingClose.id,
    fingerprint: pendingClose.fingerprint,
  });
  await assert.rejects(
    command({
      action: "confirmPRAction",
      id: pendingClose.id,
      fingerprint: pendingClose.fingerprint,
    }),
  );
  const closed = await get();
  assert.equal(closed.state.prs.PR_2.state, "closed");
  assert.equal(closed.state.prActions[pendingClose.id].status, "done");
  assert.equal(
    Object.values(closed.state.bindings).some((b) => b.prId === "PR_2"),
    true,
  );
  results.push(
    "pending close survived plugin and daemon restart, confirmed once, retained Review Workspace",
  );
  console.log(JSON.stringify({ passed: true, root, results }, null, 2));
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify({ passed: true, results }, null, 2),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (client) {
    try {
      console.error(JSON.stringify(await client.getPluginLogs("github-pr"), null, 2));
    } catch {}
  }
} finally {
  await sdk?.close();
  await client?.close();
  await daemon?.stop();
}
