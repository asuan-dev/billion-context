# billion-context

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
AI 编程助手的<strong>通用上下文压缩代理</strong>
<br />
任何能设置 base URL 的助手 —— <em>无需为每个助手写适配代码</em>。
</p>

---


## 📄 论文 / 预印本

- **[模型驱动的分层增量压缩:面向长寿命编码 Agent 的免训练多代上下文管理](./paper/模型驱动的分层增量压缩-免训练多代上下文管理.md)**(中文版,v0.2)

> 📝 **论文本身与代码一同以 MIT 许可开源(位于 `paper/` 目录),是代码库的一部分 —— 这是一份活文档,任何人都可以编辑,欢迎提 PR 改进。**

生产规模纵向研究:四个半月、三宿主、174,327 次模型调用、187.6 亿累计输入 token(三宿主合计约 247 亿),204,800-token 窗口零违规,马拉松会话 8,584–12,049 次调用。

---

<p align="center">
<a href="https://www.npmjs.com/package/billion-context"><img src="https://img.shields.io/npm/v/billion-context.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/billion-context/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/billion-context.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/billion-context"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fbillion--context-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>npm install -g billion-context</code>
</p>

---

`billion-context` 架在**任意**编程助手与其模型 API 之间,用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 压缩重写 Anthropic/OpenAI 流。何时压缩、压缩什么 —— <strong>由模型决定</strong>,而非硬截断。

## 社区

交流、求助与更新都在 QQ——同一个群覆盖三个项目(`billion-context`、`billion-context-pi`、`opencode-acp`):

**QQ 群:1056132097**

## 为什么

长编程会话会把上下文撑爆。各家 provider 按 token 计费,一旦超过上下文窗口,会话质量下降甚至崩掉。`billion-context` 把已消耗的对话压缩成分层摘要,让你**一个会话连跑数天** —— 海量 token 穿过同一个上下文窗口。

与宿主自带的摘要器不同,这里的压缩**增量、可逆、对前缀缓存友好**:摘要在小范围内写入,可按需解压,缓存前缀保持完整。

## 工作原理

```
编程助手 (Claude Code / Codex / Cursor / Aider ...)
        │  你把助手的 base URL 指向 proxy
        ▼
┌─────────────────┐
│  billion-context│   1. 解析请求(Anthropic 或 OpenAI 格式)
│     proxy       │   2. 对对话运行 acp-kernel 压缩
│                 │   3. 注入 `compress` 工具 + 压缩哲学
│                 │   4. 转发到真实模型 API
│                 │   5. 重写流式响应
└─────────────────┘
        │
        ▼
   真实模型 API (Anthropic / OpenAI / 兼容厂商)
```

代理向对话注入四个上下文管理工具(`compress`、`decompress`、`search_context`、`acp_status`)。模型在对话增长时调用 `compress`,代理在服务端执行 —— 压缩后的范围在下一轮之前折叠进对话历史。

