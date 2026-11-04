/**
 * `buildChatBody` 的请求体形状测试。
 *
 * 只依赖 `lib/protocol.js`（纯协议层，不 import 任何 @deepseek-ai/* host 包），
 * 因此在没有安装 host 依赖的检出里也能直接跑：
 *
 *   node --test tests/body.test.mjs
 *
 * 覆盖的重点是「图片复制份数」——一个网关 413 的真实事故根因：
 * `messages[].content` 是唯一真正生效的图片通道，而顶层 `image_urls` 与
 * `chat_context.imageUrls` 只是旁路；旁路每多一份，`qoderEncodeBody` 就会把
 * 它连同整个 JSON 再 base64 一遍（×4/3），最终顶穿 Qoder 50 MB 的请求体上限。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChatBody, qoderEncodeBody, qoderDecodeBody } from "../lib/protocol.js";

/** 一张图占 n 个 base64 字符的假图片片段。 */
const image = (n) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(n)}` } });

/** 统计任意结构里出现的 data URL 个数。 */
function countImages(node) {
  return (JSON.stringify(node).match(/data:image\//g) ?? []).length;
}

const turn = (label, bytes) => ([
  { role: "user", content: [{ type: "text", text: label }, image(bytes)] },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
]);

function body(messages) {
  return buildChatBody({
    modelKey: "dfmodel",
    messages,
    isReasoning: true,
    maxTokens: 32000,
    tools: [],
  });
}

test("keeps every history image in messages so model memory is untouched", () => {
  const messages = [...turn("t1", 100), ...turn("t2", 100), ...turn("t3", 100)];
  const built = body(messages);
  assert.equal(countImages(built.messages), 3, "all three history images must survive in messages");
});

test("scopes the top-level image_urls bypass to the current turn only", () => {
  const messages = [...turn("t1", 100), ...turn("t2", 100), ...turn("t3", 100)];
  const built = body(messages);
  assert.equal((built.image_urls ?? []).length, 1, "bypass must not replay the whole transcript");
});

test("scopes chat_context.imageUrls the same way", () => {
  const messages = [...turn("t1", 100), ...turn("t2", 100), ...turn("t3", 100)];
  const built = body(messages);
  assert.equal((built.chat_context?.imageUrls ?? []).length, 1);
});

test("send no bypass images at all when the current turn has none", () => {
  const messages = [
    ...turn("t1", 100),
    { role: "user", content: [{ type: "text", text: "no picture this time" }] },
  ];
  const built = body(messages);
  assert.equal(built.image_urls, null);
  assert.equal(built.chat_context?.imageUrls, null);
  assert.equal(countImages(built.messages), 1, "the earlier image is still in history");
});

test("keep the bypass images when every image belongs to the current turn", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "look" }, image(50), image(60)] },
  ];
  const built = body(messages);
  assert.equal((built.image_urls ?? []).length, 2);
});

test("never drop or reorder messages", () => {
  const messages = [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    ...turn("t1", 10),
    ...turn("t2", 20),
  ];
  const built = body(messages);
  assert.equal(built.messages.length, messages.length);
  assert.deepEqual(built.messages.map((m) => m.role), messages.map((m) => m.role));
});

test("the encoded wire body stays far smaller than replaying history three times", () => {
  // 6 prior turns x 200 KB of image, then a text-only current turn.
  const messages = [];
  for (let i = 0; i < 6; i += 1) messages.push(...turn(`t${i}`, 200_000));
  messages.push({ role: "user", content: [{ type: "text", text: "text only" }] });

  const wire = qoderEncodeBody(Buffer.from(JSON.stringify(body(messages)), "utf8")).length;
  const oneCopy = JSON.stringify({ messages }).length; // messages alone, images already 1x

  assert.ok(wire < oneCopy * 1.5, `wire ${wire} should be near one copy ${oneCopy}, not a multiple`);
});

test("body still round-trips through the custom encoder", () => {
  const built = body([...turn("t1", 64)]);
  const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(built), "utf8"));
  const decoded = JSON.parse(qoderDecodeBody(encoded).toString("utf8"));
  assert.deepEqual(decoded.messages, built.messages);
});
