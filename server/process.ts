import { execFile } from "node:child_process";
let processSignal: AbortSignal | undefined;
let processPaths: { temporary: string; cache: string } | undefined;
export function configureProcesses(signal: AbortSignal, temporary: string, cache: string) {
  processSignal = signal;
  processPaths = { temporary, cache };
}
export type Runner = (
  file: string,
  args: string[],
  cwd?: string,
  input?: string,
) => Promise<string>;
export const run: Runner = (file, args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        signal: processSignal,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
        env: {
          ...process.env,
          ...(processPaths
            ? {
                TMPDIR: processPaths.temporary,
                XDG_CACHE_HOME: processPaths.cache,
                npm_config_cache: processPaths.cache + "/npm",
              }
            : {}),
          GIT_TERMINAL_PROMPT: "0",
          GH_PROMPT_DISABLED: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${file} failed: ${stderr || error.message}`));
        else resolve(stdout.trimEnd());
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
