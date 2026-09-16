import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import biliOpencodePlugin from "../src/agent/opencode.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";
import { fetchManifest } from "../src/agent/shared.ts";

const EXPECTED_TOOLS = [...ACP_TOOLS_OPENAI.map((t) => t.function.name), ABSORB_TOOL_OPENAI.function.name];

function startFakeProxyV2(): Promise<{ origin: string; toolCalls: Array<{ conversationId?: string; tool?: string; args?: unknown }>; compacts: string[]; close: () => Promise<void> }> {
    const toolCalls: Array<{ conversationId?: string; tool?: string; args?: unknown }> = [];
    const compacts: string[] = [];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId?: string; tool?: string; args?: unknown };
                toolCalls.push(data);
                res.writeHead(200, { "content-type": "application/json" });
                if (data.tool === "acp_status") {
                    res.end(JSON.stringify({ ok: true, result: "STATUS-RESULT" }));
                } else {
                    res.end(JSON.stringify({ ok: false, error: `boom-${data.tool}` }));
                }
            });
            return;
        }
        if (url === "/__bili/plugin/compact" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId?: string };
                compacts.push(data.conversationId ?? "");
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        toolCalls,
        compacts,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }));
}

interface FakeAddedTool {
    name: string;
    description?: string;
    input: unknown;
    options?: Record<string, unknown>;
    execute: (input: Record<string, unknown>, ctx: { sessionID: string }) => Promise<{ content: string }>;
}

function makeFakeCtx() {
    const eventQueue: Array<{ type?: unknown; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let signal: AbortSignal | undefined;
    const addedTools: FakeAddedTool[] = [];
    let modelRequestCb: ((e: Record<string, unknown>) => void | Promise<void>) | undefined;
    const disposed: number[] = [];

    const ctx = {
        session: {
            hook: async (name: string, cb: (e: Record<string, unknown>) => void | Promise<void>) => {
                assert.equal(name, "http.request");
                modelRequestCb = cb;
                return { dispose: () => { disposed.push(1); } };
            },
        },
        tool: {
            transform: async (cb: (editor: { add: (t: FakeAddedTool) => void }) => void) => {
                cb({ add: (t) => addedTools.push(t) });
                return { dispose: () => { disposed.push(2); } };
            },
        },
        event: {
            subscribe: (opts?: { signal?: AbortSignal }) => {
                signal = opts?.signal;
                signal?.addEventListener("abort", () => { closed = true; wake?.(); }, { once: true });
                return {
                    [Symbol.asyncIterator]: (): AsyncIterator<{ type?: unknown; data?: Record<string, unknown> }> => ({
                        next: async () => {
                            while (eventQueue.length === 0 && !closed && !signal?.aborted) {
                                await new Promise<void>((r) => (wake = r));
                            }
                            wake = undefined;
                            const v = eventQueue.shift();
                            return v === undefined ? { done: true as const, value: undefined } : { done: false as const, value: v };
                        },
                    }),
                };
            },
        },
        catalog: {
            model: {
                list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }),
            },
        },
    };

    return {
        ctx,
        fireModelRequest: async (opts: { sessionID?: unknown; baseURL?: unknown; model?: unknown }) => {
            const store: Record<string, string> = {};
            await modelRequestCb!({
                sessionID: opts.sessionID,
                model: opts.model,
                request: {
                    url: opts.baseURL,
                    headers: { set: (k: string, v: string) => { store[k] = v; } },
                },
            });
            return { headers: store };
        },
        pushEvent: (evt: { type?: unknown; data?: Record<string, unknown> }) => { eventQueue.push(evt); wake?.(); },
        get addedTools() { return addedTools; },
        get disposed() { return disposed; },
    };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 10));
    }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

test("object export: .id/.setup for V2 and .server for V1 >= 1.18.29", () => {
    assert.equal(typeof biliOpencodePlugin, "object");
    assert.ok(biliOpencodePlugin !== null);
    assert.equal(biliOpencodePlugin.id, "billion-context-opencode");
    assert.equal(typeof biliOpencodePlugin.setup, "function");
    assert.equal(typeof biliOpencodePlugin.server, "function");
});

test("v2 setup: registers the bundled bili tools synchronously with exact schema parity", async () => {
    const fake = makeFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
        try {
            assert.deepEqual(fake.addedTools.map((t) => t.name), EXPECTED_TOOLS);
            for (const t of fake.addedTools) {
                assert.equal(t.options?.codemode, false);
                assert.equal(t.options?.permission, "allow");
            }
            const compressSrc = [...ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI].find((t) => t.function.name === "compress")!;
            assert.deepEqual(fake.addedTools.find((t) => t.name === "compress")!.input, compressSrc.function.parameters);
        } finally {
            cleanup();
        }
    });
});

