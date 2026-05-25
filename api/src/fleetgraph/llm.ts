// Claude models for FleetGraph, with tiering.
// Provider is chosen at runtime: if ANTHROPIC_API_KEY is set, use the direct Anthropic API
// (no AWS needed — used on Railway); otherwise use Bedrock (Ship's default; EB instance-role creds).
// Tier 1 = cheap/fast (triage/classify). Tier 2 = strong (reason/draft/answer).
// Calls are best-effort: if the model is unavailable, callers fall back to deterministic behavior.
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage } from '@langchain/core/messages';

const USE_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY;
const REGION = process.env.AWS_REGION || process.env.BEDROCK_AWS_REGION || 'us-east-1';

export const TIER2_MODEL =
  process.env.FLEETGRAPH_MODEL_TIER2 ||
  (USE_ANTHROPIC ? 'claude-sonnet-4-6' : 'global.anthropic.claude-opus-4-5-20251101-v1:0');
export const TIER1_MODEL =
  process.env.FLEETGRAPH_MODEL_TIER1 ||
  (USE_ANTHROPIC ? 'claude-haiku-4-5-20251001' : 'global.anthropic.claude-haiku-4-5-20251001-v1:0');

// Rough Claude pricing (USD per 1M tokens) — used only for the cost tally / projections.
const PRICE = {
  tier1: { in: Number(process.env.FLEETGRAPH_TIER1_IN_PER_M ?? 1), out: Number(process.env.FLEETGRAPH_TIER1_OUT_PER_M ?? 5) },
  tier2: { in: Number(process.env.FLEETGRAPH_TIER2_IN_PER_M ?? 5), out: Number(process.env.FLEETGRAPH_TIER2_OUT_PER_M ?? 25) },
};

let tier1: BaseChatModel | null = null;
let tier2: BaseChatModel | null = null;
let initFailed = false;

function make(model: string, maxTokens: number): BaseChatModel | null {
  if (initFailed) return null;
  try {
    // Omit temperature for Anthropic — some models (e.g. opus-4-7 thinking) reject non-default values.
    return USE_ANTHROPIC
      ? new ChatAnthropic({ model, maxTokens })
      : new ChatBedrockConverse({ model, region: REGION, temperature: 0, maxTokens });
  } catch (err) {
    console.warn('[FleetGraph] Failed to init Claude model:', err);
    initFailed = true;
    return null;
  }
}

export function getTier1(): BaseChatModel | null {
  if (!tier1) tier1 = make(TIER1_MODEL, 1024);
  return tier1;
}
export function getTier2(): BaseChatModel | null {
  if (!tier2) tier2 = make(TIER2_MODEL, 2048);
  return tier2;
}
export function isLlmAvailable(): boolean {
  return getTier2() !== null;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Invoke a tier with a system + user prompt. Returns null if Bedrock is unavailable or errors. */
export async function invokeTier(
  tier: 1 | 2,
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmResult | null> {
  const model = tier === 1 ? getTier1() : getTier2();
  if (!model) return null;
  try {
    const res = (await model.invoke([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ])) as AIMessage;
    const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const usage = res.usage_metadata;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    const p = tier === 1 ? PRICE.tier1 : PRICE.tier2;
    const usd = (inputTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
    return { text, inputTokens, outputTokens, usd };
  } catch (err) {
    console.warn(`[FleetGraph] Bedrock tier-${tier} call failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Best-effort JSON extraction from a model response (handles ```json fences). */
export function extractJson<T>(text: string): T | null {
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[1] || match[0]) as T;
  } catch {
    return null;
  }
}
