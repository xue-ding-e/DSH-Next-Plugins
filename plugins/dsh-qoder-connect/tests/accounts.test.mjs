import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPatStore, createTokenManager } from "../lib/protocol.js";

function isolatedStore(t) {
  const previousHome = process.env.DSH_HOME;
  const previousEnv = Object.fromEntries(["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"].map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "dsh-qoder-accounts-"));
  process.env.DSH_HOME = home;
  for (const key of Object.keys(previousEnv)) delete process.env[key];
  mkdirSync(join(home, "qoder"), { recursive: true });
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { home, store: createPatStore({ config: () => ({}) }) };
}

test("keeps the legacy pat file and manages multiple saved accounts", async (t) => {
  const { home, store } = isolatedStore(t);
  const legacyPath = join(home, "qoder", "pat");
  writeFileSync(legacyPath, "pt-legacy\n", "utf8");

  assert.equal((await store.resolve()).pat, "pt-legacy");
  const first = await store.addAccount("工作账号", "pt-first");
  const second = await store.addAccount("备用账号", "pt-second");
  assert.equal((await store.resolve()).pat, "pt-second");
  assert.equal(store.state().activeAccountId, second.id);

  await store.selectAccount(first.id);
  assert.equal((await store.resolve()).pat, "pt-first");
  await store.replaceAccount(first.id, "工作账号", "pt-replaced");
  assert.equal((await store.resolve()).pat, "pt-replaced");
  assert.equal(readFileSync(join(home, "qoder", "accounts", `${first.id}.pat`), "utf8").trim(), "pt-replaced");

  const publicState = JSON.stringify(store.state());
  assert.doesNotMatch(publicState, /pt-(?:legacy|first|second|replaced)/);
  await store.removeAccount(second.id);
  assert.equal(store.state().accounts.some((account) => account.id === second.id), false);
  assert.equal(store.state().accounts.find((account) => account.id === first.id)?.active, true);
});

test("keeps environment PAT precedence explicit and does not pretend a file switch won", async (t) => {
  const { store } = isolatedStore(t);
  const account = await store.addAccount("文件账号", "pt-file");
  process.env.QODERCN_API_KEY = "pt-environment";

  assert.equal((await store.resolve()).pat, "pt-environment");
  assert.equal(store.state().environmentOverride, "QODERCN_API_KEY");
  assert.equal(store.state().accounts.find((item) => item.id === "env:QODERCN_API_KEY")?.active, true);
  await assert.rejects(() => store.selectAccount(account.id), /环境变量/);
});

test("can add without switching and can rename existing accounts", async (t) => {
  const { home, store } = isolatedStore(t);
  writeFileSync(join(home, "qoder", "pat"), "pt-legacy\n", "utf8");
  const current = await store.addAccount("当前账号", "pt-current");
  const added = await store.addAccount("只添加账号", "pt-added", false);

  assert.equal((await store.resolve()).pat, "pt-current");
  assert.equal(store.state().activeAccountId, current.id);
  assert.equal(store.state().accounts.find((account) => account.id === added.id)?.active, false);

  await store.renameAccount(added.id, "备用账号");
  assert.equal(store.state().accounts.find((account) => account.id === added.id)?.label, "备用账号");
  await store.renameAccount("legacy", "手动文件账号");
  assert.equal(store.state().accounts.find((account) => account.id === "legacy")?.label, "手动文件账号");
});

test("refreshes jobToken after a GUI account switch without restarting the plugin", async (t) => {
  const { home, store } = isolatedStore(t);
  writeFileSync(join(home, "qoder", "pat"), "pt-before\n", "utf8");
  const exchangeBodies = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/api/v1/jobToken/exchange")) {
      const pat = JSON.parse(init.body).personal_token;
      exchangeBodies.push(pat);
      return new Response(JSON.stringify({ token: `jt-${pat}`, expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).endsWith("/api/v1/userinfo")) {
      const latest = exchangeBodies.at(-1);
      return new Response(JSON.stringify({ id: `uid-${latest}`, email: "test@example.invalid" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected test URL: ${String(url)}`);
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const tokens = createTokenManager({
    pats: store,
    config: () => ({ openapiBase: "https://openapi.test" }),
    logger: { debug() {}, warn() {} },
  });
  await tokens.get();
  const next = await store.addAccount("切换后账号", "pt-after");
  await tokens.get();

  assert.deepEqual(exchangeBodies, ["pt-before", "pt-after"]);
  assert.equal((await tokens.get()).userID, "uid-pt-after");
  assert.equal(readFileSync(join(home, "qoder", "accounts", `${next.id}.pat`), "utf8").trim(), "pt-after");
});

test("rejects non-Qoder tokens before writing them", async (t) => {
  const { store } = isolatedStore(t);
  await assert.rejects(() => store.addAccount("错误账号", "sk-not-qoder"), /pt- 前缀/);
  assert.deepEqual(store.state().accounts.map((item) => item.id), ["legacy"]);
});
