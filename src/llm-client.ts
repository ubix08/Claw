// ============================================================
// llm-client.ts — Provider-agnostic LLM call abstraction
// ============================================================
//
// Supports the multi-provider setup described in the spec:
//   - Anthropic (Claude Sonnet/Opus)
//   - OpenAI-compatible endpoints (covers Kimi2, MiniMax,
//     GLM-4, Qwen2.5-Coder, DeepSeek-V3, and any OpenAI
//     compatible endpoint)
//
// Provider is inferred from the model string prefix or via an
// explicit PROVIDER_API environment variable map.
//
// Environment variables:
//   ANTHROPIC_API_KEY          — for claude-* models
//   OPENAI_API_KEY             — for gpt-* models
//   OPENAI_BASE_URL            — override base URL (for OSS)
//
// Per-model overrides via PROVIDER_API_MAP (JSON env var):
//   {
//     "kimi2": { "baseUrl": "https://api.moonshot.cn/v1", "apiKey": "sk-..." },
//     "minimax": { "baseUrl": "https://api.minimax.chat/v1", "apiKey": "..." },
//     "glm": { "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "..." },
//     "qwen": { "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKey": "..." },
//     "deepseek": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "..." }
//   }
// ============================================================

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMCallParams {
  model: string;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

// ─── Provider resolution ──────────────────────────────────────

function resolveProvider(model: string): ProviderConfig {
  // Load per-model overrides from env
  let apiMap: Record<string, ProviderConfig> = {};
  try {
    if (process.env.PROVIDER_API_MAP) {
      apiMap = JSON.parse(process.env.PROVIDER_API_MAP);
    }
  } catch {
    // Ignore malformed map
  }

  // Check explicit model-prefix overrides
  for (const [prefix, cfg] of Object.entries(apiMap)) {
    if (model.toLowerCase().startsWith(prefix.toLowerCase())) {
      return cfg;
    }
  }

  // Built-in prefix detection
  if (model.startsWith("claude-")) {
    return {
      baseUrl: "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    };
  }

  // Default: OpenAI-compatible
  return {
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
    apiKey: process.env.OPENAI_API_KEY ?? "",
  };
}

// ─── Anthropic call ──────────────────────────────────────────

async function callAnthropic(params: LLMCallParams, config: ProviderConfig): Promise<string> {
  const body: Record<string, any> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (params.system) body.system = params.system;
  if (params.temperature !== undefined) body.temperature = params.temperature;

  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return (data.content as any[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ─── OpenAI-compatible call ───────────────────────────────────

async function callOpenAICompat(params: LLMCallParams, config: ProviderConfig): Promise<string> {
  const messages: Message[] = [];
  if (params.system) {
    messages.push({ role: "system", content: params.system });
  }
  for (const m of params.messages) {
    messages.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  const body: Record<string, any> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    messages,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI-compat API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── Retry wrapper ────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 2000): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastErr;
}

// ─── Public API ───────────────────────────────────────────────

export async function callLLM(params: LLMCallParams): Promise<string> {
  const config = resolveProvider(params.model);

  return withRetry(() => {
    if (params.model.startsWith("claude-")) {
      return callAnthropic(params, config);
    }
    return callOpenAICompat(params, config);
  });
}
