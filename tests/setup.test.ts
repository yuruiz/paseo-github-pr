import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { resolveSetup, resolveConnection, verifyHost } from "../server/setup";
import { Runtime } from "../server/runtime";
import { Store } from "../server/store";

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "github-pr-setup-"));
  env = { PASEO_HOME: path.join(root, "daemon"), XDG_CONFIG_HOME: path.join(root, "config") };
  await mkdir(env.PASEO_HOME!);
  await writeFile(path.join(env.PASEO_HOME!, "server-id"), "srv_fixture\n");
});
afterEach(async () => {
  if (server) {
    const closing = new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closing;
    server = undefined;
  }
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function bootstrap(config: unknown) {
  const file = path.join(env.XDG_CONFIG_HOME!, "paseo-github-pr", "bootstrap.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config));
  return file;
}

describe("automatic plugin setup", () => {
  it("needs no bootstrap and separates state by daemon home", async () => {
    const setup = await resolveSetup(env);
    expect(setup.dataDir).toBe(path.join(env.PASEO_HOME!, "plugin-data", "github-pr"));
    expect(setup.identity).toBe("paseo:srv_fixture");
    expect(await resolveConnection(setup, env)).toEqual({
      url: "ws://127.0.0.1:6767/ws",
      password: undefined,
    });
    await expect(
      readFile(path.join(env.XDG_CONFIG_HOME!, "paseo-github-pr/bootstrap.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const second = path.join(root, "second");
    await mkdir(second);
    await writeFile(path.join(second, "server-id"), "srv_second");
    const other = await resolveSetup({ ...env, PASEO_HOME: second });
    expect(other.dataDir).not.toBe(setup.dataDir);
    expect(other.identity).not.toBe(setup.identity);
  });

  it("uses actual bound ports and re-reads them after restart", async () => {
    env.PASEO_LISTEN = "127.0.0.1:0";
    const setup = await resolveSetup(env);
    const pid = path.join(env.PASEO_HOME!, "paseo.pid");
    await writeFile(pid, JSON.stringify({ listen: "0.0.0.0:18765" }));
    expect((await resolveConnection(setup, env)).url).toBe("ws://127.0.0.1:18765/ws");
    await writeFile(pid, JSON.stringify({ listen: "[::]:18766" }));
    expect((await resolveConnection(setup, env)).url).toBe("ws://[::1]:18766/ws");
    expect((await resolveSetup(env)).identity).toBe(setup.identity);
  });

  it("uses daemon config then environment overrides when no PID descriptor exists", async () => {
    const setup = await resolveSetup(env);
    await writeFile(
      path.join(env.PASEO_HOME!, "config.json"),
      JSON.stringify({ daemon: { listen: "localhost:18767" } }),
    );
    expect((await resolveConnection(setup, env)).url).toBe("ws://localhost:18767/ws");
    expect(
      await resolveConnection(setup, {
        ...env,
        PASEO_LISTEN: "127.0.0.1:18768",
        PASEO_PASSWORD: " fixture-password ",
      }),
    ).toEqual({ url: "ws://127.0.0.1:18768/ws", password: "fixture-password" });
  });

  it.each([
    "remote.example:6767",
    "127.0.0.1:0",
    "user:password@localhost:6767",
    "localhost:6767?secret=value",
  ])("rejects unsafe or unbound listener %s", async (listen) => {
    const setup = await resolveSetup(env);
    await expect(resolveConnection(setup, { ...env, PASEO_LISTEN: listen })).rejects.toThrow(
      "loopback",
    );
  });

  it("preserves existing data directories and explicit password sources", async () => {
    const legacy = {
      daemonUrl: "ws://127.0.0.1:18769/ws",
      dataDir: path.join(root, "existing"),
      passwordEnv: "FIXTURE_PASSWORD",
    };
    const file = await bootstrap(legacy);
    const setup = await resolveSetup(env);
    expect(setup.dataDir).toBe(legacy.dataDir);
    expect(setup.identity).toBe(legacy.daemonUrl);
    expect(
      await resolveConnection(setup, { ...env, FIXTURE_PASSWORD: "fixture-password" }),
    ).toEqual({ url: legacy.daemonUrl, password: "fixture-password" });
    expect((await resolveSetup({ ...env, PASEO_GITHUB_CONFIG: file })).dataDir).toBe(
      legacy.dataDir,
    );
  });

  it("does not silently discard missing explicit or malformed existing config", async () => {
    await expect(
      resolveSetup({ ...env, PASEO_GITHUB_CONFIG: path.join(root, "missing.json") }),
    ).rejects.toThrow("missing file");
    await bootstrap({ dataDir: path.join(root, "existing") });
    await expect(resolveSetup(env)).rejects.toThrow();
  });

  it("releases the writer lock and blocks work after stored daemon identity mismatch", async () => {
    vi.stubEnv("PASEO_HOME", env.PASEO_HOME);
    vi.stubEnv("XDG_CONFIG_HOME", env.XDG_CONFIG_HOME);
    vi.stubEnv("PASEO_GITHUB_CONFIG", undefined);
    vi.stubEnv("PASEO_SERVER_ID", undefined);
    const setup = await resolveSetup(env);
    await mkdir(setup.dataDir, { recursive: true });
    await writeFile(
      path.join(setup.dataDir, "endpoint.json"),
      JSON.stringify({ url: "paseo:srv_other" }),
    );
    const runtime = new Runtime();
    const store = new Store(setup.dataDir);
    try {
      await runtime.start();
      expect(runtime.error).toContain("different daemon");
      await runtime.tick(true);
      expect(runtime.api).toBeUndefined();
      await expect(runtime.execute({ action: "refresh" })).rejects.toThrow();
      await store.open();
    } finally {
      await runtime.close();
      await store.close();
    }
  });

  it("checks authenticated daemon identity before allowing background operations", async () => {
    const setup = await resolveSetup(env);
    let id = "srv_fixture";
    server = createServer((req, res) => {
      expect(req.url).toBe("/api/status");
      if (req.headers.authorization !== "Bearer fixture-password") {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ serverId: id }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const connection = { url: `ws://127.0.0.1:${address.port}/ws`, password: "fixture-password" };
    const signal = new AbortController().signal;
    await verifyHost(setup, connection, signal);
    await expect(verifyHost(setup, { ...connection, password: undefined }, signal)).rejects.toThrow(
      "authentication failed",
    );
    id = "srv_other";
    await expect(verifyHost(setup, connection, signal)).rejects.toThrow("different Paseo daemon");
  });
});
