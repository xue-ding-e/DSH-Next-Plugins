/**
 * dsh-whale-boot — a full-screen launch intro for DeepSeek Harness.
 *
 * The animation is one H.264/AAC video that already carries its own audio, so
 * this plugin is host-only: it serves the bytes and injects the opening frame
 * into the served index.html. No browser half, no ModuleLoader, no slots.
 *
 * Why the index injection matters: DSH draws its own "HARNESS / Loading
 * plugins…" card from the shell after the module graph is requested. A plugin
 * that paints from its own client bundle always loses that race by a few
 * hundred milliseconds. `webserver/index-inject` rows are rendered into
 * index.html directly after <head>, so the curtain is on the glass while the
 * document is still parsing and the card never appears at all.
 *
 * @module dsh-whale-boot
 */

import { createReadStream, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin entry name (matches cordis.patch.yml's row id). */
export const name = 'whale-boot'

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-whale-boot'

/** Absolute package root, resolved from this module. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the video lives.
 *
 * The clip is NOT part of this package: a 5.7 MB intro is user content, and
 * shipping one would force every install to carry (and license) a specific
 * animation. Resolution order:
 *
 * 1. `DSH_WHALE_BOOT_VIDEO` — an absolute path to any video the user picked.
 * 2. `<package>/assets/intro.mp4` — a clip the user dropped in locally.
 *
 * With neither present the plugin still mounts and still injects the curtain,
 * but the curtain's own error handler lifts it immediately, so a missing video
 * degrades to "no intro" instead of a black screen.
 */
const VIDEO_PATH = process.env.DSH_WHALE_BOOT_VIDEO || join(PACKAGE_ROOT, 'assets', 'intro.mp4')

/** MIME for the served asset. */
const VIDEO_MIME = 'video/mp4'

/**
 * localStorage keys shared with the injected script.
 *
 * `prefs` holds `{ enabled, volume, frequency }`; `played` is the
 * once-per-session marker. Both are read in the injected script, which cannot
 * import anything, so the literals are duplicated there on purpose.
 */
const PREFS_KEY = 'dsh:whale-boot:prefs'
const PLAYED_KEY = 'dsh:whale-boot:played'

/** Default preferences, mirrored by the injected script. */
const DEFAULT_PREFS = { enabled: true, volume: 0.9, frequency: 'session' }

/** Absolute URL of the video, as the browser sees it. */
const VIDEO_URL = ROUTE_PREFIX + '/intro.mp4'

/**
 * The curtain body.
 *
 * Serialised with `Function.prototype.toString` and inlined into index.html, so
 * it must not close over anything: every input arrives as an argument. It runs
 * in the document head, before any module, and therefore before the shell
 * exists.
 *
 * Failure posture: every step is wrapped so a broken video, a denied autoplay or
 * a missing localStorage never leaves a black wall in front of the GUI. The
 * safety timer is the last line — it lifts the curtain no matter what.
 *
 * @param videoUrl - same-origin URL of the video.
 * @param prefsKey - localStorage key holding the preferences object.
 * @param playedKey - sessionStorage key holding the once-per-session marker.
 * @param defaults - default preferences, JSON-serialisable.
 */
function curtainBody(videoUrl, prefsKey, playedKey, defaults) {
  try {
    var prefs = defaults
    try {
      var raw = window.localStorage.getItem(prefsKey)
      if (raw) {
        var parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          if (parsed.enabled === false) return
          if (typeof parsed.volume === 'number') prefs.volume = parsed.volume
          if (typeof parsed.frequency === 'string') prefs.frequency = parsed.frequency
        }
      }
    } catch (error) {
      /* private mode or a corrupt value: fall through to the defaults */
    }
    if (prefs.frequency !== 'always') {
      try {
        if (window.sessionStorage.getItem(playedKey) === '1') return
      } catch (error) {
        /* ignore */
      }
    }

    var layer = document.createElement('div')
    layer.setAttribute('data-dsh-whale-boot', '1')
    layer.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:#05070D;' +
      'opacity:1;transition:opacity 420ms ease;cursor:pointer;'
    try {
      layer.style.pointerEvents = 'auto'
    } catch (error) {
      /* ignore */
    }

    var video = document.createElement('video')
    video.muted = false
    video.defaultMuted = false
    video.volume = Math.max(0, Math.min(1, prefs.volume))
    video.autoplay = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('preload', 'auto')
    video.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#05070D;'
    layer.appendChild(video)
    document.documentElement.appendChild(layer)

    var lifted = false
    function lift() {
      if (lifted) return
      lifted = true
      try {
        video.pause()
      } catch (error) {
        /* ignore */
      }
      try {
        window.setTimeout(function () {
          if (layer.parentNode) layer.parentNode.removeChild(layer)
        }, 460)
        layer.style.opacity = '0'
        layer.style.pointerEvents = 'none'
      } catch (error) {
        if (layer.parentNode) layer.parentNode.removeChild(layer)
      }
      try {
        window.sessionStorage.setItem(playedKey, '1')
      } catch (error) {
        /* ignore */
      }
    }

    // Bounded: a stalled or undecodable file must never become a wall.
    video.addEventListener('ended', lift)
    video.addEventListener('error', lift)
    window.setTimeout(lift, 30000)

    // Manual exit: click anywhere, or Escape.
    layer.addEventListener('click', lift)
    window.addEventListener(
      'keydown',
      function (event) {
        if (event.key === 'Escape' || event.key === 'Esc') lift()
      },
      true
    )

    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        lift()
      }
    } catch (error) {
      /* ignore */
    }

    // Fade the last 900 ms so the curtain does not cut on a hard frame.
    function armFade() {
      if (!isFinite(video.duration) || video.duration <= 0) return
      var at = Math.max(0, video.duration - 0.9)
      video.addEventListener('timeupdate', function () {
        if (lifted) return
        if (video.currentTime >= at) layer.style.opacity = '0'
      })
    }
    if (video.readyState >= 1) armFade()
    else video.addEventListener('loadedmetadata', armFade)

    video.src = videoUrl

    function kick() {
      var started = video.play()
      // A shell with a stricter autoplay policy rejects sound playback; fall
      // back to a silent run rather than showing nothing.
      if (started && typeof started.catch === 'function') {
        started.catch(function () {
          video.muted = true
          video.setAttribute('muted', '')
          try {
            var again = video.play()
            if (again && typeof again.catch === 'function') again.catch(function () {})
          } catch (error) {
            lift()
          }
        })
      }
    }
    kick()
    video.addEventListener('loadeddata', kick, { once: true })
  } catch (error) {
    /* never let the intro break the shell */
  }
}

