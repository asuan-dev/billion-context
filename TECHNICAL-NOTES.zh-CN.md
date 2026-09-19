# 技术细节

README 三种使用方式背后的机制级说明。README 里每种方式只保留简洁的用法;「它到底怎么工作」的内容都放在这里,而不是夹在三种方式中间。

## 原生插件生命周期(方式 1)

插件加载时**自拉起自己的代理**(已有健康实例则直接复用 —— 父进程 pid 看门狗在客户端退出时收掉它),把模型流量改写到 `<proxy>/bili/<上游URL>`,把 `compress` / `decompress` / `acp_status` 注册为客户端原生工具(plugin 模式),并把 `/acp` 面板绑定到当前会话。插件还会把客户端**自己的模型配置**上报给代理(runtime-info 协议,#955),压缩预算用真实窗口而不是注册表猜测。退出开关:`BILI_NATIVE_PI=0`、`BILI_NATIVE_OMP=0`、`BILI_NATIVE_OPENCODE=0`、`BILI_NATIVE_DSH=0`、`BILI_NATIVE_KIMI=0`。

## Runtime-info 协议(#955)

原生插件就在客户端进程里,因此能读到客户端自己将要使用的模型配置。它通过两个通道把真相推给代理,代理在上下文窗口解析链里优先采用它而不是 models.dev 注册表/内置表:

| 通道 | 时机 | 字段 |
|---|---|---|
| 逐请求头(门控在 `x-bili-plugin`) | 每次模型请求 | `x-bili-plugin-context-window`、`x-bili-plugin-max-output`、`x-bili-plugin-model` |
| `POST /__bili/plugin/runtime-info`(回环地址) | 插件自举 + 模型切换 | `{agent, model, contextWindow?, maxOutput?, baseURL?, source}` |

窗口解析顺序:`anthropic-beta` 协商 > 逐请求 plugin 头 > runtime-info 表(agent+model 必须匹配) > launcher 环境变量 > 路由配置 > models.dev 注册表 > 内置表。上报的 `maxOutput` 仅在请求体自带输出预算缺席时兜底。现有实现:`src/agent/pi.ts`(覆盖 pi 与 omp)、`src/agent/opencode-native.ts`(v1)、`src/agent/opencode-v2.ts`、`src/agent/dsh-native.ts`、`src/kimi/native-mcp.ts`(仅自举时上报 —— kimi 的 provider `custom_headers` 是静态的,逐请求头会在模型切换后过期)—— 其他客户端接入请遵循同一协议。

launcher 环境变量这档覆盖纯代理客户端(无进程内插件):`bili <client>` 启动时读客户端自己的模型配置(codex 的 `model_context_window` / `model_max_output_tokens`,pi / omp 的 `contextWindow` / `maxTokens`,opencode 的 `limit.context` / `limit.output`,codebuddy 的 `maxInputTokens` / `maxOutputTokens`),经 `BILI_LAUNCHER_MODEL_WINDOWS` / `BILI_LAUNCHER_MODEL_MAX_OUTPUTS` 交给代理(#971)。插件上报 —— 若存在 —— 永远优先于它。

首次模型请求之前会话尚不存在,`/acp` 面板会探测 `GET /__bili/plugin/status?conversationId=<agent>&fallback=latest`,代理从 runtime-info 表应答(`phase: "pre-first-request"`)而不是返回 404 —— 上报的配置立即可见,流量落地后由真实会话接管。

## Claude 原生姿态(#964)

Claude Code 没有进程内扩展点,所以 `bili plugin install claude` 往 `~/.claude/settings.json` 写一个受管块(env `ANTHROPIC_BASE_URL=http://127.0.0.1:48787/bili/<upstream>`、`DISABLE_AUTO_COMPACT=1`、`SessionStart` hook),外加同样指向该稳定端口的用户级 MCP shell。hook 在首个模型请求前触发:附着到端口上健康的代理,或拉起一个 pid 看门狗追踪 claude 本身的代理 —— 代理随会话生灭。端口覆盖:`BILI_CLAUDE_NATIVE_PORT` > config `claude.nativePort` > 48787;上游覆盖:`BILI_CLAUDE_UPSTREAM`(或既有 `claude.anthropicBaseUrl`)。`BILI_NATIVE_CLAUDE=0` 退出 —— hook 改为拉起同端口的 **passthrough** 代理(原样转发、关闭压缩)。块是纯 JSON merge/strip:外部键从不触碰,`bili plugin remove claude` 精确还原。装有原生块的机器上 `bili claude` 仍可用 —— 它用自身临时代理覆盖静态 URL,hook 保持休眠。

## 注入优先级 —— 能不写文件就不写(#535)

bili 永不拥有用户数据:每个被启动的客户端都跑在**真实 home** 上,运行期写入落在用户预期的位置。把客户端指向代理时,启动器按优先级选择——**优先 env 变量**(hermes/dsh/codex 的代理/CA env;pi/omp 的 `BILI_PROVIDER_REWRITES` URL 清单,由扩展加载时经 `registerProvider` 消费),其次 **CLI 参数或扩展 API**(codex `-c key=value`、opencode 插件),最后才是**生成文件**——目前仅剩 opencode 的临时 `opencode.json`(退出即删)和 dsh 的回环例外:dsh 的 fetch 栈对回环目标无条件绕过代理 env,所以本地上游保留持久 `~/.dsh-bili` overlay 改写,直到 dsh 提供 settings-path env 或上游支持回环 opt-out。旧版本创建的 overlay 目录原地保留,绝不合并回真实 home。
