    const IMPORT_TAB_TYPE = "chat-import";
    // 官方原生右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right，DSH ≥ 0.1.5-rc.1，
    // peerDependencies 已抬升门槛）的打开面：footer 按钮点击时经
    // ctx.get('sidebarRight').openTab(kind) 打开「导入会话」tab（同一时刻展开右栏、
    // 对话区保留——接入侧栏接口而非覆盖主区）。闭包在 apply 里建立、点击时重证服务
    //（无挂载会话 / HMR 换服务等返回 false，对齐 dsh-context 的 openContextSidebar
    // 每次调用时重证的做法）。
    let openNativeImportTab = null;
    // 侧边栏入口按钮开关（设置项 sidebarButton）：默认 true。
    // 经 localStorage 同步缓存避免初次渲染出现闪烁；通过事件监听在设置页修改时即刻生效。
    const SIDEBAR_PREF_KEY = "dsh-chat-import:sidebar-button";
    function getStoredSidebarButton() {
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          const val = window.localStorage.getItem(SIDEBAR_PREF_KEY);
          if (val === "false") return false;
        }
      } catch (_) {}
      return true;
    }
    let cachedSidebarButton = getStoredSidebarButton();
    const sidebarButtonListeners = new Set();
    function setSidebarButton(enabled) {
      cachedSidebarButton = enabled !== false;
      try {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(SIDEBAR_PREF_KEY, String(cachedSidebarButton));
        }
      } catch (_) {}
      for (const listener of sidebarButtonListeners) {
        try { listener(cachedSidebarButton); } catch (_) {}
      }
    }
    // 组件侧翻译 hook：订阅 locale/change 触发重渲染；无服务时查 zh 字典兜底。
    function useTranslate() {
      const [, force] = useState(0);
      useEffect(() => {
        if (!localeSvc) return undefined;
        return localeSvc.subscribe(() => force((x) => x + 1));
      }, []);
      return (key, params) => {
        if (!localeSvc) return fill(DICT.zh[key] || key, params);
        return localeSvc.bind(LOCALE_NS)(key, params);
      };
    }
