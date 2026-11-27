# 架构概览

> 设计文档的公开精简版([English version](architecture.md))。本文描述 0.1 版本**实际交付**的内容,计划中的项见文末路线图。

gbrain-cockpit 是面向自托管 [gbrain](https://github.com/garrytan/gbrain)(`gbrain serve`)的 Web 界面,为一位管理员和他的团队而建:管理员用两个环境变量令牌登录,每位同事用发给自己的访问令牌登录(见[认证与授权](#认证与授权))。它不碰 gbrain 内部实现:只消费以下三个窄官方面,再无其他。

## 设计目标

1. **裁决第一公民。** 清理 nightly `dream` 维护周期的产出(信任提案、搁置写入、事实确认、关系提案、LLM 提案观点)是核心场景,不是附属功能。
2. **永不绕过 gbrain 的 owner 在场设计。** 提升信任类动作(接受信任提案、放行搁置写入)只有一种形态:*复制命令,你本人在 brain 主机终端执行*。没有 PTY 喂 token、没有 `--yes`、没有程序化代劳——上游有意用终端逐字输入确认来把关(ENG-15),cockpit 如实遵守。
3. **永不直写 gbrain 数据库。** 一切写入走 MCP:`expected_revision` 乐观锁 + `request_id` 幂等 + 超时轮询收据——绝不重发。
4. **与 gbrain 的 CalVer 迭代解耦。** 适配面刻意收窄(见下),gbrain 升级零冲突。
5. **每个人只拿到自己令牌上写明的东西。** 两个环境变量令牌属于管理员;每位同事持有一把带名字的访问令牌,带一张权限单。每个 `/api` 接口在一张路由表里写明归类,任何处理函数运行之前都先过同一道闸——访问令牌默认被拒。

## 三条通道

每个裁决动作**只走一条**通道,由 gbrain 自身的设计决定。通道矩阵是 `shared/` 里的编译期常量——运行时不可重路由。

```
浏览器(React SPA,令牌只走 Authorization 头)
   │
   ▼
cockpit server(Bun + TypeScript,零运行时 npm 依赖)
   │
   ├─① MCP 通道 ──────► gbrain serve 的 MCP 端点
   │     读取、页面写入(回执协议)、事实确认、
   │     出处读取(关系/时间线/来源诊断)、写收据列表、搜索证据组装、
   │     问一句面(0.6):免费证据腿(query,付费参数 expand 永不发送)
   │       + 付费深答腿(think,save/take 永不发送;服务端以盖章式两步
   │         confirm 旗标 + 每脑单飞 + 每调用审计设门)
   │       + 免费查缺页诊断(query 的 explain_target)
   │
   ├─② CLI 通道 ──────► 白名单内的 `gbrain` 子命令,仅 --json
   │     信任队列审阅/驳回、关系提案、takes 裁决
   │
   └─③ 只读旁路 ──────► pages/links 固定 SELECT(图谱)
         + take_proposals(Inbox takes 队列,天然跨源;
         CLI 的 takes 列表每次运行只看一个源)
         + sources.config 周期戳两键(0.5.0 夜间周期卡——「每晚跑没跑」的
           唯一全源正源,owner 批准)
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
| takes 待判定队列(`take_proposals`) | 专用只读账号 | 只读旁路 | 队列展示 |
| 每源周期戳(`sources.config` 两键) | 专用只读账号 | 只读旁路 | 夜间周期卡(0.5.0) |
| takes propose accept / reject | 无 | CLI 白名单(多源 brain 上按行带 `GBRAIN_SOURCE` env) | 一键 |
| 事实/记忆确认(`confirm_memory`) | `memory_confirm` scope | MCP | 一键 |
| 页面写入(`put_page`) | 无 | MCP 回执协议 | 编辑 + 轮询 |
| 免费证据桌(`query`) | 无 | MCP | 问一句面板(0.6) |
| 深答(`think`) | 付费模型调用 | MCP + 付费动作护栏(盖章式 confirm 旗标、单飞、审计) | 问一句面板(0.6) |
| 查为什么缺某页(`query` explain_target) | 无 | MCP | 问一句桌脚(0.6) |

多源 brain 上,裁决动词以提案行自己的 `GBRAIN_SOURCE` 与 profile 的 `GBRAIN_HOME` 直调真实 gbrain 二进制(经 `gbrainBin`/`gbrainHome` 显式开启;驱动每次执行前复断言 brain 配置的库名——与隔离 wrapper 同一道防线)。CLI 通道不可用时,一键 CLI 动作降级为复制命令块——动作仍然可达,但对 owner 在场的要求提高。不可用分两种成因,界面对应区分:未找到 gbrain 二进制(本机可能非 brain 主机)与二进制已就位但探测(`trust review`)未通过(降级,详见健康面板)。MCP 类动作(确认、页面写入)在任何能到达 MCP 端点的主机上都能用。

## 认证与授权

两种登录凭据进的是同一套接口,服务端凭令牌本身区分它们:

| 凭据 | 谁持有 | 能做什么 |
|---|---|---|
| `COCKPIT_TOKEN`——环境变量令牌 | 管理员 | 看、裁决、读运维信息、付费深度问答,对所有已配置的脑实例都有效 |
| `COCKPIT_ADMIN_TOKEN`——环境变量令牌 | 管理员 | 上面全部,再加管理类写操作:来源补授权、付费模型探测、签发 / 改权限 / 作废访问令牌 |
| 访问令牌——来自登记表 | 每位同事各一把 | 看,再加权限单上给了的——而且只在权限单列出的脑实例上 |

环境变量令牌不受任何权限单约束:以前能做的都还在,只有管理类写操作仍然要管理令牌。访问令牌默认被拒。

### 权限单

「看」不用存——每把访问令牌都有。权限单存的是其余几项:

| 项 | 含义 | 是否开放 |
|---|---|---|
| `brains` | 能进哪些脑实例(profiles 文件里的 id);至少一个,排第一的是它的默认脑实例 | 是 |
| `adjudicate` | 能不能处理收件箱:驳回、接受 / 驳回观点提案和关系提案、判定、静音 / 稍后再看 | 是 |
| `editSources` | 能保存哪些来源的页面 | **尚未**——字段已在登记表格式里,但必须为空;非空时服务端回 400,签发表单里也不显示它 |

有两条限制是有意为之,界面上也写明了。**看不分来源**:访问令牌能读到这个部署的 gbrain 凭证能读到的全部来源。**裁决也不分来源**:接受一条提案,就是把它写进它所在的那一页,不管那一页在哪个来源。

### 一张路由表与一道闸

每个 `/api/*` 接口都是 `server/src/router.ts` 里的一行:方法、路径、权限归类、处理函数。分发只认这张表里的行,不过闸就到不了任何处理函数。

| 归类 | 接口 | 访问令牌 |
|---|---|---|
| 看 | `/api/me`、`/api/profiles`、`/api/graph`、`/api/pages`、`/api/pages/facets`、`/api/page`、`/api/search`、`/api/sources`、`/api/resolve-slugs`、`/api/ask`、`/api/inbox`、`/api/audit-history`、`POST /api/evidence`、`POST /api/ask/missing` | 可以——但有裁剪(见下) |
| 裁决 | `POST /api/inbox/trust/drop`、`/api/inbox/edge`、`/api/inbox/contradictions`、`/api/inbox/takes/propose`、`/api/inbox/takes/resolve`、`/api/inbox/relief` | 要有这项权限 |
| 编辑 | `PUT /api/page`、`GET /api/write-request` | **尚未**——现在一律 403 |
| 仅管理员的环境变量令牌可用 | `/api/ops/*`(10 条)、`POST /api/ask/think`、`POST /api/inbox/confirm`、`POST /api/write-cancel`、`GET /api/write-requests`、`GET /api/write-conflicts`、`GET /api/healthz`、`/api/brain-health`、`/api/sources/status`、`/api/anomalies`,以及 `/api/tokens*` 四条 | 永远不行 |

- **类型是第一道锁。** `perm` 必填;它的取值是一个封闭联合类型,鉴权函数对它做穷举 switch;非 GET 的行只有在路径属于「带请求体的读取」那两项名单时才能归「看」。接口不写归类、归类没有判定、或把写接口归成读,都编译不过。
- **闸是第二道。** 顺序固定:验令牌(401)→ 能不能进这个脑实例(403)→ 这类操作有没有权限(403,并写明缺的是哪一项)→ 才进处理函数。处理函数从不重复检查。归类判断先于请求体校验,所以权限不够的调用方发来格式不对的请求体,回的是 403,不是 400。原来写在两个处理函数里的档位检查(补授权、模型探测)保留,当第三道锁。
- **默认是不给。** 对访问令牌,鉴权函数只认三种答案——看(给)、裁决(权限单说了才给)、编辑(权限单里有这个来源才给)——其余一律不给,包括以后新加的归类。
- **403 写明缺什么。** `missing` 取 `adjudicate`、`edit`(附带 `source`)、`brain`、`owner-only`(「仅管理员可用」这一类在接口里的名字)或 `admin-tier`(管理员的普通令牌碰了管理类写操作,前端据此给出粘贴管理令牌的提示)之一,前端把它翻成大白话。不在权限单上的脑实例和根本不存在的脑实例,返回内容完全一样,所以令牌问不出有哪些脑实例。已作废的令牌和从来不对的令牌,回的是同一个 401。不存在的路由只对有效令牌回 404——没有令牌的调用方问不出路由表。
- **访问令牌连看都不给看的。** 收件箱数据不带命令文本、不带命令行的名字、不带上游报错原文(里面可能出现主机路径);页面详情不带 `source_path`;`GET /api/profiles` 只列权限单上的脑实例,不带命令行的名字,管理页签开关为关;`GET /api/audit-history` 只回「已决提案」那部分——审计原文(里面有管理员的付费提问)仅管理员可用。没有裁决权的令牌调 `GET /api/inbox` 只拿到关系提案那一项,图谱要靠它画新关系。具名令牌拿到的每一条只读回答,还会去掉带命令的字段;通道不通的原因里,绝对路径和地址换成 `<path>` / `<address>`;知识库出错时状态码和错误码不变,文字换成大白话。
- `/healthz`——不带令牌的存活视图,只有状态——在表外,没有变化。

### 令牌登记表

`COCKPIT_TOKENS_FILE` 指向一个本机 JSON 文件,`{"version": 1, "tokens": [...]}`——签发过的每一把令牌一行:id、名字、SHA-256 摘要、权限单,以及签发 / 作废 / 上次使用的时间。已作废的行留着不删:id 永不复用,旧的审计记录也还能对上人。

- **不设就关。** 不设这个变量就没有访问令牌——只认两个环境变量令牌,和 0.6 的行为完全一致。设了,它必须是发布目录之外的绝对路径。
- **读不懂就不启动。** 文件必须存在、是普通文件(不能是软链)、属主是服务账号或 root、别人不可写;往下每一级目录同样不能让同组或其他人写(`/tmp` 这类带 sticky 位的目录可以),且必须属于服务账号或 root。编辑权限还没开放,所以权限单里出现非空的编辑清单,启动时也会被拒——手改文件打不开编辑这道闸。任何一条不满足都拒绝启动——文件不存在也一样:这段代码读不懂的登记表,绝不会被当成「空的」。解析同样严格:`version` 必须是 1,出现不认识的字段即致命,报错信息绝不回显文件内容。别人只是能*读*的文件可以启动,但会告警(文件里只有摘要;`chmod 600` 仍然是该用的权限)。
- **一个登记表只许一个服务。** 登记表旁边有一个锁文件(`<登记表路径>.lock`,记着持有者的 pid 和一个随机串),它会拒绝第二个实例——否则第二个实例下一次写盘就会把别人作废的令牌写回来。进程崩溃留下的锁会被接管:先取得一个独占的守卫文件,在里面重新判定,再接管;刚建好还没写完内容的锁算「正在写」,要等几秒才允许判为过期——所以两个服务同一瞬间启动,不会都拿到锁。
- **先写审计再改文件。** 一次改动先把所有校验做完,算出「改完以后的样子」,写下它的审计记录(严格写入——写不成就不改),原子落盘(临时文件 + fsync + 改名),最后才换掉内存里的状态。不设回滚:磁盘满的时候回滚那一次写也会失败。服务运行中有人手改了文件,每次落盘前都会发现,并拒绝覆盖而不是写回去——要手改,先停服。
- **令牌只存摘要。** 令牌是 `ck_` 加 43 个随机字符(256 位)。登记表文件里只有它的 SHA-256,列表接口里连摘要都没有,明文只在一次响应体里出现——签发那一次,并标了 `Cache-Control: no-store`。
- **立即生效,不能恢复。** 改权限和作废对下一个请求生效,不用重启。作废不能撤销;需要就重新签一把。
- **名字。** 1–40 个字符,汉字、英文字母、数字、空格和 `- _ . · ( )`,至少有一个字母或汉字。先做兼容归一(全角、花体这类长得一样的写法折回普通字母);读起来像 `owner` / `admin` / `root` 的名字、或和另一张有效令牌撞名的(`Owner`、`0wner`、`adm1n`、`owner_2`……)一律拒收,审计记录没法被名字冒充。
- **上限。** 500 把有效令牌——超过就拒绝签发。文件软上限 1 MB,在签发时检查(作废永远放行);作废满 180 天的记录在每次写入时清理,文件不会无限增长。只有超过 4 MB 的文件(cockpit 自己的写入不可能产生)才会在启动时被拒绝。
- **登记表坏了怎么救。** 先临时去掉这个变量——cockpit 就只用环境变量令牌启动——把文件换成初始内容(`{"version":1,"tokens":[]}`),再把变量加回去、重启。审计里的 `token.issue` / `token.grants` / `token.revoke` 三种记录写着谁有过什么权限,可以照着重新签发。

### 管理接口

| 接口 | 令牌 | 做什么 |
|---|---|---|
| `GET /api/me` | 任意 | 我是谁——名字、种类、能进的脑实例、权限单;界面上所有「显示不显示」都从这一个答案来 |
| `GET /api/tokens` | 两个环境变量令牌之一 | 列表:名字、权限单、时间——没有摘要,没有明文 |
| `POST /api/tokens` | 管理令牌 | 签发(`{name, brains, adjudicate}`);回 201,带一次明文 |
| `PUT /api/tokens/grants` | 管理令牌 | 整张替换权限单(`{id, brains, adjudicate}`——传全,不做零碎修补) |
| `POST /api/tokens/revoke` | 管理令牌 | 作废(`{id}`);重复作废也算成功,不能恢复;id 不存在回 404 |

请求体格式是严格的——出现不认识的字段就是 400。网页里,这三个写操作都在**管理 → 访问令牌**;每个动作要粘贴一次管理令牌,它只随那一次请求发送,无论成功失败都会清空。

### 请求去哪个脑实例

- **环境变量令牌**——和以前一样:不带 `x-brain-profile` 请求头就是默认 profile,未知的 id 回 400,绝不静默回落到错误的脑实例。
- **访问令牌**——浏览器每次请求都明说去哪个脑实例,默认的那个也明说:权限单运行中可能被改,不说的话,人停在 A 脑、请求会被送去 B 脑。命令行不带请求头时去权限单上的第一个脑实例。不在权限单上的脑实例、或者已经从 profiles 文件里拿掉的脑实例,回 403——绝不回落到别的脑实例。
- **权限单在会话打开期间被改了**——不做实时推送。页面回到前台时和每 5 分钟,界面重问一次「我是谁」,答案变了就提示刷新。当前所在的脑实例被收走时,界面自动切到还能进的第一个,并给一行提示。令牌被作废时,下一个请求就会结束会话。「我是谁」这次请求若因为别的原因失败,界面不猜:挂一条「没能确认你是谁」的提示,只显示基础功能(浏览、搜索、图谱、免费找证据),刷新后恢复。

### 审计记的是谁

用访问令牌做的写操作,审计里 `actor` 记它在权限单上的名字,另加 `actor_kind: "token"` 和它的 `actor_id`(读审计的程序按 id 取人;名字是给人看的)。环境变量令牌沿用原来的字符串——`owner` 和 `owner (admin)`——新记录带 `actor_kind: "env"`。gbrain 那边只看得到 cockpit 的客户端凭证,所以真名只存在 cockpit 自己的审计里。

收件箱的静音和稍后再看也是按人各存各的:两个环境变量令牌在每个脑实例上共用一份(用的还是它们一直用的那个键,老状态原样保留),每把访问令牌有自己的那份,按「脑实例 + 令牌 id」存。

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
- 单次保存的收据槽之外,Pages 面板还透出 gbrain 自己的记录:`list_write_requests`(本令牌的收据,新→旧)与 `list_write_conflicts`(反复 `source_changed` 的页面)——展开才拉取,旧版 gbrain 上带内降级
- 谁能保存:目前只有管理员的环境变量令牌。`PUT /api/page` 对访问令牌一律回 403,直到按来源编辑开放(见[路线图](#路线图01-未含));收据列表和作废写入也只属于管理员,因为 gbrain 的收据是按客户端凭证记的,不是按人

## 维度与出处读取

V1.1 的读取集(对照 0.60.558 实测钉形)走同一 MCP driver,按工具分别带 TTL 缓存:

- `list_pages` 接受 `slug_prefix` 与 `tag` 收窄(上游 list 行不带标签——标签筛选是自由输入框,不是 chips)
- `GET /api/page?full=1` 在页面束上附加 `get_links` / `get_backlinks` / `get_timeline`;失败或上游不支持的区块落进 `degraded` 列表、界面自描述——默认(速览)束保持两次上游调用,守住 30 次/分的自律预算
- 0.5.0 夜间可观测:四张 doctor 检查集(`--only` 逗号清单——15 个检查 id 一张编译期表,每集一条整串白名单条目)喂周期/校准/资产卡;不适用的检查显式答 `not_applicable` 行,渲染「不适用」,绝不冒充健康;`sources writer status` 喂部署体检卡的检出拓扑(只建模最小切片)
- `sources_status`(参数是 `id`,一次一源)对 grant 范围内的源列表扇出,供 Health 卡片;图谱图例的关系出处计数在客户端对旁路载荷的 `link_source` 聚合——零新增上游调用
- `assemble_evidence` 按命中三元组(单次 ≤3)返回证据窗口,支撑搜索面板的证据展开
- 所有新报告在旧版 gbrain 上一律带内降级(`status: degraded|down`);web 对缺席区块或 404 端点按「不可用」处理,绝不报错

## 安全基线

- **fail-closed 启动**:缺 `COCKPIT_TOKEN` 或 `GBRAIN_MCP_TOKEN` 拒绝启动;`GBRAIN_BIN` 设了但不可执行也拒绝启动;`COCKPIT_TOKENS_FILE` 不存在、格式不对或别人可写,`COCKPIT_ALLOWED_ORIGINS` 里有写错的条目,审计目录不可写——同样拒绝启动
- **令牌卫生**:令牌只走 `Authorization` 头——query 参数里出现令牌形态的值直接 400;浏览器侧令牌存 localStorage、仅以请求头发送、绝不进 URL;环境变量令牌用常数时间比较,访问令牌按 SHA-256 摘要查表(没有计时侧信道)。登录时先问服务端令牌是否有效,*然后*才保存;登录框是带视觉遮罩的普通文本框,不是密码框——浏览器会保存并自动填入密码框,共用电脑上最不想要的就是这个;**退出**整页重载,清掉整个会话
- **访问令牌落盘只有摘要**:登记表里只有 SHA-256 摘要,权限 0600,放在发布目录之外;明文只在一次响应里出现;作废立即生效,不能恢复([令牌登记表](#令牌登记表))
- **每个请求一道闸**:每个 `/api` 接口在路由表里写明权限归类,「验令牌 → 认脑实例 → 认归类」走完之前任何处理函数都不会运行;访问令牌默认被拒([一张路由表与一道闸](#一张路由表与一道闸))
- **Host/Origin 防线**:Host 白名单(防 DNS rebinding),加上非 GET 请求的 Origin 检查——`Origin` 必须等于 `Host`,或者在 `COCKPIT_ALLOWED_ORIGINS` 名单里——以及写请求仅接受 JSON body;从不读取 `X-Forwarded-*` 请求头
- **响应头**:网页的页面、静态资源和每个 `/api/*` 响应都带 `Content-Security-Policy: frame-ancestors 'self'`(别的网站不能把 cockpit 嵌进 iframe、在不可逆的操作上叠一层按钮诱点;同域名页面仍可嵌)和 `X-Content-Type-Options: nosniff`;`/api/*` 响应另带 `Cache-Control: no-store`——它们是按人返回的,而且其中一次响应里带着明文令牌
- **请求体上限**:读取时按 8 MB 截断——声明的大小或实际大小超了都回 413——留得下 1 MB 的页面内容加上 JSON 转义
- **不可信内容渲染**:brain 内容(导入的页面/邮件/聊天记录)是持久化不可信输入。页面正文是 markdown(gbrain 仓库即 Markdown 的设计,已对上游文档与真实 brain 实证),只经唯一一条管线渲染——`marked → DOMPurify`(`lib/markdown.ts` + `components/PageBody.tsx`;script/图片/表单剥离,外链加固为 `_blank`+`noopener`);对话导入包装(引文标记行 + 裹住正文的 text 围栏)在渲染前解包,严格形状匹配、不匹配按原样渲染;该 `dangerouslySetInnerHTML` 是全站唯一一处,其余一律纯文本,图谱标签用 canvas 绘制
- **SQL 面**:只读旁路只跑模块级常量 SELECT(pages/links 供图谱、take_proposals 供 Inbox takes 队列、sources 两键周期戳供夜间周期卡(0.5.0),专用只读账号);用户输入到不了 SQL
- **错误信封**:浏览器只看得到 `{error: 概要, code}`;子进程 stderr 只进服务端日志。运行时的调试错误页已关掉,整个请求路径套了一层统一兜底,意外出错只回 JSON 错误信封——绝不回堆栈、内部报错或工作目录
- **审计留痕**:写动作追加到程序目录之外的 `~/.cockpit-audit/YYYY-MM-DD.jsonl`,记的是调用者的真名([审计记的是谁](#审计记的是谁));目录 0700、文件 0600,因为审计里列着每个人的名字和权限。写不进审计的 cockpit 在启动时就说出来;令牌管理动作先写审计——没有这一行,就没有这次改动

## 配置

环境变量(带注释的完整版见 [`.env.example`](../.env.example)):

| 键 | 必填 | 用途 |
|---|---|---|
| `COCKPIT_BIND` | 否(默认 `127.0.0.1`) | 监听地址;远程访问请套反代/加密隧道——「内网」不是信任边界 |
| `COCKPIT_PORT` | 否(默认 `8787`) | 端口 |
| `COCKPIT_TOKEN` | **是** | 管理员的登录令牌(fail-closed):看、裁决、读运维信息、付费深度问答 |
| `COCKPIT_ADMIN_TOKEN` | 否 | 管理员的第二把令牌(0.4.0):再加上管理类写动作——来源补授权、付费模型探测,以及(0.7)签发 / 改权限 / 作废访问令牌;未设则该类动作 403、界面降级为复制命令。必须与 `COCKPIT_TOKEN` 不同;浏览器按动作 step-up 粘贴,绝不持久化 |
| `COCKPIT_TOKENS_FILE` | 否 | (0.7)访问令牌登记表的绝对路径,放在发布目录之外。不设 = 访问令牌功能关闭,只有两个环境变量令牌能登录。启动时 fail-closed——见[令牌登记表](#令牌登记表) |
| `COCKPIT_ALLOWED_HOSTS` | 否 | 额外允许的 Host 值(逗号分隔)——代理或隧道原样透传浏览器 Host 时用。不带端口的条目,原样和补上 `COCKPIT_PORT` 两种写法都认 |
| `COCKPIT_ALLOWED_ORIGINS` | 否 | 写请求额外放行的站点地址(逗号分隔)——代理改写 Host 时用。每一项必须是一个规范的完整站点地址(`https://cockpit.example.com`:https、主机小写、不带路径、不带尾斜杠、不带默认端口);写错拒绝启动。不设 = Origin 检查不变 |
| `COCKPIT_DIST_DIR` | 否 | 静态资源根目录覆盖(编译二进制部署用) |
| `COCKPIT_PROFILES_FILE` | 否 | 多 brain profiles JSON(见[多 brain(多实例)](#多-brain多实例)一章);未设 = 用下方 `GBRAIN_*` 变量单实例运行 |
| `GBRAIN_MCP_URL` | 否(默认 `http://127.0.0.1:3131/mcp`) | gbrain serve 的 MCP 端点 |
| `GBRAIN_MCP_TOKEN` | **是** | `gbrain auth create` 铸造的 token(scope 至少 `read,write,memory_confirm`) |
| `GBRAIN_TAKES_HOLDERS` | 否 | 铸 token 时的全量 holder 列表(启动自检;takes 可见域默认 fail-closed 收窄到 `world`) |
| `GBRAIN_BIN` | 否 | gbrain 可执行路径;留空自动发现 |
| `PG_READONLY_DSN` | 否 | 图谱与 takes 队列用的只读 Postgres 账号;PGLite 引擎保持未设(takes 队列届时报不可用) |

## 仓库结构

```
gbrain-cockpit/
├── server/   Bun + TypeScript,零运行时 npm 依赖
│   └── src/  drivers/{mcp,cli,pg-readonly}.ts、routes/、router.ts(路由表 + 一道闸)、authz.ts(谁在调用、权限单)、tokens.ts(登记表)、auth、config、static
├── web/      React 18 + Vite + sigma.js(图谱走 canvas)
│   └── src/  panels/{Inbox,Nebula,Pages,Search,Health,Admin}、locales/{zh-CN,en}
├── shared/   通道矩阵类型、错误码、版本号——前后端共同编译的单一来源
└── docs/     本文及其同级文档
```

## gbrain 版本耦合

cockpit 基于 gbrain 0.60.x 验证。耦合对策:

1. 只依赖 (a) 文档化的 MCP 工具名与参数、(b) 白名单 CLI 子命令的 `--json` 输出、(c) 上表枚举的只读表——不解析人类可读 CLI 输出,不碰内部实现
2. MCP 调用失败或形状变化时可见降级(队列报「暂不可用」、图谱报「通道不可用」),而不是崩溃
3. 只读旁路启动时对照 `information_schema` 检查列期望,漂移则自动禁用自身

## 多 brain(多实例)

brain = 部署:一个 `gbrain serve` + 一个库。thin 客户端无法在一条连接里选
brain(上游远程拒绝 `--brain`),所以 cockpit 的「多 brain」是**切换部署**,
不是合并——每个 profile 是一个脑的三通道(MCP 端点、CLI 命令、可选只读
DSN),每次 `/api/*` 调用经 `x-brain-profile` 头路由(缺省 = 默认 profile;
未知 id 一律 400,绝不静默回落到错误的脑)。这是管理员环境变量令牌的
规则;访问令牌另有规则,见[请求去哪个脑实例](#请求去哪个脑实例)。

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
    "cliBin": "gbrain-bip",
    "pgReadonlyDsn": "postgresql://cockpit_ro:…@host/bip",
    "gbrainBin": "/home/you/.bun/bin/gbrain",
    "gbrainHome": "/home/you/gbrain-bip"
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
- 顶栏仅在有多于一个脑实例可显示时才出现切换器——环境变量令牌看到全部
  已配置的 profile,访问令牌只看到权限单上的。切换即重挂全部面板:一个脑的
  数据、缓存与审计绝不渲染成另一个脑的。`/healthz`(免认证的存活视图)
  恒反映默认 profile。
- **信任边界(0.4.0 起两档)**:base `COCKPIT_TOKEN` 读 + 裁决全部已配置脑;可选 `COCKPIT_ADMIN_TOKEN` 额外解锁管理写(补授权)。cockpit 永不持有 gbrain 的 owner bootstrap 凭证——管理动作与裁决共用同机 CLI 白名单,信任提升类动词永远走复制命令
- **运维感知面**:健康面板新增源可见性漂移卡(pg 旁路 vs 已授权源;admin 档一键并集补授权,降级复制命令)与提案活动/周期卡(`doctor --only cycle_freshness`,只消费结构化字段,上游原话逐字展示)
- **谁能进哪个脑实例**:管理员的环境变量令牌照旧掌控全部已配置的脑实例。
  访问令牌(0.7)只掌控权限单上的脑实例,`GET /api/profiles` 给它的也
  恰好只有这些——不带命令行名字,管理页签开关为关。该接口仍然不含任何秘密。
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
  故同名页以注释代替。让访问令牌按来源保存页面——每个来源一个 gbrain
  写入客户端、保存时带 `source_id`——是访问令牌工作的第二步,尚未开放;
  在那之前保存页面是管理员的事。

## 路线图(0.1 未含)

- 只读旁路不可用时的 MCP 组合回落路径
- `/metrics` Prometheus 端点;dream 运行窗口的降级横幅
- Docker 镜像渠道(容器内裁决按设计降级为复制命令)
- 访问令牌的按来源编辑——第二步:每个可编辑来源一个 gbrain 写入客户端、`PUT /api/page` 带 `source_id`、权限单上的来源一项(第一步「看 + 裁决」已在 0.7 交付)
