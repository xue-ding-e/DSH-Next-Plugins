/**
 * dsh-qoder-connect 的浏览器侧：设置面板里的「Qoder CN」用量页。
 *
 * 形态对齐 Qoder 官方用量面板：套餐与到期 → 额度环（已用/总量）→ 组织资源包 →
 * 模型倍率表 → 凭据与连接状态。状态数据来自宿主侧接口，账号和 CLI 操作走同源
 * 回环路由（与 client.js 无关，浏览器只提交固定字段）。
 *
 * 只注册 `settings.section`，不碰任何 DSH 自带 UI；配色全部用主题 token，
 * 跟随亮/暗色。
 */

const STATUS_ROUTE = '/plugins/dsh-qoder-connect/status';
const ACCOUNT_ADD_ROUTE = '/plugins/dsh-qoder-connect/accounts/add';
const ACCOUNT_REPLACE_ROUTE = '/plugins/dsh-qoder-connect/accounts/replace';
const ACCOUNT_RENAME_ROUTE = '/plugins/dsh-qoder-connect/accounts/rename';
const ACCOUNT_SELECT_ROUTE = '/plugins/dsh-qoder-connect/accounts/select';
const ACCOUNT_REMOVE_ROUTE = '/plugins/dsh-qoder-connect/accounts/remove';
const CLI_UPDATE_ROUTE = '/plugins/dsh-qoder-connect/cli/update';
const REFRESH_MS = 30000;

/** 由 factory 注入（宿主的浏览器模块表），组件在调用时读取。 */
let React = null;

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value >= 1000 ? value.toLocaleString('zh-CN') : String(value);
}

function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '—';
  return Number.isInteger(rate) ? `${rate}×` : `${Number(rate.toFixed(2))}×`;
}

/** 180000 → `180K`，1000000 → `1M`。 */
function formatTokens(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1000000) {
    const millions = tokens / 1000000;
    return `${Number.isInteger(millions) ? millions : Number(millions.toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function formatDay(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 额度环：SVG 圆环 + 中央百分比，Qoder 用量面板同款观感。 */
function QuotaRing({ used, total, unit }) {
  const h = React.createElement;
  const pct = total > 0 ? Math.min(1, used / total) : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  const danger = pct >= 0.95;
  const warn = pct >= 0.8;
  const stroke = danger ? 'var(--dsh-color-danger, #e5484d)' : warn ? 'var(--dsh-color-warning, #f5a524)' : 'var(--dsh-color-accent, #3b82f6)';
  return h('div', { style: { position: 'relative', width: 128, height: 128, flex: '0 0 auto' } },
    h('svg', { viewBox: '0 0 128 128', width: 128, height: 128, style: { transform: 'rotate(-90deg)' } },
      h('circle', { cx: 64, cy: 64, r, fill: 'none', stroke: 'var(--dsh-color-border, rgba(128,128,128,.25))', strokeWidth: 10 }),
      h('circle', {
        cx: 64, cy: 64, r, fill: 'none', stroke, strokeWidth: 10, strokeLinecap: 'round',
        strokeDasharray: `${c * pct} ${c}`,
      }),
    ),
    h('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 2,
      },
    },
      h('div', { style: { fontSize: 22, fontWeight: 600, lineHeight: 1.1 } }, `${Math.round(pct * 100)}%`),
      h('div', { style: { fontSize: 11, opacity: 0.65 } }, unit === 'credits' ? '已用' : unit),
    ),
  );
}

function Row({ label, children }) {
  const h = React.createElement;
  return h('div', {
    style: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 16, padding: '8px 0', borderBottom: '1px solid var(--dsh-color-border, rgba(128,128,128,.18))',
    },
  },
    h('span', { style: { fontSize: 13, opacity: 0.7 } }, label),
    h('span', { style: { fontSize: 13, fontVariantNumeric: 'tabular-nums' } }, children),
  );
}

function Card({ children, style }) {
  const h = React.createElement;
  return h('div', {
    style: {
      border: '1px solid var(--dsh-color-border, rgba(128,128,128,.22))',
      borderRadius: 12, padding: 16, marginBottom: 16,
      background: 'var(--dsh-color-surface, transparent)',
      ...style,
    },
  }, children);
}

async function postJson(route, payload) {
  const response = await fetch(route, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = {};
  try { body = text.length > 0 ? JSON.parse(text) : {}; } catch { throw new Error(`服务器返回了无效响应（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

const BUTTON_STYLE = {
  fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--dsh-color-border, rgba(128,128,128,.3))',
  background: 'transparent', color: 'inherit',
};

