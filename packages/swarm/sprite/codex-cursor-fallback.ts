import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel, createAssistantMessageEventStream, type AnyModel, type Api, type AssistantMessage,
  type AssistantMessageEvent, type Model, type ModelsSimpleStreamOptions, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CODEX_MODEL = process.env.PI_FALLBACK_PRIMARY_MODEL ?? "gpt-6.2-sol";
const CURSOR_MODEL = process.env.PI_FALLBACK_CURSOR_MODEL ?? "composer-2.5";
const COOLDOWN_MS = Number(process.env.PI_FALLBACK_COOLDOWN_MINUTES ?? "30") * 60_000;

export const PERSONAL_PROVIDER = "openai-codex-personal";
export const TIERS = [
  { label: "work Codex", provider: "openai-codex", model: CODEX_MODEL },
  { label: "Cursor", provider: "cursor", model: CURSOR_MODEL },
  { label: "personal Codex", provider: PERSONAL_PROVIDER, model: CODEX_MODEL },
] as const;

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

const QUOTA_OR_AUTH_FAILURE =
  /usage limit|rate.?limit|quota|too many requests|\b429\b|\b401\b|\b403\b|unauthori[sz]ed|forbidden|insufficient (?:credits|balance|quota)|(?:limit|quota) exceeded|overloaded|credential|log ?in required|not logged in|no api key|authentication failed|(?:expired|invalid|malformed) token|failed to (?:decode|extract accountId from) (?:the )?token/i;

type Cooldowns = Record<string, number>;
type FallbackState = { cooldownUntil: Cooldowns; tried?: string[] };
type AttemptLedger = Set<string>;
const ROUTE_HANDOFF_MS = 120_000;
type AssistantLike = { role?: string; provider?: string; stopReason?: string; errorMessage?: string; timestamp?: number };
type ModelLike = { provider: string; id: string };

function tierOf(provider: string | undefined): number {
  return TIERS.findIndex((tier) => tier.provider === provider);
}

export function isTierFailure(message: AssistantLike | undefined): boolean {
  if (!message || message.stopReason !== "error" || tierOf(message.provider) < 0) return false;
  if (message.provider === "cursor") return true;
  return QUOTA_OR_AUTH_FAILURE.test(message.errorMessage ?? "");
}

function lastAssistant(messages: readonly unknown[] | undefined): AssistantLike | undefined {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages![index] as AssistantLike;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function stateFile() {
  return resolve(process.env.PI_FALLBACK_STATE_FILE || join(homedir(), ".pi/agent/codex-cursor-cooldown.json"));
}

function mergeCooldowns(now: number, ...sources: unknown[]): Cooldowns {
  const merged: Cooldowns = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const { provider } of TIERS) {
      const value = (source as Record<string, unknown>)[provider];
      if (typeof value === "number" && Number.isFinite(value) && value > now &&
          (!(provider in merged) || value > merged[provider])) merged[provider] = value;
    }
  }
  return merged;
}

// Node/Bun do not expose openat. On Linux, pin each directory by fd and walk
// through procfs so a concurrent rename cannot redirect subsequent operations.
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const fdPath = (fd: number) => join(sep, "proc", "self", "fd", String(fd));

