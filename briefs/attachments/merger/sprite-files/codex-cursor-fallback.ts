import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /usage limit|rate.?limit|quota|too many requests|\b429\b|\b401\b|\b403\b|unauthori[sz]ed|forbidden|insufficient (?:credits|balance|quota)|(?:limit|quota) exceeded|overloaded|credential|log ?in required|not logged in|no api key|expired token|invalid token/i;

type FallbackState = { cooldownUntil: Record<string, number> };
type AssistantLike = { role?: string; provider?: string; stopReason?: string; errorMessage?: string };
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

function codexModelDefinition(): Record<string, unknown> {
  try {
    const store = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models-store.json"), "utf8"));
    const found = (store?.["openai-codex"]?.models ?? []).find((model: { id?: string }) => model.id === CODEX_MODEL);
    if (found) return found;
  } catch {}
  return {
    id: CODEX_MODEL,
    name: "GPT-6.2 Sol",
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

  const failure =
    request.reason === "retry"
      ? { provider: request.failed?.model?.provider, message: request.failed?.message as AssistantLike | undefined }
      : request.reason === "user"
        ? { provider: lastAssistant(request.messages)?.provider, message: lastAssistant(request.messages) }
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

export default function (pi: ExtensionAPI) {
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
    route(request, ctx) {
      return chooseRoute(
        request as never,
        (provider, id) => ctx.modelRegistry.find(provider, id),
        Date.now(),
        (text) => ctx.ui?.notify?.(text, "warning"),
      ) as never;
    },
  });
}
