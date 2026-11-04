// zh-CN locale pack (flat dotted keys). Keys must stay in lockstep with en.ts
// — `bun run check:locales` fails CI on drift, and missing keys are also a
// compile error via the Record type in lib/i18n.tsx.
export const zhCN = {
  "app.title": "gbrain-cockpit",
  "app.tagline": "dream 整夜提案,你早晨一键裁决。",
  "app.skeleton":
    "开发版 0.0.1:Inbox/Pages/Search/Health 已通真数据;星云图待后续里程碑;界面风格未定(三个方向评审中)。",

  "lang.label": "语言",
  "lang.zh": "中文",
  "lang.en": "English",

  "panel.inbox.title": "收件箱 Inbox",
  "panel.inbox.desc":
    "dream 与日常使用产生的所有待裁决项,汇成四条队列集中处理。",
  "panel.nebula.title": "星云图 Nebula",
  "panel.nebula.desc": "整个 brain 的页面与关系网,一张图漫游。",
  "panel.pages.title": "页面 Pages",
  "panel.pages.desc": "浏览、筛选、查看历史、在线编辑。",
  "panel.search.title": "搜索 Search",
  "panel.search.desc": "字面与语义双入口,结果带出处。",
  "panel.health.title": "健康 Health",
  "panel.health.desc": "gbrain 服务状态、各通道连通与延迟、dream 运行态。",
  "panel.placeholder":
    "占位面板——星云图随后续里程碑交付(只读旁路 + sigma.js);界面文案即功能说明。",

  "pages.filterByType": "按类型筛选",
  "pages.allTypes": "全部",
  "pages.empty": "没有符合条件的页面。",
  "pages.back": "返回列表",
  "pages.edit": "编辑",
  "pages.save": "保存",
  "pages.cancel": "取消",
  "pages.saving": "提交中…(写回执协议:乐观锁 + 幂等 ID)",
  "pages.editHint":
    "保存走 gbrain 写协议:若 dream 在你编辑期间改了此页,保存会报告冲突而不是覆盖;超时不重发,自动轮询收据。",
  "pages.type": "类型",
  "pages.updated": "更新时间",
  "pages.trust": "信任层级",
  "pages.revision": "revision",
  "pages.versions": "历史版本",

  "receipt.queued": "已入队,等待 gbrain 执行…",
  "receipt.running": "gbrain 正在执行写入…",
  "receipt.pending": "等待收据中(不重发请求,按 request_id 轮询)…",
  "receipt.committed": "已提交 ✓",
  "receipt.conflict": "冲突:dream 或他人已先改此页。重载后基于新版本再改。",
  "receipt.failed": "写入失败。",
  "receipt.cancelled": "写入已取消。",
  "receipt.unknown": "未知回执状态(见详情)。",
  "receipt.reloadAfterConflict": "重载最新版本",

  "search.placeholder": "搜索 brain…(字面混合,前 20 条)",
  "search.run": "搜索",
  "search.empty": "没有命中。换更短的关键词或换英文试试。",
  "search.score": "相关度",

  "inbox.cliOk": "CLI 通道可用:裁决动作一键执行",
  "inbox.cliDegraded": "CLI 通道不可用(本机非 brain 主机):一键动作降级为复制命令",
  "inbox.empty": "队列为空 ✓",
  "inbox.queueUnavailable": "队列暂不可用",
  "inbox.drop": "驳回",
  "inbox.factConfirm": "确认入库",
  "inbox.factDiscard": "丢弃",
  "inbox.edgeAccept": "接受",
  "inbox.edgeReject": "驳回",
  "inbox.queue.proposals": "信任提案",
  "inbox.queue.proposalsDesc":
    "dream 或代理想写入、被信任规则拦下等你裁决的提案。接受需你本人在 brain 主机终端确认(gbrain 安全设计),永不在此代劳。",
  "inbox.queue.held": "搁置写入",
  "inbox.queue.heldDesc":
    "被扣留的写入,放行同样需要 owner 终端确认;驳回可一键。",
  "inbox.queue.facts": "待确认事实",
  "inbox.queue.factsDesc": "dream 从页面抽取的新事实候选:确认入库或丢弃。",
  "inbox.queue.edges": "关系提案",
  "inbox.queue.edgesDesc": "dream 发现的页面间关系修正:接受或驳回。",
  "inbox.queue.takes": "观点待判定",
  "inbox.queue.takesDesc": "dream 的 LLM 提案观点(propose_takes 队列):接受即写入该页的 takes,驳回即丢弃;点击页面 slug 可回看源文依据。",
  "inbox.queue.others": "其他待办",
  "inbox.queue.othersDesc": "信任规则/allow 条目等,用 explain 查看详情。",

  "cmd.badge": "gbrain 安全设计 · owner 终端动作",
  "cmd.copy": "复制",
  "cmd.copied": "已复制 ✓",
  "cmd.steps": "复制 → 在 brain 主机终端粘贴回车 → 回到这里刷新",

  "health.token.label": "访问令牌",
  "health.token.hint":
    "即服务端环境变量 COCKPIT_TOKEN;只保存在本浏览器(localStorage),仅以请求头发送,绝不进网址。",
  "health.token.placeholder": "粘贴 COCKPIT_TOKEN",
  "health.connect": "连接",
  "health.changeToken": "更换令牌",
  "health.refresh": "刷新",
  "health.loading": "探测中…",
  "health.retry": "重试",
  "health.error": "请求失败",

  "health.overall": "总览",
  "health.check.mcp": "MCP 通道",
  "health.check.brain": "brain 概要",
  "health.check.cli": "CLI 通道",

  "health.status.ok": "正常",
  "health.status.degraded": "降级",
  "health.status.down": "不可用",

  "health.mcp.transport": "传输",
  "health.mcp.client": "客户端",
  "health.mcp.scopes": "scopes",
  "health.mcp.latency": "延迟",

  "health.cli.bin": "二进制",
  "health.cli.unverified":
    "已找到 gbrain 二进制,但通道尚未冒烟验证(warm/cold 冒烟随 V1.0 的 CLI driver 交付);本机若非 brain 主机,裁决类动作将降级为复制命令。",
  "health.cli.missing":
    "未找到 gbrain 二进制:裁决类 CLI 动作不可用,自动降级为复制命令形态。",

  "health.brain.name": "名称",
  "health.brain.engine": "引擎",
  "health.brain.version": "gbrain 版本",
  "health.brain.counts": "计数",

  "common.loading": "加载中…",
  "common.close": "关闭",
  "common.retry": "重试",
  "common.panelError": "面板渲染出错",
} satisfies Record<string, string>;
