import assert from "node:assert/strict";
import test from "node:test";
import type { CompressionState, CoreMessage } from "acp-kernel";
import {
    BILI_ACP_TOOLS_ANTHROPIC,
    BILI_ACP_TOOLS_OPENAI,
    BILI_ACP_TOOLS_RESPONSES,
    BILI_COMPRESS_TOOL,
    BILI_COMPRESS_TOOL_OPENAI,
    BILI_COMPRESS_TOOL_RESPONSES,
    COMPRESS_TOOL_NAME,
} from "../src/compress-tool.ts";
import { stripFailedCompressCalls } from "../src/server.ts";

// #743: hosts pre-validate tool args against the served schema and reject a
// missing `content` CLIENT-side, showing the model a bare "content: is
// required" it gives up on instead of retrying. The softened schema routes
// those calls to the executor's rich retry receipt instead.
test("#743: compress schema no longer requires content on any surface", () => {
    for (const schema of [BILI_COMPRESS_TOOL.input_schema, BILI_COMPRESS_TOOL_OPENAI.function.parameters, BILI_COMPRESS_TOOL_RESPONSES.parameters]) {
        assert.ok(!(schema.required ?? []).includes("content"), `content must not be schema-required: ${JSON.stringify(schema.required)}`);
    }
    const anthropic = BILI_ACP_TOOLS_ANTHROPIC.find((t) => t.name === COMPRESS_TOOL_NAME);
    const openai = BILI_ACP_TOOLS_OPENAI.find((t) => t.function.name === COMPRESS_TOOL_NAME);
    const responses = BILI_ACP_TOOLS_RESPONSES.find((t) => t.name === COMPRESS_TOOL_NAME);
    assert.ok(anthropic && openai && responses, "compress tool present on all three surfaces");
    for (const schema of [anthropic!.input_schema, openai!.function.parameters, responses!.parameters]) {
        assert.ok(!(schema.required ?? []).includes("content"));
    }
});

test("#743: compress description tells the model how to recover a rejected call", () => {
    for (const description of [BILI_COMPRESS_TOOL.description, BILI_COMPRESS_TOOL_OPENAI.function.description, BILI_COMPRESS_TOOL_RESPONSES.description]) {
        assert.ok(description!.includes("retry"), "description must point at retry");
    }
});

let seq = 0;
function msg(m: Omit<CoreMessage, "id">): CoreMessage {
    return { id: `m${++seq}`, ...m };
}

const FAILED = "[Compression FAILED: no valid ranges parsed. NOTHING was compressed — the nudge is still pending.]";
const clientRejected = 'Validation failed for tool "compress": content: is required';
const okCall = (toolCallId: string) => msg({ role: "assistant", contentType: "tool-call", toolName: COMPRESS_TOOL_NAME, toolCallId });
const failedResult = (toolCallId: string) => msg({ role: "tool", contentType: "tool-result", toolCallId, text: FAILED });
const successResult = (toolCallId: string) => msg({ role: "tool", contentType: "tool-result", toolCallId, text: "[Compressed m00002-m00007 -> 1 block(s), ~6459 tokens saved]" });
const user = (text: string) => msg({ role: "user", contentType: "text", text });

test("#743: failed compress pair in a closed turn is dropped", () => {
    const messages = [user("investigate"), okCall("tc1"), failedResult("tc1"), user("continue")];
    const out = stripFailedCompressCalls(messages);
    assert.equal(out.length, 2);
    assert.ok(!out.some((m) => m.toolCallId === "tc1"));
});

test("#743: failed compress pair in the current turn is kept for in-place retry", () => {
    const messages = [user("investigate"), okCall("tc1"), failedResult("tc1"), user("continue"), okCall("tc2"), failedResult("tc2")];
    const out = stripFailedCompressCalls(messages);
    assert.equal(out.length, 4);
    assert.ok(out.some((m) => m.toolCallId === "tc2"), "current-turn pair survives");
    assert.ok(!out.some((m) => m.toolCallId === "tc1"), "closed-turn pair dropped");
});

test("#743: client-side validation failures are stripped too", () => {
    const messages = [user("investigate"), okCall("tc1"), msg({ role: "tool", contentType: "tool-result", toolCallId: "tc1", text: clientRejected }), user("continue")];
    const out = stripFailedCompressCalls(messages);
    assert.equal(out.length, 2);
});

test("#743: successful compress calls are never stripped", () => {
    const messages = [user("investigate"), okCall("tc1"), successResult("tc1"), user("continue")];
    const out = stripFailedCompressCalls(messages);
    assert.equal(out.length, 4);
});

test("#743: non-compress tools with failure-looking text are untouched", () => {
    const messages = [
        user("investigate"),
        msg({ role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tc1" }),
        msg({ role: "tool", contentType: "tool-result", toolCallId: "tc1", text: FAILED }),
        user("continue"),
    ];
    const out = stripFailedCompressCalls(messages);
    assert.equal(out.length, 4);
});

test("#743: history without a user message is returned unchanged", () => {
    const messages = [okCall("tc1"), failedResult("tc1")];
    const out = stripFailedCompressCalls(messages);
    assert.equal(out.length, 2);
});
