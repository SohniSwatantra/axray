/** Terminal + JSON reporting, Lighthouse-style. Zero dependencies. */

import type { AxrayResult, MeasuredSignals } from "./types.js";

const isTTY = process.stdout.isTTY;
const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  red: isTTY ? "\x1b[31m" : "",
  lime: isTTY ? "\x1b[92m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
};

function scoreColor(n: number): string {
  return n >= 75 ? c.green : n >= 50 ? c.yellow : c.red;
}

function bar(n: number, width = 24): string {
  const filled = Math.round((n / 100) * width);
  return `${scoreColor(n)}${"█".repeat(filled)}${c.dim}${"░".repeat(width - filled)}${c.reset}`;
}

function chip(ok: boolean, label: string): string {
  return ok ? `${c.green}✓ ${label}${c.reset}` : `${c.dim}✗ ${label}${c.reset}`;
}

function signalChips(s: MeasuredSignals): string {
  return [
    chip(s.llmsTxt.present, "llms.txt"),
    chip(s.robotsTxt.present && s.robotsTxt.allowsAiAgents, "robots allows agents"),
    chip(s.sitemapXml.present || s.robotsTxt.hasSitemapDirective, "sitemap.xml"),
    chip(s.contentNegotiation.supportsMarkdown, "markdown negotiation"),
    chip(s.structuredData.jsonLdBlocks > 0, `JSON-LD (${s.structuredData.jsonLdBlocks})`),
    chip(s.agentsMd.present, "AGENTS.md"),
    chip(s.rssFeed.present, "RSS/Atom"),
    chip(s.apiSurface.hasOpenApi, "OpenAPI"),
    chip(s.apiSurface.hasMcp, "MCP"),
  ].join("  ");
}

export function printReport(result: AxrayResult): void {
  const { measured, council } = result;
  const f = measured.factorScores;
  const line = `${c.dim}${"─".repeat(64)}${c.reset}`;

  console.log("");
  console.log(`${c.bold}${c.lime}AXray${c.reset} ${c.dim}— Agent Experience report${c.reset}`);
  console.log(`${c.dim}${result.url}${c.reset}`);
  console.log(line);
  console.log("");
  console.log(
    `  ${c.bold}Score: ${scoreColor(result.score)}${result.score}/100${c.reset}` +
      (council?.score != null
        ? `  ${c.dim}(council of ${council.models.filter((m) => m.axScore != null).length} models; measured ${measured.score})${c.reset}`
        : `  ${c.dim}(measured — run with --council for the full multi-model score)${c.reset}`)
  );
  if (council?.anps != null) {
    console.log(`  ${c.bold}ANPS:${c.reset}  ${council.anps > 0 ? "+" : ""}${council.anps} ${c.dim}(Agent Net Promoter Score)${c.reset}`);
  }
  console.log("");
  console.log(`  ${signalChips(measured.signals)}`);
  console.log("");
  console.log(`  ${c.bold}Measured factors${c.reset}`);
  console.log(`    Structured Data        ${bar(f.structuredData)} ${f.structuredData}`);
  console.log(`    Content Accessibility  ${bar(f.contentAccessibility)} ${f.contentAccessibility}`);
  console.log(`    Content Negotiation    ${bar(f.contentNegotiation)} ${f.contentNegotiation}`);
  console.log(`    Action Readiness       ${bar(f.actionReadiness)} ${f.actionReadiness}`);

  if (council) {
    console.log("");
    console.log(`  ${c.bold}Council${c.reset}`);
    for (const m of council.models) {
      if (m.axScore != null) {
        console.log(`    ${m.model.padEnd(36)} ${scoreColor(m.axScore)}${m.axScore}${c.reset}`);
      } else {
        console.log(`    ${m.model.padEnd(36)} ${c.red}failed${c.reset} ${c.dim}${(m.error || "").slice(0, 60)}${c.reset}`);
      }
    }
  }

  if (result.recommendations.length) {
    console.log("");
    console.log(`  ${c.bold}Top recommendations${c.reset}`);
    result.recommendations.slice(0, 8).forEach((r, i) => {
      console.log(`    ${c.cyan}${i + 1}.${c.reset} ${r}`);
    });
  }

  console.log("");
  console.log(line);
  console.log(
    `${c.dim}Full report with screenshots + section analysis: https://getaxray.com${c.reset}`
  );
  console.log("");
}
