import type { WireProtocol } from "../util.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../util.js";
import { type ResolvedImageBilling } from "../image-tokens.js";

// #388: side requests (title-gen etc.) share the main session key but must not
// touch kernel state. Identified by a tiny output budget (same heuristic as
// prepareOpenai's isTitleGen); a missing/non-positive budget is never a side req.
// #546: a non-empty tools array marks an agent MAIN turn — clients that size the
// output budget from their raw (uncompressed) history shrink max_tokens to
// <=200 on long sessions; that must never demote the request to a side pass
// (title-gen requests never carry tools).
export const SIDE_REQUEST_MAX_TOKENS = 200;
export function isSideRequest(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    const raw = p.max_tokens ?? p.max_completion_tokens ?? p.max_output_tokens;
    return typeof raw === "number" && raw > 0 && raw <= SIDE_REQUEST_MAX_TOKENS;
}

export type OutputBudgetField = "max_tokens" | "max_completion_tokens" | "max_output_tokens";

export function outputBudgetField(parsed: unknown): OutputBudgetField | null {
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
        if (typeof p[field] === "number" && (p[field] as number) > 0) return field;
    }
    return null;
}

/** #546: clients that derive the output budget from their RAW (uncompressed)
 *  history drive it down to <=200 tokens on long sessions, then truncate every
 *  reply mid-thought — the model cannot even emit a compress tool call, so the
 *  loop can never rescue the session. The proxy's compressed view still fits
 *  the window, so remember the healthy budget per session (last non-starved
 *  value wins) and restore it on tool-carrying main requests whose budget has
 *  starved. Mutates `parsed` in place BEFORE prepare() serializes it. */
export function restoreOutputBudget(
    parsed: unknown,
    session: { id: string; metadata: Record<string, unknown> },
    log: (level: string, msg: string) => void,
): void {
    const field = outputBudgetField(parsed);
    if (!field) return;
    const p = parsed as Record<string, unknown>;
    const value = p[field] as number;
    if (value > SIDE_REQUEST_MAX_TOKENS) {
        session.metadata.outputBudgetHighWater = value;
        return;
    }
    if (!Array.isArray(p.tools) || p.tools.length === 0) return;
    const highWater = session.metadata.outputBudgetHighWater;
    if (typeof highWater === "number" && highWater > SIDE_REQUEST_MAX_TOKENS) {
        p[field] = highWater;
        log("info", `[${session.id}] output budget restored ${value} -> ${highWater} (#546: client shrank it from its raw-history estimate)`);
    }
}

// defaultCountTokens counts CJK per-char but real tokenizers encode CJK at
// ~0.6-0.75 tokens/char, so CJK-heavy raw bodies over-estimate by up to ~1.6x.
// Everywhere else that bias is safe (it only compresses earlier); here it
// would hard-deny a payload that really fits (retryable: false), so tolerate
// 15% over the window — borderline payloads forward, and a real overflow 400
// still teaches the learned limit.
const SIDE_REQUEST_GUARD_TOLERANCE = 1.15;

/** #554: side requests are forwarded VERBATIM (no pipeline, #388), so a payload
 *  over the upstream window is a guaranteed 400 that the learned self-heal can
 *  never fix from this path — the gate fires before the self-heal read and
 *  never consults reqConfig.modelContextLimit. Block here instead of forwarding:
 *  estimate the RAW body (CJK-aware text + image tokens) against the effective
 *  window = resolved ∩ learned (learned only ever shrinks) minus the output
 *  reservation on wires where output counts against the window. blocked=false
 *  with limit<=0 means "window unknown — forward as before". blocked requires
 *  estimate >= limit x SIDE_REQUEST_GUARD_TOLERANCE (estimator bias). */
export function sideRequestGuard(
    parsed: unknown,
    protocol: WireProtocol,
    modelContextLimit: number,
    learnedLimit: number | undefined,
    imageBilling: ResolvedImageBilling = "bytes",
): { blocked: boolean; estimate: number; limit: number } {
    let limit = modelContextLimit;
    if (typeof learnedLimit === "number" && learnedLimit > 0 && learnedLimit < limit) limit = learnedLimit;
    const field = outputBudgetField(parsed);
    const maxOut = field ? ((parsed as Record<string, unknown>)[field] as number) : 0;
    if (limit > 0 && shouldReserveOutputHeadroom(protocol)) limit = reserveOutputHeadroom(limit, maxOut);
    const estimate = estimateRawBodyTokens(parsed) + imageTokensInParsedBody(protocol, parsed, imageBilling);
    return { blocked: limit > 0 && estimate >= limit * SIDE_REQUEST_GUARD_TOLERANCE, estimate, limit };
}
