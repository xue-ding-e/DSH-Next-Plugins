import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createPrivacyFilter } from "../lib/privacy-filter.js";

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function fakeSpawn() {
  const calls = [];
  const requests = [];
  const spawn = (path, args) => {
    calls.push({ path, args });
    const child = new EventEmitter();
    const stdout = new PassThrough();
    let input = Buffer.alloc(0);
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        input = Buffer.concat([input, chunk]);
        drain();
        callback();
      },
    });
    child.stdout = stdout;
    child.stdin = stdin;
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = "SIGTERM";
      queueMicrotask(() => {
        stdout.end();
        child.emit("close");
      });
      return true;
    };
    stdout.write('{"device":"CPU","gpu":false,"ms":1}\n');

    function drain() {
      if (input.length < 4) return;
      const count = input.readUInt32LE(0);
      let offset = 4;
      const texts = [];
      for (let index = 0; index < count; index += 1) {
        if (input.length < offset + 4) return;
        const length = input.readUInt32LE(offset);
        offset += 4;
        if (input.length < offset + length) return;
        texts.push(input.subarray(offset, offset + length).toString("utf8"));
        offset += length;
      }
      requests.push(texts);
      input = input.subarray(offset);
      const output = [u32(0)];
      for (const text of texts) {
        const bytes = Buffer.from(text, "utf8");
        const value = Buffer.from("Alice", "utf8");
        const start = bytes.indexOf(value);
        if (start < 0) {
          output.push(u32(0));
          continue;
        }
        output.push(u32(1), u32(start), u32(start + value.length), u32(0));
        output.push(Buffer.from(["private_person".length]), Buffer.from("private_person", "utf8"));
      }
      stdout.write(Buffer.concat(output));
      drain();
    }
    return child;
  };
  return { calls, requests, spawn };
}

function assets(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-qoder-privacy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const modelPath = join(directory, "privacy-filter-q8-80efc1803eda.gguf");
  const executablePath = join(directory, "pf-serve.exe");
  writeFileSync(modelPath, "fixture");
  writeFileSync(executablePath, "fixture");
  return { directory, modelPath, executablePath };
}

test("classifies request text through Magpie's pf-serve protocol and restores placeholders", async (t) => {
  const fixture = assets(t);
  const fake = fakeSpawn();
  const privacy = createPrivacyFilter({
    enabled: true,
    cacheDir: fixture.directory,
    requestTimeoutMs: 1000,
    startupTimeoutMs: 1000,
  }, { spawn: fake.spawn });
  const original = { messages: [{ role: "user", content: "Alice lives in the project" }] };
  const prepared = await privacy.maskBody(original);
  const masked = prepared.body;
  const placeholder = masked.messages[0].content.match(/\{\{MAGPIE_[^}]+\}\}/u)?.[0];
  assert.equal(typeof placeholder, "string");
  assert.ok(!masked.messages[0].content.includes("Alice"));
  assert.equal(original.messages[0].content, "Alice lives in the project");
  assert.equal(prepared.restoreArgument(`reply: ${placeholder}`), "reply: Alice");

  const again = await privacy.maskBody({ messages: [{ role: "user", content: "Alice again" }] });
  assert.ok(again.body.messages[0].content.includes(placeholder));
  assert.equal(fake.calls.length, 1, "repeated text reuses the live pf-serve process");

  assert.equal(again.restoreArgument(placeholder), "Alice");
  assert.equal(again.restoreArgument(placeholder.slice(2, -2)), "Alice");
  const unrelated = await privacy.maskBody({ messages: [{ role: "user", content: "Separate request" }] });
  assert.equal(unrelated.restoreArgument(placeholder), placeholder);
  for (let split = 1; split < placeholder.length; split += 1) {
    const restorer = prepared.createResponseRestorer();
    assert.equal(restorer.restore("content", placeholder.slice(0, split)), "");
    assert.equal(restorer.restore("content", `${placeholder.slice(split)} is here`), "Alice is here");
  }
  await privacy.close();
});

test("enabled privacy filtering fails before sending when Magpie assets are absent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-qoder-privacy-empty-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privacy = createPrivacyFilter({ enabled: true, cacheDir: directory }, {
    spawn: fakeSpawn().spawn,
    existsSync: () => false,
  });
  await assert.rejects(
    () => privacy.maskBody({ messages: [{ role: "user", content: "Alice" }] }),
    (error) => error.code === "PRIVACY_FILTER_NOT_INSTALLED",
  );
  await privacy.close();
});

test("can preserve URLs while restoring legacy markers for URLs in the request", async (t) => {
  const fixture = assets(t);
  const fake = fakeSpawn();
  const privacy = createPrivacyFilter({
    enabled: true,
    preserveUrls: true,
    cacheDir: fixture.directory,
    requestTimeoutMs: 1000,
    startupTimeoutMs: 1000,
  }, { spawn: fake.spawn });
  const url = "https://example.test/search?q=Alice";
  const original = {
    messages: [
      { role: "user", content: `Alice lives at ${url}` },
      { role: "assistant", tool_calls: [{ type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }] },
    ],
  };
  const prepared = await privacy.maskBody(original);
  const masked = prepared.body;
  const argumentsText = masked.messages[1].tool_calls[0].function.arguments;
  assert.equal(masked.messages[0].content.includes(url), true);
  assert.equal(argumentsText, JSON.stringify({ url }));
  assert.equal(masked.messages[0].content.startsWith("{{MAGPIE_"), true);
  assert.equal(fake.requests.flat().some(text => text.includes(url)), false);

  const hash = createHash("sha256").update(url, "utf8").digest("hex").slice(0, 16).toUpperCase();
  assert.equal(prepared.restoreArgument(`{{MAGPIE_PRIVATE_URL_${hash}}}`), url);
  await privacy.close();
});

test("masks URLs in text, structured fields and escaped tool JSON by default", async t => {
  const fixture = assets(t);
  const privacy = createPrivacyFilter({ enabled: true, cacheDir: fixture.directory }, { spawn: fakeSpawn().spawn });
  t.after(() => privacy.close());
  const url = "https://example.test/search?q=synthetic&x=1";
  const prepared = await privacy.maskBody({
    messages: [
      { role: "user", content: [{ type: "text", text: `打开 [链接](${url})` }, { type: "image_url", image_url: { url: "data:image/png;base64,TEST" } }] },
      { role: "assistant", tool_calls: [{ function: { name: "web_fetch", arguments: JSON.stringify({ url }).replaceAll("/", "\\/") } }] },
    ],
    target: { url },
  });
  const [user, assistant] = prepared.body.messages;
  const marker = prepared.body.target.url;
  assert.match(marker, /^https:\/\/magpie-url-[0-9a-f]{16}\.invalid\/$/u);
  assert.equal(user.content[0].text, `打开 [链接](${marker})`);
  assert.equal(user.content[1].image_url.url, "data:image/png;base64,TEST");
  assert.equal(JSON.parse(assistant.tool_calls[0].function.arguments).url, marker);
  assert.equal(prepared.restoreArgument(marker.toLowerCase()), url);
  assert.equal(prepared.restoreArgument(marker.slice("https://".length, -1)), url);
  const changedHost = marker.replace("://", "://other.");
  assert.equal(prepared.restoreArgument(changedHost), changedHost);
  for (let split = 1; split < marker.length; split += 1) {
    const restorer = prepared.createResponseRestorer();
    const text = restorer.restore("content", marker.slice(0, split))
      + restorer.restore("content", marker.slice(split) + " done");
    assert.equal(text, `${url} done`, `split at ${split}`);
  }
});
