# billion-context

[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Universal context-compression proxy</strong> for AI coding agents
<br />
Any agent that can set a base URL — <em>zero per-agent adapter code</em>.
</p>

---


## 📄 Paper / Preprint

- **[Model-Driven Incremental Hierarchical Compression: Training-Free Multi-Generational Context Management for Long-Lived Coding Agents](./paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md)** (English, v0.2)

> 📝 **The paper itself is open-sourced under the MIT License as part of the codebase (`paper/`). It is a living document — anyone may edit it; improvements are welcome via pull request.**

A production-scale longitudinal study: 4.5 months, three hosts, 174,327 model calls, 18.76B cumulative input tokens (~24.7B across all hosts), zero window violations on 204,800-token models, marathon sessions of 8,584–12,049 calls.

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

`billion-context` sits between **any** agent and its model API, rewriting Anthropic/OpenAI streams with [acp-kernel](https://github.com/ranxianglei/acp-kernel) compression. The model decides **when** and **what** to compress into high-fidelity summaries — not a hard truncation limit.

## Community

Discussion, help, and updates on QQ — one group covers all three projects (`billion-context`, `billion-context-pi`, `opencode-acp`):

**QQ Group: 1056132097**

## Why

Long coding sessions blow up context. Each provider charges per token, and once you pass the context window the session degrades or dies. `billion-context` compresses consumed conversation into layered summaries so you can run a single session for days — billions of tokens through one context window.

Unlike a host's built-in summarizer, compression here is **incremental, reversible, and prefix-cache friendly**: summaries are written in small ranges, can be decompressed on demand, and the cache prefix stays intact.

## How it works

```
Agent (Claude Code / Codex / Cursor / Aider ...)
        │  you point the agent's base URL at the proxy
        ▼
┌─────────────────┐
│  billion-context│   1. parse the request (Anthropic or OpenAI shape)
│     proxy       │   2. run acp-kernel compression on the conversation
│                 │   3. inject a `compress` tool + compression philosophy
│                 │   4. forward to the real model API
│                 │   5. rewrite the streaming response
└─────────────────┘
        │
        ▼
   real model API (Anthropic / OpenAI / compatible)
```

The proxy injects four context-management tools (`compress`, `decompress`, `search_context`, `acp_status`) into the conversation. The model calls `compress` when the conversation grows, and the proxy executes it server-side — the compressed ranges are folded into the conversation history before the next turn.

An opt-in fifth tool, `absorb` (`compress.absorb.enabled: true` — see [CONFIGURATION.md](CONFIGURATION.md)), compresses **individual tool results the moment they arrive**: large results (builds, logs, greps) get a forced absorb instruction, the model distills each into a compact summary, and the original pair is hidden from the wire from the next turn on — keeping mid-session pressure lower between fold rounds (#605).

### Two compression modes — who executes `compress`

The proxy runs in one of two modes, and **the mode decides who executes
`compress`, which in turn decides how the summary travels to the model** (the
"carrier"). This distinction is the root of #377.

| | **Launcher / plugin mode** (`bili pi`, `bili codex`, …) | **Proxy mode** (plain client → `/bili/`) |
|---|---|---|
| Client | ACP-native agent with the bili extension (pi/omp) | Any OpenAI/Anthropic client, no extension |
| Who executes `compress` | **The agent** (pi runs it locally) | **The proxy** (server-side compress loop) |
| `compress` tool call in the re-sent history? | Yes — part of the agent's own conversation | No — ephemeral proxy-loop traffic |
| Preflight blocks (no tool call)? | Last-resort backstop — the agent normally compresses on its own `compress` calls, but `src/preflight.ts` still fires (in both modes) when the input alone exceeds the window (#470) | Yes — `src/preflight.ts` compresses behind the client's back |
| **Summary carrier on the wire** | **the `compress` tool call** | **an `acp_summary` user message** |
| System messages on the wire | always exactly 1 (client + prompt) | always exactly 1 (client + prompt) — summaries ride on user messages |
| SGLang "single system" 400 (#377) | cannot happen | cannot happen (summaries are user messages, not system) |
| Proxy-injected `compress` tools | none — the agent registers the 4 ACP tools natively | the 4 context tools (when enabled) |
| Proxy-injected nudge | **yes** — the agent has no nudge channel of its own, so the proxy-side nudge is the proactive compression trigger (preflight alone only fires at the hard limit; #451) | yes (when enabled) |

**Why the carriers differ.** In plugin mode the agent owns compression: the
`compress` call + result live in the agent's own history and are re-sent every
turn, so the summary rides on the tool call and the agent's view never renders
the kernel's `acp_summary` fallback (`billion-context-pi` `src/messages.ts`
skips `acp_summary_*`). In proxy mode the client is not ACP-native, so the
proxy executes `compress` server-side; the tool call never enters the client's
history, and preflight blocks have no tool call at all — so the kernel's
`acp_summary` message is the only carrier. The kernel renders it as role
`system`, but strict OpenAI-compatible backends (SGLang) require exactly one
system message at index 0, so `systemToUser` (`src/util.ts`) re-voices it as a
`user` message, leaving it at its anchor position. This keeps the head system
message (the prefix-cache anchor) byte-stable across compress turns, so a new
block does not invalidate the whole-conversation prefix.

**Why `user`, not `system` or a forged tool call.** A mid-stream `system`
message is what SGLang rejects (#377). A forged `compress` tool call would be
the "pure" carrier, but in proxy mode it requires fabricating an
assistant `tool_calls` + `user` `tool_result` pair by id, declaring the tool in
the request, and handling preflight blocks that have no authentic call — far
more invasive than re-voicing a standalone note. A `user` message is allowed
anywhere in the conversation, so it is the minimal change that satisfies both
SGLang's one-system rule and prefix-cache stability. The accepted trade-off:
a summary is a stand-in for the folded history, and re-voicing it as a user
turn is a semantic mismatch the model tolerates (it is clearly marked
`[Compressed conversation section]`).

**Do the two modes coexist?**

- **Same proxy instance: yes, by design.** One proxy serves plugin and plain
  clients at once; `pluginMode` is decided per request (`x-bili-plugin` header)
  and bound per session (`session.metadata.pluginAgent`). The launcher reuses a
  running proxy.
- **Same session: the mode is sticky.** A session created in plugin mode stays
  plugin mode (metadata inheritance); a plain session can only be *upgraded* to
  plugin mode if a plugin request arrives with a matching conversation id (the
  header outranks) — and never downgraded. In practice a plain→plugin upgrade
  requires the plugin client's conversation id to match an existing plain
  session id, which doesn't happen (each client generates its own id).
- **Cross-mode block hazard: theoretical only.** It would require the same
  conversation id to span a mode switch. plugin→proxy is safe (the tool call is
  in the shared history); proxy→plugin could orphan proxy-created block
  summaries (their tool call isn't in the agent's history and the agent's view
  skips `acp_summary`) — but that needs the id match above, which doesn't occur.

**Verifying that a compression actually landed.** After executing `compress`,
the proxy emits a confirmation marker (`📦 [ACP] Compressed …`) as plain
assistant text — but under sustained context pressure a model was observed
*writing that marker format itself* without ever calling the tool (#717): 17
fake "compressions" over ~2 hours while real usage climbed to 89%. A marker
line visible in the transcript is therefore not proof of persistence — verify
with `acp_status` (block count increased, compressible-range start advanced)
before trusting it. As a backstop, the proxy strips any marker-shaped line the
model emits on its own and logs a `[marker-echo]` warning, and both the nudge
and the injected prompt state explicitly that markers are proxy-emitted only.


## Which do I need?

Pick by your client:

| Client | Use |
|---|---|
| **pi** | [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) (in-process extension) |
| **opencode 1.x** | `bili plugin install opencode` (self-spawning native plugin — pre-migration [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) sessions keep working, see "OpenCode 1.x") or `bili opencode` (launcher) or standalone `opencode-acp` (in-process extension) |
| **opencode 2.0+** | `bili opencode` (built-in V2 plugin — native tools, no separate package) or `bili plugin install opencode` (self-spawning native plugin, no launcher) |
| **omp** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili omp` (built-in plugin) |
| **dsh** | `bili dsh` (launcher — full native plugin via `--patch`: tools, session-bound `/acp`, fetch intercept) or `bili plugin install dsh` (self-spawning native plugin, no launcher — writes the cordis patch into every profile under `~/.dsh/profiles/*/cordis.patch.yml`) or `dsh plugin --profile <name> add billion-context` (dsh-side install, no bili commands — mounts the bundled patch layer from npm) |
| **jcode** | [`billion-context`](https://github.com/ranxianglei/billion-context) via `bili jcode` (launcher, cert-MITM) or `/bili/` prefix — no native plugin possible: compiled Rust binary with no plugin seam, and its static per-provider config can't stamp per-request headers ([#962](https://github.com/ranxianglei/billion-context/issues/962)) |
| **everything else** (no context hook) | [`billion-context`](https://github.com/ranxianglei/billion-context) — `bili <client>` (launcher, preferred) or `/bili/` prefix |

**Native mode vs standalone extensions.** The host-native plugins (`bili plugin install pi` / `opencode` — they spawn the proxy inside the host process) and the standalone in-process extensions (`billion-context-pi`, `opencode-acp`) are **mutually exclusive**: both active means double compression. The installer makes the switch: `bili plugin install pi` replaces the legacy `npm:billion-context-pi` entry (with a reminder that a project-scope entry in `<project>/.pi/settings.json` from `pi install -l` lives outside the global settings), and `bili plugin install opencode` strips legacy `opencode-acp` entries from the global opencode.json — bare name, `npm:` alias, versioned (`opencode-acp@stable`), or path form, array or object shape; the original config is snapshotted to `.bili-bak` once. A **project-local** install (`opencode plugin opencode-acp` writes `<project>/.opencode/opencode.json`, not the global config) is not touched — remove it by hand; the installer note reminds you. As a runtime safety net for manual installs, the native entries set `BILLION_CONTEXT_NATIVE=<host>` synchronously at load so a standalone extension can stand down at action time — its own load-time `BILLION_CONTEXT_PROXY` check cannot see a proxy that native mode spawns asynchronously, and its `/bili/` baseUrl check never sees the fetch-layer rewrite. On the pi side the marker needs `billion-context-pi` **0.1.72+** (the per-event re-check landed after 0.1.71); the pi-native entry additionally scans both pi settings files once its proxy is up and warns loudly when it spots a co-resident legacy entry the installer never saw — that warning is the only visible signal while an old `billion-context-pi` silently double-compresses.

**Legacy sessions from opencode-acp (v1 lane routing).** On OpenCode 1.x, `bili plugin install opencode` keeps pre-migration sessions WORKING: the native entry absorbs the installed `opencode-acp` package (imported directly from `node_modules` — `.opencode/node_modules`, project `node_modules`, global npm root, or opencode's config-scope modules, first hit wins) and routes per session. A session is legacy iff opencode-acp's persisted state file exists (`<XDG_DATA_HOME>/opencode/storage/plugin/acp/<sessionID>.json`):

- **Legacy session** — compression runs through the absorbed opencode-acp (its own `<dcp-message-id>` refs and block store keep working: `compress` / `decompress` / `search_context` / `acp_status` / `acp_context_recap` all execute in it). Its model requests carry `x-bili-plugin-bypass: 1`, and the proxy forwards them VERBATIM — no wire injection, no nudge, no session binding.
- **New session** — bili owns it: tool calls forward to the proxy's plugin endpoints (plugin mode). The tool slots the model sees carry the DCP schemas (one def per name process-wide on v1), but the executor routes by session lane, so a new session's `compress` reaches the proxy while a legacy session's reaches opencode-acp. `acp_context_recap` has no proxy counterpart — on new sessions the proxy answers it with its unknown-tool message.

`/acp` and `/dcp` route the same way. Adoption of new sessions into opencode-acp's registry is prevented by gating its transforms (system / messages / text.complete) on the legacy predicate. Degradation: when the opencode-acp package is absent or fails to import, bili runs alone and legacy sessions behave as read-only archives (old `<acp>` tags render, `decompress` returns `[Block … not found]`, new refs restart from m00001).

## Install

```bash
npm install -g billion-context
```

This installs the `bili` command (`bili-proxy` is kept as an alias).

## Quickstart

Three ways to use it — pick one:

- **Native plugin (no launcher):** `bili plugin install <client>` — bili
  becomes a plugin inside the client; start the client as usual.
- **Launcher (easiest):** one `bili <client>` command brings up the proxy and
  the client together — no real config file is ever touched.
- **URL change (persistent):** prefix your client's baseURL with the proxy
  origin + `/bili/`.

### Option 1 — Native plugin (`bili plugin install pi` / `opencode` / `dsh`)

The proxy lives inside the client: install once, then start the client
exactly as you always do — no launcher command, no env vars, no fixed port,
no URL edits. Supported today for **pi**, **opencode** (1.x and 2.x) and
**dsh**:

```bash
bili plugin install pi          # registers a "billion-context" entry in pi's settings (npm form when bili itself was npm-installed)
bili plugin install opencode    # registers the plugin in opencode's real config + disables native auto-compaction
bili plugin install dsh         # appends a managed block to every ~/.dsh/profiles/*/cordis.patch.yml
bili plugin remove <client>     # undo (dsh restores the placeholder; config snapshots go to .bili-bak)
```

dsh users can skip bili entirely: `dsh plugin --profile <name> add
billion-context` installs the same native plugin through dsh's own plugin
channel (pnpm into the profile, bundled patch layer) — see the dsh section
below.

At load the plugin **spawns its own proxy** (or attaches to a healthy
running one — a parent-pid watchdog tears it down when the client exits),
rewrites model traffic to `<proxy>/bili/<upstream-url>`, registers
`compress` / `decompress` / `acp_status` as native client tools (plugin
mode), and binds the `/acp` panel to the current session. Opt-out envs:
`BILI_NATIVE_PI=0`, `BILI_NATIVE_OPENCODE=0`, `BILI_NATIVE_DSH=0`.

Notes:

- Native mode is **mutually exclusive** with the standalone in-process
  extensions (`billion-context-pi`, `opencode-acp`) — the installer swaps
  the entries and snapshots the original config (`.bili-bak`); migration
  details in the client table above (pi needs `billion-context-pi` 0.1.72+
  to stand down cleanly).
- On OpenCode 1.x, pre-migration `opencode-acp` sessions keep working
  (v1 lane routing, #920) — see "OpenCode 1.x" below.
- `claude` / `codex` / `omp` have companion installs too (an MCP shell and a
  thin extension), but those need a running proxy — they are not native
  mode.
- `jcode` has no native mode at all: it is a compiled Rust binary with no
  plugin or extension seam, its only per-provider request surface is a static
  TOML header table applied verbatim to every request, and its MCP servers
  run in a global pool shared across all sessions — so there is neither a
  way to rewrite model traffic in-process nor one to stamp the per-request
  headers plugin mode requires (`x-bili-plugin`, conversation id,
  runtime-info). Full source-level analysis: [#962](https://github.com/ranxianglei/billion-context/issues/962)
  (closed wontfix). Use `bili jcode`.

### Injection priority — no files unless unavoidable (#535)

bili never owns user data: every launched client runs on its **real home**, so
runtime writes land where the user expects them. When pointing a client at the
proxy, the launcher picks by priority — **env vars first** (proxy/CA envs for
hermes/dsh/codex; the `BILI_PROVIDER_REWRITES` URL manifest for pi/omp,
consumed by their extension's `registerProvider` at load), then **CLI flags or
extension APIs** (codex `-c key=value`, opencode plugin), and **generated files
last** — today only opencode's temp `opencode.json` (deleted on exit) and dsh's
loopback exception: dsh's fetch stack bypasses proxy envs for loopback targets
unconditionally, so local upstreams keep the persistent `~/.dsh-bili` overlay
rewrite until dsh gains a settings-path env or an upstream loopback opt-out.
Overlay dirs created by older versions are left in place and never merged back
into the real home.

### Option 2 — Launcher (`bili pi` / `bili codex` / `bili claude` / `bili omp` / `bili opencode` / `bili hermes` / `bili dsh` / `bili codebuddy` / `bili qoder` / `bili trae` / `bili jcode` / `bili kimi`)

The launcher wraps a client in one command: it starts a proxy on an
independent port (a fresh instance is always spawned — a port is never
reused), then points the client at it — **certificate-based MITM** where the
client honors proxy/CA env vars, or an isolated **`/bili/` config rewrite**
where it doesn't. No real config file is ever edited; the client's own
config is READ to discover which HTTPS upstream hosts it talks to, and those
hosts are whitelisted for MITM so the proxy can TLS-terminate exactly them
and blind-tunnel everything else.

```bash
bili pi                               # launch pi through the proxy — file-free (#535): env + extension registerProvider, real ~/.pi untouched
bili codex                            # launch codex through the proxy
bili claude                           # launch claude through the proxy
bili omp                              # pi-style, file-free (#535): env + extension registerProvider + compaction cancel, real ~/.omp untouched
bili opencode                         # MITM for HTTPS + temp opencode.json (/bili/ for HTTP) + thin /acp plugin; OpenCode 1.x: existing opencode-acp sessions keep working (entries stripped from the clone, package imported as a library, #920); OpenCode 2.0+: built-in V2 plugin with native bili tools, native compaction auto-disabled. Reads the user's opencode.jsonc / opencode.json / config.json (JSONC comments accepted, merged the same way opencode itself merges them); relative local plugin specs (`./x`, `../x`) are re-anchored to absolute paths in the clone — opencode resolves them against the declaring config file's dir (#826)
bili hermes                           # file-free (#535): hermes proxy env (HTTPS_PROXY + HERMES_CA_BUNDLE) — https via CONNECT MITM, http via absolute-form forward proxy; real ~/.hermes untouched
bili dsh                              # deepseek-harness: full native plugin injected via --patch (#941) — compress/decompress/acp_status registered as real dsh tools, requests stamped with the dsh session id (plugin mode), /acp session-bound; non-loopback upstreams ride proxy envs (https MITM, http absolute-form), loopback keeps the overlay DSH_HOME (~/.dsh-bili) rewrite (#535), built-in deepseek route via DEEPSEEK_BASE_URL; dsh native auto-compaction disabled (compaction-basic auto:false)
bili codebuddy                        # Tencent CodeBuddy Code CLI: CODEBUDDY_BASE_URL /bili/ rewrite (OpenAI chat completions wire), budget aligned via CODEBUDDY_AUTO_COMPACT_WINDOW; real ~/.codebuddy untouched
bili qoder                            # qoder: model endpoint is hardcoded https (no /bili/ rewrite possible) — cert-MITM via HTTPS_PROXY + NODE_EXTRA_CA_CERTS, default model hosts whitelisted (#653)
bili trae                             # Trae CLI (ByteDance, closed Go binary, no base-URL override) — cert-MITM via HTTPS_PROXY + SSL_CERT_FILE, model host from TRAE_CLI_API_HOST or the default enterprise gateway (#655)
bili jcode                            # jcode (Rust agent harness) — env-only cert-MITM launch: HTTPS_PROXY + SSL_CERT_FILE, model host api.z.ai whitelisted, local loopback providers stay direct via NO_PROXY
bili kimi                             # Kimi Code CLI (Moonshot): honors standard proxy envs for all traffic EXCEPT an unconditional loopback bypass — non-loopback https via cert-MITM (HTTPS_PROXY + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE), non-loopback http via absolute-form forward proxy; provider/model hosts from ~/.kimi-code/config.toml (KIMI_CODE_HOME respected) or the managed OAuth endpoints when none declared; loopback endpoints inventoried with a manual /bili/ prefix hint (#757)
bili pi --mitm-domain api.foo.com     # add a domain to the MITM whitelist
```

### Option 3 — URL change (`/bili/` prefix)

Start the proxy:

```bash
bili
```

Then just prefix your client's existing baseURL with `http://localhost:8787/bili/`.
The full upstream URL is embedded in the path, so the proxy knows where to
forward without any config:

```
client baseURL before:  https://api.openai.com/v1
client baseURL after:   http://localhost:8787/bili/https://api.openai.com/v1
```

That's it — put your real API key in the client config as usual (the proxy
passes it through untouched). Context windows (gpt-5.1-codex=400K,
glm-5.2=1M, claude-opus-4=200K, …) are looked up from models.dev
automatically.

For per-client configuration examples (OpenCode, Codex, Pi, login-client
MITM, …) see the web UI guide at [http://localhost:8787](http://localhost:8787).

### OpenCode 1.x

On a 1.x host, `bili opencode` runs **new sessions through the bili proxy** and
keeps **existing `opencode-acp` ("legacy") sessions working with their own
machinery** (#920). The launcher strips the `opencode-acp` entry from its temp
config clone (the host never loads it armed), and the thin bili plugin imports
the installed package as a library instead:

- every acp hook is gated on "an acp store file exists for this session"
  (`~/.local/share/opencode/storage/plugin/acp/<sessionID>.json`, or the dir
  from `storagePath` in `acp.jsonc`) — legacy sessions keep their DCP compress /
  decompress / search_context / acp_status tools and the `/dcp` command; new
  sessions are never adopted and run plain proxy mode.
- legacy LLM requests are stamped `x-bili-plugin-bypass: 1`, which the proxy
  honors as raw passthrough (no injection, no compression, no session state).
- in proxy mode the proxy owns the compression tool names: same-named client
  tools in the body are dropped before injection, so upstream sees one
  definition per name.

Graceful degradation: if the package can't be found/imported or isn't v1, the
plugin behaves exactly as before this change — legacy sessions degrade the way
they did when `opencode-acp` self-disabled on `/bili/` baseURLs.

### OpenCode 2.0

OpenCode 2.0 ships a new plugin API (`@opencode/plugin`); the standalone
`opencode-acp` extension is V1-only and does not load under 2.0. Both bili
modes work on 2.0. The 2.x plugin API surface is still moving between builds
(adjacent npm `dev`-channel builds expose different `ctx` shapes), so the
hook/tool details below are version-specific observations, not a stable
contract:

- **Launcher:** `bili opencode` works unchanged. On a 2.x host it injects the
  built-in V2 plugin (`dist/agent/opencode.js`) into the temp config as a temp
  wrapper directory whose `index.js` re-exports the plugin file — 2.x rejects
  bare file paths in the config `plugin` array (directory entries use
  `index.js` as entrypoint); 1.x hosts get the bare file path. Host generation
  is detected with a `--version` probe (a failed probe defaults to the 1.x
  shape). The V2 plugin registers the bili tools natively in-host — compress /
  decompress / search_context / acp_status (+ absorb), JSON-Schema inputs — and
  stamps the proxy headers on every outgoing provider request, so compression
  runs in plugin mode with no wire-level tool injection. Native auto-compaction
  is disabled automatically (`compaction.auto: false`). Every registration is
  defensive (optional chaining): on any 2.x build where a seam is missing or
  never fires, the plugin stays inert and the session transparently runs in
  plain proxy mode (wire-level tool injection) instead of breaking — observed
  on two adjacent `dev` builds (2026-09-13 / 2026-09-14) whose API surfaces
   differ from each other (#754 review probes); conversely verified end-to-end
   on `@opencode/cli` 2.0.3 (native `acp_status` executed through the plugin
   endpoint, zero wire-level injection).
- **Native (no launcher):** with the package installed from npm, run
  `bili plugin install opencode` — it registers a self-spawning plugin in your
  real opencode config and sets `compaction.auto: false`, after which plain
  `opencode` works as-is. No `mcp.bili` MCP face is added by default (the
  native plugin already provides the bili tools, session-bound); pass
  `--with-mcp` to add one — the entry then carries no origin pin, so it
  survives the plugin's ephemeral-port proxy restarts (#926). The entry form
  depends on how THIS bili was installed: an **npm install** writes the bare
  package name (`"plugin":
  ["billion-context"]`) — the package publishes `exports["./server"]` →
  `dist/agent/opencode-native.js`, so opencode loads it through its own
  Npm.add machinery and manages install/upgrade itself; zero absolute paths,
  portable across machines. A **git checkout / dev build** has no published
  entry and falls back to a local shim dir
  (`<configDir>/plugins/billion-context/index.js` → this checkout's
  `dist/agent/opencode-native.js`) — machine-local by construction, not
  portable; re-running install from an npm install migrates the entry back to
  the bare name. At load the plugin bootstraps its own
  proxy (attaches to a healthy instance instead of doubling; parent-pid
  watchdog kills it when opencode exits), routes model-API traffic to
  `<proxy>/bili/<upstream-url>`, and exposes the same native bili tools as
  launcher mode — no fixed port, no env var, no launcher.
  Opt-out: `BILI_NATIVE_OPENCODE=0`. If no proxy can be made healthy, requests
  go direct (uncompressed) with a one-time warning and recover automatically.
  Under a `bili opencode` launch this entry is skipped entirely (the launcher
  owns the proxy).

  The same wrapper serves **OpenCode 1.x** through the V1 `.server()` hooks
  (verified on 1.14.46 and 1.18.31): the `config` hook mutates the shared
  config object in-process to rewrite every provider `options.baseURL` to
  `<proxy>/bili/…` and sets `compaction.auto: false`; `chat.headers` stamps
  the plugin headers per request; `tool` registers the bili tools with real
  zod shapes (zod is a runtime dependency — when it cannot be resolved the
  plugin degrades to plain proxy mode: rewrite only, wire-injected tools);
  the `/acp` command renders the same status panel. Providers **without**
  an explicit `baseURL` (SDK defaults, e.g. bare `@ai-sdk/openai` →
  api.openai.com) are caught by a global `fetch` patch (the pi-native
  mechanism) that reroutes model-API calls to the proxy — verified end-to-end
  on 1.14.46 and 1.18.31 (log: `v1: fetch patch installed`), including the
  OpenAI Responses endpoint. The patch is idempotent and passes
  `/bili/`-wrapped URLs through untouched.
- **Pure proxy:** point the provider baseURL at the proxy like any other
  client:

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

  Note: 2.0 AI-SDK providers require an `apiKey` field even for local
  endpoints that never check it — set any non-empty value.

Caveats: the 2.x line publishes as npm package `@opencode/cli`. Command
support is build-dependent: one pre-release exposed only
list/get/update/remove, while 2.0.x stable lets plugins ADD commands via
`ctx.command.transform((editor) => editor.add(...))` — invocable in the TUI by
accepting the slash-menu completion (Tab + Enter); note `opencode run` mode
dispatches no slash commands at all (they pass through to the model). The
bundled plugin deliberately registers no commands on either shape — call the
`acp_status` tool instead of an `/acp` command. The bundled agent file keeps
the V1 `server()` export alongside the V2 `setup()`, so the same artifact also
loads on hosts ≥ 1.18.29 that support dual-shape plugins. Design note: the V2 plugin is a thin protocol client (no
acp-kernel inside) because the proxy stays the single compression authority,
which eliminates kernel-version drift between agent and proxy — it does not
rely on the plugin API being unable to mutate context (that capability varies
by 2.x build).

#### dsh (deepseek-harness)

Two lanes, same plugin (#941):

- **Launcher:** `bili dsh` injects the full native plugin through a
  `--patch` overlay (`~/.dsh-bili/.bili-acp.patch.yml`) — every profile
  boots with the bili tools registered natively, model requests carry
  `x-bili-plugin` + the dsh session id (plugin mode), and `/acp` is
  session-bound. dsh's native auto-compaction is disabled in the same patch
  (`compaction-basic` → `auto: false`); manual `/compact` stays available.
- **Native (no launcher):** `bili plugin install dsh` appends a managed
  block to every profile's `~/.dsh/profiles/<name>/cordis.patch.yml`
  (markers `# bili begin` / `# bili end`; user entries and comments are
  preserved, a placeholder `[]` root is replaced, removal restores it).
  Run dsh once in each profile first so the profile dirs exist. The plugin
  spawns its own proxy at load (attaches to a healthy one instead of
  doubling; parent-pid watchdog), rewrites model-API traffic to
  `<proxy>/bili/<upstream-url>` via a global fetch patch, registers the
  manifest tools verbatim, and gates plugin-mode headers on tool readiness
  (round 1 rides wire mode). Opt-out: `BILI_NATIVE_DSH=0`. Remove with
  `bili plugin remove dsh`.
- **dsh-side install (no `bili` command needed):** `dsh plugin --profile
  <name> add billion-context` installs the npm package into the profile via
  pnpm and mounts the bundled patch layer (`dsh.bundle.patch.yml`)
  automatically — same plugin, same behavior as the native lane, zero bili
  commands. The installer, the `bili dsh` launcher overlay, and
  `plugin status` all detect bundle-installed profiles and leave them alone
  (cordis rejects duplicate entry ids across layers, so a second
  `id: bili-native` insert would hard-fail dsh boot). Remove with
  `dsh plugin --profile <name> remove billion-context`. Requires a published
  release that carries `dsh.bundle.patch.yml`.

Under a `bili dsh` launch the plugin ATTACHES to the launcher's proxy (no
second spawn). Raw upstream URLs rewrite to `<proxy>/bili/<url>` like
spawn mode (a loopback proxy target is never proxied, so the MITM envs are
simply bypassed); already-routed `/bili/`-prefixed requests pass through
untouched except for header stamping. Known limitation: manual
`/compact` has no dsh-side event hook, so its boundary is left to the
kernel's natural ingest diff (auto-compaction is off, so this is rare).

### Verify

With the proxy running and your config saved, check it answers and that your
first real request shows compression activity in the log:

```bash
# Health check (proxy up + where it forwards)
curl -s http://localhost:8787/__bili/health
# → {"ok":true,"upstream":"https://api.anthropic.com"}

# Live session stats (after a real request)
curl -s http://localhost:8787/__bili/stats
```

Then send one message from your client and watch the log
(`~/.local/state/billion-context/bili.log`, also printed to stderr). You
should see a `processTurn` line per request, and once the conversation grows,
`[acp-usage] round N input=X cached=Y (cache hit Z%)` + a `compress` event.

### Client uses `http.proxy` (CONNECT) but nothing compresses

Some clients (VS Code-based IDEs: CodeBuddy, Cursor, Windsurf, …) only offer an HTTP **proxy** setting (`http.proxy`, `codingcopilot.httpProxyURL`, …) — no model base-URL to rewrite. Such clients send `CONNECT <model-host>:443` through the proxy instead of plain `/bili/…` requests. That path is only decrypted when the model host is on bili's **MITM whitelist**; otherwise bili blind-tunnels the TLS bytes (opaque relay) and can never see — or compress — the model requests (#897).

This failure mode is now loud instead of silent:

- a one-time `BLIND TUNNEL WARNING` per target host in the log, with the fix steps;
- `blindTunnels` (count + exact target hosts) in `curl -s http://localhost:8787/__bili/health` and `/__bili/stats` (loopback-only);
- an `UNDECRYPTED TRAFFIC (instance-level)` section in `acp_status` output while such tunnels exist.

To actually compress such a client: add its model domain to `"mitm".domains` in `billion-context.json` (e.g. `"mitm": { "domains": ["copilot.tencent.com"] }`) or via `BILI_MITM_DOMAINS`, restart bili, and make the client trust bili's root CA (`NODE_EXTRA_CA_CERTS=~/.local/share/billion-context/ca/root-ca.pem` for Node-based clients, or the client's own CA-path setting). The `/bili/` prefix trick does not apply here — there is no URL to change. Details: [CONFIGURATION.md → MITM](CONFIGURATION.md#mitm-transparent-proxy-login-clients).

## Running the proxy

### Flags

```bash
bili --port 9000              # change listen port
bili --host 0.0.0.0           # listen on all interfaces (see host note below)
bili --debug                 # verbose logging (also: set "debug": true in config)
bili --passthrough           # forward without compression (smoke-test mode)
bili --config ~/my-bili.json # use a different config file
bili update                  # check & install a newer version now (bypasses throttle)
bili --no-auto-update        # disable self-update for this run
```

Flags override env vars and the config file. `bili --help` lists them all.

### Remote agents (`--host`)

By default the proxy binds `127.0.0.1` and only accepts loopback
connections. To serve agents on other machines, bind a non-loopback host:

```bash
bili --host 0.0.0.0           # all interfaces (or use your LAN IP)
```

- Remote agents point their model `baseURL` at `http://<this-host>:<port>/bili/…`.
- MITM-mode `CONNECT` then also accepts remote clients — for **whitelisted
  model hosts only**. Blind tunnels to arbitrary hosts stay loopback-only, so
  the proxy can never be used as an open relay.
- The `/bili/<absolute-url>` tunnel has destination admission (#409): the
  proxy itself and link-local/metadata addresses are **always denied**;
  loopback/private destinations are allowed for local clients (self-hosted
  upstreams) and **denied for remote clients** unless listed in
  `BILI_TUNNEL_ALLOWED_HOSTS` (`host` or `host:port`, comma-separated) — a
  remote peer must not use the proxy as an SSRF pivot into your LAN, and the
  management plane is unreachable through the tunnel even via NAT hairpin
  (tunneled requests carry an internal `x-bili-tunnel` marker that `/__bili/`
  rejects).
- There is **no authentication**: only do this on a trusted LAN or behind a
  firewall. The `/__bili/` management endpoints remain loopback-only.
- A startup `[security]` warning reminds you of the above.

### Debugging

Three ways to enable verbose logging (priority: flag > env > config):

1. **CLI flag** (quickest): `bili --debug`
2. **Env var**: `ACP_DEBUG=1 bili`
3. **Config file**: `"debug": true` in `billion-context.json`

Verbose mode logs every `processTurn` (tag counts, token usage), the nudge
decision (growth/usage/pendingT1/shouldInject), client headers, and SSE
rewrites.

### Log file

All logs are **tee'd to a file by default**: `~/.local/state/billion-context/bili.log`
(XDG state dir). They also still print to stderr so a foreground `bili start`
shows them in the terminal.

```bash
# Config:  "logFile": "/custom/path.log"
# Env:     ACP_LOG_FILE=/custom/path.log   (or ACP_LOG_FILE=off to disable the file)
```

The file auto-rotates at 10 MB (renamed to `bili.log.old`). Cache-hit stats
per request are logged as `[acp-usage] round N input=X cached=Y (cache hit Z%)`
so you can measure prefix-cache health directly from the log.

### Self-update

The proxy checks npm for a newer version on startup and every 3 minutes. When a
newer version is found it installs it globally (`npm install -g`) and logs a
notice — **restart `bili` to pick up the new version**.

Disable permanently via config (`"autoUpdate": false`) or env
(`ACP_AUTO_UPDATE=0`).

## Configuration

The full configuration reference — config file location, top-level keys,
providers, compression tuning, environment variables — lives in
**[CONFIGURATION.md](CONFIGURATION.md)**.

### Upstream proxy (firewall / GFW)

If the proxy's own outbound connections to a model provider are blocked
(e.g. `api.openai.com` from inside the GFW), configure an **upstream proxy**
(the local v2rayA / clash HTTP port) so the proxy reaches the provider:

```jsonc
{
  // Global default: ALL providers route through this proxy
  "proxy": "http://127.0.0.1:20172",
  "providers": {
    "https://api.openai.com/v1": {
      // Per-URL overrides global (use a different proxy for this host)
      "proxy": "http://127.0.0.1:20173",
      "models": { "gpt-5": { "context": 400000 } }
    },
    "https://open.bigmodel.cn/api/anthropic": {
      // Empty string = explicitly DIRECT, overriding the global proxy
      "proxy": "",
      "models": { "glm-5.2": { "context": 1000000 } }
    }
  }
}
```

Rules:
- **Per-URL `proxy`** has the highest priority for its matching provider URL.
- Remaining priority is `BILI_UPSTREAM_PROXY` → Web UI manual proxy → top-level
  `proxy` → `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows system proxy
  → direct.
- Empty string `""` means **explicitly direct** (override-and-disable).
- Auto mode honors `NO_PROXY` and the Windows proxy bypass list for
  environment/system fallbacks. A proxy pointing back to bili's own local port
  is ignored or rejected to prevent a loop.
- HTTP and HTTPS proxy origins are supported. SOCKS5 is not supported yet.
- Both outbound paths are covered: `/bili/` path-mode (fetch) AND MITM CONNECT
  tunnels (the proxy's connection to the real upstream goes through the HTTP
  CONNECT proxy).
- The auto-updater's own egress (npm registry check + tarball download) uses
  the same decision for its hosts, so `bili update` and auto-update work on
  hosts where npm is only reachable through the proxy (#609).

Env override: `BILI_UPSTREAM_PROXY=http://127.0.0.1:20172` (higher priority than
the config file). On Windows, common Clash/Mihomo static system proxies are
discovered automatically; the Web UI shows the effective source and any PAC
URL detected in Internet Settings.

**MITM vs `/bili/` — distinguishing the key scheme.** A login client
(ZCode via MITM) and an API-key client can both hit the same host
(`open.bigmodel.cn`). To let their config differ, MITM traffic uses a
`mitm://` scheme in the lookup key while `/bili/` traffic uses the real
`https://`:

| Client | Lookup key example |
|---|---|
| ZCode (MITM, login) | `mitm://open.bigmodel.cn` |
| API-key client (`/bili/`) | `https://open.bigmodel.cn/api/anthropic` |

So you can give ZCode its own proxy without affecting API-key clients:
```jsonc
{
  "providers": {
    "mitm://open.bigmodel.cn":            { "proxy": "http://127.0.0.1:20173" },
    "https://open.bigmodel.cn/api/anthropic": { "proxy": "http://127.0.0.1:20172" }
  }
}
```

### Wire-compat role rewrite (`compat.roles`)

Some upstreams reject the `developer` role newer codex clients send on the
Responses API (`400 Invalid role: developer`). `compat.roles` maps roles to
what the upstream accepts — applied at the forward boundary to the final
`openai`/`responses` body (client-sent roles **and** bili's own injected
prompt alike), global or per-provider, default off = byte-for-byte:

```jsonc
{
  "compat": { "roles": { "developer": "system" } },
  "providers": {
    "https://picky.example.com": { "compat": { "roles": { "developer": "user" } } }
  }
}
```

**No configuration needed for the common case.** When an upstream answers a
request with `400 Invalid role: …`, bili auto-rewrites the offending role to
`system`, retries the request once, and — if the retry succeeds — remembers
the mapping **for that session only** (nothing is written to your config).
Later requests in the session skip the 400 round-trip. The log line printed
when the auto-fix fires includes a copy-paste per-provider snippet if you
want the mapping permanently.

## How sessions work

The proxy needs a stable per-conversation identifier to isolate compression
state across concurrent users/accounts. It derives one from four dimensions
(see `src/session-id.ts`): **protocol × upstream origin × API key ×
conversation**. The first three prevent cross-account / cross-provider
bleeding; the conversation dimension comes from whatever the client sends.

Clients differ in what they send:

| Client | Sends conversation id? | Source | Safety |
|---|---|---|---|
| **Codex** (0.147+) | ✅ yes | `body.session_id` (per-conversation UUID) | ✅ safe |
| **OpenCode** | ✅ yes | `x-session-affinity` header (`ses_…`) | ✅ safe |
| **pi** | ❌ **no** | nothing | ⚠️ **collision risk** |

When the client sends an explicit id, the proxy uses it directly. When it
does not (pi), the proxy falls back to hashing the first user message — so
two conversations that start with the same opener collapse onto the same
session. This does **not** corrupt data (per-message refs use a separate
content fingerprint that stays stable), but it can skew nudge/compression
timing and occasionally over-eagerly reap a block. It is self-healing: the
worst case is reduced compression efficiency, never data loss.

For upstream sticky-routing, when the client sends no session header the
proxy synthesizes one (`x-session-id: ses_<hash>`) so cache pools / load
balancers still get a stable key.

**Recommendation:** Codex and OpenCode are safe to run many concurrent
conversations through the proxy. pi is fine for a single agent, but is **not
recommended** for many concurrent conversations because of the collision
risk — until pi grows its own session-id signal. For pi multi-agent use,
pass an explicit `x-acp-session` header per conversation to avoid collisions.

### Windows: exclude the sessions dir from antivirus (#362)

The proxy persists each session's compression state to the sessions dir
(`%USERPROFILE%\.local\share\billion-context\` by default) and rewrites the
file every turn of a long session. Persisted per session: the compression
state (block summaries), the compressed originals cache (`blockContents`,
what `bili export --full` recovers), and a bounded folded-view snapshot of
the recent conversation (newest `BILI_PERSIST_TAIL_TOKENS` tokens, default
16k) — the raw full history is never duplicated on disk (#401). On
Windows, real-time antivirus (Windows
Defender), the search indexer, or a sync tool (OneDrive) can lock that
directory mid-write, so the rename fails with `EPERM` and every persist for
that session fails until the lock clears.

When the same session fails N consecutive writes (default `5`), the proxy
logs a one-time, actionable alert naming the directory to exclude. To fix it
at the root: add `%USERPROFILE%\.local\share\billion-context\` to your
antivirus **exclusions** (Windows Defender: Settings → Virus & threat
protection → Manage settings → Exclusions → Add an exclusion → Folder) and
make sure no sync tool (OneDrive / Dropbox / …) is syncing that path. Full
steps in [CONFIGURATION.md](CONFIGURATION.md#windows-exclude-the-sessions-dir-from-antivirus-362).

## Status

Early. Protocol handling and compression work against mock tests (500+ passing). Real-model integration testing is the next milestone. Expect rough edges.

Client-side plugins for pi / omp / opencode ship inside `billion-context` (`dist/agent/*.js`) for the cooperative-proxy path. See the **"Which do I need?"** section above for how `billion-context`, the standalone `billion-context-pi`, and `opencode-acp` relate.

## Community

QQ group — one shared group for all three projects ([`billion-context`](https://github.com/ranxianglei/billion-context), [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi), [`opencode-acp`](https://github.com/ranxianglei/opencode-acp)): **1056132097**

## License

MIT
