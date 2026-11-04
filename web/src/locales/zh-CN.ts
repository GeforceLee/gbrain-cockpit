// zh-CN locale pack (flat dotted keys). Keys must stay in lockstep with en.ts
// — `bun run check:locales` fails CI on drift, and missing keys are also a
// compile error via the Record type in lib/i18n.tsx.
export const zhCN = {
  "app.title": "gbrain-cockpit",
  "app.tagline": "dream 整夜提案,你早晨一键裁决。",
  "app.skeleton":
    "M0 骨架:面板为占位,五面板最小可用随 V1.0 交付;界面风格未定(三个方向评审中)。",

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
    "占位面板——功能随 V1.0 交付;界面文案即功能说明,正式版此处为队列/视图本体。",

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

  "common.close": "关闭",
} satisfies Record<string, string>;
