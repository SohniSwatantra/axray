/**
 * AXray measured probe — real HTTP checks, no LLM, no API key.
 *
 * Measures how agent-ready a site is by checking the concrete surfaces AI
 * agents rely on: llms.txt, robots.txt agent policy, sitemap, JSON-LD,
 * AGENTS.md, content negotiation (Accept: text/markdown), RSS, and the
 * machine-readable API/MCP discovery surface (Link headers, RFC 9727
 * api-catalog, MCP server cards).
 *
 * Every check is best-effort and never throws — failures are recorded in
 * `errors[]` and the affected signal is treated as "not present".
 */

import type { MeasuredSignals, MeasuredFactorScores, RobotsAgentRule } from "./types.js";

// Known AI-agent crawler user-agents we look for in robots.txt
const AI_AGENT_USER_AGENTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
  "Applebot-Extended",
  "Bytespider",
  "Amazonbot",
  "cohere-ai",
];

const PROBE_TIMEOUT_MS = 10000;
const PROBE_USER_AGENT =
  "Mozilla/5.0 (compatible; AXray/1.0; +https://github.com/SohniSwatantra/axray)";

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": PROBE_USER_AGENT, ...(init.headers || {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Presence + size check via GET (HEAD is unreliable on many CDNs). */
async function checkResource(
  url: string,
  errors: string[]
): Promise<{ present: boolean; bytes: number; contentType: string | null }> {
  const res = await timedFetch(url);
  if (!res) {
    errors.push(`Request failed: ${url}`);
    return { present: false, bytes: 0, contentType: null };
  }
  if (!res.ok) {
    return { present: false, bytes: 0, contentType: res.headers.get("content-type") };
  }
  const contentType = res.headers.get("content-type");
  // A site that serves its SPA index.html for every unknown path will return
  // 200 for /llms.txt. Treat HTML responses to text-file probes as absent.
  const looksHtml = (contentType || "").includes("text/html");
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  if (looksHtml) {
    return { present: false, bytes: body.length, contentType };
  }
  return { present: body.trim().length > 0, bytes: body.length, contentType };
}

/**
 * Minimal robots.txt parser focused on whether named AI agents are blocked
 * from the whole site (Disallow: /). Falls back to the `*` group.
 */
function parseRobots(text: string): {
  agentRules: RobotsAgentRule[];
  hasSitemapDirective: boolean;
} {
  const lines = text.split(/\r?\n/);
  const groups: Record<string, string[]> = {};
  let currentAgents: string[] = [];
  let sawSitemap = false;

  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      currentAgents = [value.toLowerCase()];
      if (!groups[value.toLowerCase()]) groups[value.toLowerCase()] = [];
    } else if (key === "disallow") {
      for (const a of currentAgents) {
        if (!groups[a]) groups[a] = [];
        groups[a].push(value);
      }
    } else if (key === "sitemap") {
      sawSitemap = true;
    }
  }

  const fullyBlocked = (agent: string): boolean => {
    const rules = groups[agent.toLowerCase()] ?? groups["*"];
    if (!rules) return false;
    return rules.some((r) => r === "/");
  };

  const agentRules: RobotsAgentRule[] = AI_AGENT_USER_AGENTS.filter(
    (a) => groups[a.toLowerCase()] || groups["*"]
  ).map((a) => ({ userAgent: a, disallowed: fullyBlocked(a) }));

  return { agentRules, hasSitemapDirective: sawSitemap };
}

/** Extract JSON-LD blocks and their schema.org @type values from HTML. */
function parseJsonLd(html: string): { blocks: number; types: string[] } {
  const matches =
    html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const types = new Set<string>();
  let blocks = 0;
  for (const block of matches) {
    blocks++;
    const inner = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(inner);
      collectTypes(parsed, types);
    } catch {
      /* malformed JSON-LD block — count it but skip types */
    }
  }
  return { blocks, types: Array.from(types) };
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectTypes(n, out));
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.add(x));
    if (obj["@graph"]) collectTypes(obj["@graph"], out);
  }
}

