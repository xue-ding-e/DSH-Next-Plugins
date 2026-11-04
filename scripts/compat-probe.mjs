/** Read-only compatibility probes. No Harness application, real account, browser, or OS input. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as crypto from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const repo = path.resolve(option('--host-repo') ?? path.join(root, '..', 'DSH-Next'));
const probeTemp = path.join(root, '.staging', 'compat-probe');
fs.mkdirSync(probeTemp, { recursive: true });
const req = createRequire(path.join(repo, 'package.json'));
const ts = req('typescript');
const semver = req('semver');
const refs = { official: 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159', next: '1813d72421df0a0675df18f219d3a28cae640da7' };
const show = (ref, file) => execFileSync('git', ['show', ref + ':' + file], { cwd: repo, encoding: 'utf8', windowsHide: true });
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const ids = fs.readdirSync(path.join(root, 'plugins')).filter(id => fs.existsSync(path.join(root, 'plugins', id, 'package.json')));
const manifests = ids.map(id => JSON.parse(read('plugins/' + id + '/package.json')));
const fakeHome = path.join(probeTemp, 'empty-home');
const results = { refs, node: process.version, level: 'static-and-mocked-functions-only', harnessProfileStarted: false, checks: {} };
const attempts = [];
const missing = () => Object.assign(new Error('probe empty store'), { code: 'ENOENT' });
const blocked = operation => { attempts.push(operation); throw new Error('probe denied: ' + operation); };
const missingRead = filename => { attempts.push('mock-read'); throw missing(); };
const fakeFs = { existsSync: () => false, readFileSync: missingRead, statSync: missingRead, mkdirSync: () => blocked('filesystem-write'), writeFileSync: () => blocked('filesystem-write'), chmodSync: () => blocked('filesystem-write'), createReadStream: () => blocked('file-stream') };
const fakeFsPromises = { readFile: async filename => missingRead(filename), mkdir: async () => blocked('filesystem-write'), writeFile: async () => blocked('filesystem-write'), rename: async () => blocked('filesystem-write'), rm: async () => blocked('filesystem-write'), chmod: async () => blocked('filesystem-write') };
const timer = () => ({ unref() {}, ref() {} });
const timers = { setTimeout: timer, clearTimeout() {}, setInterval: timer, clearInterval() {} };
const inertSchema = new Proxy(function () {}, { get: () => inertSchema, apply: () => inertSchema });
class Adapter { providerInfo(provider) { return { id: provider, name: provider }; } }
class HostError extends Error { constructor(message, code) { super(message); this.code = code; } }
const identity = value => value;
const llm = { LlmAdapter: Adapter, LlmError: HostError, ReasoningEffortId: identity, ToolCallId: identity, CallId: identity,
  CONTEXT_WINDOW_EXCEEDED_CODE: 'CONTEXT_WINDOW_EXCEEDED', EMPTY_RESPONSE_CODE: 'EMPTY_RESPONSE', QUOTA_EXCEEDED_CODE: 'QUOTA_EXCEEDED',
  attributionHeaders: () => ({}), errorChain: error => error.message, isContextWindowExceededError: () => false, isQuotaExceededError: () => false,
  resolveRetryPolicy: () => ({ maxRetries: 4, maxWaitMs: 30000 }), RetryPolicySchema: inertSchema };
const importTable = {
  'node:fs': { ...fakeFs, default: fakeFs }, 'node:fs/promises': fakeFsPromises,
  'node:path': { ...path, default: path }, 'node:url': { fileURLToPath, pathToFileURL }, 'node:crypto': crypto,
  'node:os': { homedir: () => fakeHome },
  'node:net': { getDefaultAutoSelectFamilyAttemptTimeout: () => 250, setDefaultAutoSelectFamilyAttemptTimeout() {} },
  'node:http': { createServer: () => blocked('network-listen') },
  'node:child_process': { execFile: () => blocked('process-spawn'), execFileSync: () => blocked('process-spawn') },
  undici: { fetch: async () => blocked('network-fetch'), ProxyAgent: class { async close() {} async destroy() {} } },
  '@deepseek-ai/schemastery': { default: inertSchema }, '@deepseek-ai/dsh-llm': llm,
  '@deepseek-ai/dsh-home-paths': { dshHomePath: (...parts) => path.join(fakeHome, ...parts), resolveDshHome: () => fakeHome },
  '@deepseek-ai/dsh-attachment': { AttachmentId: identity }, '@deepseek-ai/dsh-web': { WebError: HostError },
  '@deepseek-ai/dsh-tools': { defineTool: identity }, semver: { default: semver }
};
async function loadModule(file, source = fs.readFileSync(file, 'utf8'), overrideImports = {}) {
  const context = vm.createContext({ console: { log() {}, info() {}, warn() {}, error() {} }, ...timers,
    AbortController, AbortSignal, URL, Headers, Request, Response, TextEncoder, TextDecoder, Buffer, atob, btoa, structuredClone, DOMException, queueMicrotask,
    fetch: async () => blocked('network-fetch'), process: { env: {}, platform: 'win32', argv: ['node', path.join(fakeHome, 'dsh.mjs')], versions: { node: process.versions.node } } });
  const cache = new Map();
  const imports = { ...importTable, ...overrideImports };
  async function make(filename, code) {
    const module = new vm.SourceTextModule(code, { context, identifier: filename, initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; } });
    cache.set(filename, module);
    await module.link(async (specifier, importer) => {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(importer.identifier), specifier);
        if (!target.startsWith(path.join(root, 'plugins') + path.sep)) throw new Error('probe relative import outside plugin');
        return cache.get(target) ?? make(target, fs.readFileSync(target, 'utf8'));
      }
      if (!Object.hasOwn(imports, specifier)) throw new Error('probe missing synthetic import: ' + specifier);
      const key = 'synthetic:' + specifier;
      if (cache.has(key)) return cache.get(key);
      const values = imports[specifier];
      const synthetic = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context, identifier: key });
      cache.set(key, synthetic);
      return synthetic;
    });
    return module;
  }
  const entry = await make(file, source);
  await entry.evaluate();
  return entry.namespace;
}
function functionSource(file, name) {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(sf).replace(/^export /, ''); ts.forEachChild(node, visit); }
  visit(sf);
  if (!found) throw new Error('probe function not found: ' + name);
  return found;
}

// Execute the official pure preflight evaluator; never import a Harness application.
const evaluatorSource = ts.transpileModule(show(refs.official, 'packages/boot/app-boot/src/plugin-compatibility.ts'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const evaluator = await loadModule(path.join(fakeHome, 'evaluator.mjs'), evaluatorSource);
results.checks.officialPreflight = manifests.map(manifest => ({ plugin: manifest.name, issue: evaluator.evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1') ?? null, ignoredNestedDshEngines: manifest.dsh?.engines ?? null }));
function contextFixture() {
  const cleanups = [], registeredTools = [], providers = [], routes = [], events = [], pendingServices = [];
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const services = {
    tools: { register(definition) { registeredTools.push(definition); return () => {}; }, restrict() {} },
    llm: { registerAdapter(names, adapter) { for (const name of names) { const info = adapter.providerInfo(name); if (info.id !== name) throw new Error('provider id mismatch'); providers.push(name); } const handle = () => {}; handle.replace = () => {}; return handle; } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }), fetch: { register(route) { routes.push(route); return () => {}; } } },
    web: { registerSearchProvider() { return () => {}; } }
  };
  const ctx = { ...services, logger, get(name) { return services[name]; },
    effect(acquire) { const release = acquire(); if (typeof release === 'function') cleanups.push(release); return async () => { if (typeof release === 'function') await release(); }; },
    inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(ctx); else pendingServices.push(names); },
    on(name, listener) { events.push(name); return () => {}; }, emit() {}, provide(name, value) { services[name] = value; return () => {}; }
  };
  return { ctx, registeredTools, providers, routes, events, pendingServices, async dispose() { for (const cleanup of cleanups.reverse()) await cleanup(); } };
}
results.checks.mockedRegistration = [];
for (const id of ids.filter(id => !['dsh-qoder-connect', 'dsh-chat-import'].includes(id))) {
  const fixture = contextFixture();
  const file = path.join(root, 'plugins', id, 'lib', 'index.js');
  const before = attempts.length;
  try {
    const namespace = await loadModule(file);
    const config = id === 'dsh-retry-tuning' ? { enabled: true, maxWaitMs: 30000, maxRetries: 4, retryableCodes: ['TIMEOUT'] } : {};
    await namespace.apply(fixture.ctx, config);
    for (let index = 0; index < 30; index++) await Promise.resolve();
    results.checks.mockedRegistration.push({ plugin: id, outcome: 'apply-returned-with-mocks', tools: fixture.registeredTools.map(tool => tool.name), providers: fixture.providers, routeCount: fixture.routes.length, events: fixture.events, pendingServices: fixture.pendingServices, mockOperations: attempts.slice(before) });
  } catch (error) { results.checks.mockedRegistration.push({ plugin: id, outcome: 'probe-error', error: error.message }); }
  await fixture.dispose();
}
// These leaf probes use verbatim function declarations, with inert surrounding collaborators.
const browserRegistration = results.checks.mockedRegistration.find(row => row.plugin === 'dsh-browser-control');
const clientSource = read('plugins/dsh-browser-control/lib/client.js');
results.checks.screenshot = {
  outcome: browserRegistration.tools.includes('browser_screenshot') ? 'advertised' : 'not-exposed',
  registered: browserRegistration.tools.includes('browser_screenshot'),
  clientScreenshotCase: /case ['"]screenshot['"]/.test(clientSource)
};
const appendHostEvents = vm.runInNewContext('(' + functionSource('plugins/dsh-chat-import/lib/host-session.mjs', 'appendHostEvents') + ')', {
  targetSessionFormatVersion: async () => 4, hostSessionFormatVersion: async () => 4, hostNativeFormatVersion: async () => 4, prepareHostEvents: events => events
});
const handleTrace = [];
const currentPersistence = { async open(id, access) { handleTrace.push(['open', id, access]); return {
  async append(events) { handleTrace.push(['append', events.length]); },
  async flush() { handleTrace.push(['flush']); }, async close() { handleTrace.push(['close']); }
}; } };
await appendHostEvents({ get: name => name === 'sessionPersistence' ? currentPersistence : undefined }, 'probe-session', []);
results.checks.incrementalImport = { outcome: 'current-write-handle-path-completed-with-mocks', trace: handleTrace };
try {
  await appendHostEvents({ get: name => name === 'agents' ? { get: () => ({}) } : currentPersistence }, 'probe-live', []);
  throw new Error('probe expected live import refusal');
} catch (error) {
  if (!error.message.includes('unloaded conversation')) throw error;
  results.checks.incrementalImport.liveSessionRefused = true;
}
const resolveOAuth = vm.runInNewContext('(' + functionSource('plugins/dsh-plugin-subscriptions/lib/index.js', 'resolveAntigravityOAuthConfig') + ')', {
  process: { env: {} }, ANTIGRAVITY_DEFAULT_CLIENT_ID: '', ANTIGRAVITY_DEFAULT_CLIENT_SECRET: ''
});
try { resolveOAuth({}); results.checks.antigravityMissingConfig = { unexpectedlyReturned: true }; }
catch (error) { results.checks.antigravityMissingConfig = { outcome: 'resolver-rejects-unconfigured-login', error: error.message }; }
// Published JavaScript closure and symbol exports are checked against Git objects, never WIP.
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const manifestLines = git('grep', '-n', '-E', '"name":|"version":', refs.official, '--', 'packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json').trim().split('\n');
const hostPackages = new Map();
let packageName;
for (const row of manifestLines) {
  const match = /^[^:]+:([^:]+):\d+:\s*"(name|version)":\s*"([^"]+)"/.exec(row);
  if (!match) continue;
  if (match[2] === 'name') { packageName = match[3]; hostPackages.set(packageName, { path: match[1] }); }
  else if (packageName) hostPackages.get(packageName).version = match[3];
}
const exportCache = new Map();
function exported(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const names = new Map(); exportCache.set(file, names);
  const source = show(refs.official, file), parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const where = node => ({ path: file, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  for (const node of parsed.statements) {
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) if (!element.isTypeOnly) names.set(element.name.text, where(node));
      } else if (node.moduleSpecifier?.text.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text));
        for (const [name, location] of exported(target)) names.set(name, location);
      }
    } else if (ts.isExportAssignment(node)) names.set('default', where(node));
    else if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0) {
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, where(node));
      }
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
        names.set(node.name.text, where(node));
        if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0) names.set('default', where(node));
      }
    }
  }
  return names;
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? files(child) : /\.(mjs|js|cjs)$/.test(entry.name) ? [child] : [];
  });
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
results.checks.runtimeArtifacts = [];
results.checks.namedHostImports = [];
results.checks.runtimeImportClosure = { missingRelativeImports: [], absoluteImports: [], drivePathLiterals: [] };
for (const manifest of manifests) {
  const base = path.join(root, 'plugins', manifest.name);
  const runtime = files(path.join(base, 'lib'));
  if (fs.existsSync(path.join(base, 'client.js'))) runtime.push(path.join(base, 'client.js'));
  const rows = [];
  for (const file of runtime) {
    const text = fs.readFileSync(file, 'utf8'), relative = path.relative(base, file).split(path.sep).join('/');
    rows.push([relative, sha256(text)]);
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.') && !fs.existsSync(path.resolve(path.dirname(file), specifier))) results.checks.runtimeImportClosure.missingRelativeImports.push({ plugin: manifest.name, file: relative, specifier });
        if (/^[a-z]:[\\/]|^file:\/\/\//i.test(specifier)) results.checks.runtimeImportClosure.absoluteImports.push({ plugin: manifest.name, file: relative, specifier });
        const host = hostPackages.get(specifier);
        if (host && node.importClause) {
          const requested = [...node.importClause.name ? ['default'] : [], ...node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements.map(element => (element.propertyName ?? element.name).text) : []];
          const available = exported(path.posix.dirname(host.path) + '/src/index.ts');
          for (const name of requested) results.checks.namedHostImports.push({ plugin: manifest.name, module: specifier, name, official: available.get(name) ?? null });
        }
      }
      if (ts.isStringLiteral(node) && /^[a-z]:[\\/].{2,}/i.test(node.text)) results.checks.runtimeImportClosure.drivePathLiterals.push({ plugin: manifest.name, file: relative, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  rows.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  results.checks.runtimeArtifacts.push({ plugin: manifest.name, version: manifest.version, manifestSha256: sha256(fs.readFileSync(path.join(base, 'package.json'))), runtimeJavaScriptFiles: rows.length, runtimeTreeSha256: sha256(rows.map(([file, hash]) => file + '\n' + hash + '\n').join('')), hostEntrypoint: manifest.main, hostEntrypointSha256: sha256(fs.readFileSync(path.join(base, manifest.main))) });
}
results.checks.desktopNavigation = {
  officialPreloadNavigation: /navigation:\s*\{/.test(show(refs.official, 'apps/desktop/src/preload-app.ts')),
  officialAppCommandForwarding: show(refs.official, 'apps/desktop/src/main.ts').includes("'app-command'"),
  nextPreloadNavigation: /navigation:\s*\{/.test(show(refs.next, 'apps/desktop/src/preload-app.ts')),
  nextAppCommandForwarding: show(refs.next, 'apps/desktop/src/main.ts').includes("'app-command'")
};
if (results.checks.namedHostImports.some(row => row.official === null)) throw new Error('missing public Host export');
if (Object.values(results.checks.runtimeImportClosure).some(rows => rows.length)) throw new Error('published runtime import closure changed');
results.checks.externalOperations = { attemptedNetworkOrProcessOrWrites: attempts.filter(operation => operation !== 'mock-read'), realCredentialReads: 0, browserOrOsInput: 0 };
if (results.checks.mockedRegistration.some(row => row.outcome === 'probe-error')) throw new Error('mock registration failed');
if (results.checks.officialPreflight.some(row => row.issue)) throw new Error('preflight expectation changed');
if (results.checks.externalOperations.attemptedNetworkOrProcessOrWrites.length) throw new Error('probe attempted external effects');
fs.writeFileSync(path.join(probeTemp, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(process.argv.includes('--summary') ? {
  refs, preflightAccepted: results.checks.officialPreflight.filter(row => row.issue === null).length,
  plugins: results.checks.runtimeArtifacts.map(row => ({ name: row.plugin, version: row.version })),
  matchedHostImportSites: results.checks.namedHostImports.length, importClosure: results.checks.runtimeImportClosure,
  desktopNavigation: results.checks.desktopNavigation, screenshot: results.checks.screenshot,
  incrementalImport: results.checks.incrementalImport, harnessProfileStarted: false,
  externalOperations: results.checks.externalOperations
} : results, null, 2));
