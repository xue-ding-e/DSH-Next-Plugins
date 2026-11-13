import assert from "node:assert/strict";
import { test } from "node:test";
import { createQoderClient, createSseReader, qoderDecodeBody } from "../lib/protocol.js";

const usage = { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 };
const args = { command: "Set-Location 'D:\\_code\\项目'\nWrite-Output '完成'", description: "probe" };
const argsJson = JSON.stringify(args);

function frame(delta, finishReason = null) {
  const chunk = { choices: [{ index: 0, delta, finish_reason: finishReason }] };
  if (finishReason !== null) chunk.usage = usage;
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
}

const start = frame({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "pwsh", arguments: "" } }] });
const argument = (text, index = 0) => frame({ tool_calls: [{ index, function: { arguments: text } }] });
const finish = frame({}, "tool_calls") + "data: [DONE]\n\n";

async function translated(t, chunks) {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  })));
  const client = createQoderClient({
    config: () => ({ gateway: "https://qoder.test" }),
    tokens: { get: async () => ({ userID: "test-user", authToken: "test-token", machineID: "test-machine" }) },
  });
  const result = await client.chatStream({ model: "dfmodel", messages: [{ role: "user", content: "probe" }] });
  assert.equal(result.ok, true);
  const bytes = Buffer.from(await new Response(result.response).arrayBuffer());
  return createSseReader().push(bytes).map(event => event.raw === "[DONE]" ? "[DONE]" : JSON.parse(event.raw));
}

function assertCall(events, expected = argsJson, index = 0) {
  const received = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? [])
    .filter(call => call.index === index)
    .map(call => call.function?.arguments ?? "").join("");
  assert.equal(received, expected);
  assert.deepEqual(JSON.parse(received), JSON.parse(expected));
  const terminal = events.find(event => event.choices?.[0]?.finish_reason != null);
  assert.equal(terminal.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(terminal.usage, usage);
  assert.equal(events.filter(event => event === "[DONE]").length, 1);
}

test("keeps argument prefixes batched with the first tool-call event", async t => {
  const events = await translated(t, [start + argument(argsJson.slice(0, 9)), argument(argsJson.slice(9)) + finish]);
  assertCall(events);
});

test("keeps a complete tool call, finish reason and usage in one transport chunk", async t => {
  assertCall(await translated(t, [start + argument(argsJson) + finish]));
});

test("keeps an incomplete SSE event when handing the stream to the translator", async t => {
  const nextFrame = argument(argsJson);
  for (const split of [1, 5, 18, nextFrame.indexOf("body") + 9, nextFrame.length - 1]) {
    await t.test(`split at byte ${split}`, async inner => {
      assertCall(await translated(inner, [start + nextFrame.slice(0, split), nextFrame.slice(split) + finish]));
    });
  }
});

test("keeps TextDecoder state across a split UTF-8 character at handoff", async t => {
  const bytes = Buffer.from(start + argument(argsJson) + finish);
  const split = bytes.indexOf(Buffer.from("完成")) + 1;
  assert.ok(split > 1);
  assertCall(await translated(t, [bytes.subarray(0, split), bytes.subarray(split)]));
});

test("keeps batched reasoning, text and parallel tool calls in order", async t => {
  const secondArgs = JSON.stringify({ status: "complete", revision: 4 });
  const secondStart = frame({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "update_goal", arguments: "" } }] });
  const events = await translated(t, [
    frame({ role: "assistant" }) + frame({ reasoning_content: "thinking" })
      + frame({ content: "working" }) + start + argument(argsJson.slice(0, 9)) + secondStart,
    argument(secondArgs, 1) + argument(argsJson.slice(9)) + finish,
  ]);
  assertCall(events);
  assertCall(events, secondArgs, 1);
  assert.deepEqual(events.flatMap(event => event.choices?.[0]?.delta?.reasoning_content ?? []), ["thinking"]);
  assert.deepEqual(events.flatMap(event => event.choices?.[0]?.delta?.content ?? []), ["working"]);
  assert.deepEqual(events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []).filter(call => call.id).map(call => call.id), ["call_1", "call_2"]);
});