const INPUT_STYLE = {
  width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 9px', borderRadius: 7,
  border: '1px solid var(--dsh-color-border, rgba(128,128,128,.3))',
  background: 'var(--dsh-color-surface-muted, rgba(128,128,128,.08))', color: 'inherit',
};

function CliUpdateRow() {
  const h = React.createElement;
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  const update = () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setFailed(false);
    postJson(CLI_UPDATE_ROUTE, {})
      .then((result) => {
        const isFailed = result.status === 'failed';
        setFailed(isFailed);
        setMessage(result.message || (isFailed ? 'Qoder CLI 更新失败' : 'Qoder CLI 已更新'));
      })
      .catch((error) => { setFailed(true); setMessage(error.message || String(error)); })
      .finally(() => setBusy(false));
  };

  return h(Card, null,
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } },
      h('div', { style: { minWidth: 220, flex: '1 1 320px' } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 5 } }, 'Qoder CLI'),
        h('div', { style: { fontSize: 12, opacity: 0.65, lineHeight: 1.6 } },
          '在这里安装或更新 Qoder CLI；更新过程中会复用同一个操作，连续点击不会重复启动。'),
        message !== null
          ? h('div', { style: { fontSize: 12, marginTop: 8, color: failed ? 'var(--dsh-color-danger, #e5484d)' : 'var(--dsh-color-success, #2ea043)' } }, message)
          : null,
      ),
      h('button', {
        type: 'button', disabled: busy, onClick: update,
        style: { ...BUTTON_STYLE, opacity: busy ? 0.6 : 1 },
      }, busy ? '正在安装/更新…' : '安装/更新 Qoder CLI'),
    ),
  );
}

function accountSourceLabel(account) {
  if (account.source === 'environment') return '环境变量优先';
  if (account.source === 'legacy-file') return '默认 pat 文件';
  return '独立 PAT 文件';
}