/**
 * Evidence of an ACTUAL MCP endpoint — an mcp:// scheme, an mcp. subdomain,
 * an /mcp path, an @scope/mcp package, or the official SDK namespace. A bare
 * textual mention of "MCP" (e.g. marketing copy about MCP consulting) does
 * NOT count; that produced false positives.
 */
const MCP_ENDPOINT_RE =
  /(mcp:\/\/)|(\bmcp\.[a-z0-9-]+\.[a-z]{2,})|(https?:\/\/[^\s"'<>)]*\/mcp\b)|(@[a-z0-9-]+\/mcp\b)|(modelcontextprotocol)/im;

/** Pull <loc> URLs out of a sitemap (or sitemap index) body. */
function extractSitemapLocs(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi))
    .map((m) => m[1].trim())
    .slice(0, 200);
}

// Paths most likely to carry the structured/commercial facts a homepage lacks.
const SAMPLE_PRIORITY = [
  /\/pricing\/?$/i,
  /\/faq\/?$/i,
  /\/services?\/?$/i,
  /\/products?\/?$/i,
  /\/about\/?$/i,
  /\/docs?\/?/i,
  /\/(blog|posts|articles)\//i,
  /\/contact\/?$/i,
];

/** Choose up to 3 same-origin, non-homepage URLs to sample, best-first. */
function pickSamplePages(locs: string[], origin: string, homepage: string): string[] {
  const homeNorm = homepage.replace(/\/+$/, "");
  const candidates = locs.filter((l) => {
    try {
      return new URL(l).origin === origin && l.replace(/\/+$/, "") !== homeNorm;
    } catch {
      return false;
    }
  });
  const picked: string[] = [];
  for (const re of SAMPLE_PRIORITY) {
    const hit = candidates.find((c) => re.test(c) && !picked.includes(c));
    if (hit) picked.push(hit);
    if (picked.length >= 3) break;
  }
  for (const c of candidates) {
    if (picked.length >= 3) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

/**
 * Probe a URL for agent-readiness. `html` (if you already fetched the page)
 * is reused to detect structured data without a second fetch.
 */
export async function probeAgentReadiness(url: string, html?: string): Promise<MeasuredSignals> {
  const errors: string[] = [];
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }

  const signals: MeasuredSignals = {
    checkedAt: new Date().toISOString(),
    origin,
    llmsTxt: { present: false, url: `${origin}/llms.txt`, bytes: 0 },
    llmsFullTxt: { present: false, bytes: 0 },
    wellKnownLlmsTxt: { present: false },
    agentsMd: { present: false, bytes: 0 },
    robotsTxt: {
      present: false,
      allowsAiAgents: true,
      agentRules: [],
      hasSitemapDirective: false,
    },
    sitemapXml: { present: false },
    contentNegotiation: {
      supportsMarkdown: false,
      supportsPlainText: false,
      markdownContentType: null,
      htmlContentType: null,
    },
    structuredData: { jsonLdBlocks: 0, schemaTypes: [], hasOpenGraph: false },
    apiSurface: {
      hasOpenApi: false,
      hasWellKnown: false,
      hasMcp: false,
      hasApiCatalog: false,
      linkRels: [],
    },
    rssFeed: { present: false },
    sampledPages: [],
    errors,
  };

  // Run all independent network probes in parallel.
  const [
    llms,
    llmsFull,
    wellKnown,
    agents,
    robotsRes,
    sitemap,
    openapi,
    wellKnownRoot,
    apiCatalog,
    mcpCard,
    rss,
    feed,
    atom,
    mdNeg,
    htmlNeg,
  ] = await Promise.all([
    checkResource(`${origin}/llms.txt`, errors),
    checkResource(`${origin}/llms-full.txt`, errors),
    checkResource(`${origin}/.well-known/llms.txt`, errors),
    checkResource(`${origin}/AGENTS.md`, errors),
    timedFetch(`${origin}/robots.txt`),
    checkResource(`${origin}/sitemap.xml`, errors),
    checkResource(`${origin}/openapi.json`, errors),
    timedFetch(`${origin}/.well-known/`),
    checkResource(`${origin}/.well-known/api-catalog`, errors), // RFC 9727 discovery
    checkResource(`${origin}/.well-known/mcp/server-card.json`, errors), // MCP server card
    checkResource(`${origin}/rss.xml`, errors),
    checkResource(`${origin}/feed.xml`, errors),
    checkResource(`${origin}/atom.xml`, errors),
    timedFetch(url, { headers: { Accept: "text/markdown, text/plain" } }),
    timedFetch(url, { headers: { Accept: "text/html" } }),
  ]);

  signals.llmsTxt.present = llms.present;
  signals.llmsTxt.bytes = llms.bytes;
  signals.llmsFullTxt = { present: llmsFull.present, bytes: llmsFull.bytes };
  signals.wellKnownLlmsTxt.present = wellKnown.present;
  signals.agentsMd = { present: agents.present, bytes: agents.bytes };
  signals.sitemapXml.present = sitemap.present;
  signals.apiSurface.hasOpenApi = openapi.present;
  signals.apiSurface.hasWellKnown = !!wellKnownRoot && wellKnownRoot.ok;
  signals.apiSurface.hasApiCatalog = apiCatalog.present;
  signals.apiSurface.hasMcp = mcpCard.present;
  signals.rssFeed.present = rss.present || feed.present || atom.present;

  // robots.txt
  if (robotsRes && robotsRes.ok) {
    const robotsText = await robotsRes.text().catch(() => "");
    const ct = robotsRes.headers.get("content-type") || "";
    if (robotsText.trim() && !ct.includes("text/html")) {
      const parsed = parseRobots(robotsText);
      const blockedCount = parsed.agentRules.filter((r) => r.disallowed).length;
      signals.robotsTxt = {
        present: true,
        allowsAiAgents:
          parsed.agentRules.length === 0 ? true : blockedCount < parsed.agentRules.length,
        agentRules: parsed.agentRules,
        hasSitemapDirective: parsed.hasSitemapDirective,
      };
    }
  }

  // Content negotiation: did the markdown request return a non-HTML representation?
  if (mdNeg) {
    const mdCt = mdNeg.headers.get("content-type");
    signals.contentNegotiation.markdownContentType = mdCt;
    signals.contentNegotiation.supportsMarkdown =
      !!mdCt && (mdCt.includes("markdown") || mdCt.includes("text/x-markdown"));
    signals.contentNegotiation.supportsPlainText = !!mdCt && mdCt.includes("text/plain");
  }
  if (htmlNeg) {
    signals.contentNegotiation.htmlContentType = htmlNeg.headers.get("content-type");
    // RFC 8288 Link header — sites advertise their agent/API discovery surface
    // here (rel="api-catalog", "service-desc", "service-doc", MCP links).
    const linkHeader = htmlNeg.headers.get("link") || "";
    const rels = Array.from(linkHeader.matchAll(/rel=["']?([^"';,\s]+)/gi)).map((m) =>
      m[1].toLowerCase()
    );
    if (rels.length) signals.apiSurface.linkRels = Array.from(new Set(rels));
    if (rels.some((r) => r === "api-catalog")) signals.apiSurface.hasApiCatalog = true;
    if (rels.some((r) => r === "service-desc" || r === "service-doc"))
      signals.apiSurface.hasOpenApi = true;
    if (/mcp/i.test(linkHeader)) signals.apiSurface.hasMcp = true;
  }

  // Structured data — prefer provided HTML; fall back to the negotiated fetch.
  let pageHtml = html;
  if (!pageHtml && htmlNeg) {
    pageHtml = await htmlNeg.text().catch(() => "");
  }
  if (!pageHtml) {
    const res = await timedFetch(url);
    pageHtml = res ? await res.text().catch(() => "") : "";
  }
  if (pageHtml) {
    const ld = parseJsonLd(pageHtml);
    signals.structuredData.jsonLdBlocks = ld.blocks;
    signals.structuredData.schemaTypes = ld.types;
    signals.structuredData.hasOpenGraph = /property=["']og:/i.test(pageHtml);
    // RSS/Atom advertised in <head> costs no extra request.
    if (/<link[^>]+type=["']application\/(rss|atom)\+xml["']/i.test(pageHtml)) {
      signals.rssFeed.present = true;
    }
    // MCP referenced anywhere in the page (e.g. an mcp.* subdomain or /mcp path).
    if (!signals.apiSurface.hasMcp && MCP_ENDPOINT_RE.test(pageHtml)) {
      signals.apiSurface.hasMcp = true;
    }
  }

  // The MCP endpoint is often named only in llms.txt (which we already fetched).
  if (signals.llmsTxt.present && !signals.apiSurface.hasMcp) {
    const res = await timedFetch(signals.llmsTxt.url);
    const body = res ? await res.text().catch(() => "") : "";
    if (MCP_ENDPOINT_RE.test(body)) signals.apiSurface.hasMcp = true;
  }

  // Sample a few sitemap-discovered pages beyond the homepage. Schema (Offer,
  // FAQPage, BlogPosting) routinely lives on /pricing, /faq or /posts/* — a
  // homepage-only read would report those as absent site-wide.
  if (signals.sitemapXml.present) {
    try {
      const smRes = await timedFetch(`${origin}/sitemap.xml`);
      let smBody = smRes ? await smRes.text().catch(() => "") : "";
      let locs = extractSitemapLocs(smBody);
      // Sitemap index: follow the first child sitemap.
      if (locs.length && locs.every((l) => l.endsWith(".xml"))) {
        const childRes = await timedFetch(locs[0]);
        smBody = childRes ? await childRes.text().catch(() => "") : "";
        locs = extractSitemapLocs(smBody);
      }
      const targets = pickSamplePages(locs, origin, url);
      const pages = await Promise.all(
        targets.map(async (pageUrl) => {
          const res = await timedFetch(pageUrl, { headers: { Accept: "text/html" } });
          const body = res && res.ok ? await res.text().catch(() => "") : "";
          if (!body) return null;
          const ld = parseJsonLd(body);
          return { url: pageUrl, schemaTypes: ld.types, jsonLdBlocks: ld.blocks };
        })
      );
      signals.sampledPages = pages.filter(
        (p): p is { url: string; schemaTypes: string[]; jsonLdBlocks: number } => p !== null
      );
    } catch (e) {
      errors.push(`Sitemap sampling failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  return signals;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Turn measured signals into 0-100 sub-scores for the verifiable AX factors. */
export function computeMeasuredFactorScores(s: MeasuredSignals): MeasuredFactorScores {
  // Structured Data
  let structured = 20;
  if (s.structuredData.jsonLdBlocks > 0) structured += 40;
  if (s.structuredData.schemaTypes.length > 0) structured += 20;
  if (s.structuredData.hasOpenGraph) structured += 20;

  // Content Accessibility (robots permits agents + sitemap discoverability)
  let accessibility = 40;
  if (s.robotsTxt.present) {
    accessibility += s.robotsTxt.allowsAiAgents ? 30 : -25;
  }
  if (s.sitemapXml.present || s.robotsTxt.hasSitemapDirective) accessibility += 20;
  if (s.rssFeed.present) accessibility += 10;

  // Content Negotiation (the agent-native formats)
  let negotiation = 10;
  if (s.llmsTxt.present) negotiation += 40;
  if (s.llmsFullTxt.present || s.wellKnownLlmsTxt.present) negotiation += 10;
  if (s.contentNegotiation.supportsMarkdown) negotiation += 25;
  else if (s.contentNegotiation.supportsPlainText) negotiation += 10;
  if (s.agentsMd.present) negotiation += 10;

  // Action Readiness — can an agent take the next step? A public API is the
  // strongest signal, but NOT required: a documented primary action
  // (AGENTS.md) and a clear, identifiable entity to act on satisfy this too.
  // Sites that legitimately have no API (agencies, portfolios, brochure
  // sites) start from a fair baseline rather than being floored.
  const allSchemaTypes = [
    ...s.structuredData.schemaTypes,
    ...(s.sampledPages || []).flatMap((p) => p.schemaTypes),
  ];
  let action = 40;
  if (s.apiSurface.hasOpenApi) action += 45; // programmatic action = strongest
  if (s.apiSurface.hasMcp) action += 40; // an MCP server is first-class agent access
  if (s.agentsMd.present) action += 35; // documents the next step for agents
  if (s.apiSurface.hasApiCatalog) action += 15; // RFC 9727 discovery linkset
  if (s.apiSurface.hasWellKnown) action += 10;
  if (allSchemaTypes.some((t) => /Organization|LocalBusiness|Service|ProfessionalService/i.test(t))) {
    action += 15; // a clear entity + contact path agents can act on
  }

  return {
    structuredData: clamp(structured),
    contentAccessibility: clamp(accessibility),
    contentNegotiation: clamp(negotiation),
    actionReadiness: clamp(action),
  };
}

/** The headline measured score: average of the four verified factors. */
export function computeMeasuredScore(f: MeasuredFactorScores): number {
  return Math.round(
    (f.structuredData + f.contentAccessibility + f.contentNegotiation + f.actionReadiness) / 4
  );
}

/**
 * Deterministic, high-impact recommendations derived straight from measured
 * gaps. Every item maps to a real, verifiable signal. Ordered by impact.
 */
export function generateMeasuredRecommendations(s: MeasuredSignals): string[] {
  const recs: string[] = [];

  if (!s.llmsTxt.present) {
    recs.push(
      "Add an llms.txt file at /llms.txt — a short Markdown summary of what the site does, who it's for, and links to your key pages and docs. It's the single fastest signal for AI agents."
    );
  }
  if (s.structuredData.jsonLdBlocks === 0) {
    recs.push(
      "Add Schema.org JSON-LD (e.g. Organization, Product/Offer, FAQPage) so agents can extract structured facts — name, price, availability, FAQs — without parsing HTML."
    );
  }
  if (!s.contentNegotiation.supportsMarkdown && !s.contentNegotiation.supportsPlainText) {
    recs.push(
      "Serve a clean Markdown/plain-text representation when an agent sends Accept: text/markdown. Agents parse Markdown far more reliably than rendered HTML."
    );
  }
  const blocked = s.robotsTxt.agentRules.filter((r) => r.disallowed).map((r) => r.userAgent);
  if (s.robotsTxt.present && (!s.robotsTxt.allowsAiAgents || blocked.length)) {
    recs.push(
      `Update robots.txt to allow AI crawlers${blocked.length ? ` (currently blocking ${blocked.join(", ")})` : " (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)"} so assistants can read and recommend your site.`
    );
  }
  if (!s.sitemapXml.present && !s.robotsTxt.hasSitemapDirective) {
    recs.push(
      "Add a sitemap.xml (and reference it in robots.txt) so agents can discover all of your pages."
    );
  }
  if (!s.structuredData.hasOpenGraph) {
    recs.push(
      "Add Open Graph meta tags (og:title, og:description, og:image) for richer agent and social previews."
    );
  }
  if (!s.agentsMd.present) {
    recs.push(
      "Publish a public /AGENTS.md served on your site (distinct from any repo-root AGENTS.md that instructs coding agents) stating your primary action and exactly how an agent takes it — how to contact you, book a call, or buy."
    );
  }
  if (!s.rssFeed.present) {
    recs.push(
      'Publish an RSS/Atom feed (e.g. /rss.xml) and reference it with <link rel="alternate" type="application/rss+xml"> so agents can track and cite your updates.'
    );
  }
  // Only recommend a public API when the site actually looks like a
  // programmatic product AND doesn't already expose an MCP server or API
  // catalog. Agencies, portfolios and brochure sites rightly have no API.
  const recSchemaTypes = [
    ...s.structuredData.schemaTypes,
    ...(s.sampledPages || []).flatMap((p) => p.schemaTypes),
  ];
  const looksProgrammatic =
    recSchemaTypes.some((t) => /Product|Offer|SoftwareApplication|WebAPI|WebApplication/i.test(t)) ||
    s.apiSurface.hasWellKnown;
  if (
    !s.apiSurface.hasOpenApi &&
    !s.apiSurface.hasMcp &&
    !s.apiSurface.hasApiCatalog &&
    looksProgrammatic
  ) {
    recs.push(
      "Your site looks like a product agents could use programmatically — expose a public API with an /openapi.json (or document an MCP server) so agents can act, not just read."
    );
  }

  return recs;
}

/**
 * Human/LLM-readable summary of the MEASURED facts, injected into the council
 * prompt so models score against ground truth instead of guessing.
 */
export function buildMeasuredSignalsSummary(s: MeasuredSignals): string {
  const yn = (b: boolean) => (b ? "YES" : "NO");
  const blockedAgents = s.robotsTxt.agentRules
    .filter((r) => r.disallowed)
    .map((r) => r.userAgent);

  return `**MEASURED SIGNALS (verified by real HTTP requests — treat as ground truth):**
- llms.txt present: ${yn(s.llmsTxt.present)}${s.llmsTxt.present ? ` (${s.llmsTxt.bytes} bytes)` : ""}
- llms-full.txt present: ${yn(s.llmsFullTxt.present)}
- /.well-known/llms.txt present: ${yn(s.wellKnownLlmsTxt.present)}
- AGENTS.md present: ${yn(s.agentsMd.present)}
- robots.txt present: ${yn(s.robotsTxt.present)}; allows AI agents: ${yn(s.robotsTxt.allowsAiAgents)}${blockedAgents.length ? `; blocked: ${blockedAgents.join(", ")}` : ""}
- sitemap.xml present: ${yn(s.sitemapXml.present || s.robotsTxt.hasSitemapDirective)}
- Content negotiation (Accept: text/markdown): served ${s.contentNegotiation.markdownContentType || "no response"} → markdown supported: ${yn(s.contentNegotiation.supportsMarkdown)}
- Schema.org JSON-LD blocks: ${s.structuredData.jsonLdBlocks}${s.structuredData.schemaTypes.length ? ` (types: ${s.structuredData.schemaTypes.join(", ")})` : ""}
- Open Graph tags: ${yn(s.structuredData.hasOpenGraph)}
- OpenAPI (/openapi.json or Link service-desc): ${yn(s.apiSurface.hasOpenApi)}
- MCP server (server-card / llms.txt / page): ${yn(s.apiSurface.hasMcp)}
- API catalog (/.well-known/api-catalog, RFC 9727): ${yn(s.apiSurface.hasApiCatalog)}
- RSS/Atom feed: ${yn(s.rssFeed.present)}
- Link header rels advertised: ${s.apiSurface.linkRels.length ? s.apiSurface.linkRels.join(", ") : "none"}
${
  s.sampledPages && s.sampledPages.length
    ? `- Sampled sitemap pages (schema found beyond the homepage):\n${s.sampledPages
        .map((p) => `  - ${p.url}: ${p.schemaTypes.length ? p.schemaTypes.join(", ") : "no JSON-LD"}`)
        .join("\n")}`
    : "- Sampled sitemap pages: none available"
}

Use these measured facts for Structured Data, Content Accessibility, Content Negotiation, and Action Readiness. Do NOT contradict them. An API is NOT required for a high Action Readiness score — a clear primary action (contact, booking, sign-up) plus AGENTS.md counts fully.

CRITICAL HONESTY RULE: Only assert a feature is ABSENT if the measured signals above confirm it. The measured signals cover the HOMEPAGE and well-known paths only. For anything NOT measured, do NOT claim it is missing site-wide — say "not found on the homepage" or omit the claim.`;
}
