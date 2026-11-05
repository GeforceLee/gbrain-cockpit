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
- **不可信内容渲染**:brain 内容(导入的页面/邮件/聊天记录)是持久化不可信输入。页面正文是 markdown(gbrain 仓库即 Markdown 的设计,已对上游文档与真实 brain 实证),只经唯一一条管线渲染——`marked → DOMPurify`(`lib/markdown.ts` + `components/PageBody.tsx`;script/图片/表单剥离,外链加固为 `_blank`+`noopener`);该 `dangerouslySetInnerHTML` 是全站唯一一处,其余一律纯文本,图谱标签用 canvas 绘制
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

## 路线图(0.1 未含)

- 只读旁路不可用时的 MCP 组合回落路径
- `/metrics` Prometheus 端点;dream 运行窗口的降级横幅
- Docker 镜像渠道(容器内裁决按设计降级为复制命令)
- 多令牌支持(命名令牌、独立吊销、只读分享)
