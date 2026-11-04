window.__ModuleLoader__.load({
  id: 'dsh-retry-tuning',
  factory(require) {
/**
 * Retry timing settings page.
 *
 * One page, three knobs: whether the plugin manages waits, the ceiling for a
 * single wait, and how many attempts to spend. Everything else in the host half
 * is derived from these.
 *
 * Values live in this plugin's own profile entry (`retry-tuning`) through
 * `ctx.configForms`, so they persist in the profile patch and every session in
 * this profile reads them.
 */

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.retryTuning'

/** This plugin's Host entry id, which is also its settings namespace. */
const NAMESPACE = 'retry-tuning'

/** Node cannot schedule a longer timer; the Host refuses values above this. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Values shown when the Host has not resolved a field yet. */
const DEFAULTS = { enabled: true, maxWaitMs: 30_000, maxRetries: 4 }

/** Render milliseconds as the shortest exact duration a person can read. */
function formatDelay(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
}

/** Read one member of the Host section, tolerating an absent value. */
function value(section, key) {
  const raw = section?.[key]
  return raw === undefined ? DEFAULTS[key] : raw
}

/**
 * The waits a person will actually see, for the small preview under the inputs.
 * Mirrors `waitFor` in lib/index.js: start at 1s, double, cut to the ceiling.
 * @param {number} ceiling - configured maximum for one wait.
 * @param {number} maxRetries - attempt budget.
 * @returns {number[]} one delay per attempt.
 */
function preview(ceiling, maxRetries) {
  if (!(ceiling > 0) || !(maxRetries > 0)) return []
  const bounded = Math.min(ceiling, MAX_TIMER_DELAY_MS)
  const rows = []
  for (let retry = 1; retry <= Math.min(maxRetries, 10); retry += 1) {
    rows.push(Math.max(1, Math.round(Math.min(1_000 * 2 ** (retry - 1), bounded))))
  }
  return rows
}

/** One labelled row; the label column owns the text, the control column the input. */
function Row({ label, hint, children, React }) {
  return React.createElement('div', { style: styles.row },
    React.createElement('div', { style: styles.rowText },
      React.createElement('div', { style: styles.rowLabel }, label),
      hint === undefined ? null : React.createElement('div', { style: styles.rowHint }, hint)),
    React.createElement('div', { style: styles.rowControl }, children))
}

/** A number input with its unit beside it, so milliseconds are never ambiguous. */
function NumberField({ value: current, onChange, min, max, step, unit, disabled, React }) {
  return React.createElement('div', { style: styles.numberWrap },
    React.createElement('input', {
      type: 'number',
      value: String(current),
      min,
      max,
      step,
      disabled: disabled === true,
      'aria-label': unit,
      onChange: event => { onChange(Number(event.target.value)) },
      style: { ...styles.input, opacity: disabled === true ? 0.5 : 1 },
    }),
    React.createElement('span', { style: styles.unit }, unit))
}

/** The settings page body. */
function RetryTuningSection({ t, form }) {
  const React = require('react')
  const snapshot = React.useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
    () => form.getSnapshot(),
  )

  if (snapshot.status === 'loading') return React.createElement('div', { style: styles.empty }, t('loading'))
  if (snapshot.status === 'unavailable') return React.createElement('div', { style: styles.empty }, t('unavailable'))

  const section = snapshot.value
  const disabled = snapshot.writable !== true
  const enabled = value(section, 'enabled') === true
  const ceiling = value(section, 'maxWaitMs')
  const maxRetries = value(section, 'maxRetries')
  // The Host validates on write and refuses bad values, so the page only has to
  // avoid offering an obviously unschedulable one.
  const ceilingInvalid = !Number.isFinite(ceiling) || ceiling <= 0
  const retriesInvalid = !Number.isSafeInteger(maxRetries) || maxRetries < 0

  const write = (field, next) => { void form.set(field, next) }
  const waits = preview(ceiling, maxRetries)

  return React.createElement('div', { style: styles.root },
    React.createElement('p', { style: styles.intro }, t('intro')),

    React.createElement('div', { style: styles.card },
      React.createElement(Row, {
        React, label: t('enabled'), hint: t('enabledHint'),
      }, React.createElement('input', {
        type: 'checkbox',
        checked: enabled,
        disabled,
        role: 'switch',
        'aria-checked': enabled,
        'aria-label': t('enabled'),
        onChange: event => { write('enabled', event.target.checked) },
        style: styles.checkbox,
      })),

      React.createElement(Row, {
        React, label: t('maxWaitMs'), hint: t('maxWaitMsHint'),
      }, React.createElement(NumberField, {
        React,
        value: ceiling,
        min: 1,
        step: 1_000,
        unit: 'ms',
        disabled: disabled || !enabled,
        onChange: next => { write('maxWaitMs', next) },
      })),

      React.createElement(Row, {
        React, label: t('maxRetries'), hint: t('maxRetriesHint'),
      }, React.createElement(NumberField, {
        React,
        value: maxRetries,
        min: 0,
        max: 100,
        step: 1,
        unit: t('times'),
        disabled: disabled || !enabled,
        onChange: next => { write('maxRetries', next) },
      }))),

    ceilingInvalid || retriesInvalid
      ? React.createElement('div', { style: styles.error, role: 'alert' }, t('invalid'))
      : null,

    enabled && waits.length > 0
      ? React.createElement('div', { style: styles.card },
          React.createElement('div', { style: styles.previewHead }, t('preview')),
          React.createElement('div', { style: styles.previewBody },
            waits.map((delay, index) => React.createElement('span', { key: index, style: styles.chip },
              React.createElement('span', { style: styles.chipIndex }, `#${index + 1}`),
              React.createElement('span', null, formatDelay(delay))))),
          React.createElement('p', { style: styles.note }, t('previewNote')))
      : null,

    React.createElement('p', { style: styles.footer }, t('footer')))
}

/**
 * Register the page once the settings shell declares its section seat.
 * @param {object} ctx - client root context.
 */
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  // Writes go through the settings provider's own fiber, so the namespace must be
  // this plugin's profile entry id — the same id the patch row declares.
  const form = () => ctx.configForms.get(NAMESPACE)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'retry-tuning',
    order: 13,
    label: () => t('nav'),
    inject: () => ({ t, form: form() }),
  }, RetryTuningSection))
}

