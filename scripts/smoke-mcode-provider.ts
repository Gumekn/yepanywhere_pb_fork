// Live smoke for McodeProvider: new session -> prompt -> resume -> tool prompt.
// Run: npx tsx scripts/smoke-mcode-provider.ts [cwd]
import { mkdirSync } from "node:fs";
import { McodeProvider } from "../packages/server/src/sdk/providers/mcode.js";
import { McodeSessionReader } from "../packages/server/src/sessions/mcode-reader.js";
import { normalizeSession } from "../packages/server/src/sessions/normalization.js";

const cwd = process.argv[2] ?? "/tmp/yep-mcode-smoke";
mkdirSync(cwd, { recursive: true });
const provider = new McodeProvider();
console.log("installed", await provider.isInstalled());
console.log("auth", await provider.getAuthStatus());
if (process.env.SMOKE_MODELS === "1") {
  const models = await provider.getAvailableModels();
  console.log("models", JSON.stringify(models).slice(0, 900));
}

const approvals: string[] = [];
async function runTurn(text: string, resumeSessionId?: string) {
  const session = await provider.startSession({
    cwd,
    resumeSessionId,
    permissionMode: "default",
    initialMessage: { text },
    onToolApproval: async (toolName, input) => {
      approvals.push(toolName);
      if (toolName === "AskUserQuestion") {
        const questions = (
          input as { questions: Array<Record<string, unknown>> }
        ).questions;
        console.log("  [question]", JSON.stringify(questions).slice(0, 400));
        await new Promise((resolve) =>
          setTimeout(resolve, Number(process.env.SMOKE_ANSWER_DELAY_MS ?? 0)),
        );
        const answers = Object.fromEntries(
          questions.map((q) => {
            const options = q.options as Array<{ value: string }>;
            return [q.id as string, options[0]?.value ?? "free text answer"];
          }),
        );
        return {
          behavior: "allow",
          updatedInput: { ...input, answers },
        } as never;
      }
      console.log(
        "  [approval]",
        toolName,
        JSON.stringify(input).slice(0, 160),
      );
      return (
        denyApprovals
          ? { behavior: "deny", message: "denied by smoke test" }
          : { behavior: "allow", updatedInput: input }
      ) as never;
    },
  });
  let sessionId = "";
  for await (const message of session.iterator) {
    const m = message as Record<string, unknown>;
    if (m.type === "system" && m.subtype === "init") {
      sessionId = String(m.session_id);
      console.log("  init", sessionId, "model", m.model);
    } else if (m.type === "result") {
      console.log("  result", m.turnStatus);
      break;
    } else if (m.type === "error") {
      console.log("  ERROR", m.error);
      break;
    } else {
      const content = (m.message as { content?: unknown })?.content;
      const summary =
        typeof content === "string"
          ? `text(${content.length}): ${content.slice(0, 80)}`
          : String(JSON.stringify(content ?? m)).slice(0, 160);
      console.log(" ", m.type, summary);
    }
  }
  session.abort();
  return sessionId;
}

const denyApprovals = process.env.SMOKE_DENY === "1";
let sessionId = process.env.SMOKE_RESUME ?? "";
if (!sessionId) {
  console.log("== turn 1 (new)");
  sessionId = await runTurn("Reply with exactly the word: pong");
}
console.log("== turn 2 (resume + tool)");
await runTurn(
  process.env.SMOKE_PROMPT ??
    "Use the bash tool to run `echo yep-mcode-ok`, then reply with its output.",
  sessionId,
);

await new Promise((resolve) => setTimeout(resolve, 1500));
const reader = new McodeSessionReader({ projectPath: cwd });
const loaded = await reader.getSession(sessionId, "p" as never);
console.log("== reader summary", JSON.stringify(loaded?.summary).slice(0, 400));
if (loaded) {
  const normalized = normalizeSession(loaded);
  for (const msg of normalized.messages) {
    console.log(
      "  ",
      msg.type,
      JSON.stringify(msg.message?.content ?? msg.content ?? null).slice(0, 140),
    );
  }
}
console.log("approvals", approvals);
process.exit(0);