function AccountManager({ doc, onChanged }) {
  const h = React.createElement;
  const accounts = Array.isArray(doc.accounts) ? doc.accounts : [];
  const [label, setLabel] = React.useState('');
  const [pat, setPat] = React.useState('');
  const [replaceId, setReplaceId] = React.useState(null);
  const [replacePat, setReplacePat] = React.useState('');
  const [nameEditId, setNameEditId] = React.useState(null);
  const [nameEditLabel, setNameEditLabel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (replaceId !== null && !accounts.some((account) => account.id === replaceId)) {
      setReplaceId(null);
      setReplacePat('');
    }
    if (nameEditId !== null && !accounts.some((account) => account.id === nameEditId)) {
      setNameEditId(null);
      setNameEditLabel('');
    }
  }, [accounts, nameEditId, replaceId]);

  const run = (task, successMessage) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setFailed(false);
    task()
      .then(() => {
        setMessage(successMessage);
        return onChanged ? onChanged() : undefined;
      })
      .catch((error) => { setFailed(true); setMessage(error.message || String(error)); })
      .finally(() => setBusy(false));
  };

  const add = (activate) => {
    if (!pat.startsWith('pt-')) {
      setFailed(true);
      setMessage('PAT 必须以 pt- 开头。');
      return;
    }
    run(
      () => postJson(ACCOUNT_ADD_ROUTE, { label, pat, activate }).then(() => {
        setLabel('');
        setPat('');
      }),
      activate ? '账号已添加并切换。' : '账号已添加，当前账号未改变。',
    );
  };

  const select = (account) => {
    run(() => postJson(ACCOUNT_SELECT_ROUTE, { id: account.id }), `已切换到「${account.label}」。`);
  };

  const replace = (account, event) => {
    event.preventDefault();
    if (!replacePat.startsWith('pt-')) {
      setFailed(true);
      setMessage('PAT 必须以 pt- 开头。');
      return;
    }
    run(
      () => postJson(ACCOUNT_REPLACE_ROUTE, { id: account.id, label: account.label, pat: replacePat }).then(() => {
        setReplacePat('');
        setReplaceId(null);
      }),
      `「${account.label}」的 PAT 已替换并设为当前账号。`,
    );
  };

  const rename = (account, event) => {
    event.preventDefault();
    if (nameEditLabel.trim().length === 0) {
      setFailed(true);
      setMessage('账号名称不能为空。');
      return;
    }
    run(
      () => postJson(ACCOUNT_RENAME_ROUTE, { id: account.id, label: nameEditLabel }).then(() => {
        setNameEditId(null);
        setNameEditLabel('');
      }),
      `账号名称已改为「${nameEditLabel.trim()}」。`,
    );
  };

  const remove = (account) => {
    if (typeof window !== 'undefined' && !window.confirm(`确定删除「${account.label}」保存的 PAT 吗？`)) return;
    run(() => postJson(ACCOUNT_REMOVE_ROUTE, { id: account.id }), `已删除「${account.label}」。`);
  };

  return h('div', null,
    h(Card, null,
      h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, 'Qoder 账号 / PAT'),
      h('div', { style: { fontSize: 12, opacity: 0.68, lineHeight: 1.7, marginBottom: 12 } },
        '可以保存多个 Qoder 账号。当前账号额度用完后，直接切换到另一个账号即可；切换会立即作用于后续请求，不需要重启 DSH。'),
      doc.environmentOverride
        ? h('div', { style: { fontSize: 12, lineHeight: 1.6, marginBottom: 12, padding: '8px 10px', borderRadius: 8, color: 'var(--dsh-color-warning, #f5a524)', background: 'var(--dsh-color-warning-muted, rgba(245,165,36,.12))' } },
            `检测到 ${doc.environmentOverride} 环境变量，它会优先于下面的账号；清除该环境变量后，界面切换才会生效。`)
        : null,
      h('form', { onSubmit: (event) => { event.preventDefault(); add(true); }, style: { display: 'grid', gridTemplateColumns: 'minmax(130px, .6fr) minmax(220px, 1fr) auto', gap: 8, alignItems: 'end', marginBottom: 14 } },
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, opacity: 0.72 } },
          '账号名称',
          h('input', { value: label, onChange: (event) => setLabel(event.target.value), placeholder: '例如：工作账号', style: INPUT_STYLE, autoComplete: 'off' }),
        ),
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, opacity: 0.72 } },
          'Personal Access Token',
          h('input', { type: 'password', value: pat, onChange: (event) => setPat(event.target.value), placeholder: 'pt-…', style: INPUT_STYLE, autoComplete: 'new-password' }),
        ),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('button', { type: 'button', disabled: busy || pat.length === 0, onClick: () => add(false), style: { ...BUTTON_STYLE, opacity: busy || pat.length === 0 ? 0.55 : 1 } }, '仅添加'),
          h('button', { type: 'submit', disabled: busy || pat.length === 0, style: { ...BUTTON_STYLE, opacity: busy || pat.length === 0 ? 0.55 : 1 } }, '添加并切换'),
        ),
      ),
      h('div', null,
        accounts.length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: '8px 0' } }, '暂无已保存账号。')
          : accounts.map((account) => h('div', {
              key: account.id,
              style: { padding: '10px 0', borderTop: '1px solid var(--dsh-color-border, rgba(128,128,128,.16))' },
            },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
              h('div', { style: { minWidth: 180, flex: '1 1 240px' } },
                h('div', { style: { fontSize: 13, fontWeight: 600 } },
                  account.label,
                  account.active
                    ? h('span', { style: { marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--dsh-color-success, #2ea043)' } }, '当前账号')
                    : null,
                ),
                h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 4 } },
                  `${accountSourceLabel(account)} · ${account.configured ? '已配置' : '未配置'}`),
              ),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                !account.active && account.source !== 'environment'
                  ? h('button', { type: 'button', disabled: busy, onClick: () => select(account), style: { ...BUTTON_STYLE, opacity: busy ? 0.55 : 1 } }, '切换')
                  : null,
                account.source !== 'environment'
                  ? h('button', { type: 'button', disabled: busy, onClick: () => { setNameEditId(nameEditId === account.id ? null : account.id); setNameEditLabel(nameEditId === account.id ? '' : account.label); setReplaceId(null); setReplacePat(''); }, style: { ...BUTTON_STYLE, opacity: busy ? 0.55 : 1 } }, '编辑')
                  : null,
                account.source !== 'environment'
                  ? h('button', { type: 'button', disabled: busy, onClick: () => { setReplaceId(replaceId === account.id ? null : account.id); setReplacePat(''); setNameEditId(null); setNameEditLabel(''); }, style: { ...BUTTON_STYLE, opacity: busy ? 0.55 : 1 } }, '替换 Key')
                  : null,
                account.source === 'file'
                  ? h('button', { type: 'button', disabled: busy, onClick: () => remove(account), style: { ...BUTTON_STYLE, opacity: busy ? 0.55 : 1 } }, '删除')
                  : null,
              ),
            ),
            nameEditId === account.id
              ? h('form', { onSubmit: (event) => rename(account, event), style: { display: 'flex', gap: 8, alignItems: 'end', marginTop: 9, flexWrap: 'wrap' } },
                  h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, opacity: 0.72, flex: '1 1 260px' } },
                    '账号名称',
                    h('input', { value: nameEditLabel, onChange: (event) => setNameEditLabel(event.target.value), placeholder: '账号名称', style: INPUT_STYLE, autoComplete: 'off' }),
                  ),
                  h('button', { type: 'submit', disabled: busy || nameEditLabel.trim().length === 0, style: { ...BUTTON_STYLE, opacity: busy || nameEditLabel.trim().length === 0 ? 0.55 : 1 } }, '保存名称'),
                )
              : null,
            replaceId === account.id
              ? h('form', { onSubmit: (event) => replace(account, event), style: { display: 'flex', gap: 8, alignItems: 'end', marginTop: 9, flexWrap: 'wrap' } },
                  h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, opacity: 0.72, flex: '1 1 260px' } },
                    '新的 Personal Access Token',
                    h('input', { type: 'password', value: replacePat, onChange: (event) => setReplacePat(event.target.value), placeholder: 'pt-…', style: INPUT_STYLE, autoComplete: 'new-password' }),
                  ),
                  h('button', { type: 'submit', disabled: busy || replacePat.length === 0, style: { ...BUTTON_STYLE, opacity: busy || replacePat.length === 0 ? 0.55 : 1 } }, '保存替换'),
                )
              : null,
          )),
      ),
      message !== null
        ? h('div', { style: { fontSize: 12, marginTop: 10, color: failed ? 'var(--dsh-color-danger, #e5484d)' : 'var(--dsh-color-success, #2ea043)' } }, message)
        : null,
    ),
    h(CliUpdateRow),
  );
}

