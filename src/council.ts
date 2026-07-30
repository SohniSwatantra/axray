/**
 * Optional LLM council — bring your own OpenRouter key.
 *
 * Multiple frontier models each score the site's Agent Experience against the
 * measured signals (ground truth from probe.ts), then results are averaged.
 * Runs only when OPENROUTER_API_KEY is set and --council is passed.
 */

import type { CouncilModelResult, MeasuredSignals } from "./types.js";
import { buildMeasuredSignalsSummary } from "./probe.js";

export const DEFAULT_COUNCIL_MODELS = [
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
  "google/gemini-3.1-pro-preview",
  "x-ai/grok-4.3",
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function buildPrompt(url: string, signals: MeasuredSignals, pageText: string): string {
  return `You are an AI Agent Experience (AX) evaluator. Analyze the following website from the perspective of how easily AI agents (like ChatGPT, Claude, Perplexity) can access, understand, and act on it.

Website URL: ${url}

${buildMeasuredSignalsSummary(signals)}

Judge the site on what matters for ITS archetype (personal site, blog, docs, SaaS/product, ecommerce, agency/services, portfolio). Do NOT penalize a personal site, blog or agency for lacking pricing, testimonials, or a public API. Only assert a feature is ABSENT if you directly observed it; you are seeing the homepage, so hedge anything that could live on another page ("not found on the homepage") rather than declaring it missing site-wide.

Evaluate these 8 factors, scoring each 0-100:

1. **Structured Data** - Schema.org markup, JSON-LD, Open Graph tags, machine-readable metadata
2. **Semantic HTML** - Heading hierarchy, ARIA labels, semantic elements (nav, main, article)
3. **Meta Tags Quality** - Title, description and meta information quality and completeness
4. **Content Accessibility** - robots.txt allows agents, sitemap.xml, RSS feeds
5. **Action Readiness** - Can an agent complete the primary action? A public API or MCP server counts, but so does a clear next step (contact, booking, sign-up) plus an AGENTS.md describing it. Do NOT penalize sites that rightly have no API
6. **Content Clarity** - How clear and unambiguous the value proposition is for AI parsing
7. **Agent Interaction** - Structured FAQs, forms, feedback mechanisms an agent could use
8. **Content Negotiation** - llms.txt, markdown responses to Accept: text/markdown, AGENTS.md, agent-native formats

Homepage content (extracted text, truncated):
"""
${pageText.slice(0, 8000)}
"""

Return ONLY JSON in this exact shape:
{
  "axScore": <0-100 overall>,
  "anps": <-100..100 agent net promoter score: would you, as an agent, recommend this site>,
  "factors": [{"name": "<factor>", "score": <0-100>, "description": "<one line>"}],
  "summary": "<2-3 sentence overall assessment>"
}`;
}

interface ModelJson {
  axScore?: number;
  anps?: number;
  factors?: Array<{ name: string; score: number; description: string }>;
  summary?: string;
}

/**
 * Parse a model's JSON, tolerating the real-world failure modes: markdown
 * fences, prose around the JSON, and truncated/malformed tails (some models
 * emit invalid JSON mid-array). Falls back to regex-salvaging the scalar
 * fields so a broken factors array doesn't cost us the score.
 */
function parseModelJson(text: string): ModelJson | null {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
  try {
    return JSON.parse(candidate) as ModelJson;
  } catch {
    /* fall through to salvage */
  }
  const num = (key: string): number | undefined => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : undefined;
  };
  const axScore = num("axScore");
  if (axScore === undefined) return null;
  const summary = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  return {
    axScore,
    anps: num("anps"),
    factors: [],
    summary: summary ? summary.replace(/\\"/g, '"') : "(salvaged from malformed model JSON)",
  };
}

async function callModel(
  model: string,
  prompt: string,
  apiKey: string
): Promise<CouncilModelResult> {
  const base: CouncilModelResult = {
    model,
    axScore: null,
    anps: null,
    factors: [],
    summary: "",
  };
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/SohniSwatantra/axray",
        "X-Title": "AXray CI",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 3000, // verbose models truncated at 2000, corrupting the JSON tail
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new Error(
        (err as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content || "";
    const parsed = parseModelJson(text);
    if (!parsed) throw new Error("No parsable JSON in model response");
    return {
      model,
      axScore: typeof parsed.axScore === "number" ? Math.round(parsed.axScore) : null,
      anps: typeof parsed.anps === "number" ? Math.round(parsed.anps) : null,
      factors: parsed.factors || [],
      summary: parsed.summary || "",
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Strip tags to give models readable page text without an HTML parser dep. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runCouncil(
  url: string,
  signals: MeasuredSignals,
  pageHtml: string,
  models: string[],
  apiKey: string
): Promise<{ models: CouncilModelResult[]; score: number | null; anps: number | null }> {
  const prompt = buildPrompt(url, signals, htmlToText(pageHtml));
  const results = await Promise.all(models.map((m) => callModel(m, prompt, apiKey)));
  const ok = results.filter((r) => r.axScore !== null);
  const avg = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  return {
    models: results,
    score: avg(ok.map((r) => r.axScore as number)),
    anps: avg(ok.filter((r) => r.anps !== null).map((r) => r.anps as number)),
  };
}
