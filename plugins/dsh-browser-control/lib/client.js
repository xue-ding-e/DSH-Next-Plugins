// Modified 2026-11-05: removed the unsupported screenshot action from this distribution.
window.__ModuleLoader__.load({
  id: 'dsh-browser-control',
  factory() {
/**
 * Page half of browser control: finds the Electron `<webview>` guest the sidebar
 * browser plugin already mounted, performs the requested action inside it, and
 * answers the Host's private RPC channel.
 *
 * Why a `<webview>` and not the host window: `webviewTag` is enabled for the
 * primary Desktop window, and the guest is the user's own logged-in tab, so
 * `executeJavaScript` runs with that tab's origin, cookies and storage. No new
 * browser process is created and the login state is exactly what the user
 * already has.
 */

/** Snapshot refs live on the page's own window so they survive between calls. */
const REF_ATTR = 'data-dsh-bc-ref'

/** Interactive elements worth listing to the model. */
const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
  '[contenteditable="true"]', '[onclick]',
].join(',')

/** Text-bearing blocks that give the model page context without a full DOM dump. */
const TEXTUAL = 'h1,h2,h3,h4,h5,h6,p,li,th,caption,figcaption'

/** The webview surface this module needs; kept structural so no Electron type import is required. */
function findWebviews() {
  return Array.from(document.querySelectorAll('webview[data-sidebar-browser-frame]'))
}

/** @returns the guest that is actually attached to the document and usable. */
function usableWebviews() {
  return findWebviews().filter(element => element.isConnected && typeof element.executeJavaScript === 'function')
}

/**
 * Find the innermost sandboxed part of a known Web origin so the sidebar can be
 * reached through a cross-origin boundary inside this iframe.
 */
function hostWindow() {
  return window
}

/**
 * Wait for a condition, polling briefly.
 * @param probe - returns the value once it is ready, or undefined.
 * @param timeoutMs - bounded wait.
 * @returns the first truthy probe result, or undefined on timeout.
 */
async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * Drive the sidebar browser's own start page when no guest exists yet.
 *
 * The browser tab renders a start page with an address input until a document is
 * requested; the `<webview>` guest does not exist before that. Typing the target
 * into that input and submitting it is the same path a user takes, so the tab
 * creates its guest with the profile's own partition and cookies.
 * @param url - the address to open.
 * @returns true when a start page accepted the address.
 */
async function driveStartPage(url) {
  const scope = hostWindow().document
  const inputs = Array.from(scope.querySelectorAll('input'))
  const field = inputs.find(element => {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase()
    if (type !== 'text' && type !== 'url' && type !== 'search') return false
    const hint = `${element.placeholder ?? ''} ${element.getAttribute('aria-label') ?? ''}`.toLowerCase()
    return hint.includes('http') || hint.includes('url') || hint.includes('地址') || hint.includes('网址')
  })
  if (field === undefined) return false
  field.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter !== undefined) setter.call(field, url)
  else field.value = url
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
  const form = field.form ?? field.closest('form')
  if (form !== null) {
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  return true
}

/**
 * Wait until a guest has committed its document.
 *
 * Electron rejects `executeJavaScript`/`loadURL` with "The WebView must be
 * attached to the DOM and the dom-ready event emitted" until the guest fires
 * `dom-ready`, which happens shortly after `will-attach-webview` completes. The
 * sidebar plugin mounts the guest asynchronously, so this waits instead of
 * failing the first call after a navigation.
 * @param webview - candidate guest.
 * @param timeoutMs - bounded wait.
 * @returns the guest once it is usable, or undefined on timeout.
 */
async function whenReady(webview, timeoutMs) {
  // Callers pass whatever `chooseWebview` returned, which is undefined until a
  // tab has mounted. Reading `.isConnected` off that crashed the whole action
  // with a bare TypeError instead of reporting "no tab open".
  if (webview === undefined || webview === null) return undefined
  const ready = () => {
    if (webview.isConnected !== true) return false
    try {
      // A committed document reports a URL; an attached-but-blank guest does not.
      return typeof webview.getURL === 'function' && webview.getURL() !== ''
    } catch { return false }
  }
  if (ready()) return webview
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return webview
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return undefined
}

/**
 * Pick the guest to drive, opening the target through the tab's own start page
 * when the tab exists but has not requested a document yet.
 * @param tabId - optional `name`/lease hint from the caller.
 * @param url - address to open when no guest is mounted.
 * @returns the target guest.
 * @throws when no sidebar browser tab is open at all.
 */
async function pickWebview(tabId, url) {
  const existing = await whenReady(chooseWebview(tabId), 1_000)
  if (existing !== undefined) return existing
  // No ready guest: the browser tab may be sitting on its start page. Ask that
  // page to load the target, which is what creates the guest.
  if (url !== undefined) {
    const opened = await driveStartPage(url)
    if (opened) {
      const guest = await waitFor(() => chooseWebview(tabId), 15_000)
      if (guest !== undefined) {
        const ready = await whenReady(guest, 15_000)
        if (ready !== undefined) return ready
        throw new Error('The sidebar browser created a view but it never became ready to script.')
      }
    }
  }
  const late = await whenReady(chooseWebview(tabId), 3_000)
  if (late !== undefined) return late
  throw new Error(
    'No sidebar browser tab is showing a page. Open the 浏览器 tab in the right sidebar, then retry: '
    + 'the tab creates its browser view only after it is asked to open an address.',
  )
}

/**
 * Choose among already-mounted guests.
 * @param tabId - optional lease/tab hint.
 * @returns the guest, or undefined when none is mounted.
 */
function chooseWebview(tabId) {
  const all = usableWebviews()
  if (all.length === 0) return undefined
  if (tabId !== undefined) {
    const exact = all.find(element => element.getAttribute('name') === tabId || element.dataset.dshBcTab === tabId)
    if (exact !== undefined) return exact
  }
  // Prefer a guest that has already committed a real document.
  const loaded = all.find(element => {
    try { return element.getURL().startsWith('http') } catch { return false }
  })
  return loaded ?? all[0]
}

/** Read the guest's current URL without throwing on a not-yet-ready guest. */
function currentUrl(webview) {
  try { return webview.getURL() } catch { return '' }
}

/**
 * Run a function body inside the guest page and return its value.
 * @param webview - target guest.
 * @param body - source of an async function body; `args` is in scope.
 * @param args - JSON arguments handed to the body.
 * @returns the page's JSON-serialisable result.
 * @throws when the page threw; the message carries the page-side error.
 */
async function runInPage(webview, body, args) {
  const source = `(async () => { const args = ${JSON.stringify(args ?? {})}; ${body} })()`
  return await webview.executeJavaScript(source, true)
}

/** Serialise one element into the compact shape the model reads. */
const DESCRIBE = `
  const describe = (element, ref) => {
    const tag = element.tagName.toLowerCase()
    const out = { ref, tag }
    const role = element.getAttribute('role')
    if (role !== null) out.role = role
    const text = (element.innerText ?? element.textContent ?? '').trim().replace(/\\s+/g, ' ')
    if (text !== '') out.text = text.length > 160 ? text.slice(0, 160) + '…' : text
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      out.inputType = element.getAttribute('type') ?? (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')
      if (element.name) out.name = element.name
      if (element.placeholder) out.placeholder = element.placeholder
      if (element.id) out.id = element.id
      if (element.value && (element.type === 'checkbox' || element.type === 'radio')) out.checked = element.checked
      else if (element.value && element.type !== 'password') out.value = String(element.value).slice(0, 80)
    } else {
      if (element.id) out.id = element.id
      const href = element.getAttribute('href')
      if (href) out.href = href
    }
    if (element.disabled) out.disabled = true
    return out
  };
`

/**
 * Perform one action against the guest.
 * @param action - action name from the Host.
 * @param request - action arguments.
 * @param webview - target guest.
 * @returns the action result.
 */
async function perform(action, request, webview) {
  switch (action) {
    case 'goto': {
      const url = String(request.url)
      await webview.loadURL(url)
      await settle(webview)
      return { url: currentUrl(webview), title: titleOf(webview) }
    }
    case 'snapshot': {
      const maxElements = Number.isFinite(request.maxElements) ? Math.max(1, Number(request.maxElements)) : 200
      const selector = typeof request.selector === 'string' ? request.selector : undefined
      const result = await runInPage(webview, `
        ${DESCRIBE}
        const scope = ${selector === undefined ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`};
        if (scope === null) throw new Error(${JSON.stringify(`no element matches selector ${selector ?? ''}`)});
        const seen = new Set();
        const elements = [];
        const nodes = scope.querySelectorAll(${JSON.stringify(INTERACTIVE)});
        for (const element of nodes) {
          if (seen.has(element)) continue;
          seen.add(element);
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const style = getComputedStyle(element);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const ref = 'e' + (elements.length + 1);
          element.setAttribute(${JSON.stringify(REF_ATTR)}, ref);
          elements.push(describe(element, ref));
          if (elements.length >= ${maxElements}) break;
        }
        const headings = [];
        // Deduplicated by text: pages repeat the same labels verbatim (a footer
        // mirrored for mobile, a nav rendered twice), and an agent reading the
        // same string twice spends context on nothing. Also capped by total
        // characters, because 40 entries of up to 200 chars is 8 KB in one tool
        // result while the caller may only need to know what the page is about.
        const seenText = new Set();
        let budget = 4000;
        for (const element of scope.querySelectorAll(${JSON.stringify(TEXTUAL)})) {
          const text = (element.innerText ?? '').trim().replace(/\\s+/g, ' ');
          if (text === '' || seenText.has(text)) continue;
          if (text.length > budget) break;
          seenText.add(text);
          budget -= text.length;
          headings.push({ tag: element.tagName.toLowerCase(), text: text.slice(0, 200) });
        }
        return {
          url: location.href,
          title: document.title,
          elements,
          text: headings,
          truncated: nodes.length > elements.length,
        };
      `, {})
      return result
    }
    case 'click': {
      const target = targetExpression(request)
      return await runInPage(webview, `
        ${DESCRIBE}
        const element = ${target};
        if (element === null) throw new Error('click target not found');
        element.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof element.focus === 'function') element.focus();
        const before = location.href;
        element.click();
        return { clicked: describe(element, ${JSON.stringify(String(request.ref ?? request.selector ?? ''))}), urlBefore: before };
      `, {})
    }
    case 'fill': {
      const target = targetExpression(request)
      const value = String(request.value)
      return await runInPage(webview, `
        ${DESCRIBE}
        const element = ${target};
        if (element === null) throw new Error('fill target not found');
        element.scrollIntoView({ block: 'center' });
        if (typeof element.focus === 'function') element.focus();
        const value = ${JSON.stringify(value)};
        if (element.isContentEditable) {
          element.textContent = value;
        } else {
          const proto = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter !== undefined) setter.call(element, value); else element.value = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        ${request.submit === true ? `
        const form = element.form ?? element.closest('form');
        if (form !== null) { if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit(); }
        ` : ''}
        return { filled: describe(element, ${JSON.stringify(String(request.ref ?? request.selector ?? ''))}), submitted: ${request.submit === true} };
      `, {})
    }
    case 'read_text': {
      const selector = typeof request.selector === 'string' ? request.selector : undefined
      const maxChars = Number.isFinite(request.maxChars) ? Math.max(1, Number(request.maxChars)) : 8000
      return await runInPage(webview, `
        const scope = ${selector === undefined ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`};
        if (scope === null) throw new Error(${JSON.stringify(`no element matches selector ${selector ?? ''}`)});
        const text = (scope.innerText ?? scope.textContent ?? '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return { url: location.href, title: document.title,
          text: text.length > ${maxChars} ? text.slice(0, ${maxChars}) + '\\n…[truncated]' : text,
          truncated: text.length > ${maxChars} };
      `, {})
    }
    case 'eval': {
      const expression = String(request.expression)
      const awaitPromise = request.awaitPromise !== false
      return await runInPage(webview, `
        const value = ${awaitPromise ? 'await (' : '('}${expression});
        try { return JSON.parse(JSON.stringify(value ?? null)); }
        catch { return String(value); }
      `, {})
    }
    case 'probe': {
      // Diagnostic: report which guest methods this Electron build really exposes.
      const names = new Set()
      let cursor = webview
      for (let depth = 0; cursor && depth < 6; depth++) {
        Object.getOwnPropertyNames(cursor).forEach(name => names.add(name))
        cursor = Object.getPrototypeOf(cursor)
      }
      const all = [...names]
      return {
        hasCapturePage: typeof webview.capturePage,
        hasGetWebContents: typeof webview.getWebContents,
        hasExecuteJavaScript: typeof webview.executeJavaScript,
        hasLoadURL: typeof webview.loadURL,
        captureLike: all.filter(name => /capture|print|picture|snapshot|save|image|contents/i.test(name)),
        url: currentUrl(webview),
        title: titleOf(webview),
      }
    }
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`)
  }
}

/**
 * Build the page-side expression that resolves a click/fill target.
 * A ref wins over a selector; both compile to one `document.querySelector` call.
 * @param request - action arguments carrying `ref` and/or `selector`.
 * @returns JavaScript source evaluated inside the guest.
 */
function targetExpression(request) {
  if (typeof request.ref === 'string' && request.ref !== '') {
    return `document.querySelector(${JSON.stringify(`[${REF_ATTR}="${request.ref}"]`)})`
  }
  if (typeof request.selector === 'string' && request.selector !== '') {
    return `document.querySelector(${JSON.stringify(request.selector)})`
  }
  throw new Error('this action needs a snapshot ref or a CSS selector')
}

/** @returns the guest's observed document title. */
function titleOf(webview) {
  try { return webview.getTitle() } catch { return '' }
}

/**
 * Wait for a navigation the guest already started to settle.
 * @param webview - target guest.
 * @returns after the guest reports it is no longer loading, or after a bounded wait.
 */
async function settle(webview) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    let loading = false
    try { loading = webview.isLoading() } catch { loading = false }
    if (!loading) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * Install the page half.
 * @param ctx - Client plugin context.
 */
function apply(ctx) {
  const channel = '/tool-sidebar-browser'
  let stopped = false
  let generation = 0

  const call = async (endpoint, payload, signal) => {
    const result = await ctx.connection.rpc.call(channel, endpoint, payload, signal)
    if (!result.ok) throw new Error(`${channel}/${endpoint}: ${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const loop = async (lifetime) => {
    const myGeneration = ++generation
    while (!stopped && !lifetime.signal.aborted && myGeneration === generation) {
      let claimed
      try {
        claimed = await call('poll', {}, lifetime.signal)
      } catch (error) {
        if (stopped || lifetime.signal.aborted) return
        console.error('[dsh-browser-control] poll failed; retrying', error)
        await new Promise(resolve => setTimeout(resolve, 1500))
        continue
      }
      if (claimed === undefined || claimed.idle === true || typeof claimed.id !== 'string') continue
      let answer
      try {
        const request = claimed.request
        // `goto` supplies the address that creates the guest when the tab is
        // still on its start page; other actions reuse whatever guest exists.
        const webview = await pickWebview(request.tabId, request.action === 'goto' ? String(request.url) : undefined)
        answer = { ok: true, value: await perform(String(request.action), request, webview) }
      } catch (error) {
        answer = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      try { await call('resolve', { id: claimed.id, answer }, lifetime.signal) }
      catch (error) { console.error('[dsh-browser-control] could not deliver a page answer', error) }
    }
  }

  // One lifetime for the whole plugin, plus a generation counter that a reset
  // bumps. The old loop stops when its generation no longer matches; a NEW loop
  // must then be started, or the feature stays dead.
  const lifetime = new AbortController()
  const startLoop = () => { void loop(lifetime) }

  ctx.effect(() => {
    startLoop()
    return () => { stopped = true; lifetime.abort() }
  }, 'dsh-browser-control: page loop')

  // Opening the sidebar browser (or reconnecting) resets the connection. Bumping
  // the generation ends the previous loop; restarting is what keeps the channel
  // alive. Without the restart the page half polls once and then goes silent,
  // which reads as "browser tab not open" for every later tool call.
  ctx.on('connection/reset', () => {
    if (stopped || lifetime.signal.aborted) return
    generation++
    startLoop()
  })
  ctx.logger?.info?.('dsh-browser-control: page half polling', channel)
}

return { inject: ['connection'], apply }
  },
})
