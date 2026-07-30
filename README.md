<div align="center">

<img src="assets/logo.svg" alt="AXray" width="340" />

### Lighthouse for Agent Experience (AX)

Measure how AI agents – **ChatGPT, Claude, Perplexity** – read, understand, and recommend your site.<br/>
Get a real, measured **Agent Experience (AX) score** and the fixes that make agents pick you.

![Measured AX Score](https://img.shields.io/badge/Measured_AX_Score-C6F24E?style=for-the-badge)
![Multi-Model Council](https://img.shields.io/badge/Multi--Model_Council-C6F24E?style=for-the-badge)
![llms.txt · Schema · Agents](https://img.shields.io/badge/llms.txt_·_Schema_·_Agents-C6F24E?style=for-the-badge)

[**getaxray.com**](https://getaxray.com) · [Quick start](#quick-start) · [GitHub Action](#github-action) · [What gets measured](#what-gets-measured-no-api-key-needed)

</div>

---

Your next customers are AI agents. AXray scores how well ChatGPT, Claude, Perplexity — and the agents built on them - can read, understand, and act on your site. Run it after every feature ship, gate your pipeline on it, and watch the score climb as you make your product agent-friendly.

```
AXray - Agent Experience report
https://your-site.com
────────────────────────────────────────────────────────────────

  Score: 78/100  (measured)

  ✓ llms.txt  ✓ robots allows agents  ✓ sitemap.xml  ✗ markdown negotiation
  ✓ JSON-LD (5)  ✓ AGENTS.md  ✓ RSS/Atom  ✗ OpenAPI  ✓ MCP

  Measured factors
    Structured Data        ████████████████████░░░░ 80
    Content Accessibility  ██████████████████████░░ 90
    Content Negotiation    ██████████████░░░░░░░░░░ 60
    Action Readiness       █████████████████████░░░ 85

  Top recommendations
    1. Serve a clean Markdown representation when an agent sends
       Accept: text/markdown ...
```

## Why

Agents don't scroll, squint, or guess. They read `llms.txt`, parse JSON-LD, respect `robots.txt`, negotiate content types, and look for a documented way to act (`AGENTS.md`, OpenAPI, MCP). If your site doesn't expose those surfaces, agents skip you — or hallucinate your pricing.

Lighthouse made performance measurable in CI. AXray does the same for Agent Experience.

## Quick start

No install, no API key — the measured score is pure HTTP checks:

```bash
npx github:SohniSwatantra/axray https://your-site.com
```

Gate your CI like Lighthouse CI (exit code 1 below the threshold):

```bash
npx github:SohniSwatantra/axray https://your-site.com --min-score 70
```

Machine-readable output:

```bash
npx github:SohniSwatantra/axray https://your-site.com --json report.json
```

## GitHub Action

Run AXray on every deploy — for example after your preview/production deploy step:

```yaml
name: AX score
on:
  push:
    branches: [main]

jobs:
  axray:
    runs-on: ubuntu-latest
    steps:
      - uses: SohniSwatantra/axray@main
        with:
          url: https://your-site.com
          min-score: "70"
```

With the LLM council — just provide your [OpenRouter](https://openrouter.ai/keys) key as a repo secret and the council runs automatically:

```yaml
      - uses: SohniSwatantra/axray@main
        with:
          url: https://your-site.com
          min-score: "70"
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

Prefer a deterministic measured-only gate on every push (LLM scores vary slightly run to run)? Pin `council: "false"` and run the council on a nightly schedule instead.

The action writes the score to the job summary and exposes it as an output (`steps.<id>.outputs.score`).

## What gets measured (no API key needed)

Real HTTP requests, zero guessing:

| Signal | What AXray checks |
|---|---|
| `llms.txt` / `llms-full.txt` / `.well-known/llms.txt` | The plain-text brief agents read first |
| `robots.txt` | Whether GPTBot, ClaudeBot, PerplexityBot, Google-Extended & co. are allowed |
| `sitemap.xml` | Discoverability beyond the homepage (plus sampling of up to 3 sitemap pages for schema) |
| JSON-LD / Open Graph | Machine-readable facts: Organization, Product, Offer, FAQPage, Review... |
| Content negotiation | Does `Accept: text/markdown` return Markdown instead of HTML? |
| `AGENTS.md` | A served file telling agents how to take your primary action |
| RSS / Atom | `/rss.xml`, `/feed.xml`, `/atom.xml`, `<link rel="alternate">` |
| API / MCP surface | `/openapi.json`, RFC 8288 `Link` headers, RFC 9727 `/.well-known/api-catalog`, MCP server cards, MCP endpoints named in `llms.txt` |

These roll up into four measured factors — **Structured Data, Content Accessibility, Content Negotiation, Action Readiness** — averaged into the headline score. Sites without an API (agencies, portfolios, blogs) are **not** penalized: a clear documented action counts.

## The LLM council (BYO key — auto-enabled)

The council is the heart of AXray: multiple frontier models each score all 8 AX factors (adding Semantic HTML, Meta Tags, Content Clarity, Agent Interaction) **against the measured ground truth** — models are explicitly forbidden from contradicting the HTTP-verified facts. Results are averaged into a final score plus an **ANPS** (Agent Net Promoter Score: would an agent recommend you?).

**It runs automatically whenever `OPENROUTER_API_KEY` is set** — no flag needed:

```bash
OPENROUTER_API_KEY=sk-or-... npx github:SohniSwatantra/axray https://your-site.com
```

Use `--no-council` when the key is set but you want the fast, free, deterministic measured-only run (the right choice for per-push CI gates, since LLM scores vary slightly between runs).

Pick your own models (and cost) with `--models`:

```bash
npx github:SohniSwatantra/axray https://your-site.com --council \
  --models anthropic/claude-opus-4.8,openai/gpt-5.5
```

## CLI reference

```
axray <url> [options]

--min-score <n>   Exit 1 if the final score is below n (CI gate)
--council         Run the LLM council (auto-enabled when OPENROUTER_API_KEY is set)
--no-council      Skip the council even if OPENROUTER_API_KEY is set
--models <list>   Comma-separated OpenRouter model ids
--json [file]     Write full JSON result (file, or '-' for stdout)
--quiet           Suppress the human-readable report
```

Zero runtime dependencies. Node 18+.

## How to raise your score

The fastest fixes, in rough order of impact:

1. **`/llms.txt`** — a concise Markdown brief of what you do, who it's for, and links to key pages ([llmstxt.org](https://llmstxt.org))
2. **JSON-LD** — Organization + Product/Service/FAQPage schema on the pages where the facts live
3. **Open `robots.txt` to AI crawlers** — blocked agents can't recommend you
4. **`/AGENTS.md`** — state your primary action and exactly how an agent completes it
5. **Content negotiation** — serve Markdown for `Accept: text/markdown`
6. **OpenAPI or MCP** — if you're a product agents could drive programmatically

## Hosted version

Want the full report — screenshots, section-by-section analysis, multi-model council with per-model breakdowns, and a prioritized roadmap? Run your site through **[getaxray.com](https://getaxray.com)** (free).

## License

MIT
