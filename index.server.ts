import { PRActions } from "./server/pr-actions";
import { Reviews } from "./server/review";
import { Stacks } from "./server/stack";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { snapshot, command } from "./shared/rpc";
import { Automation } from "./server/automation";
import { Publications } from "./server/publication";
import { Runtime } from "./server/runtime";
export default function contribute(server: PluginServerContext) {
  const runtime = new Runtime();
  runtime.extensions.push(
    new Publications(runtime),
    new PRActions(runtime),
    new Reviews(runtime),
    new Stacks(runtime),
    new Automation(runtime),
  );
  const startup = runtime.start();
  server.on("agent.turn_ended", (event) => {
    if (!Object.values(runtime.state.bindings).some((b) => b.agentId === event.agent.id)) return;
    if (!runtime.stopped && runtime.connected)
      void runtime
        .exclusive(async () => {
          for (const e of runtime.extensions) await e.tick();
        })
        .catch((error) => {
          runtime.error = String(error);
        });
  });
  server.on("agent.permission_requested", async (event, context) => {
    if (event.request.kind !== "tool" && event.request.kind !== "mode") return;
    if (!Object.values(runtime.state.bindings).some((b) => b.agentId === event.agent.id)) return;
    await context.paseo.agents.ref(event.agent.id).respondToPermission({
      requestId: event.request.id,
      response: {
        behavior: "deny",
        message: "PR automation cannot escalate or publish. Use the plugin publication preview.",
      },
    });
  });
  server.handle(snapshot, async () => {
    await startup;
    return {
      state: runtime.state,
      workspaces: runtime.workspaces,
      connected: runtime.connected,
      error: runtime.error,
    };
  });
  server.handle(command, async (input) => {
    await startup;
    return { message: await runtime.exclusive(() => runtime.execute(input)) };
  });
  return async () => {
    await startup;
    await runtime.close();
  };
}
