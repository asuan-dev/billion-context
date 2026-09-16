// #300: bili→bili chain marker. When a bili instance forwards a request it has
// processed upstream, it stamps this header with its own instance id. A bili
// instance that RECEIVES a request already carrying it knows an upstream bili
// already ran the compression pipeline on this request — processing it again
// would double-compress and corrupt session state (issue #292). Clients never
// send this header, so its presence on an inbound request always means "came
// from a bili instance".
export const BILI_HOP_HEADER = "x-bili-hop";

// Per-model context windows handed over by a `bili <client>` launcher
// (BILI_LAUNCHER_MODEL_WINDOWS, JSON model-id → window), read from the
// client's OWN config (pi models.json / omp models.yml / …) at launch time.
// Ranked between the plugin report and the models.dev registry in the
// native-window chain — the client's own number is authoritative for its
// deployment (it is what the client itself truncates at), unlike the generic
// registry.
export function parseLauncherModelWindows(raw: string | undefined): Record<string, number> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: Record<string, number> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) out[id] = Math.floor(v);
        }
        return out;
    } catch {
        return {};
    }
}

export const LAUNCHER_MODEL_WINDOWS: Readonly<Record<string, number>> = parseLauncherModelWindows(process.env.BILI_LAUNCHER_MODEL_WINDOWS);

export function launcherContextWindow(model: string): number | undefined {
    return LAUNCHER_MODEL_WINDOWS[model];
}

export const windowSourceLogged = new Set<string>();

/** Parse an `anthropic-beta` header for a larger-context beta (e.g.
 *  `context-1m-2025-08-07` → 1,000,000). The beta lets the CLIENT negotiate a
 *  window beyond the model's standard size, so it is the most direct per-request
 *  evidence of the window the upstream will actually serve — it outranks the
 *  model table / registry (which list the STANDARD window, e.g. 200K for claude)
 *  and must be re-read on every request (the header may appear/disappear between
 *  requests of the same session, #302). `context-Nm` generalizes to future
 *  larger-context betas (N × 1,000,000). Returns the largest requested window,
 *  or undefined when no context beta is present. */
export function anthropicBetaContextWindow(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = headers["anthropic-beta"];
    if (raw === undefined) return undefined;
    const list = Array.isArray(raw) ? raw.join(",") : raw;
    let best: number | undefined;
    for (const part of list.split(",")) {
        const m = /^context-(\d+)m\b/.exec(part.trim().toLowerCase());
        if (!m) continue;
        const n = Number.parseInt(m[1], 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        const w = n * 1_000_000;
        if (best === undefined || w > best) best = w;
    }
    return best;
}
