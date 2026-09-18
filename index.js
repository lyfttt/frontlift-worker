const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "*";
  const configured = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin = configured.includes("*") || configured.includes(origin) ? origin : configured[0] || "*";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request, env) },
  });
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048) throw new Error("A valid website URL is required.");
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Private or local network addresses are not allowed.");
  }
  url.hash = "";
  return url;
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseModelJson(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The AI response was not valid JSON.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function fetchWebsite(url, maxChars) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.2",
        "user-agent": "FrontliftPreviewBot/1.0 (+https://frontlift.com)",
      },
    });
    if (!response.ok) throw new Error(`The website returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error("The submitted URL did not return a readable webpage.");
    }
    const html = await response.text();
    const text = htmlToText(html).slice(0, maxChars);
    if (text.length < 80) throw new Error("Not enough readable website content was found.");
    return { text, finalUrl: response.url || url.toString() };
  } finally {
    clearTimeout(timeout);
  }
}

function promptFor({ sourceUrl, businessName, notes, sourceText }) {
  return `You are Frontlift, an expert conversion-focused website strategist for local small businesses.

Analyze the supplied public website text and return ONLY valid JSON matching this shape:
{
  "business": { "name": "", "category": "", "location": "", "summary": "" },
  "audit": { "strengths": [""], "problems": [""], "missedOpportunities": [""] },
  "redesign": {
    "headline": "",
    "subheadline": "",
    "primaryCta": "",
    "secondaryCta": "",
    "trustBar": [""],
    "services": [{ "title": "", "description": "" }],
    "about": "",
    "socialProof": [{ "quote": "", "attribution": "" }],
    "faq": [{ "question": "", "answer": "" }],
    "seoTitle": "",
    "seoDescription": "",
    "styleDirection": { "tone": "", "colors": [""], "imagery": "", "layout": "" }
  },
  "sales": { "personalizedOpener": "", "threeValuePoints": [""], "recommendedOffer": "" }
}

Rules:
- Use only facts supported by the supplied text. Never invent awards, reviews, prices, guarantees, addresses, or credentials.
- If a fact is unavailable, use an empty string or empty array.
- Write concise, polished copy that can be rendered directly in a preview.
- Tailor the result to the actual business and its likely customers.

Submitted URL: ${sourceUrl}
Business name supplied by customer: ${businessName || "Not supplied"}
Customer notes: ${notes || "None"}

WEBSITE TEXT:
${sourceText}`;
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return json(request, env, {
        ok: true,
        service: "frontlift-generator",
        version: "1.0.0",
        aiConfigured: Boolean(env.AI),
      });
    }

    if (request.method !== "POST" || !["/generate", "/api/generate"].includes(path)) {
      return json(request, env, { ok: false, error: "Not found", requestId }, 404);
    }

    try {
      if (!env.AI) throw new Error("Workers AI binding is not configured.");
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return json(request, env, { ok: false, error: "Content-Type must be application/json.", requestId }, 415);
      }
      const body = await request.json();
      const url = normalizeUrl(body.url || body.websiteUrl);
      const businessName = String(body.businessName || "").trim().slice(0, 160);
      const notes = String(body.notes || "").trim().slice(0, 1000);
      const maxChars = Math.min(Math.max(Number(env.MAX_SOURCE_CHARS) || 30000, 5000), 60000);
      const website = await fetchWebsite(url, maxChars);

      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
        messages: [
          { role: "system", content: "Return only valid JSON. Do not use Markdown fences." },
          { role: "user", content: promptFor({ sourceUrl: website.finalUrl, businessName, notes, sourceText: website.text }) },
        ],
        temperature: 0.25,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      });
      const modelText = aiResponse?.response ?? aiResponse?.result?.response ?? aiResponse?.result ?? aiResponse?.output_text ?? "";
      const result = parseModelJson(modelText);

      return json(request, env, {
        ok: true,
        requestId,
        sourceUrl: website.finalUrl,
        generatedAt: new Date().toISOString(),
        result,
      });
    } catch (error) {
      const message = error?.name === "AbortError" ? "The submitted website took too long to respond." : error?.message || "Generation failed.";
      console.error(JSON.stringify({ requestId, message }));
      return json(request, env, { ok: false, error: message, requestId }, 500);
    }
  },
};
