import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import * as NativeToolExecutor from "@deepseek-ai/dsh-tool-executor-native";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { createQoderAdapter } from "../lib/index.js";
import { createPrivacyFilter } from "../lib/privacy-filter.js";
import { installToolErrorRecovery } from "../lib/tool-error-recovery.js";
import { createQoderClient, createQoderShim, qoderDecodeBody } from "../lib/protocol.js";
import { fakeSpawn } from "./privacy-fixture.mjs";

const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({
  statusCodeValue: 200,
  body: JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }),
})}\n\n`;
const tool = (index, id, argumentsText, name = "web_fetch") => ({ index, id, type: "function", function: { name, arguments: argumentsText } });

test("AgentLoop continues after unknown markers and malformed JSON, then runs corrected calls", { timeout: 30000 }, async t => {
  const ctx = new Context();
  let shim;
  let privacy;
  t.after(async () => {
    await ctx.fiber.dispose();
    await shim?.close();
    await privacy?.close();
  });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, { personaPrefix: "" });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(NativeToolExecutor);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const recoverToolArguments = installToolErrorRecovery(ctx);
  ctx.on("tools/pre-execute", () => ({ kind: "allow" }));
  const executed = [];
  ctx.tools.register(defineTool({
    name: "web_fetch",
    description: "Read a page.",
    parameters: { url: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_args, title) => [{ type: "text", text: title }] },
    async execute(args) { executed.push(args.url); return "Example Domain"; },
  }));
  let shellExecutions = 0;
  ctx.tools.register(defineTool({
    name: "pwsh",
    description: "Synthetic command tool.",
    parameters: { command: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_args, text) => [{ type: "text", text }] },
    async execute() { shellExecutions += 1; return "shell ran"; },
  }));
  const url = "https://example.test/original?private=synthetic";
  privacy = createPrivacyFilter({
    enabled: true, modelPath: "/fixture.gguf", executablePath: "/pf-serve",
  }, { existsSync: () => true, spawn: fakeSpawn().spawn });
  const realFetch = globalThis.fetch;
  const modelRequests = [];
  t.mock.method(globalThis, "fetch", async (endpoint, init) => {
    if (!String(endpoint).startsWith("https://qoder.test/")) return realFetch(endpoint, init);
    const body = JSON.parse(qoderDecodeBody(Buffer.from(init.body)).toString("utf8"));
    modelRequests.push(body);
    const number = modelRequests.length;
    const known = JSON.stringify(body.messages).match(/https:\/\/magpie-url-[0-9a-f]{16}\.invalid\//u)?.[0];
    assert.ok(known);
    assert.equal(JSON.stringify(body).includes(url), false);
    let calls;
    if (number === 1) {
      calls = [
        tool(0, "bad-marker", '{"url":"https://magpie-url-883fc37ba663659d.invalid/"}'),
        tool(1, "valid-sibling", JSON.stringify({ url: known })),
        tool(2, "bad-person", '{"command":"git show MAGPIE_PRIVATE_PERSON_8F0F4E7B8B5B3F1B/repo"}', "pwsh"),
        tool(3, "bad-array", '["not-an-argument-object"]'),
      ];
    } else if (number === 2) {
      const priorError = body.messages.find(message => message.role === "tool" && message.tool_call_id === "bad-marker");
      assert.match(priorError.content, /工具未执行/);
      calls = [tool(0, "bad-json", '{"url":')];
    } else if (number === 3) {
      const priorError = body.messages.find(message => message.role === "tool" && message.tool_call_id === "bad-json");
      assert.match(priorError.content, /JSON/);
      calls = [tool(0, "corrected", JSON.stringify({ url: known }))];
    } else {
      assert.equal(number, 4);
      return new Response(frame({ content: "Recovered and finished." }) + frame({}, "stop") + "data: [DONE]\n\n");
    }
    return new Response(frame({ tool_calls: calls }) + frame({}, "tool_calls") + "data: [DONE]\n\n");
  });
  const config = () => ({ gateway: "https://qoder.test" });
  const client = createQoderClient({
    config, privacy, recoverToolArguments,
    tokens: { get: async () => ({ userID: "test-user", authToken: "test-token", machineID: "test-machine" }) },
  });
  const catalog = {
    current: () => [{ id: "dfmodel", name: "Fixture", contextWindow: 180000, maxTokens: 1024 }],
    find: id => catalog.current().find(model => model.id === id),
  };
  shim = createQoderShim({ client, catalog });
  await shim.ready;
  const { adapter } = createQoderAdapter({ shim, catalog, config: {}, ctx });
  ctx.llm.registerAdapter(["qoder1"], adapter);
  const handle = await ctx.agents.create({
    sessionId: "qoder-tool-recovery",
    agentOptions: { provider: "qoder1", model: "dfmodel" },
    meta: { cwd: tmpdir() },
  });
  handle.agent.steer(createUserMessage({ content: [{ type: "text", text: url }], source: { kind: "user" } }));
  await handle.agent.whenIdle();
  const events = handle.agent.session.snapshotEvents();
  const results = events.filter(event => event.type === "tool/result").map(event => ({
    id: event.data.message.toolCallId,
    isError: event.data.message.isError === true,
    code: event.data.error?.code,
  }));
  assert.equal(modelRequests.length, 4);
  assert.deepEqual(executed, [url, url]);
  assert.equal(shellExecutions, 0);
  assert.deepEqual(results, [
    { id: "bad-marker", isError: true, code: "PRIVACY_FILTER_UNKNOWN_PLACEHOLDER" },
    { id: "valid-sibling", isError: false, code: undefined },
    { id: "bad-person", isError: true, code: "PRIVACY_FILTER_UNKNOWN_PLACEHOLDER" },
    { id: "bad-array", isError: true, code: "PRIVACY_FILTER_TOOL_JSON" },
    { id: "bad-json", isError: true, code: "PRIVACY_FILTER_TOOL_JSON" },
    { id: "corrected", isError: false, code: undefined },
  ]);
  assert.equal(events.filter(event => event.type === "turn/start").length, 1);
  assert.deepEqual(events.filter(event => event.type === "turn/end").map(event => event.data.reason), [{ kind: "completed" }]);
  assert.equal(events.some(event => event.type === "assistant/attempt"), false);
  assert.equal(handle.agent.status, "idle");
});