function QoderSection() {
  const h = React.createElement;
  const [doc, setDoc] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback((force) => {
    const url = force ? `${STATUS_ROUTE}?refresh=1` : STATUS_ROUTE;
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `请求失败（HTTP ${res.status}）`);
        return json;
      })
      .then((json) => { setDoc(json); setError(null); })
      .catch((err) => setError(String(err && err.message ? err.message : err)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load(true);
    const timer = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && doc === null) return h('div', { style: { fontSize: 13, opacity: 0.7 } }, '正在读取 Qoder 账号…');
  if (error !== null) return h('div', { style: { fontSize: 13, color: 'var(--dsh-color-danger, #e5484d)' } }, `读取失败：${error}`);

  if (doc.status !== 'signed-in') {
    return h('div', null,
      h(AccountManager, { doc, onChanged: () => { setLoading(true); return load(true); } }),
      h(Card, null,
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '当前账号尚未就绪'),
        h('div', { style: { fontSize: 13, opacity: 0.75, lineHeight: 1.7 } },
          '可以在上面的账号管理里添加或替换 Qoder CN Personal Access Token（pt- 开头）；保存后插件会自动生效，无需重启。'),
        h('code', {
          style: {
            display: 'block', marginTop: 10, padding: '10px 12px', fontSize: 12,
            borderRadius: 8, background: 'var(--dsh-color-surface-muted, rgba(128,128,128,.12))',
            wordBreak: 'break-all',
          },
        }, doc.patPath || '(未知路径)'),
        doc.reason ? h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 10 } }, doc.reason) : null,
      ),
    );
  }

  const usage = doc.usage || null;
  const plan = doc.plan || null;
  const quota = usage && usage.quota ? usage.quota : null;
  const orgPackage = usage && usage.orgPackage ? usage.orgPackage : null;
  const models = Array.isArray(doc.models) ? doc.models : [];

  return h('div', null,
    h(AccountManager, { doc, onChanged: () => { setLoading(true); return load(true); } }),
    h(Card, null,
      h('div', { style: { display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' } },
        h(QuotaRing, { used: quota ? quota.used : 0, total: quota ? quota.total : 0, unit: quota ? quota.unit : 'credits' }),
        h('div', { style: { flex: '1 1 240px', minWidth: 240 } },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 2 } },
            plan && plan.planTierName ? plan.planTierName : 'Qoder CN'),
          h('div', { style: { fontSize: 12, opacity: 0.65, marginBottom: 12 } },
            doc.account || doc.email || doc.userId || ''),
          quota
            ? h('div', null,
                h('div', { style: { fontSize: 13, marginBottom: 6 } },
                  `剩余 ${formatNumber(quota.remaining)} / ${formatNumber(quota.total)} ${quota.unit}`),
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: 0.65 } },
                  h('span', null, `已用 ${formatNumber(quota.used)}`),
                  h('span', null, usage && usage.expiresAt ? `到期 ${formatDay(usage.expiresAt)}` : '到期 —'),
                ),
              )
            : h('div', { style: { fontSize: 13, opacity: 0.7 } }, doc.usageError ? `额度读取失败：${doc.usageError}` : '额度不可用'),
          usage && usage.isQuotaExceeded
            ? h('div', { style: { marginTop: 10, fontSize: 12, color: 'var(--dsh-color-danger, #e5484d)' } }, '额度已用尽，调用会被上游拒绝')
            : null,
        ),
      ),
    ),

    orgPackage && orgPackage.cap > 0
      ? h(Card, null,
          h(Row, { label: '组织资源包' },
            orgPackage.available
              ? `${formatNumber(orgPackage.used)} / ${formatNumber(orgPackage.cap)}`
              : `未启用（上限 ${formatNumber(orgPackage.cap)}）`),
          plan && plan.organization && plan.organization.name
            ? h(Row, { label: '组织' }, `${plan.organization.name}${plan.organization.role ? ` · ${plan.organization.role}` : ''}`)
            : null,
        )
      : null,

    h(Card, null,
      h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, `模型（${models.length}）`),
      h('div', { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 } },
        '倍率是 Qoder 的计价系数，实际扣费 = 倍率 × token 用量。'
        + '方括号里的数字是该模型**官方声明的输入上限**（官方 max_input_tokens），鼠标悬停可看可选档位。'),
      // 这一行是为了避免一个真实误解：这里标的是「官方声明上限」，不是「DSH 当前实际用的值」。
      // DSH 设置里的「上下文窗口」在**上层**，会覆盖这里；两者可以不同。
      h('div', { style: { fontSize: 11, opacity: 0.45, marginBottom: 8, lineHeight: 1.6 } },
        '注意：这是上游声明的上限，不等于 DSH 实际使用的窗口。'
        + 'DSH 设置里的「上下文窗口」在更上层，会覆盖它；调到超过声明上限时，'
        + '请求一旦真的超过该上限，上游可能直接报超长。'),
      h('div', { style: { maxHeight: 280, overflowY: 'auto' } },
        models.map((model) => h('div', {
          key: model.id,
          style: {
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
            borderBottom: '1px solid var(--dsh-color-border, rgba(128,128,128,.14))',
          },
        },
          h('span', { style: { flex: 1, fontSize: 13 } }, model.name || model.id),
          model.contextWindow
            ? h('span', {
                // 悬停显示：真正生效值 / 官方声明值 / 官方可选档位
                title: (model.contextWindowOverridden === true
                  ? `已由插件配置覆盖为 ${formatTokens(model.contextWindow)}`
                    + `（官方声明 ${formatTokens(model.declaredContextWindow)}）`
                  : `官方声明上限 ${formatTokens(model.contextWindow)}`)
                  + (Array.isArray(model.contextWindows) && model.contextWindows.length > 0
                    ? `；官方可选档位：${model.contextWindows.map(formatTokens).join(' / ')}`
                    : ''),
                style: {
                  fontSize: 11, opacity: 0.55, marginLeft: 6, cursor: 'help',
                  fontVariantNumeric: 'tabular-nums',
                  ...(model.contextWindowOverridden === true
                    ? { color: 'var(--dsh-color-warning, #f5a524)', opacity: 0.9 }
                    : {}),
                },
              }, `[${formatTokens(model.contextWindow)}]`)
            : null,
          model.free ? h('span', {
            style: {
              fontSize: 11, padding: '1px 6px', borderRadius: 999,
              background: 'var(--dsh-color-success-muted, rgba(46,160,67,.16))',
              color: 'var(--dsh-color-success, #2ea043)',
            },
          }, '免费') : null,
          h('span', {
            style: {
              fontSize: 12, opacity: 0.75, width: 44, textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            },
          }, formatRate(model.rate)),
        )),
      ),
    ),

    h(AlertBanner, { warnings: doc.warnings }),

    h(Card, null,
      h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '诊断'),
      h(CatalogAuditRow, { audit: doc.catalogAudit, probe: doc.versionProbe }),
      h(Row, { label: 'PAT 来源' }, doc.patSource ? String(doc.patSource) : '—'),
      h(Row, { label: 'jobToken 到期' }, doc.jobTokenExpiresAt ? new Date(doc.jobTokenExpiresAt).toLocaleString('zh-CN') : '—'),
      h(Row, { label: '模型目录' }, doc.catalogSource === 'remote' ? '已从上游同步' : '兜底快照'),
      doc.usageError ? h(Row, { label: '额度接口' }, String(doc.usageError)) : null,
      doc.planError ? h(Row, { label: '套餐接口' }, String(doc.planError)) : null,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 12 } },
        h('button', {
          type: 'button',
          onClick: () => { setLoading(true); load(true); },
          style: {
            fontSize: 12, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--dsh-color-border, rgba(128,128,128,.3))',
            background: 'transparent', color: 'inherit',
          },
        }, '刷新'),
      ),
    ),
  );
}