function belowDirectory(path: string, create: boolean) {
  const dir = dirname(path);
  const root = parse(dir).root;
  let fd = openSync(root, DIR_FLAGS);
  try {
    for (const part of dir.slice(root.length).split(sep).filter(Boolean)) {
      const component = join(fdPath(fd), part);
      if (create && !lstatSync(component, { throwIfNoEntry: false })) {
        try { mkdirSync(component, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!lstatSync(component).isDirectory()) throw new Error("Unsafe state directory");
      const next = openSync(component, DIR_FLAGS);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readCooldowns(path: string, now: number): Cooldowns {
  try {
    // Do not block on a FIFO or parse a large or non-regular file.
    if (!lstatSync(path).isFile()) return {};
    const fd = openSync(path, READ_FLAGS);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !(stat.mode & 0o444) || stat.size > 4096) return {};
      return mergeCooldowns(now, JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
}

export function loadCooldowns(now: number): Cooldowns {
  if (process.platform !== "linux") return {};
  try {
    const path = stateFile();
    const fd = belowDirectory(path, false);
    try { return readCooldowns(join(fdPath(fd), basename(path)), now); } finally { closeSync(fd); }
  } catch { return {}; }
}

const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 25;
const lockTiming = { now: Date.now, sleep: (ms: number) => delay(ms) };
const sameFile = (a: Stats | undefined, b: Stats) => a?.dev === b.dev && a.ino === b.ino;

function breakStaleLock(lock: string, now: number) {
  try {
    const stat = lstatSync(lock);
    if (!stat.isFile() && !stat.isDirectory()) return false;
    let timestamp = stat.mtimeMs;
    if (stat.isFile() && stat.size <= 256) {
      const fd = openSync(lock, READ_FLAGS);
      try {
        if (!sameFile(fstatSync(fd), stat)) return false;
        try {
          const holder = JSON.parse(readFileSync(fd, "utf8"));
          if (Number.isFinite(holder.timestamp)) timestamp = holder.timestamp;
        } catch {} // A process can die before it writes the lock contents.
      } finally { closeSync(fd); }
    }
    if (now - timestamp < LOCK_STALE_MS || !sameFile(lstatSync(lock), stat)) return false;
    const orphan = `${lock}.${randomUUID()}.stale`;
    renameSync(lock, orphan);
    if (!sameFile(lstatSync(orphan), stat)) {
      // Another process replaced the stale lock between the check and rename.
      // Restore its lock without replacing any lock acquired in the meantime.
      try { linkSync(orphan, lock); } catch {}
      unlinkSync(orphan);
      return false;
    }
    if (stat.isDirectory()) rmdirSync(orphan); // Locks from older router versions.
    else unlinkSync(orphan);
    return true;
  } catch { return false; }
}

export async function saveCooldowns(entries: Cooldowns, now: number, timing = lockTiming): Promise<void> {
  if (process.platform !== "linux") return;
  let dirFd: number | undefined, lockFd: number | undefined;
  let lock: string | undefined;
  try {
    const file = stateFile();
    dirFd = belowDirectory(file, true);
    const dir = fdPath(dirFd);
    const path = join(dir, basename(file));
    const safeFile = () => !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink();
    if (!safeFile()) return;
    lock = `${path}.lock`;
    // The exclusive file serializes writers. After two seconds, still merge and
    // publish atomically instead of dropping the cooldown on contention.
    for (let retries = 0; ; retries++) {
      try { lockFd = openSync(lock, "wx", 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || retries >= 2000 / LOCK_POLL_MS) break;
        if (!breakStaleLock(lock, timing.now())) await timing.sleep(LOCK_POLL_MS);
        continue;
      }
      try { writeFileSync(lockFd, JSON.stringify({ pid: process.pid, timestamp: timing.now() }) + "\n"); }
      catch {} // A lock without metadata still has an age on disk.
      break;
    }
    if (!safeFile()) return;
    const merged = mergeCooldowns(now, readCooldowns(path, now), entries);
    const temp = join(dir, `.codex-cursor-cooldown-${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(merged) + "\n"); } finally { closeSync(fd); }
      if (safeFile()) renameSync(temp, path);
    } finally {
      try { unlinkSync(temp); } catch {}
    }
  } catch {
    // Persistence is best-effort; the current process still skips failed tiers.
  } finally {
    if (lockFd !== undefined) {
      try { if (sameFile(lstatSync(lock!), fstatSync(lockFd))) unlinkSync(lock!); } catch {}
      closeSync(lockFd);
    }
    if (dirFd !== undefined) closeSync(dirFd);
  }
}

function codexModelDefinition(): Record<string, unknown> {
  try {
    const store = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models-store.json"), "utf8"));
    const found = (store?.["openai-codex"]?.models ?? []).find((model: { id?: string }) => model.id === CODEX_MODEL);
    if (found) return found;
  } catch {}
  return {
    id: CODEX_MODEL,
    name: "Codex 6.2 Sol",
    api: "openai-codex-responses",
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    contextWindow: 500000,
    maxTokens: 128000,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    type: "chat",
  };
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function refreshPersonalCodexToken(credentials: { refresh: string }) {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh, client_id: CODEX_CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`personal Codex token refresh failed (${response.status})`);
  const json = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("personal Codex token refresh response missing fields");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: accountIdFromToken(json.access_token),
  };
}

export function chooseRoute(
  request: {
    reason?: string;
    state?: FallbackState;
    failed?: { model?: ModelLike; message?: unknown };
    previous?: { model: ModelLike; thinkingLevel?: string };
    messages?: readonly unknown[];
    thinkingLevel?: string;
  },
  find: (provider: string, id: string) => ModelLike | undefined,
  now: number,
  notify?: (text: string) => void,
) {
  const level = request.thinkingLevel ?? "medium";
  const cooldownUntil = { ...(request.state?.cooldownUntil ?? {}) };
  let changed = false;

  const prior = request.reason === "user" ? lastAssistant(request.messages) : undefined;
  const failure = request.reason === "retry"
    ? { provider: request.failed?.model?.provider, message: request.failed?.message as AssistantLike | undefined }
    : prior && (prior.timestamp === undefined || prior.timestamp + COOLDOWN_MS > now)
      ? { provider: prior.provider, message: prior }
      : undefined;
  if (failure && isTierFailure(failure.message) && failure.provider && !(cooldownUntil[failure.provider] > now)) {
    cooldownUntil[failure.provider] = now + COOLDOWN_MS;
    changed = true;
    notify?.(`${TIERS[tierOf(failure.provider)].label} unavailable; skipping it for ${COOLDOWN_MS / 60_000} min`);
  }

  const available = TIERS.map((tier) => ({ tier, model: find(tier.provider, tier.model) })).filter(
    (entry): entry is { tier: (typeof TIERS)[number]; model: ModelLike } => Boolean(entry.model),
  );
  if (!available.length) throw new Error(`no fallback tier is available: ${TIERS.map((t) => `${t.provider}/${t.model}`).join(", ")}`);

  const ready = available.filter((entry) => !(cooldownUntil[entry.tier.provider] > now));
  const state = changed ? { cooldownUntil } : undefined;

  if (request.reason !== "user" && request.reason !== "retry" && request.previous) {
    const previousTier = tierOf(request.previous.model.provider);
    if (previousTier >= 0 && ready.some((entry) => entry.tier.provider === request.previous!.model.provider)) {
      return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? level, state };
    }
  }

  const pick =
    ready[0] ??
    [...available].sort((a, b) => (cooldownUntil[a.tier.provider] ?? 0) - (cooldownUntil[b.tier.provider] ?? 0))[0];
  return { model: pick.model, thinkingLevel: level, state };
}

type Clock<Timer> = {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => Timer;
  clearTimer: (timer: Timer) => void;
};

export function createStreamWatchdog<Timer>({ idleMs, now, setTimer, clearTimer, onIdle }: Clock<Timer> & {
  idleMs: number;
  onIdle: () => void;
}) {
  let timer: Timer | undefined;
  let generation = 0;
  let stopped = false;
  return {
    activity(timeoutMs = idleMs) {
      if (stopped) return;
      const current = ++generation;
      const deadline = now() + timeoutMs;
      if (timer !== undefined) clearTimer(timer);
      const expire = () => {
        if (stopped || current !== generation) return;
        const remaining = deadline - now();
        if (remaining > 0) {
          timer = setTimer(expire, Math.min(remaining, 2_147_483_647));
          return;
        }
        stopped = true;
        timer = undefined;
        onIdle();
      };
      timer = setTimer(expire, Math.min(timeoutMs, 2_147_483_647));
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

export function streamIdleMs() {
  const ms = Number(process.env.PI_FALLBACK_STREAM_IDLE_SECONDS ?? "90") * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : 90_000;
}

const DISPATCH_API = "fallback-dispatch";
const EXHAUSTED = "Fallback attempt quota exceeded (local tier rate limit): ";
const realClock = { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout };
type Registry = ExtensionContext["modelRegistry"];

// This Pi version consumes transformHeaders in ModelRuntime.prepareRequest and
// does not expose the callback to custom providers. Keep it on prepared *dispatch*
// options only; each physical prepareRequest then applies it to its own headers.
const bridgedRuntimes = new WeakSet<object>();
function bridgeHeaderTransform(registry: Registry) {
  const runtime = registry["runtime"];
  if (bridgedRuntimes.has(runtime)) return;
  const prepare = runtime["prepareRequest"];
  runtime["prepareRequest"] = async function (model: AnyModel, options?: ModelsSimpleStreamOptions) {
    if (model.api !== DISPATCH_API || model.provider !== "fallback" || !options?.transformHeaders) {
      return prepare.call(this, model, options);
    }
    const { transformHeaders, ...rest } = options;
    const prepared = await prepare.call(this, model, rest);
    return { ...prepared, options: { ...prepared.options, transformHeaders } };
  };
  bridgedRuntimes.add(runtime);
}

function isDispatchFailure(provider: string, message: AssistantLike | undefined, status?: number) {
  // Adapters can omit HTTP status from the error text. Pi also wraps auth setup failures.
  return message?.stopReason === "error" && (
    status === 401 || status === 403 || status === 429 || isTierFailure({ ...message, provider }) ||
    /^(?:OAuth (?:refresh|auth derivation) failed for |Provider is not configured: )/.test(message.errorMessage ?? ""));
}

function errorMessage(model: Model<Api>, text: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
  return {
    role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [], stopReason,
    errorMessage: text, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function streamAttempt<Timer>(
  registry: Registry, model: Model<Api>, context: TranscriptContext, options: ModelsSimpleStreamOptions,
  clock: Clock<Timer>, idleMs: number, forward: (event: AssistantMessageEvent) => void,
) {
  const controller = new AbortController();
  const parent = options.signal;
  let settled = false;
  let status: number | undefined;
  let providerActive = false;
  let interrupt!: (outcome: { message: AssistantMessage; idle: boolean }) => void;
  const interrupted = new Promise<{ message: AssistantMessage; idle: boolean }>((resolve) => { interrupt = resolve; });
  const stopAttempt = (idle: boolean) => {
    if (settled) return;
    settled = true;
    watchdog.stop();
    interrupt({ message: errorMessage(model, idle ? `Stream idle for ${idleMs / 1000} seconds` : "Request aborted", idle ? "error" : "aborted"), idle });
    controller.abort();
  };
  const cancel = () => stopAttempt(false);
  const watchdog = createStreamWatchdog({ ...clock, idleMs, onIdle: () => stopAttempt(true) });
  const activity = () => {
    providerActive = true;
    watchdog.activity();
  };
  parent?.addEventListener("abort", cancel, { once: true });
  try {
    if (parent?.aborted) {
      cancel();
      return { ...await interrupted, status };
    }
    const consume = async () => {
      try {
        // The dispatch model is keyless. Each physical call resolves its own auth and headers.
        const { apiKey: _key, headers: _headers, env: _env, ...rest } = options;
        const level = clampThinkingLevel(model, options.reasoning ?? "off");
        const stream = registry.streamSimple(model, context, {
          ...rest, signal: controller.signal, reasoning: level === "off" ? undefined : level,
          maxTokens: options.maxTokens && model.maxTokens > 0 ? Math.min(options.maxTokens, model.maxTokens) : options.maxTokens,
          maxRetries: 0,
          async onPayload(payload, requestModel) {
            controller.signal.throwIfAborted();
            const replacement = await options.onPayload?.(payload, requestModel);
            controller.signal.throwIfAborted();
            // No send hook: defer the first idle deadline by the connection grace.
            if (!providerActive) watchdog.activity(idleMs + Math.max(idleMs, 30_000));
            return replacement;
          },
          onResponse(response, requestModel) {
            controller.signal.throwIfAborted();
            status = response.status;
            activity();
            return options.onResponse?.(response, requestModel);
          },
          onProviderStreamEvent(event, requestModel) {
            controller.signal.throwIfAborted();
            activity();
            return options.onProviderStreamEvent?.(event, requestModel);
          },
        });
        for await (const event of stream) {
          if (settled) break;
          if (event.type === "done" || event.type === "error") {
            watchdog.stop();
            return event.type === "done" ? event.message : event.error;
          }
          activity();
          forward(event);
        }
        watchdog.stop();
        return settled ? errorMessage(model, "Request aborted", "aborted") : errorMessage(model, "Provider stream ended without a result");
      } catch (error) {
        watchdog.stop();
        return errorMessage(model, error instanceof Error ? error.message : String(error));
      }
    };
    const result = await Promise.race([consume().then((message) => ({ message, idle: false })), interrupted]);
    return { ...result, status };
  } finally {
    settled = true;
    watchdog.stop();
    parent?.removeEventListener("abort", cancel);
  }
}

export default function (pi: ExtensionAPI) {
  installRouter(pi, realClock);
}

export function installRouter<Timer>(pi: ExtensionAPI, clock: Clock<Timer>) {
  let registry: Registry | undefined;
  let inMemory: Cooldowns = {};
  // Pi passes the same signal from routing to streaming, then supplies the exact
  // final message on a host retry (which can run with a new signal/transcript).
  const pendingSignals = new WeakMap<AbortSignal, AttemptLedger>();
  const pendingMessages = new WeakMap<readonly unknown[], { length: number; expires: number; tried: AttemptLedger }>();
  const failedAttempts = new WeakMap<AssistantMessage, AttemptLedger>();
  const find = (provider: string, id: string) => {
    const model = registry?.find(provider, id);
    return model && registry?.hasConfiguredAuth(model) ? model : undefined;
  };
  const candidates = (entries: Cooldowns, tried: ReadonlySet<string>) =>
    (provider: string, id: string) => !(provider in entries) && !tried.has(provider) ? find(provider, id) : undefined;
  const dispatch = (provider: string): Model<Api> => {
    const tier = TIERS[tierOf(provider)];
    const model = registry?.find(tier.provider, tier.model);
    return {
      provider: "fallback", id: provider, api: DISPATCH_API, name: `Fallback dispatch (${tier.label})`, baseUrl: "",
      input: model?.input ?? ["text"], reasoning: true,
      cost: model?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model?.contextWindow ?? 500_000, maxTokens: model?.maxTokens ?? 128_000,
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    };
  };
  const cool = async (provider: string, now: number, entries: Cooldowns) => {
    inMemory = mergeCooldowns(now, inMemory, entries, { [provider]: now + COOLDOWN_MS });
    await saveCooldowns(inMemory, now);
  };
  const openStream = (model: Model<Api>, context: TranscriptContext, options: ModelsSimpleStreamOptions = {}) => {
    const byMessage = pendingMessages.get(context.messages);
    pendingMessages.delete(context.messages);
    const bySignal = options.signal && pendingSignals.get(options.signal);
    const messageMatch = byMessage && byMessage.length === context.messages.length && byMessage.expires > clock.now();
    if (!messageMatch && options.signal) pendingSignals.delete(options.signal);
    const tried = (messageMatch ? byMessage.tried : bySignal) ?? new Set<string>();
    const output = createAssistantMessageEventStream();
    const finish = (message: AssistantMessage) => {
      const reason = message.stopReason;
      if (reason === "pending") throw new Error("Provider stream did not finish");
      if (reason === "error") failedAttempts.set(message, tried);
      if (reason === "error" || reason === "aborted") output.push({ type: "error", reason, error: message });
      else output.push({ type: "done", reason, message });
      output.end(message);
    };
    // Pi's string-based retry/compaction classifiers recognize the local limit markers. Keep the
    // last provider's error intact without letting Pi automatically re-run the exhausted request.
    const exhausted = (last: AssistantMessage) => finish({
      ...last, errorMessage: EXHAUSTED + (last.errorMessage ?? "Provider request failed"),
    });
    // The virtual route only selects a catalog model. A custom stream owns attempts so Pi never
    // receives intermediate terminal errors, even with its automatic retries disabled.
    void (async () => {
      const activeRegistry = registry;
      if (!activeRegistry) throw new Error("Fallback dispatch requires a virtual model route");
      const idleMs = streamIdleMs();
      let failover = tried.size > 0;
      let started = false;
      const nextReady = (preferred?: string) => {
        const now = clock.now();
        const ready = candidates(mergeCooldowns(now, inMemory, loadCooldowns(now)), tried);
        const first = TIERS[tierOf(preferred)];
        return (first && ready(first.provider, first.model)) ?? TIERS.map((tier) => ready(tier.provider, tier.model)).find(Boolean);
      };
      let next = nextReady(model.id);
      let failed: AssistantMessage | undefined;
      if (options.signal?.aborted) return finish(errorMessage(model, "Request aborted", "aborted"));
      while (next) {
        const attempt = next;
        tried.add(attempt.provider);
        const { idle, message, status } = await streamAttempt(activeRegistry, attempt, context, options, clock, idleMs, (event) => {
          // Pi associates updates with one assistant message. Later partials replace earlier ones.
          if (event.type === "start") {
            if (started) return;
            started = true;
          }
          output.push(event);
        });
        if (options.signal?.aborted) return finish(errorMessage(attempt, "Request aborted", "aborted"));
        if (message.stopReason !== "error") return finish(message);
        if (idle || isDispatchFailure(attempt.provider, message, status)) {
          failover = true;
          const now = clock.now();
          await cool(attempt.provider, now, loadCooldowns(now));
          if (options.signal?.aborted) return finish(errorMessage(attempt, "Request aborted", "aborted"));
        } else if (!failover) {
          return finish(message);
        }
        failed = message;
        next = nextReady();
      }
      if (!failed) throw new Error("No fallback tier is available");
      exhausted(failed);
    })().catch((error) => finish(errorMessage(model, error instanceof Error ? error.message : String(error))));
    return output;
  };
  pi.registerProvider({
    id: "fallback", name: "Fallback dispatch",
    auth: { apiKey: { name: "Local router", resolve: async () => ({ auth: {}, source: "local router" }) } },
    getModels: () => TIERS.map(({ provider }) => dispatch(provider)),
    filterModels: () => [], // Only the virtual selection is intended to appear in the model picker.
    stream(model, context, options) {
      return openStream(model, context, options as SimpleStreamOptions);
    },
    streamSimple: openStream,
  });
  pi.registerProvider(PERSONAL_PROVIDER, {
    name: "OpenAI Codex (personal account)",
    api: "openai-codex-responses",
    baseUrl: CODEX_BASE_URL,
    models: [{ ...codexModelDefinition(), provider: PERSONAL_PROVIDER }],
    oauth: {
      name: "OpenAI Codex (personal account)",
      getApiKey: (credentials: { access: string }) => credentials.access,
      refreshToken: refreshPersonalCodexToken,
      async login() {
        throw new Error("Set PI_CODEX_PERSONAL_AUTH, or copy a signed-in openai-codex entry to openai-codex-personal in auth.json.");
      },
    },
  } as never);

  pi.registerVirtualModel<FallbackState>({
    provider: "fallback",
    id: "codex-cursor",
    name: "Work Codex, then Cursor, then personal Codex",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    async route(request: ModelRouteRequest<FallbackState>, ctx) {
      request.signal?.throwIfAborted();
      registry = ctx.modelRegistry;
      bridgeHeaderTransform(registry);
      const now = clock.now();
      let entries = mergeCooldowns(now, request.state?.cooldownUntil, inMemory, loadCooldowns(now));
      const failure = request.reason === "retry" ? request.failed?.message : undefined;
      const tried = new Set(failure && failedAttempts.get(failure));
      const failedProvider = request.reason === "retry" ? request.failed?.model.provider : undefined;
      if (failedProvider && tierOf(failedProvider) >= 0) {
        tried.add(failedProvider);
        if (isDispatchFailure(failedProvider, failure) && !failure?.errorMessage?.startsWith(EXHAUSTED) &&
            !(failedProvider in entries)) {
          await cool(failedProvider, now, entries);
          request.signal?.throwIfAborted();
          entries = mergeCooldowns(now, entries, inMemory, loadCooldowns(now));
        }
      }
      inMemory = mergeCooldowns(now, inMemory, entries);
      const eligible = candidates(inMemory, tried);
      if (!TIERS.some((tier) => eligible(tier.provider, tier.model))) {
        throw new Error(failure?.errorMessage ?? "No fallback tier is ready (missing login or cooling down)");
      }
      const pick = chooseRoute({ ...request, failed: undefined, state: { cooldownUntil: entries },
        // Live routes never infer failures from transcript history.
        messages: undefined,
      }, eligible, now);
      if (request.signal && request.reason !== "direct") pendingSignals.set(request.signal, tried);
      else if (request.messages) pendingMessages.set(request.messages, {
        length: request.messages.length, expires: clock.now() + ROUTE_HANDOFF_MS, tried,
      });
      const old = request.state?.cooldownUntil;
      const unchanged = old && Object.keys(old).length === Object.keys(entries).length &&
        Object.entries(entries).every(([provider, until]) => old[provider] === until);
      return {
        model: dispatch(pick.model.provider), thinkingLevel: pick.thinkingLevel as typeof request.thinkingLevel,
        state: unchanged ? request.state : { cooldownUntil: entries },
      };
    },
  });
}