test("v2 setup: inert without proxy detection (tools present but no headers, no forwarding)", async () => {
    const fake = makeFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
        try {
            const res = await fake.fireModelRequest({ sessionID: "s1", baseURL: "http://upstream.example/v1" });
            assert.deepEqual(res.headers, {});
            const out = await fake.addedTools[0].execute({}, { sessionID: "s1" });
            assert.match(out.content, /no proxy detected/);
        } finally {
            cleanup();
            assert.ok(fake.disposed.includes(1) && fake.disposed.includes(2));
        }
    });
});

test("v2 setup: inert-safe when the host exposes none of the V2 seams", async () => {
    const cleanup = await biliOpencodePlugin.setup({} as never);
    assert.equal(typeof cleanup, "function");
    cleanup();
});

test("v2 setup: kill switch stays inert even with /bili/ URL + proxy env", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const res = await fake.fireModelRequest({ sessionID: "s1", baseURL: `${proxy.origin}/bili/http://upstream.example/v1` });
                assert.deepEqual(res.headers, {});
                const out = await fake.addedTools.find((t) => t.name === "compress")!.execute({ content: [] }, { sessionID: "s1" });
                assert.match(out.content, /disabled \(BILLION_CONTEXT_PLUGIN=0\)/);
                assert.equal(proxy.toolCalls.length, 0);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: activates from /bili/ baseURL on round 1, stamps headers, forwards tools", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const r1 = await fake.fireModelRequest({
                    sessionID: "ses_v2_1",
                    baseURL: `${proxy.origin}/bili/http://upstream.example/v1`,
                    model: { providerID: "qwen", id: "m1" },
                });
                assert.equal(r1.headers["x-bili-plugin"], "opencode");
                assert.equal(r1.headers["x-bili-plugin-conversation"], "ses_v2_1");
                // window header needs the async catalog fetch — lands from round 2
                const r2 = await fake.fireModelRequest({
                    sessionID: "ses_v2_1",
                    baseURL: `${proxy.origin}/bili/http://upstream.example/v1`,
                    model: { providerID: "qwen", id: "m1" },
                });
                await until(() => r2.headers["x-bili-plugin-context-window"] === "262144");

                const out = await fake.addedTools.find((t) => t.name === "compress")!.execute({ content: [] }, { sessionID: "ses_v2_1" });
                assert.match(out.content, /boom-compress/);
                assert.equal(proxy.toolCalls.at(-1)?.conversationId, "ses_v2_1");
                assert.equal(proxy.toolCalls.at(-1)?.tool, "compress");

                const statusOut = await fake.addedTools.find((t) => t.name === "acp_status")!.execute({}, { sessionID: "ses_other" });
                assert.equal(statusOut.content, "STATUS-RESULT");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: env-based activation without /bili/ URL", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const res = await fake.fireModelRequest({ sessionID: "s2", baseURL: "http://real-upstream.example/v1" });
                assert.equal(res.headers["x-bili-plugin"], "opencode");
                assert.equal(res.headers["x-bili-plugin-conversation"], "s2");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: session.compaction.ended reports boundary to proxy archive", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                await fake.fireModelRequest({ sessionID: "s3", baseURL: "http://u.example/v1", headers: {} });
                fake.pushEvent({ type: "session.compaction.ended", data: { sessionID: "s3", reason: "manual" } });
                fake.pushEvent({ type: "session.created", data: { info: { id: "nope" } } });
                await until(() => proxy.compacts.includes("s3"));
                assert.deepEqual(proxy.compacts, ["s3"]);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: cleanup aborts event subscription and disposes registrations", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            await fake.fireModelRequest({ sessionID: "s4", baseURL: "http://u.example/v1", headers: {} });
            cleanup();
            assert.ok(fake.disposed.includes(1), "model.request hook registration disposed");
            assert.ok(fake.disposed.includes(2), "tool transform registration disposed");
        });
    } finally {
        await proxy.close();
    }
});

test("fetchManifest openai format maps parameters to inputSchema", async () => {
    const MANIFEST_OPENAI = [
        { name: "compress", description: "Compress a range", parameters: { type: "object", properties: { content: { type: "array" } }, required: ["content"] } },
        { name: "acp_status", description: "Context status", parameters: { type: "object", properties: {} } },
    ];
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/manifest" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocolVersion: 1, version: "99.0.0-test", tools: { openai: MANIFEST_OPENAI } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const tools = await fetchManifest(origin, "openai");
        assert.deepEqual(tools.map((t) => t.name), ["compress", "acp_status"]);
        assert.deepEqual(tools[0].inputSchema, MANIFEST_OPENAI[0].parameters);
        const anthropic = await fetchManifest(origin, "anthropic").catch((e) => e);
        assert.ok(anthropic instanceof Error, "fake serves no anthropic tools — format must not cross-contaminate");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