/** 顶部告警横幅：有 warnings 才出现，红底，一眼能看到。 */
function AlertBanner({ warnings }) {
  const h = React.createElement;
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return h('div', {
    style: {
      marginBottom: 16, padding: '12px 14px', borderRadius: 10,
      border: '1px solid var(--dsh-color-danger, #e5484d)',
      background: 'var(--dsh-color-danger-muted, rgba(229,72,77,.12))',
      fontSize: 13, lineHeight: 1.65,
    },
  },
    h('div', { style: { fontWeight: 600, marginBottom: 6, color: 'var(--dsh-color-danger, #e5484d)' } },
      `需要处理（${warnings.length}）`),
    ...warnings.map((text, index) => h('div', { key: index, style: { opacity: 0.9 } }, `· ${text}`)),
  );
}

/**
 * 目录审计结果。
 *
 * 这一块存在的唯一理由：模型数变少时**区分「官方下线」还是「我们版本落后」**。
 * 两个相互独立的参照物，都是零 token：
 *
 *   1. 用 `Cosy-Version: 9.9.9` 再问一次目录（服务端对高版本不裁剪）→ 拿到「已知全体」，
 *      每个模型自带 `minimal_version.cli`，缺口能被它解释的就是「落后」。
 *   2. 读官方桌面客户端自己那份缓存（`~/.qoder-cn/.models/<uid>/catalog-v<N>`，
 *      离线、密钥由 uid 派生）→ 跟官方客户端看到的东西逐条对比。
 */
