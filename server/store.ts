import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { State, emptyState, type PluginState } from "../shared/model";

export async function dataPath(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("Specify an absolute path");
  const absolute = path.resolve(value);
  if (absolute === path.parse(absolute).root)
    throw new Error("Choose a dedicated directory, not the filesystem root");
  return absolute;
}
export class Store {
  state: PluginState = emptyState();
  private lock?: ChildProcess;
  private locked = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async open() {
    await dataPath(this.directory);
    await mkdir(this.directory, { recursive: true });
    this.lock = spawn(
      "flock",
      [
        "-n",
        path.join(this.directory, "state.lock"),
        process.execPath,
        "-e",
        "process.stdout.write('locked\\n'); process.stdin.resume();",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      this.lock!.once("error", reject);
      this.lock!.once("exit", () => reject(new Error("Plugin data directory already locked")));
      this.lock!.stdout!.once("data", () => resolve());
    });
    this.lock.once("exit", () => {
      this.locked = false;
    });
    this.locked = true;
    try {
      this.state = State.parse(
        JSON.parse(await readFile(path.join(this.directory, "state.json"), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.close();
        throw e;
      }
    }
  }
  async update(fn: (state: PluginState) => void): Promise<void> {
    const job = this.tail.then(async () => {
      if (!this.locked) throw new Error("State writer lock is not held");
      const next = structuredClone(this.state);
      fn(next);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return;
      next.revision++;
      State.parse(next);
      const temporary = path.join(this.directory, "state.json.next");
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path.join(this.directory, "state.json"));
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.state = next;
    });
    this.tail = job.catch(() => {});
    await job;
  }
  async close() {
    await this.tail;
    const lock = this.lock;
    if (!lock || lock.exitCode !== null) return;
    this.lock = undefined;
    const done = new Promise<void>((resolve) => lock.once("exit", () => resolve()));
    lock.stdin?.end();
    await done;
  }
}