/**
 * One inline script tag carrying the curtain.
 * @returns the script text, with its inputs bound.
 */
function curtainScript() {
  return (
    '(' +
    curtainBody.toString() +
    ')(' +
    JSON.stringify(VIDEO_URL) +
    ',' +
    JSON.stringify(PREFS_KEY) +
    ',' +
    JSON.stringify(PLAYED_KEY) +
    ',' +
    JSON.stringify(DEFAULT_PREFS) +
    ')'
  )
}

/** Background paint under the video, so the first frame is never white. */
const CURTAIN_STYLE =
  'html[data-dsh-whale-boot-pending] body{background:#05070D}' +
  '[data-dsh-whale-boot]{will-change:opacity}'

/**
 * Parse one `Range: bytes=a-b` header against a known size.
 * @param header - the raw header value, or undefined.
 * @param size - total byte length of the resource.
 * @returns the inclusive start/end pair, `null` for "serve the whole body", or
 *   `'invalid'` when the range cannot be satisfied.
 */
function parseRange(header, size) {
  if (header === undefined || header === null || header === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return 'invalid'
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start
  let end
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isInteger(length) || length <= 0) return 'invalid'
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid'
  if (start > end || start < 0 || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Serve the intro video, with Range support so playback can start before the
 * whole file arrives.
 * @param req - incoming request.
 * @param res - response to write.
 */
function serveVideo(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let stat
  try {
    stat = statSync(VIDEO_PATH)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      'No intro video configured. Set DSH_WHALE_BOOT_VIDEO to an absolute path, ' +
        'or place a clip at ' + VIDEO_PATH
    )
    return
  }
  const size = stat.size
  const etag = '"' + size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'

  // A cached install revalidates instead of re-downloading 6 MB every boot.
  const inm = req.headers['if-none-match']
  if (typeof inm === 'string' && inm === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return
  }

  const range = parseRange(req.headers.range, size)
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': 'bytes */' + String(size) })
    res.end()
    return
  }
  const base = {
    'content-type': VIDEO_MIME,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'no-cache',
  }
  if (range === null) {
    res.writeHead(200, { ...base, 'content-length': String(size) })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(VIDEO_PATH).pipe(res)
    return
  }
  res.writeHead(206, {
    ...base,
    'content-range': 'bytes ' + String(range.start) + '-' + String(range.end) + '/' + String(size),
    'content-length': String(range.end - range.start + 1),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(VIDEO_PATH, { start: range.start, end: range.end }).pipe(res)
}

/**
 * Register the asset route and contribute the curtain to every index render.
 *
 * `webserver/index-inject` is a plain composition event with no service
 * dependency, so the curtain is contributed even on a host whose route service
 * is named differently; only the video would then be missing, and the curtain's
 * own error handler lifts it.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === VIDEO_URL) {
              serveVideo(req, res)
              return
            }
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'not-found' }))
          },
        }),
      'whale-boot: GET ' + ROUTE_PREFIX + '/*'
    )
  })

  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: CURTAIN_STYLE })
    table.push({ kind: 'script', placement: 'head', text: curtainScript() })
  })
}
