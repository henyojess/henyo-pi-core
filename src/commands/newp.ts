import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("newp", {
    description: "Start a new session with an initial prompt",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /newp <your prompt>", "error");
        return;
      }

      const prompt = args.trim();

      const result = await ctx.newSession({
        withSession: async (newCtx) => {
          await newCtx.sendUserMessage(prompt);
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("New session was cancelled", "warning");
      }
    },
  });
}