可选的第五个工具 `absorb`(`compress.absorb.enabled: true` —— 见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md))对**各个工具结果即时压缩**:大结果(构建、日志、grep)被附带强制吸收指令,模型将各自蒸馏为紧凑摘要,原配对从下一轮起从线上隐藏 —— 使折叠轮之间的中间会话压力更低(#605)。

**如何确认压缩真的生效了。** 代理执行 `compress` 后会以普通 assistant 文本发出确认标记(`📦 [ACP] Compressed …`)—— 但曾观察到模型在持续上下文压力下*自行书写该标记格式*而从未调用工具(#717):约 2 小时内 17 次假"压缩",真实用量一路爬到 89%。因此对话中看到的标记行本身不是持久化完成的证据 —— 请先用 `acp_status` 复核(块数 +1、可压缩区间起点前移)再采信。作为兜底,代理会剥离模型自发的标记形文本并记录 `[marker-echo]` 警告;注入的 nudge 与系统提示词也明确声明标记只由代理发出。

## 该选哪个?

按客户端选:

| 客户端 | 用这个 |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)(进程内扩展) |
| **opencode 1.x** | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili plugin install opencode`(V1 `.server()` 钩子,与 2.x 同一个包装器)或 `bili opencode`(启动器);[`opencode-acp`](https://github.com/ranxianglei/opencode-acp)(进程内扩展)仍可用 |
| **opencode 2.0+** | `bili opencode`(内置 V2 插件 —— 原生工具,无需另装包)或 `bili plugin install opencode`(自拉起原生插件,免启动器) |
| **opencode** | [`billion-context`](https://github.com/ranxianglei/billion-context),`bili opencode`(新会话走 bili 代理;现有 [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) 会话继续可用,见下文「OpenCode 1.x」) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context)，`bili omp`（内置插件） |
| **dsh** | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili dsh`（启动器，经 `--patch` 注入完整原生插件：工具、会话绑定 `/acp`、fetch 拦截）或 `bili plugin install dsh`（自拉起原生插件，免启动器 —— 往 `~/.dsh/profiles/*/cordis.patch.yml` 每个profile 写入 cordis patch）或 `dsh plugin --profile <name> add billion-context`（dsh 侧安装，全程不需 bili 命令 —— 从 npm 挂载包内 patch 层） |
| **jcode** | [`billion-context`](https://github.com/ranxianglei/billion-context)，`bili jcode`（启动器，cert-MITM）或 `/bili/` 前缀 —— 无法做原生插件：编译型 Rust 二进制、无插件接缝，其静态 provider 配置无法按请求打头（[#962](https://github.com/ranxianglei/billion-context/issues/962)） |
| **其余所有**（没有上下文 hook） | [`billion-context`](https://github.com/ranxianglei/billion-context) —— `bili <client>`（启动器，优先）或 `/bili/` 前缀 |

**原生模式 vs 独立扩展。** 宿主原生插件(`bili plugin install pi` / `opencode` —— 代理在宿主进程内拉起)与独立进程内扩展(`billion-context-pi`、`opencode-acp`)**互斥**:两者同时生效意味着双重压缩。安装器负责切换:`bili plugin install pi` 会替换旧的 `npm:billion-context-pi` 条目;`bili plugin install opencode` 会从全局 opencode.json 里剔除旧的 `opencode-acp` 条目 —— 裸名、`npm:` 别名、带版本号(`opencode-acp@stable`)、路径形式都认,数组/对象两种形态都处理;原配置会快照到 `opencode.json.bili-bak`。**项目级**安装(`opencode plugin opencode-acp` 写的是 `<project>/.opencode/opencode.json`,不是全局配置)不会被碰 —— 需手动移除,安装器输出里会提醒。作为手动安装的运行期安全网,原生入口在加载时同步设置 `BILLION_CONTEXT_NATIVE=<host>`,让独立扩展在动作时自动退出 —— 它自己的加载期 `BILLION_CONTEXT_PROXY` 检查看不见原生模式异步拉起的代理,`/bili/` baseURL 检查也看不见 fetch 层改写。

**从 opencode-acp 迁移旧会话（v1 泳道路由）。** 在 OpenCode 1.x 上，`bili plugin install opencode` 让迁移前的旧会话继续可用：原生入口会吸收已安装的 `opencode-acp` 包（直接从 `node_modules` 导入 —— `.opencode/node_modules`、项目 `node_modules`、全局 npm root、opencode 配置级 modules，先到先得），并按会话路由。会话属于 legacy ⟺ opencode-acp 的持久化状态文件存在（`<XDG_DATA_HOME>/opencode/storage/plugin/acp/<sessionID>.json`）：

- **旧会话** —— 压缩由被吸收的 opencode-acp 执行（它自己的 `<dcp-message-id>` 引用号与块存储照常工作：`compress` / `decompress` / `search_context` / `acp_status` / `acp_context_recap` 全部在它里面执行）。其模型请求带 `x-bili-plugin-bypass: 1`，代理原样转发 —— 不注入 wire 工具、不注 nudge、不绑定会话。
- **新会话** —— bili 接管：工具调用转发到代理的 plugin 端点（plugin 模式）。模型看到的工具槽位带 DCP schema（v1 进程级每个名字仅一份定义），但执行器按会话分泳道：新会话的 `compress` 发到代理，旧会话的发给 opencode-acp。`acp_context_recap` 没有代理端对应 —— 新会话调用会收到代理的 unknown-tool 消息。

`/acp` 与 `/dcp` 同样路由。新会话被 opencode-acp 注册表收编的可能被其 transform 门控（system / messages / text.complete 都过 legacy 谓词）阻断。退化路径：opencode-acp 包缺失或导入失败时 bili 单独运行，旧会话退化为只读存档（旧 `<acp>` 标签照常渲染、`decompress` 返回 `[Block … not found]`、新引用号从 m00001 重新开始）。

## 安装

```bash
npm install -g billion-context
```

这会安装 `bili` 命令(`bili-proxy` 保留为别名)。

## 快速上手

3种方式 —— 任选其一:

- **原生插件(免启动器):** `bili plugin install <client>` —— bili 成为客户端内的插件,照常启动客户端即可.
- **启动器(最省事):** `bili <client>` 一条命令拉起代理 + 客户端,不碰任何真实配置文件.
- **改url(持久化):** 在客户端 baseURL 前面加上代理地址 + `/bili/`。



### 方式 1 —— 原生插件(native,`bili plugin install pi` / `opencode` / `dsh`)

代理住进客户端:装一次,之后照常启动客户端 —— 不用启动器命令、不用环境变量、不用固定端口、不用改 URL。目前支持 **pi**、**opencode**(1.x 与 2.x)、**dsh**:

```bash
bili plugin install pi          # 在 pi 的 settings 里注册 billion-context 条目(bili 自身为 npm 安装时写 npm 条目)
bili plugin install opencode    # 在 opencode 真实配置里注册插件 + 关闭原生自动压缩
bili plugin install dsh         # 往每个 ~/.dsh/profiles/*/cordis.patch.yml 追加受管块
bili plugin remove <client>     # 卸载(dsh 还原占位符;配置快照存 .bili-bak)
```

dsh 用户可以完全不用 bili：`dsh plugin --profile <name> add billion-context` 经 dsh 自己的插件通道装上同一个原生插件（pnpm 装进 profile、挂载包内 patch 层）—— 见下文 dsh 段。

插件加载时**自拉起自己的代理**(已有健康实例则直接复用 —— 父进程 pid 看门狗在客户端退出时收掉它),把模型流量改写到 `<proxy>/bili/<上游URL>`,并把 `compress` / `decompress` / `acp_status` 注册为客户端原生工具(plugin 模式),`/acp` 面板绑定当前会话。退出开关:`BILI_NATIVE_PI=0`、`BILI_NATIVE_OPENCODE=0`、`BILI_NATIVE_DSH=0`。

注意:

- 原生模式与独立进程内扩展(`billion-context-pi`、`opencode-acp`)**互斥** —— 安装器负责换条目并把原配置快照(`.bili-bak`);迁移细节见上方客户端表(pi 需 `billion-context-pi` 0.1.72+ 才能干净退让)。
- OpenCode 1.x 上,迁移前的 `opencode-acp` 旧会话继续可用(v1 泳道路由,#920)—— 见下文 "OpenCode 1.x"。
- `claude` / `codex` / `omp` 也有配套安装(MCP shell 与轻量扩展),但它们需要一个在跑的代理 —— 不属于原生模式。
- `jcode` 则完全没有原生模式:它是编译型 Rust 二进制、无插件/扩展接缝,唯一的 provider 级请求头是静态 TOML 表(对每个请求原样附加),MCP server 又是跨所有会话共享的全局池 —— 既无法在进程内改写模型流量,也无法打上 plugin 模式所需的按请求头(`x-bili-plugin`、会话 id、runtime-info)。完整源码级分析见 [#962](https://github.com/ranxianglei/billion-context/issues/962)(已按 wontfix 关闭)。请用 `bili jcode`(启动器)。

### 注入优先级 —— 能不写文件就不写(#535)

bili 永不拥有用户数据:每个被启动的客户端都跑在**真实 home** 上,运行期写入落在用户预期的位置。把客户端指向代理时,启动器按优先级选择——**优先 env 变量**(hermes/dsh/codex 的代理/CA env;pi/omp 的 `BILI_PROVIDER_REWRITES` URL 清单,由扩展加载时经 `registerProvider` 消费),其次 **CLI 参数或扩展 API**(codex `-c key=value`、opencode 插件),最后才是**生成文件**——目前仅剩 opencode 的临时 `opencode.json`(退出即删)和 dsh 的回环例外:dsh 的 fetch 栈对回环目标无条件绕过代理 env,所以本地上游保留持久 `~/.dsh-bili` overlay 改写,直到 dsh 提供 settings-path env 或上游支持回环 opt-out。旧版本创建的 overlay 目录原地保留,绝不合并回真实 home。

### 方式 2 —— 启动器(`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh` / `bili codebuddy` / `bili qoder` / `bili trae` / `bili jcode` / `bili kimi`)

启动器把客户端包进一条命令:在独立端口拉起一个代理(总是全新实例,绝不复用端口),再按客户端支持的机制把它指向代理 —— 能吃代理/CA 环境变量的走**证书 MITM**,不吃的走隔离的**`/bili/` 配置重写**。真实配置文件从不被修改;客户端自己的配置只被**读取**,用来发现它实际连接的 HTTPS 上游主机,把这些主机加入 MITM 白名单 —— 代理只 TLS 终结它们,其余流量盲透传。

```bash
bili pi                               # 拉起 pi,走代理 —— file-free(#535):环境变量 + 扩展 registerProvider,真实 ~/.pi 不动
bili codex                            # 拉起 codex
bili claude                           # 拉起 claude
bili omp                              # pi 同款,file-free(#535):环境变量 + 扩展 registerProvider + 压缩取消,真实 ~/.omp 不动
bili opencode                         # HTTPS 走 MITM + 临时 opencode.json(HTTP 走 /bili/)+ 轻量 /acp 插件;OpenCode 2.0+:内置 V2 插件带原生 bili 工具,自动关掉原生 auto-compaction;OpenCode 1.x:旧 opencode-acp 会话继续可用(条目从副本中移除、包以库形式导入,#920)。详见下方「OpenCode 专属说明」
bili hermes                           # file-free(#535):hermes 代理环境变量(HTTPS_PROXY + HERMES_CA_BUNDLE)—— https 走 CONNECT MITM,http 走绝对形式转发;真实 ~/.hermes 不动
bili dsh                              # deepseek-harness:经 --patch 注入完整原生插件(#941) —— compress/decompress/acp_status 注册为真实 dsh 工具，请求盖 dsh 会话 id(plugin 模式)，/acp 会话绑定；非回环上游走代理 env(https MITM、http absolute-form)，回环上游保留 overlay DSH_HOME(~/.dsh-bili)改写(#535)，内置 deepseek 路由走 DEEPSEEK_BASE_URL；dsh 原生自动压缩被禁用(compaction-basic auto:false)
bili codebuddy                        # Tencent CodeBuddy Code CLI:CODEBUDDY_BASE_URL /bili/ 重写(OpenAI chat completions wire),预算对齐走 CODEBUDDY_AUTO_COMPACT_WINDOW;真实 ~/.codebuddy 不动
bili qoder                            # qoder:模型端点硬编码 https(无法 /bili/ 改写)—— 证书 MITM(HTTPS_PROXY + NODE_EXTRA_CA_CERTS),默认模型主机已加白名单(#653)
bili trae                             # Trae CLI(字节跳动,闭源 Go 二进制,无 base-URL 覆盖)—— 证书 MITM(HTTPS_PROXY + SSL_CERT_FILE),模型主机取 TRAE_CLI_API_HOST 或默认企业网关(#655)
bili jcode                            # jcode(Rust 终端编码 agent)—— 环境变量式证书 MITM 启动:HTTPS_PROXY + SSL_CERT_FILE,模型主机 api.z.ai 默认加白,本地回环 provider 走 NO_PROXY 直连
bili kimi                             # Kimi Code CLI(Moonshot):除无条件回环绕过外,所有流量遵循标准代理环境变量——非回环 https 走证书 MITM(HTTPS_PROXY + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE),非回环 http 走绝对形式转发;provider/model 主机取 ~/.kimi-code/config.toml(遵循 KIMI_CODE_HOME)或未声明时的托管 OAuth 端点;回环端点编目并附手动 /bili/ 前缀提示(#757)
bili pi --mitm-domain api.foo.com     # 向 MITM 白名单追加域名
```


### OpenCode 1.x —— 旧 opencode-acp 会话继续可用(#920)

在 1.x 主机上，`bili opencode` 会**通过 bili 代理运行新会话**，同时**让现有 `opencode-acp`（"legacy"）会话继续使用其自身机制正常工作**（#920）。启动器会从临时配置副本中移除 `opencode-acp` 条目（主机永远不会以激活状态加载它），而轻量的 bili 插件则改为以库的形式导入已安装的包：

- 每个 ACP 钩子都以"该会话存在 ACP 存储文件"为门控条件（`~/.local/share/opencode/storage/plugin/acp/<sessionID>.json`，或 `acp.jsonc` 中 `storagePath` 指定的目录）——旧版会话保留其 DCP compress / decompress / search_context / acp_status 工具和 `/dcp` 命令；新会话不会被接管，而是运行纯代理模式。
- 旧版 LLM 请求会被打上 `x-bili-plugin-bypass: 1` 标记，代理将其视为原始透传（无注入、无压缩、无会话状态）。
- 在代理模式下，压缩工具的名称由代理独占：请求体中同名的客户端工具会在注入前被丢弃，因此上游对每个名称只看到一个定义。

优雅降级：如果包无法找到/导入或不是 v1 版本，插件的行为与此更改之前完全一致——旧版会话的降级方式与 `opencode-acp` 在 `/bili/` baseURL 上自我禁用时的表现相同。

### 方式 3 —— 改url(`/bili/` 前缀)

启动代理:

```bash
bili
```

然后把客户端现有的 baseURL 前面加上 `http://localhost:8787/bili/` 就行。完整上游 URL 嵌在路径里,proxy 无需任何配置就知道转发到哪:

```
客户端 baseURL 之前:  https://api.openai.com/v1
客户端 baseURL 之后:  http://localhost:8787/bili/https://api.openai.com/v1
```

更多客户端配置参考网页引导: [http://localhost:8787](http://localhost:8787) .

#### dsh(deepseek-harness)

两条通道，同一个插件(#941):

- **启动器:** `bili dsh` 经 `--patch` overlay(`~/.dsh-bili/.bili-acp.patch.yml`)注入完整原生插件 —— 每个 profile 启动即注册 bili 工具，模型请求盖 `x-bili-plugin` + dsh 会话 id(plugin 模式)，`/acp` 会话绑定。同一份 patch 同时禁用 dsh 原生自动压缩(`compaction-basic` → `auto: false`);手动 `/compact` 仍可用。
- **原生(免启动器):** `bili plugin install dsh` 往每个 profile 的 `~/.dsh/profiles/<name>/cordis.patch.yml` 追加受管块(标记 `# bili begin` / `# bili end`;用户条目与注释保留，占位 `[]` 根会被替换，卸载时还原)。先在每个 profile 里跑过一次 dsh 让目录存在。插件加载时自拉起代理(已有健康实例则附看，不重复拉;父进程 pid 看门狗)，经全局 fetch 补丁把模型流量改写为 `<proxy>/bili/<上游URL>`，原样注册清单工具，并按工具就绪门控 plugin 模式头(第一轮走 wire 模式)。退出开关:`BILI_NATIVE_DSH=0`。卸载:`bili plugin remove dsh`。
- **dsh 侧安装(全程不需 bili 命令):** `dsh plugin --profile <name> add billion-context` 经 pnpm 把 npm 包装进该 profile 并自动挂载包内 patch 层(`dsh.bundle.patch.yml`) —— 同一插件、行为与原生泳道完全一致。安装器、`bili dsh` 启动器 overlay 与 `plugin status` 都会识别 bundle 安装的 profile 并跳过(cordis 拒绝跨层重复 entry id,二次 insert `id: bili-native` 会直接弄崩 dsh 启动)。卸载:`dsh plugin --profile <name> remove billion-context`。要求 npm 上已发布含 `dsh.bundle.patch.yml` 的版本。

`bili dsh` 启动下插件**附看**(attach)启动器的代理(不二次拉起)。裸上游 URL 与 spawn 模式一样重写为 `<proxy>/bili/<url>`(回环代理目标永不被代理 env 拦截，等于直接绕开 MITM)；已经路由的 `/bili/` 前缀请求原样放行、只盖章。已知局限:手动 `/compact` 没有 dsh 侧事件钩子，其边界交给内核的自然 ingest diff(自动压缩已关，影响罕见)。

### 验证

代理跑着、配置保存了之后,确认它能应答,并且第一个真实请求在日志里显示压缩活动:

```bash
# 健康检查(代理是否在跑 + 转发到哪)
curl -s http://localhost:8787/__bili/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# 实时会话统计(发过真实请求后)
curl -s http://localhost:8787/__bili/stats
```

然后从助手发一条消息,观察日志(`~/.local/state/billion-context/bili.log`,
同时也打到 stderr)。每个请求应该看到一行 `processTurn`,等对话变长后
会出现 `[acp-usage] round N input=X cached=Y (cache hit Z%)` + `compress` 事件。

### OpenCode 专属说明

OpenCode 2.0 换了新插件 API(`@opencode/plugin`);独立扩展 `opencode-acp` 仅支持 V1,在 2.0 下不加载。bili 的两种模式在 2.0 都能用。2.x 插件 API 面在不同 build 间仍在变动(相邻的 npm `dev` 构建 `ctx` 形状不同),下面列的钩子/工具细节是针对具体版本的观察,不是稳定契约:

- **启动器:** `bili opencode` 用法不变。在 2.x 宿主上,它把内置 V2 插件(`dist/agent/opencode.js`)以临时包装目录的形式注入临时配置(目录入口 `index.js` 再 re-export 插件文件 —— 2.x 拒绝配置 `plugin` 数组里的裸文件路径;1.x 宿主用裸文件路径)。宿主代次用 `--version` 探测(探测失败默认 1.x 形状)。V2 插件在宿主内原生注册 bili 工具 —— compress / decompress / search_context / acp_status(另加 absorb),JSON-Schema 入参 —— 并在每个 provider 请求上盖章代理头,压缩走插件模式,不做 wire 级工具注入;原生 auto-compaction 自动关闭(`compaction.auto: false`)。所有注册都是防御式的(可选链):任一 2.x build 上接缝缺失或未触发时,插件保持情性,会话透明回退纯代理模式(wire 级注入)而不是报错 —— 在两个相邻 `dev` build(2026-09-13 / 2026-09-14)上观察到过 API 面不同(#754 评审探针);反之在 `@opencode/cli` 2.0.3 上端到端验证过(原生 `acp_status` 经插件端点执行,零 wire 注入)。
- **原生(免启动器):** npm 装好包后跑 `bili plugin install opencode` —— 它在真实 opencode 配置里注册一个自拉起插件并设 `compaction.auto: false`,之后直接跑 `opencode` 即可。入口形态取决于**本 bili 自身的安装来源**:**npm 安装**写裸包名(`"plugin": ["billion-context"]`)—— 包通过 `exports["./server"]` → `dist/agent/opencode-native.js` 暴露插件入口,opencode 用自己的 Npm.add 机制加载、自行管理安装与升级;零绝对路径、可跨机同步。**git checkout / 开发构建**没有已发布入口,回退到本机 shim 目录(`<configDir>/plugins/billion-context/index.js` → 该 checkout 的 `dist/agent/opencode-native.js`)—— 按构造即机器本地、不可跨机;之后改用 npm 安装再跑一次 install 会把条目迁回裸包名。加载时插件自拉起自己的代理(健康的已有实例直接复用不重复起;父进程 pid 看门狗在 opencode 退出时收掉它),把模型流量路由到 `<proxy>/bili/<upstream-url>`,并暴露与启动器模式相同的原生 bili 工具 —— 无固定端口、无环境变量、免启动器。退出:`BILI_NATIVE_OPENCODE=0`。若没有任何代理能拉到健康状态,请求直连(不压缩)并给一次性告警,之后自动恢复。在 `bili opencode` 启动下该入口整体跳过(代理归启动器管)。

  同一个包装器也服务 **OpenCode 1.x**(V1 `.server()` 钩子;在 1.14.46 和 1.18.31 上验证):`config` 钩子在进程内直接改共享配置对象,把每个 provider 的 `options.baseURL` 改写为 `<proxy>/bili/…` 并设 `compaction.auto: false`;`chat.headers` 每次请求盖章插件头;`tool` 用真实 zod 形状注册 bili 工具(zod 是运行时依赖 —— 解析不到时插件降级纯代理模式:只改写、wire 注入工具);`/acp` 命令渲染同一张状态面板。**没有显式 `baseURL`** 的 provider(SDK 默认值,如裸 `@ai-sdk/openai` → api.openai.com)由全局 `fetch` 补丁(pi-native 同机制)兑住 —— 模型 API 调用重路由到代理(日志:`v1: fetch patch installed`),在 1.14.46 / 1.18.31 上含 OpenAI Responses 端点端到端验证;补丁幂等,`/bili/` 包装过的 URL 原样直通。
- **纯代理:** 与其它客户端一样,把 provider baseURL 指向代理:

  ```json
  {
    "provider": {
      "myprovider": {
        "npm": "@ai-sdk/openai-compatible",
        "options": {
          "baseURL": "http://localhost:8787/bili/http://upstream.example/v1",
          "apiKey": "sk-any"
        }
      }
    }
  }
  ```

  注意:2.0 AI-SDK provider 即使本地端点从不校验也要求 `apiKey` 字段 —— 随便填个非空值。

注意事项:2.x 系列以 npm 包 `@opencode/cli` 发布。命令支持随 build 而定:某个预发布版只暴露 list/get/update/remove,而 2.0.x 稳定版允许插件经 `ctx.command.transform((editor) => editor.add(...))` 新增命令 —— TUI 里接受斜杠菜单补全(Tab + Enter)即可调用;注意 `opencode run` 模式完全不派发斜杠命令(它们会透传给模型)。内置插件在两种形状上都刻意不注册命令。
### 客户端用 `http.proxy`(CONNECT)接入但从不压缩

部分客户端(VS Code 系 IDE:CodeBuddy、Cursor、Windsurf……)只提供一个 HTTP **代理**设置(`http.proxy`、`codingcopilot.httpProxyURL` 等),没有可改写的模型 base-URL。这类客户端不走普通的 `/bili/…` 请求,而是把 `CONNECT <模型域名>:443` 发给代理。只有当模型域名在 bili 的 **MITM 白名单**里时这条路径才会被解密;否则 bili 只做盲隧道(不透明转发),永远看不到——也就无法压缩——模型请求(#897)。

该失效模式现在不再静默:

- 日志里对每个目标域名打一次 `BLIND TUNNEL WARNING`,附修复步骤;
- `curl -s http://localhost:8787/__bili/health` 与 `/__bili/stats` 输出 `blindTunnels`(计数 + 精确目标域名,仅 loopback);
- 存在此类隧道时,`acp_status` 输出会多一节 `UNDECRYPTED TRAFFIC (instance-level)`。

要真正压缩这类客户端:把它的模型域名加进 `billion-context.json` 的 `"mitm".domains`(如 `"mitm": { "domains": ["copilot.tencent.com"] }`)或环境变量 `BILI_MITM_DOMAINS`,重启 bili,并让客户端信任 bili 的根 CA(Node 系客户端用 `NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem`,有 CA 路径设置的用其设置)。`/bili/` 前缀方案在这里不适用——没有 URL 可改。详见 [CONFIGURATION.zh-CN.md → MITM](CONFIGURATION.zh-CN.md#mitm-透明代理登录客户端)。

## 运行代理

### 命令行参数

```bash
bili --port 9000              # 改监听端口
bili --host 0.0.0.0           # 监听所有网卡(见下面的 host 说明)
bili --debug                 # 详细日志(也可在配置里设 "debug": true)
bili --passthrough           # 不压缩直接转发(冒烟测试模式)
bili --config ~/my-bili.json # 用别的配置文件
bili update                  # 立即检查并安装新版本(跳过节流)
bili --no-auto-update        # 本次启动禁用自动更新
```

参数优先级高于环境变量和配置文件。`bili --help` 列出全部。

### 远程 agent（`--host`）

默认绑定 `127.0.0.1`，只接受本机连接。要给其他机器上的 agent 用，绑定非 loopback 地址:

```bash
bili --host 0.0.0.0           # 所有网卡(或直接用局域网 IP)
```

- 远程 agent 把模型 `baseURL` 指向 `http://<本机IP>:<端口>/bili/…`。
- MITM 模式的 `CONNECT` 也会接受远程客户端 —— 但仅限**白名单内的模型域名**;
  到任意主机的盲隧道仍仅限本机，代理不会沦为开放中继。
- **没有任何鉴权**: 只应在可信局域网或防火墙内使用。`/__bili/` 管理
  端点仍仅限本机访问。
- 启动时的 `[security]` 警告会提醒上述事项。


### 调试

三种方式打开详细日志(优先级:参数 > 环境变量 > 配置):

1. **命令行参数**(最快):`bili --debug`
2. **环境变量**:`ACP_DEBUG=1 bili`
3. **配置文件**:在 `billion-context.json` 里设 `"debug": true`

详细模式会打印每次 `processTurn`(标签计数、token 用量)、nudge 决策(growth/usage/pendingT1/shouldInject)、客户端 headers 和 SSE 重写。

### 日志文件

所有日志**默认同时写入文件**:`~/.local/state/billion-context/bili.log`
(XDG state 目录)。同时仍打印到 stderr,所以前台运行 `bili start` 时终端也能看到。

```bash
# 配置: "logFile": "/custom/path.log"
# 环境变量: ACP_LOG_FILE=/custom/path.log   (或 ACP_LOG_FILE=off 关闭文件,只保留 stderr)
```

文件超过 10 MB 自动轮转(重命名为 `bili.log.old`)。每个请求的缓存命中统计会以 `[acp-usage] round N input=X cached=Y (cache hit Z%)` 打印,可直接从日志衡量前缀缓存健康度。

### 自动更新

代理启动时和每 3 分钟检查 npm 是否有新版本。发现新版本就全局安装(`npm install -g`)并打印通知 —— **重启 `bili` 才能生效**。

永久禁用:配置(`"autoUpdate": false`)或环境变量(`ACP_AUTO_UPDATE=0`)。

## 配置

完整的配置参考 —— 配置文件位置、顶层键、providers、压缩调参、环境变量 ——
见 **[CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md)**。

### 上游代理(防火墙 / GFW)

如果代理自身访问模型提供商的连接被墙(比如 GFW 内访问 `api.openai.com`),配置一个**上游代理**(本地 v2rayA / clash 的 HTTP 端口),让代理能连到提供商:

```jsonc
{
  // 全局默认:所有提供商的出站都走这个代理
  "proxy": "http://127.0.0.1:20172",
  "providers": {
    "https://api.openai.com/v1": {
      // 按 URL 覆盖全局(给这个域名用另一个代理)
      "proxy": "http://127.0.0.1:20173",
      "models": { "gpt-5": { "context": 400000 } }
    },
    "https://open.bigmodel.cn/api/anthropic": {
      // 空字符串 = 明确直连,覆盖全局代理
      "proxy": "",
      "models": { "glm-5.2": { "context": 1000000 } }
    }
  }
}
```

规则:
- **按 URL 的 `proxy`** 对匹配的 provider URL 优先级最高。
- 其余优先级为:`BILI_UPSTREAM_PROXY` → Web UI 手动代理 → 顶层 `proxy` →
  `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows 系统代理 → 直连。
- 空字符串 `""` 表示**明确直连**(覆盖并禁用)。
- 自动模式会让环境/系统 fallback 遵守 `NO_PROXY` 与 Windows 绕过列表。
  指回 bili 自己本地端口的代理会被跳过或拒绝,防止自环。
- 支持 HTTP 和 HTTPS 代理 origin。SOCKS5 暂不支持。
- 两条出站路径都覆盖:`/bili/` 路径模式(fetch)和 MITM CONNECT 隧道(代理连接真实上游的链路走 HTTP CONNECT 代理)。

环境变量覆盖:`BILI_UPSTREAM_PROXY=http://127.0.0.1:20172`(优先于配置文件)。
Windows 下会自动发现常见 Clash/Mihomo 静态系统代理;Web UI 会显示实际来源,
以及 Internet Settings 中检测到的 PAC URL。

**MITM 与 `/bili/` —— 用 scheme 区分。** 登录客户端(ZCode 走 MITM)和 API-key 客户端可能连同一个域名(`open.bigmodel.cn`)。为了让它们的配置能区分,MITM 流量在查找键里用 `mitm://` scheme,`/bili/` 流量用真实的 `https://`:

| 客户端 | 查找键示例 |
|---|---|
| ZCode(MITM,登录态)| `mitm://open.bigmodel.cn` |
| API-key 客户端(`/bili/`)| `https://open.bigmodel.cn/api/anthropic` |

所以你可以给 ZCode 单独配代理,不影响 API-key 客户端:
```jsonc
{
  "providers": {
    "mitm://open.bigmodel.cn":            { "proxy": "http://127.0.0.1:20173" },
    "https://open.bigmodel.cn/api/anthropic": { "proxy": "http://127.0.0.1:20172" }
  }
}
```

## 会话机制

代理需要一个稳定的、按会话标识的 ID,以便在多个用户/账号并发时隔离压缩状态。它从四个维度推导一个(见 `src/session-id.ts`):**协议 × 上游 origin × API key × 会话**。前三个防止跨账号 / 跨 provider 串数据;会话维度来自客户端发送的内容。

不同客户端发送的东西不同:

| 客户端 | 发会话 id 吗? | 来源 | 安全性 |
|---|---|---|---|
| **Codex**(0.147+) | ✅ 发 | `body.session_id`(按会话 UUID) | ✅ 安全 |
| **OpenCode** | ✅ 发 | `x-session-affinity` header(`ses_…`) | ✅ 安全 |
| **pi** | ❌ **不发** | 无 | ⚠️ **有碰撞风险** |

客户端发显式 id 时,代理直接用它。不发时(pi),代理回退到对首条用户消息做哈希 —— 于是两个开头相同的会话会塌缩到同一个 session。这**不会损坏数据**(每条消息的 ref 用独立的内容指纹,保持稳定),但会让 nudge/压缩时机跑偏,偶尔过早回收某个 block。它是自愈的:最坏情况是压缩效率降低,绝不丢数据。

用于上游粘性路由时,客户端不发会话 header 时代理会合成一个(`x-session-id: ses_<hash>`),让缓存池 / 负载均衡器仍能拿到稳定 key。

**建议:** Codex 和 OpenCode 可以安全地通过代理并发跑很多会话。pi 单个 agent 没问题,但因碰撞风险**不建议**并发多会话 —— 直到 pi 自己长出 session-id 信号。pi 多 agent 场景下,每个会话发一个显式 `x-acp-session` header 来避免碰撞。

### Windows：把会话目录加入杀软排除项（#362）

代理把每个会话的压缩状态持久化到会话目录（默认 `%USERPROFILE%\.local\share\billion-context\`），长会话每一轮都会重写该文件。在 Windows 上，实时杀毒（Windows Defender）、搜索索引器或同步工具（OneDrive）可能在写入中途锁住该目录，导致 rename 以 `EPERM` 失败，在锁解除前该会话的每次持久化都会失败。

当同一会话连续 N 次写失败（默认 `5`）时，代理会打一条一次性、可操作的告警，明确指出要排除的目录。要从根上修复：把 `%USERPROFILE%\.local\share\billion-context\` 加入杀软**排除项**（Windows Defender：设置 → 病毒和威胁防护 → 管理设置 → 排除项 → 添加排除 → 文件夹），并确认没有同步工具（OneDrive / Dropbox / …）在同步该路径。完整步骤见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md) 的「Windows：把会话目录加入杀软排除项」章节。

## 状态

早期。协议处理和压缩已通过 mock 测试(500+ 项通过)。真实模型集成测试是下一里程碑。预期会有粗糙的地方。

针对 pi / omp / opencode 的客户端插件随 `billion-context` 一起发布(`dist/agent/*.js`),用于协作代理路径。三者(`billion-context`、独立的 `billion-context-pi`、`opencode-acp`)如何取舍,见上文「该选哪个?」一节。

## 社区

QQ 群 —— 三个项目共用一个群（[`billion-context`](https://github.com/ranxianglei/billion-context)、[`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi)、[`opencode-acp`](https://github.com/ranxianglei/opencode-acp)）：**1056132097**

## 许可证

MIT