function CatalogAuditRow({ audit, probe }) {
  const h = React.createElement;
  const danger = { color: 'var(--dsh-color-danger, #e5484d)' };
  const success = { color: 'var(--dsh-color-success, #2ea043)' };
  const hint = { fontSize: 11, opacity: 0.55, paddingTop: 6, lineHeight: 1.6, wordBreak: 'break-all' };
  const subtle = { fontSize: 11, opacity: 0.45, paddingTop: 4, lineHeight: 1.6 };

  // 老版本后端没有 catalogAudit，退回只读 versionProbe。
  if (audit === null || audit === undefined) {
    if (probe === null || probe === undefined) return h(Row, { label: '目录审计' }, '未运行');
    if (probe.error) return h(Row, { label: '目录审计' }, `探测失败：${probe.error}`);
    return h(Row, { label: '目录审计' }, probe.behind === true ? '落后' : '未落后');
  }
  if (audit.error) return h(Row, { label: '目录审计' }, `探测失败：${audit.error}`);

  const gated = Array.isArray(audit.gated) ? audit.gated : [];
  const unexplained = Array.isArray(audit.unexplained) ? audit.unexplained : [];
  const official = audit.official;
  const behind = audit.behind === true;

  const verdict = behind
    ? h('span', { style: danger }, `我们版本落后（${gated.length} 个模型被裁）`)
    : (unexplained.length > 0
      ? h('span', { style: danger }, `异常（${unexplained.length} 个模型无法解释）`)
      : h('span', { style: success }, '一致'));

  const children = [
    h(Row, { key: 'verdict', label: '目录审计' }, verdict),
    h('div', { key: 'counts', style: hint },
      `Cosy-Version ${audit.cosyVersion}：实际 ${audit.currentCount} 个 · `
      + `该版本应见 ${audit.expectedCount} 个 · 高版本(${audit.probeVersion}) 全体 ${audit.universeCount} 个`),
  ];

  if (gated.length > 0) {
    children.push(h('div', { key: 'gated', style: hint },
      '被版本门槛裁掉：' + gated.map((item) => `${item.name}（需 ≥ ${item.requires}）`).join('、')));
  }
  if (unexplained.length > 0) {
    children.push(h('div', { key: 'unexplained', style: hint },
      '官方没删、版本也够，但我们没拿到（要查解析）：' + unexplained.map((item) => item.name).join('、')));
  }

  if (official === undefined || official === null || official.available !== true) {
    children.push(h('div', { key: 'official', style: subtle },
      `官方客户端缓存：${official?.reason ?? '未读到'}`));
  } else {
    // 已被 minimal_version.cli 解释过的缺口不在这里重复一遍。
    const explained = new Set(gated.map((item) => item.id));
    const extraHere = (official.missingHere ?? []).filter((item) => !explained.has(item.id));
    const parts = [`官方客户端缓存 ${official.officialCount} 个（更新于 ${new Date(official.updatedAt).toLocaleString('zh-CN')}）`];
    if (extraHere.length > 0) {
      parts.push(`官方有我们没有：${extraHere.map((item) => item.name).join('、')}`);
    }
    if (official.missingThere?.length > 0) {
      parts.push(`我们有官方没有：${official.missingThere.join('、')}`);
    }
    children.push(h('div', { key: 'official', style: hint },
      parts.join(' · ') + (official.consistent === true ? ' · 完全一致' : '')));
  }

  children.push(h('div', { key: 'basis', style: subtle },
    '判据：① 高版本目录探测（服务端对高版本不裁剪，模型自带 minimal_version.cli 就是门槛）；'
    + '② 读官方桌面客户端缓存（离线、密钥由 uid 派生）。两者都零 token 消耗。'));

  return h('div', null, ...children);
}

window.__ModuleLoader__.load({
  id: 'dsh-qoder-connect',
  factory(require) {
    // React 来自宿主的浏览器模块表，不重复安装。
    React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qoder-cn',
          order: 12,
          label: () => 'Qoder CN',
        }, QoderSection));
      },
    };
  },
});
