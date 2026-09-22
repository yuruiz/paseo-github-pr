import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { dataPath } from "./store";

const Bootstrap = z.object({
  daemonUrl: z.string().url(),
  dataDir: z.string(),
  passwordEnv: z.string().optional(),
});
export type Setup = {
  dataDir: string;
  identity: string;
  home?: string;
  legacy?: z.infer<typeof Bootstrap>;
};

async function optionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function localUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid local daemon endpoint");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === "0"
  )
    throw new Error(
      "Daemon endpoint must be a bound loopback WebSocket address without credentials",
    );
  return url.href;
}

export async function resolveSetup(env: NodeJS.ProcessEnv = process.env): Promise<Setup> {
  // Preserve existing installations; only an absent implicit file selects automatic setup.
  const file =
    env.PASEO_GITHUB_CONFIG ??
    path.join(
      env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
      "paseo-github-pr",
      "bootstrap.json",
    );
  const raw = await optionalJson(await dataPath(file));
  if (raw !== undefined) {
    const legacy = Bootstrap.parse(raw);
    localUrl(legacy.daemonUrl);
    return { dataDir: await dataPath(legacy.dataDir), identity: legacy.daemonUrl, legacy };
  }
  if (env.PASEO_GITHUB_CONFIG) throw new Error("PASEO_GITHUB_CONFIG points to a missing file");
  const rawHome = env.PASEO_HOME ?? "~/.paseo";
  const home = path.resolve(
    rawHome === "~"
      ? homedir()
      : rawHome.startsWith("~/")
        ? path.join(homedir(), rawHome.slice(2))
        : rawHome,
  );
  const serverId =
    env.PASEO_SERVER_ID?.trim() || (await readFile(path.join(home, "server-id"), "utf8")).trim();
  if (!serverId) throw new Error("Paseo daemon identity is missing");
  return {
    home,
    identity: `paseo:${serverId}`,
    dataDir: path.join(home, "plugin-data", "github-pr"),
  };
}

export async function resolveConnection(setup: Setup, env: NodeJS.ProcessEnv = process.env) {
  if (setup.legacy)
    return {
      url: localUrl(setup.legacy.daemonUrl),
      password: setup.legacy.passwordEnv ? env[setup.legacy.passwordEnv] : undefined,
    };
  // The supervisor records the bound address here, including ephemeral ports and CLI overrides.
  const pid = z
    .object({ listen: z.string().nullish() })
    .parse((await optionalJson(path.join(setup.home!, "paseo.pid"))) ?? {});
  const config = z
    .object({ daemon: z.object({ listen: z.string().optional() }).optional() })
    .parse((await optionalJson(path.join(setup.home!, "config.json"))) ?? {});
  const listen =
    pid.listen ?? env.PASEO_LISTEN ?? config.daemon?.listen ?? `127.0.0.1:${env.PORT ?? "6767"}`;
  const address = listen.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:");
  return { url: localUrl(`ws://${address}/ws`), password: env.PASEO_PASSWORD?.trim() || undefined };
}

export async function verifyHost(
  setup: Setup,
  connection: { url: string; password?: string },
  signal: AbortSignal,
) {
  if (setup.legacy) return;
  const url = new URL(connection.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/status";
  const response = await fetch(url, {
    headers: connection.password ? { Authorization: `Bearer ${connection.password}` } : {},
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (response.status === 401)
    throw new Error(
      "Daemon authentication failed; use the daemon's PASEO_PASSWORD environment variable for background monitoring",
    );
  if (!response.ok) throw new Error(`Daemon identity check failed (${response.status})`);
  const status = z.object({ serverId: z.string() }).parse(await response.json());
  if (`paseo:${status.serverId}` !== setup.identity)
    throw new Error("Discovered endpoint belongs to a different Paseo daemon");
}
