import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig, defaultPrompts } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue847-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function makeCtx(messages: CoreMessage[], config?: Config): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

test("#847: acp_status lists only ranges that pass the submit gate (chars >= minCompressRange)", () => {
    // One large run (3 x 2000 chars = 6000 >= 5000 gate), then a user boundary,
    // then a small tail (~1502 chars < 5000 but >= 200 tokens, so viableRanges
    // alone lets it through — the exact #847 invariant violation). Recent-
    // preservation is zeroed so the whole fixture is outside the soft zone.
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(2000)),
        textMsg("raw_2", "assistant", "b".repeat(2000)),
        textMsg("raw_3", "assistant", "c".repeat(2000)),
        textMsg("raw_4", "user", "ok"),
        textMsg("raw_5", "assistant", "d".repeat(1500)),
    ];
    const ctx = makeCtx(msgs, defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }));
    assert.equal(ctx.config.compress.minCompressRange, 5000, "fixture sanity: default gate is 5000 chars");

    const report = handleAcpStatus({}, ctx);
    const idx = report.indexOf("Compressible ranges");
    assert.ok(idx !== -1, "ranges section present");
    const section = report.slice(idx);
    assert.ok(section.includes("m00001"), "large range m00001–m00003 listed");
    assert.ok(!section.includes("m00004"), "sub-gate tail range must NOT be listed");
    assert.ok(!section.includes("m00005"), "sub-gate tail range must NOT be listed");
});

test("#847: reversed refs surface an explicit note on gate failure instead of silent normalization", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    const ctx = makeCtx(msgs);
    const out = applyRanges(parseCompressInput(compressArgs("m00002", "m00001")), ctx);
    assert.ok(out.startsWith("[Compression FAILED:"), `gate rejection expected (got: ${out.slice(0, 100)})`);
    assert.match(out, /Total compressible content too small \(1600 chars/, "normalized span was evaluated (kernel swapped bounds)");
    assert.match(out, /reversed/, "explicit reversal note present");
});

test("#847: repeated identical failing spec escalates; success clears the streak", () => {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    const ctx = makeCtx(msgs);

    const first = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx);
    assert.ok(first.startsWith("[Compression FAILED:"), `first attempt fails at gate (got: ${first.slice(0, 100)})`);
    assert.ok(!first.includes("Repeat-failure guard"), "first failure carries no escalation");

    const second = applyRanges(parseCompressInput(compressArgs("m00002", "m00001")), ctx);
    assert.ok(second.startsWith("[Compression FAILED:"), "second attempt fails identically (reversed spec normalizes to the same key)");
    assert.match(second, /Repeat-failure guard/, "escalation on repeat");
    assert.match(second, /2 time\(s\)/, "occurrence count reported");
    assert.match(second, /acp_status/, "escalation points at acp_status");

    const third = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx);
    assert.match(third, /3 time\(s\)/, "alternating direction still counts as the same spec");

    const success = applyRanges(parseCompressInput(compressArgs("m00003", "m00008")), ctx);
    assert.ok(success.startsWith("[Compressed "), `large range compresses (got: ${success.slice(0, 100)})`);
    assert.equal(ctx.session.metadata["compressFailKeys"], undefined, "streak cleared on success");

    const after = applyRanges(parseCompressInput(compressArgs("m00001", "m00002")), ctx);
    assert.ok(after.startsWith("[Compression FAILED:"), "small range still fails after the successful compress");
    assert.ok(!after.includes("Repeat-failure guard"), "streak restarted after the clear");
});

test("#847: preflight reports honest exhaustion when every listed range is sub-gate, without calling upstream", async () => {
    const session = getSession(`issue847-preflight-${randomUUID()}`);
    session.stats.lastInputTokens = 6000;
    const messages: CoreMessage[] = [
        textMsg("p_1", "user", "u".repeat(100)),
        textMsg("p_2", "assistant", "a".repeat(1500)),
        textMsg("p_3", "user", "u".repeat(100)),
        textMsg("p_4", "assistant", "a".repeat(1500)),
        textMsg("p_5", "user", "u".repeat(100)),
        textMsg("p_6", "assistant", "a".repeat(1500)),
    ];
    const logs: string[] = [];
    const deps: PreflightDeps = {
        core: createCore(),
        session,
        config: defaultConfig(6000),
        prompts: defaultPrompts,
        protocol: "openai",
        // Port 9 (discard) refuses connections immediately: if preflight ever
        // tried to spend a summarization call on a sub-gate chunk, this would
        // surface as an "upstream" failure instead of "exhausted".
        url: "http://127.0.0.1:9/v1/chat/completions",
        headers: {},
        model: "test-model",
        log: (_level, msg) => { logs.push(msg); },
    };
    const result = await preflightCompress(deps, messages);
    assert.equal(result.compressedRanges, 0, "nothing compressed");
    assert.equal(result.failure?.kind, "exhausted", `honest exhaustion, not an upstream call (got: ${JSON.stringify(result.failure)})`);
    assert.match(result.failure?.detail ?? "", /no compressible ranges remain/i, "does not misreport sub-gate ranges as tried viable ranges");
    assert.equal(session.state.blocks.length, 0, "no blocks created");
});
