import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function upstreamServer(status: number, onBody: (path: string, rawBody: string) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            onBody(req.url ?? "", Buffer.concat(chunks).toString("utf8"));
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness {
    port: number;
    stop: () => Promise<void>;
    cleanup: () => void;
}

async function startProxy(upstream: http.Server): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-fix806mb-${process.pid}-${Date.now()}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, "{}", "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("anthropic path: parseable body without messages → 400, upstream untouched (#806)", async () => {
    const seen: string[] = [];
    const upstream = await upstreamServer(200, (p) => seen.push(p));
    const harness = await startProxy(upstream);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as Record<string, any>;
        assert.equal(body.type, "error");
        assert.equal(body.error.type, "invalid_request_error");
        assert.match(String(body.error.message), /messages/);
        assert.equal(seen.length, 0, "malformed body must not reach the upstream");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("anthropic path: top-level array body → 400 (used to crash the kernel fingerprint) (#806)", async () => {
    const seen: string[] = [];
    const upstream = await upstreamServer(200, (p) => seen.push(p));
    const harness = await startProxy(upstream);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "[1,2]",
        });
        assert.equal(res.status, 400);
        assert.equal(seen.length, 0);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("openai path: parseable body without messages → 400 openai-shaped error (#806)", async () => {
    const seen: string[] = [];
    const upstream = await upstreamServer(200, (p) => seen.push(p));
    const harness = await startProxy(upstream);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as Record<string, any>;
        assert.equal(body.error.type, "invalid_request_error");
        assert.match(String(body.error.message), /messages/);
        assert.equal(seen.length, 0);
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("valid conversation bodies still pass through to the upstream (#806)", async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const upstream = await upstreamServer(200, (p, b) => seen.push({ path: p, body: b }));
    const harness = await startProxy(upstream);
    try {
        const r1 = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r1.status, 200);
        const r2 = await fetch(`http://127.0.0.1:${harness.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r2.status, 200);
        assert.equal(seen.length, 2);
        assert.ok(seen[0].body.includes('"messages"'));
        assert.ok(seen[1].body.includes('"messages"'));
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("unparseable body stays on the raw-forward path — upstream rejects it itself (#806)", async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const upstream = await upstreamServer(200, (p, b) => seen.push({ path: p, body: b }));
    const harness = await startProxy(upstream);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "not-json",
        });
        assert.equal(res.status, 200, "garbage body must be forwarded verbatim, not rejected by bili");
        assert.equal(seen.length, 1);
        assert.equal(seen[0].body, "not-json");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
