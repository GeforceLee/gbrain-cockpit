# 架构概览

> 设计文档的公开精简版([English version](architecture.md))。本文描述 0.1 版本**实际交付**的内容,计划中的项见文末路线图。

gbrain-cockpit 是面向自托管 [gbrain](https://github.com/garrytan/gbrain)(`gbrain serve`)的单 owner Web 界面。它不碰 gbrain 内部实现:只消费以下三个窄官方面,再无其他。

## 设计目标

1. **裁决第一公民。** 清理 nightly `dream` 维护周期的产出(信任提案、搁置写入、事实确认、关系提案、LLM 提案观点)是核心场景,不是附属功能。
2. **永不绕过 gbrain 的 owner 在场设计。** 提升信任类动作(接受信任提案、放行搁置写入)只有一种形态:*复制命令,你本人在 brain 主机终端执行*。没有 PTY 喂 token、没有 `--yes`、没有程序化代劳——上游有意用终端逐字输入确认来把关(ENG-15),cockpit 如实遵守。
3. **永不直写 gbrain 数据库。** 一切写入走 MCP:`expected_revision` 乐观锁 + `request_id` 幂等 + 超时轮询收据——绝不重发。
4. **与 gbrain 的 CalVer 迭代解耦。** 适配面刻意收窄(见下),gbrain 升级零冲突。

## 三条通道

每个裁决动作**只走一条**通道,由 gbrain 自身的设计决定。通道矩阵是 `shared/` 里的编译期常量——运行时不可重路由。

```
浏览器(React SPA,令牌只走 Authorization 头)
   │
   ▼
cockpit server(Bun + TypeScript,零运行时 npm 依赖)
   │
   ├─① MCP 通道 ──────► gbrain serve 的 MCP 端点
   │     读取、页面写入(回执协议)、事实确认
   │
   ├─② CLI 通道 ──────► 白名单内的 `gbrain` 子命令,仅 --json
   │     信任队列审阅/驳回、关系提案、takes propose
   │
   └─③ 只读旁路 ──────► pages/links 固定 SELECT(仅图谱用)
         SQL 零用户输入;可选,PGLite 引擎下关闭
```

### 通道矩阵

| 动作 | gbrain 侧门槛 | 通道 | cockpit 形态 |
|---|---|---|---|
| 信任队列列表(`trust review --json`) | 无 | CLI 白名单 | 队列展示 |
| 驳回提案/搁置写入/事实(`trust drop`) | 无 | CLI 白名单 | 一键 |
| 接受信任提案(tp) | owner 终端逐字确认 | **复制命令** | 命令块 |
| 放行搁置写入(h) | owner 终端逐字确认 | **复制命令** | 命令块 |
| 关系提案 accept / reject / undo / date | 无 | CLI 白名单 | 一键 |
| takes propose accept / reject | 无 | CLI 白名单 | 一键 |
| 事实/记忆确认(`confirm_memory`) | `memory_confirm` scope | MCP | 一键 |
| 页面写入(`put_page`) | 无 | MCP 回执协议 | 编辑 + 轮询 |

CLI 通道不可用时(cockpit 不在 brain 主机上),一键 CLI 动作降级为复制命令块——动作仍然可达,但对 owner 在场的要求提高。MCP 类动作(确认、页面写入)在任何能到达 MCP 端点的主机上都能用。

## CLI 执行纪律

- 只用 `execFile` 数组传参——永不拼接 shell 字符串
- 位置参数前加 `--` 分隔符(防 flag 注入)
- 双层校验:子命令白名单 **加** 每个参数的正则(ref / date / id 模式)
- 白名单之外一律 400,进程根本不会拉起
- `--json` 输出严格 `JSON.parse`;人类可读输出永不解析
- 30 秒超时、10MB 输出上限、最多 2 个并发执行

## 页面写回执协议

保存全流程走 gbrain 自身的写协议:

- `expected_revision`——dream 在你编辑期间改了此页,你会看到显式冲突,而不是被静默覆盖
- `request_id`(客户端生成 UUID)——同一 ID 重放取回同一结果;超时的写入通过 `get_write_request` **轮询**收据,绝不重发
- `wait_ms` 15 秒;上游超时后界面保留 request_id 轮询到终态(`committed | conflict | failed | cancelled`)

## 安全基线

- **fail-closed 启动**:缺 `COCKPIT_TOKEN` 或 `GBRAIN_MCP_TOKEN` 拒绝启动;`GBRAIN_BIN` 设了但不可执行也拒绝启动
- **令牌卫生**:令牌只走 `Authorization` 头——query 参数里出现令牌形态的值直接 400;浏览器侧令牌存 localStorage、仅以请求头发送、绝不进 URL;比较为常数时间
- **Host/Origin 防线**:Host 白名单(防 DNS rebinding)+ 非 GET 请求的 Origin/`Sec-Fetch-Site` 校验 + 写请求仅接受 JSON body
- **不可信内容渲染**:brain 内容(导入的页面/邮件/聊天记录)是持久化不可信输入。页面正文是 markdown(gbrain 仓库即 Markdown 的设计,已对上游文档与真实 brain 实证),只经唯一一条管线渲染——`marked → DOMPurify`(`lib/markdown.ts` + `components/PageBody.tsx`;script/图片/表单剥离,外链加固为 `_blank`+`noopener`);对话导入包装(引文标记行 + 裹住正文的 text 围栏)在渲染前解包,严格形状匹配、不匹配按原样渲染;该 `dangerouslySetInnerHTML` 是全站唯一一处,其余一律纯文本,图谱标签用 canvas 绘制
- **SQL 面**:只读旁路只跑三条模块级常量 SELECT(pages/links 两表,专用只读账号);用户输入到不了 SQL
- **错误信封**:浏览器只看得到 `{error: 概要, code}`;子进程 stderr 只进服务端日志
- **审计留痕**:写动作追加到程序目录之外的 `~/.cockpit-audit/YYYY-MM-DD.jsonl`

## 配置

环境变量(带注释的完整版见 [`.env.example`](../.env.example)):

| 键 | 必填 | 用途 |
|---|---|---|
| `COCKPIT_BIND` | 否(默认 `127.0.0.1`) | 监听地址;远程访问请套反代/加密隧道——「内网」不是信任边界 |
| `COCKPIT_PORT` | 否(默认 `8787`) | 端口 |
| `COCKPIT_TOKEN` | **是** | 浏览器访问令牌(fail-closed) |
| `COCKPIT_ALLOWED_HOSTS` | 否 | 反代/隧道场景下额外允许的 Host 值 |
| `COCKPIT_DIST_DIR` | 否 | 静态资源根目录覆盖(编译二进制部署用) |
| `COCKPIT_PROFILES_FILE` | 否 | 多 brain profiles JSON(见[多 brain(多实例)](#多-brain多实例)一章);未设 = 用下方 `GBRAIN_*` 变量单实例运行 |
| `GBRAIN_MCP_URL` | 否(默认 `http://127.0.0.1:3131/mcp`) | gbrain serve 的 MCP 端点 |
| `GBRAIN_MCP_TOKEN` | **是** | `gbrain auth create` 铸造的 token(scope 至少 `read,write,memory_confirm`) |
| `GBRAIN_TAKES_HOLDERS` | 否 | 铸 token 时的全量 holder 列表(启动自检;takes 可见域默认 fail-closed 收窄到 `world`) |
| `GBRAIN_BIN` | 否 | gbrain 可执行路径;留空自动发现 |
| `PG_READONLY_DSN` | 否 | 图谱用的只读 Postgres 账号;PGLite 引擎保持未设 |

## 仓库结构

```
gbrain-cockpit/
├── server/   Bun + TypeScript,零运行时 npm 依赖
│   └── src/  drivers/{mcp,cli,pg-readonly}.ts、routes/、auth、config、static
├── web/      React 18 + Vite + sigma.js(图谱走 canvas)
│   └── src/  panels/{Inbox,Nebula,Pages,Search,Health}、locales/{zh-CN,en}
├── shared/   通道矩阵类型、错误码、版本号——前后端共同编译的单一来源
└── docs/     本文及其同级文档
```

## gbrain 版本耦合

cockpit 基于 gbrain 0.60.x 验证。耦合对策:

1. 只依赖 (a) 文档化的 MCP 工具名与参数、(b) 白名单 CLI 子命令的 `--json` 输出、(c) 两张只读表——不解析人类可读 CLI 输出,不碰内部实现
2. MCP 调用失败或形状变化时可见降级(队列报「暂不可用」、图谱报「通道不可用」),而不是崩溃
3. 只读旁路启动时对照 `information_schema` 检查列期望,漂移则自动禁用自身

## 多 brain(多实例)

brain = 部署:一个 `gbrain serve` + 一个库。thin 客户端无法在一条连接里选
brain(上游远程拒绝 `--brain`),所以 cockpit 的「多 brain」是**切换部署**,
不是合并——每个 profile 是一个脑的三通道(MCP 端点、CLI 命令、可选只读
DSN),每次 `/api/*` 调用经 `x-brain-profile` 头路由(缺省 = 默认 profile;
未知 id 一律 400,绝不静默回落到错误的脑)。

配置是 `COCKPIT_PROFILES_FILE` 指向的 JSON 文件:

```json
[
  {
    "id": "atlas",
    "name": "atlas-brain",
    "mcpUrl": "http://127.0.0.1:3131/mcp",
    "mcpToken": "…",
    "pgReadonlyDsn": "postgresql://cockpit_ro:…@host/gbrain",
    "cliBin": "gbrain",
    "takesHolders": ["world", "analyst"]
  },
  {
    "id": "bip",
    "name": "bip-brain",
    "mcpUrl": "http://127.0.0.1:3132/mcp",
    "mcpCredentials": "/etc/gbrain-cockpit/bip-credentials.json",
    "cliBin": "gbrain-bip"
  }
]
```

- 每 profile 恰一种凭证:`mcpToken`(`gbrain auth create` 的静态 bearer)
  或 `mcpCredentials`(`gbrain mcp grant --credentials-out` 的 OAuth
  client-credentials 交接文件——驱动自行续期 access token,密钥不出进程)。
  该文件属秘密类:`0600`、放仓库外(`brains.json` 已 gitignore)。
- `cliBin` 是裸命令名(经 PATH 解析——隔离 `GBRAIN_HOME` 的包装脑如
  `gbrain-bip` 即官方形态)或绝对路径。它既是 CLI exec 的 argv[0],也是
  owner 复制命令的前缀:包装脑上,上游自带的字面 `gbrain …` 命令文本会
  打到默认脑,所以 cockpit 恒用自己校验过的模板。
- fail-closed:文件不可读/非法、id 重复或畸形、profile 缺凭证——启动即
  致命。某 profile 显式 `cliBin` 解析失败只降级**该 profile** 的 CLI 通道
  为复制命令,其余脑照常服务。
- 未设 `COCKPIT_PROFILES_FILE` 时回落旧单实例 `GBRAIN_*` 变量(包装为单个
  `default` profile)——0.1 配置零改动升级。两者同设时文件优先,启动日志
  点名被忽略的旧变量。
- 顶栏仅在多于一个 profile 时显示切换器。切换即重挂全部面板:一个脑的
  数据、缓存与审计绝不渲染成另一个脑的。`/healthz`(免认证的存活视图)
  恒反映默认 profile。
- **信任边界**:一枚 `COCKPIT_TOKEN` 掌控全部已配置脑(V1 单 token 决策;
  按 profile 的浏览器令牌属后续),`GET /api/profiles` 在该边界内枚举
  id/名称——不含任何秘密。
- 只读 grant 的 profile(无 `write` / `memory_confirm`)会可见地禁用编辑器
  与一键事实确认;宿主侧 CLI 裁决是另一凭证、不受影响——UI 会明说。

## 多 source 联邦

brain 内的 source 是服务器强制的写边界:一张 grant 钉死一个写源加一组
`federated_read`,页面身份 = `(source_id, slug)`——slug 仅源内唯一,不带源
的 `get_page` 会**静默**选行(0.60.558 实证)。cockpit 的规则:

- 读面全带源:列表行、搜索命中、图谱节点与 take 显示所属源;Pages/Search
  的源过滤把 `source_id` 作为纯**收窄**参数传给 gbrain——grant 仍是执法点,
  越权选择的 `permission_denied` 按上游错误转达,绝不是 cockpit 自己的判
  决。过滤选项表(`sources_list`)按 grant 域给出且无「被扣留」标记,其
  提示文案如实说明。
- 消歧是 cockpit 的责任:裸 slug 打开时,存在同名页即显示「另有同名页于
  其他来源」并可点击跳转;一切已知来源的打开路径(行、命中、图谱节点)
  都带上源。
- 图谱只读 SELECT 在列存在时纳入 `pages.source_id`(在场检查;旧库降级为
  slug 键)。节点身份变为 `source_id/slug`,同名双页渲染为两个节点,跨源
  关系——上游的排序加权信号——使用专属虚线样式。指纹中的 `s` schema 标记
  令升级时冻结布局恰好失效一次。
- 写侧从不直指源(`put_page` 无 source 参数——grant 的写源决定);编辑器
  显示所属源并在 slug 多源同名时警示。版本历史跟随上游的裸 slug 解析,
  故同名页以注释代替。

## 路线图(0.1 未含)

- 只读旁路不可用时的 MCP 组合回落路径
- `/metrics` Prometheus 端点;dream 运行窗口的降级横幅
- Docker 镜像渠道(容器内裁决按设计降级为复制命令)
- 多令牌支持(命名令牌、独立吊销、只读分享)
