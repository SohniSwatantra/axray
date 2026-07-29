/** A robots.txt rule observed for a known AI crawler user-agent. */
export interface RobotsAgentRule {
  userAgent: string;
  disallowed: boolean;
}

/** Everything AXray measures with real HTTP requests — no LLM required. */
export interface MeasuredSignals {
  checkedAt: string;
  origin: string;
  llmsTxt: { present: boolean; url: string; bytes: number };
  llmsFullTxt: { present: boolean; bytes: number };
  wellKnownLlmsTxt: { present: boolean };
  agentsMd: { present: boolean; bytes: number };
  robotsTxt: {
    present: boolean;
    allowsAiAgents: boolean;
    agentRules: RobotsAgentRule[];
    hasSitemapDirective: boolean;
  };
  sitemapXml: { present: boolean };
  contentNegotiation: {
    supportsMarkdown: boolean;
    supportsPlainText: boolean;
    markdownContentType: string | null;
    htmlContentType: string | null;
  };
  structuredData: {
    jsonLdBlocks: number;
    schemaTypes: string[];
    hasOpenGraph: boolean;
  };
  apiSurface: {
    hasOpenApi: boolean;
    hasWellKnown: boolean;
    hasMcp: boolean;
    hasApiCatalog: boolean;
    linkRels: string[];
  };
  rssFeed: { present: boolean };
  /** Up to 3 sitemap-discovered pages sampled beyond the homepage. */
  sampledPages: Array<{ url: string; schemaTypes: string[]; jsonLdBlocks: number }>;
  errors: string[];
}

/** 0-100 sub-scores for the four factors AXray can verify with HTTP checks. */
export interface MeasuredFactorScores {
  structuredData: number;
  contentAccessibility: number;
  contentNegotiation: number;
  actionReadiness: number;
}

/** One model's verdict from the optional LLM council. */
export interface CouncilModelResult {
  model: string;
  axScore: number | null;
  anps: number | null;
  factors: Array<{ name: string; score: number; description: string }>;
  summary: string;
  error?: string;
}

/** The full result AXray reports (and writes as JSON). */
export interface AxrayResult {
  url: string;
  checkedAt: string;
  measured: {
    signals: MeasuredSignals;
    factorScores: MeasuredFactorScores;
    /** Average of the four measured factors — the no-key "Lighthouse" score. */
    score: number;
  };
  recommendations: string[];
  council?: {
    models: CouncilModelResult[];
    /** Average AX score across models that completed. */
    score: number | null;
    anps: number | null;
  };
  /** Final headline score: council average when available, else measured. */
  score: number;
}
