import assert from "node:assert/strict";
import { test } from "node:test";
import { findQoderCliCommand, runQoderCliUpdate, updateQoderCli } from "../lib/qoder-cli.js";

function fakeEnv() {
  return {
    USERPROFILE: "C:\\Users\\test-user",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATH: "C:\\Tools",
  };
}

test("prefers the user Qoder dispatcher and runs only update", async () => {
  const calls = [];
  const env = fakeEnv();
  const result = await runQoderCliUpdate({
    platform: "win32",
    env,
    exists: (path) => path.endsWith("\\entry\\qodercn.cmd"),
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "updated", stderr: "" };
    },
  });

  assert.deepEqual(result, { status: "updated", message: "Qoder CLI 已更新。" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /qodercn\.cmd$/i);
  assert.deepEqual(calls[0].args, ["update"]);
  assert.equal(calls[0].options.shell, env.ComSpec);
});

test("falls back to the fixed official installer when the dispatcher reports no CLI", async () => {
  const calls = [];
  const env = fakeEnv();
  const result = await runQoderCliUpdate({
    platform: "win32",
    env,
    exists: (path) => path.endsWith("\\entry\\qodercn.cmd"),
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        const error = new Error("QoderCN CLI is not installed.");
        error.code = 127;
        error.stderr = "QoderCN CLI is not installed.";
        throw error;
      }
      return { stdout: "installed", stderr: "" };
    },
  });

  assert.deepEqual(result, { status: "installed", message: "Qoder CLI 已安装/更新。" });
  assert.equal(calls.length, 2);
  assert.match(calls[1].command, /powershell\.exe$/i);
  assert.match(calls[1].args.at(-1), /static\.qoder\.com\.cn\/qoder-cli-cn\/install\.ps1/);
});

test("does not hide ordinary update failures behind an install attempt", async () => {
  const calls = [];
  const result = await runQoderCliUpdate({
    platform: "win32",
    env: fakeEnv(),
    exists: (path) => path.endsWith("\\entry\\qodercn.cmd"),
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      const error = new Error("network unavailable");
      error.code = 1;
      error.stderr = "network unavailable";
      throw error;
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.message, /网络|network unavailable/);
  assert.equal(calls.length, 1);
});

test("coalesces concurrent update clicks into one process", async () => {
  let calls = 0;
  const options = {
    platform: "win32",
    env: fakeEnv(),
    exists: () => false,
    execFileImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { stdout: "installed", stderr: "" };
    },
  };
  const first = updateQoderCli(options);
  const second = updateQoderCli(options);
  assert.strictEqual(first, second);
  await first;
  assert.equal(calls, 1);
});

test("finds nothing when neither the bundled entry nor PATH has Qoder", () => {
  assert.equal(findQoderCliCommand({ platform: "win32", env: fakeEnv(), exists: () => false }), undefined);
});
