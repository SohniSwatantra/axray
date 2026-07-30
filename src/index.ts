#!/usr/bin/env node
/**
 * AXray CLI — Lighthouse-style Agent Experience (AX) scoring for CI.
 *
 *   axray https://your-site.com                    # measured score (no key)
 *   axray https://your-site.com --min-score 70     # fail CI below 70
 *   axray https://your-site.com --council          # + LLM council (OPENROUTER_API_KEY)
 *   axray https://your-site.com --json report.json # machine-readable output
 */

import { writeFileSync } from "node:fs";
import {
  probeAgentReadiness,
  computeMeasuredFactorScores,
  computeMeasuredScore,
  generateMeasuredRecommendations,
} from "./probe.js";
import { runCouncil, DEFAULT_COUNCIL_MODELS } from "./council.js";
import { printReport } from "./report.js";
import type { AxrayResult } from "./types.js";

const HELP = `AXray — Lighthouse for Agent Experience (AX)

Usage:
  axray <url> [options]

Options:
  --min-score <n>   Exit with code 1 if the final score is below n (CI gate)
  --council         Run the LLM council (auto-enabled when OPENROUTER_API_KEY is set)
  --no-council      Skip the council even if OPENROUTER_API_KEY is set
  --models <list>   Comma-separated OpenRouter model ids for the council
                    (default: ${DEFAULT_COUNCIL_MODELS.join(",")})
  --json [file]     Write the full result as JSON (to file, or stdout with -)
  --quiet           Suppress the human-readable report
  --help            Show this help

The multi-model council runs automatically when OPENROUTER_API_KEY is set —
key present means you want the full verdict. Use --no-council for a fast,
free, deterministic measured-only run (recommended for per-push CI gates).

Examples:
  npx axray https://example.com --min-score 70
  OPENROUTER_API_KEY=sk-or-... npx axray https://example.com
`;

interface Args {
  url: string;
  minScore: number | null;
  council: boolean;
  noCouncil: boolean;
  models: string[];
  json: string | null;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    url: "",
    minScore: null,
    council: false,
    noCouncil: false,
    models: DEFAULT_COUNCIL_MODELS,
    json: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return null;
    else if (a === "--min-score") args.minScore = Number(argv[++i]);
    else if (a === "--council") args.council = true;
    else if (a === "--no-council") args.noCouncil = true;
    else if (a === "--models") args.models = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--json") {
      const next = argv[i + 1];
      args.json = next && !next.startsWith("--") ? argv[++i] : "-";
    } else if (a === "--quiet") args.quiet = true;
    else if (!a.startsWith("--") && !args.url) args.url = a;
  }
  return args.url ? args : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(HELP);
    process.exit(process.argv.includes("--help") || process.argv.includes("-h") ? 0 : 2);
  }

  let url = args.url.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    console.error(`Invalid URL: ${args.url}`);
    process.exit(2);
  }

  if (!args.quiet) console.error(`Probing ${url} ...`);

  // Fetch homepage HTML once — reused by the probe and the council prompt.
  let pageHtml = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AXray/1.0; +https://github.com/SohniSwatantra/axray)",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    pageHtml = res.ok ? await res.text() : "";
  } catch {
    /* the probe reports fetch failures itself */
  }

  const signals = await probeAgentReadiness(url, pageHtml || undefined);
  const factorScores = computeMeasuredFactorScores(signals);
  const measuredScore = computeMeasuredScore(factorScores);
  const recommendations = generateMeasuredRecommendations(signals);

  const result: AxrayResult = {
    url,
    checkedAt: signals.checkedAt,
    measured: { signals, factorScores, score: measuredScore },
    recommendations,
    score: measuredScore,
  };

  // The council is a headline feature: auto-enable it whenever a key is
  // present (key set = you want the full verdict). --no-council opts out for
  // fast deterministic CI gates; --council without a key explains what's needed.
  const apiKey = process.env.OPENROUTER_API_KEY;
  const wantCouncil = !args.noCouncil && (args.council || !!apiKey);
  if (wantCouncil) {
    if (!apiKey) {
      console.error(
        "--council requires OPENROUTER_API_KEY (get one at https://openrouter.ai/keys). Running measured-only."
      );
    } else {
      if (!args.quiet) console.error(`Running council (${args.models.length} models) ...`);
      const council = await runCouncil(url, signals, pageHtml, args.models, apiKey);
      result.council = council;
      if (council.score != null) result.score = council.score;
    }
  }

  if (!args.quiet) printReport(result);

  if (args.json) {
    const payload = JSON.stringify(result, null, 2);
    if (args.json === "-") console.log(payload);
    else {
      writeFileSync(args.json, payload);
      if (!args.quiet) console.error(`JSON written to ${args.json}`);
    }
  }

  if (args.minScore != null && result.score < args.minScore) {
    console.error(
      `\nAX score ${result.score} is below the required minimum ${args.minScore}. Failing.`
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("AXray failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