test("masks the Qoder wire body and restores a placeholder split across response deltas", async t => {
  const placeholder = "{{MAGPIE_PRIVATE_PERSON_0123456789ABCDEF}}";
  let seenBody;
  const privacy = {
    async maskBody(body) {
      seenBody = body;
      return {
        body: {
          ...body,
          messages: body.messages.map(message => ({ ...message, content: "masked prompt" })),
        },
        createResponseRestorer,
      };
    },
  };
  function createResponseRestorer() {
      let pending = "";
      return {
        restore(_key, text, final = false) {
          pending += text;
          if (!final && !pending.includes("}}")) return "";
          const out = pending.replace(placeholder, "Alice");
          pending = "";
          return out;
        },
        flush() {
          const out = new Map();
          if (pending.length > 0) {
            out.set("content", pending.replace(placeholder, "Alice"));
            pending = "";
          }
          return out;
        },
      };
  }
  const first = frame({ content: placeholder.slice(0, 19) });
  const second = frame({ content: `${placeholder.slice(19)} done` }) + finish;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const encoded = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
    const wire = JSON.parse(qoderDecodeBody(encoded).toString("utf8"));
    assert.equal(wire.messages[0].content, "masked prompt");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(first));
        controller.enqueue(Buffer.from(second));
        controller.close();
      },
    }));
  });
  const client = createQoderClient({
    config: () => ({ gateway: "https://qoder.test" }),
    tokens: { get: async () => ({ userID: "test-user", authToken: "test-token", machineID: "test-machine" }) },
    privacy,
  });
  const result = await client.chatStream({ model: "dfmodel", messages: [{ role: "user", content: "Alice" }] });
  assert.equal(result.ok, true);
  assert.equal(seenBody.messages[0].content, "Alice");
  const bytes = Buffer.from(await new Response(result.response).arrayBuffer());
  const events = createSseReader().push(bytes).filter(event => event.raw !== "[DONE]").map(event => JSON.parse(event.raw));
  assert.equal(events.flatMap(event => event.choices?.[0]?.delta?.content ?? []).join(""), "Alice done");
  await client.close();
});

test("restores tool arguments when Qoder puts the call in choice.message", async t => {
  const placeholder = "{{MAGPIE_PRIVATE_URL_0123456789ABCDEF}}";
  const originalUrl = "https://example.test/source?q=1";
  const privacy = {
    async maskBody(body) {
      return {
        body,
        restoreArgument: text => text.replaceAll(placeholder, originalUrl),
        createResponseRestorer: () => ({ restore: (_key, text) => text, flush: () => new Map() }),
      };
    },
  };
  const messageFrame = (message, finishReason) => `data: ${JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ index: 0, message, finish_reason: finishReason }] }),
  })}\n\n`;
  const response = messageFrame({
    role: "assistant",
    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: placeholder }) } }],
  }, "tool_calls") + "data: [DONE]\n\n";
  t.mock.method(globalThis, "fetch", async () => new Response(response));
  const client = createQoderClient({
    config: () => ({ gateway: "https://qoder.test" }),
    tokens: { get: async () => ({ userID: "test-user", authToken: "test-token", machineID: "test-machine" }) },
    privacy,
  });
  const result = await client.chatStream({ model: "dfmodel", messages: [{ role: "user", content: "probe" }] });
  assert.equal(result.ok, true);
  const events = createSseReader().push(Buffer.from(await new Response(result.response).arrayBuffer()))
    .filter(event => event.raw !== "[DONE]").map(event => JSON.parse(event.raw));
  const argumentsText = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? [])
    .map(call => call.function?.arguments ?? "").join("");
  assert.equal(argumentsText, JSON.stringify({ url: originalUrl }));
  await client.close();
});