/** Styles use only theme tokens, so light and dark both hold. */
const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px 24px' },
  intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' },
  card: {
    display: 'flex', flexDirection: 'column',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)',
    overflow: 'hidden',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  rowLabel: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
  rowHint: { fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' },
  rowControl: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' },
  numberWrap: { display: 'flex', alignItems: 'center', gap: '6px' },
  input: {
    width: '104px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
    color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px',
    fontVariantNumeric: 'tabular-nums',
  },
  unit: { fontSize: '12px', minWidth: '20px', color: 'var(--dsw-alias-label-secondary)' },
  checkbox: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer' },
  previewHead: {
    padding: '9px 14px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)',
    borderBottom: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
  },
  previewBody: { display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '12px 14px' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '3px 9px', borderRadius: '999px', fontSize: '12px',
    fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-base)',
  },
  chipIndex: { color: 'var(--dsw-alias-label-secondary)' },
  note: {
    margin: 0, padding: '0 14px 11px', fontSize: '12px', lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  empty: { padding: '24px 4px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
  error: {
    padding: '9px 12px', fontSize: '12px', lineHeight: '18px', borderRadius: '8px',
    color: 'var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-state-error-primary)',
  },
  footer: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
}

const en = {
  nav: 'Retry timing',
  loading: 'Reading configuration…',
  unavailable: 'This profile has no retry-tuning entry to configure.',
  intro: 'How long DeepSeek Harness waits before retrying a failed model request. Changes apply to the next wait — no restart.',
  enabled: 'Manage retry waits',
  enabledHint: 'Off hands every failure back to the built-in retry policy.',
  maxWaitMs: 'Longest single wait',
  maxWaitMsHint: 'No wait exceeds this — including the reset time a provider reports.',
  maxRetries: 'Retries',
  maxRetriesHint: 'Attempts after the first request. 0 disables retrying.',
  times: '×',
  invalid: 'The Host cannot schedule these values. Enter a wait above 0 and retries of 0 or more.',
  preview: 'What each retry waits',
  previewNote: 'A shorter provider-disclosed reset is honored as-is; a longer one is cut to the ceiling above.',
  footer: 'Stored in this profile and re-read on every attempt, so an edit changes the very next wait.',
}

const zh = {
  nav: '重试时间',
  loading: '正在读取配置…',
  unavailable: '当前 profile 没有 retry-tuning 条目可配置。',
  intro: '模型请求失败后，DeepSeek Harness 等多久再重试。改完对下一次等待立即生效，不用重启。',
  enabled: '接管重试等待',
  enabledHint: '关闭后所有失败都交回内置重试策略。',
  maxWaitMs: '单次最多等',
  maxWaitMsHint: '任何等待都不超过它——包括上游给出的重置时间。',
  maxRetries: '重试次数',
  maxRetriesHint: '首次请求之后还能试几次；0 表示不重试。',
  times: '次',
  invalid: '这组值排不出等待。等待要大于 0，重试次数要大于等于 0。',
  preview: '每次重试会等多久',
  previewNote: '上游给出的重置时间更短就照它的；更长就截断到上面的上限。',
  footer: '存在当前 profile 里，每次重试都会重新读取，所以改完下一次等待就变。',
}

return { inject: ['slots', 'locale', 'configForms'], apply, NS, en, zh }
  },
})
