import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { BlockAssembler, createUserMessage, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { Config, createQoderAdapter } from "../lib/index.js";
import { createQoderClient, createQoderShim } from "../lib/protocol.js";

const catalog = {
  current: () => [{ id: "dfmodel", name: "test model", contextWindow: 180000, maxTokens: 1024 }],
  find: id => catalog.current().find(model => model.id === id),
};
const policy = {
  mode: "normal", maxRetries: 2,
  retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "MALFORMED_RESPONSE"],
  backoff: { initialDelayMs: 500, maxDelayMs: 4000, jitterRatio: 0.2 },
};

function adapterOf(config) {
  return createQoderAdapter({
    config, catalog,
    shim: { baseUrl: () => "http://127.0.0.1:1", token: () => "test" },
    ctx: { get: () => undefined },
  });
}

test("retry policy is optional and preserves host defaults when omitted", () => {
  assert.doesNotThrow(() => Config({}));
  assert.deepEqual(adapterOf({}).adapter.providerRetryPolicy("qoder1"), resolveRetryPolicy(undefined, "test"));
});

test("accepts bounded malformed-response retries and captures them on the provider", async t => {
  const config = Config({ retryPolicy: policy, contextWindowOverrides: { dfmodel: 1000000 } });
  const created = adapterOf(config);
  assert.deepEqual(created.adapter.providerRetryPolicy("qoder1"), resolveRetryPolicy(policy, "test"));
  assert.equal(created.effectiveContextWindows().get("dfmodel"), 1000000);
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  t.after(() => ctx.fiber.dispose());
  ctx.llm.registerAdapter(["qoder1"], created.adapter);
  const prepared = await ctx.llm.prepareCall({ provider: "qoder1", model: "dfmodel" });
  assert.deepEqual(prepared.retryPolicy, resolveRetryPolicy(policy, "test"));
});

test("rebuilds retry settings when the configuration reader is invalidated", () => {
  let config = { retryPolicy: policy };
  const created = adapterOf(() => config);
  const previous = created.adapter.providerRetryPolicy("qoder1");
  config = { retryPolicy: { ...policy, maxRetries: 1 } };
  created.invalidate();
  assert.equal(created.adapter.providerRetryPolicy("qoder1").maxRetries, 1);
  assert.equal(previous.maxRetries, 2);
});

test("rejects invalid retry settings before registering the adapter", () => {
  assert.throws(() => adapterOf({ retryPolicy: { ...policy, maxRetries: -1 } }), /maxRetries/);
  assert.throws(() => adapterOf({ retryPolicy: { ...policy, retryableCodes: [] } }), /retryableCodes/);
});

test("batched Qoder arguments survive the real shim, pi-ai and DSH adapter", async t => {
  const args = { command: "Write-Output '完成'\nSet-Location 'D:\\_code\\项目'", description: "probe" };
  const json = JSON.stringify(args);
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }),
  })}\n\n`;
  const first = frame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "pwsh", arguments: "" } }] })
    + frame({ tool_calls: [{ index: 0, function: { arguments: json.slice(0, 9) } }] });
  const second = frame({ tool_calls: [{ index: 0, function: { arguments: json.slice(9) } }] })
    + frame({}, "tool_calls") + "data: [DONE]\n\n";
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (!String(url).startsWith("https://qoder.test/")) return realFetch(url, init);
    return Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(first));
        controller.enqueue(Buffer.from(second));
        controller.close();
      },
    })));
  });
  const client = createQoderClient({
    config: () => ({ gateway: "https://qoder.test" }),
    tokens: { get: async () => ({ userID: "test-user", authToken: "test-token", machineID: "test-machine" }) },
  });
  const shim = createQoderShim({ client, catalog });
  t.after(() => shim.close());
  await shim.ready;
  const { adapter } = createQoderAdapter({ shim, catalog, config: { retryPolicy: policy }, ctx: { get: () => undefined } });
  const assembler = new BlockAssembler();
  for await (const chunk of adapter.stream({
    provider: "qoder1", model: "dfmodel",
    messages: [createUserMessage({ content: [{ type: "text", text: "probe" }], source: { kind: "user" } })],
  })) assembler.push(chunk);
  assert.deepEqual(assembler.blocks(), [{ type: "tool-call", id: "call_1", name: "pwsh", arguments: json }]);
  assert.deepEqual(assembler.finish, { kind: "tool-calls" });
});
