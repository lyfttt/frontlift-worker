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

const PAYMENT_PRODUCTS = {
  refresh: { amount: 29900, name: "Frontlift Website Refresh", description: "Four-page responsive website refresh, one revision round, and domain connection walkthrough." },
  new: { amount: 34900, name: "Frontlift First Website", description: "Four-page responsive first website, one revision round, and domain connection walkthrough." },
  landing: { amount: 14900, name: "Frontlift Focused Landing Page", description: "One responsive landing page, one revision round, and domain connection walkthrough." },
};

function validCheckoutOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    const allowed = new Set(["https://getfrontlift.com", "https://www.getfrontlift.com"]);
    return allowed.has(url.origin) ? url.origin : "";
  } catch {
    return "";
  }
}

async function getStripeSecret(env) {
  const binding = env.STRIPE_SECRET_KEY;
  if (!binding) return "";
  if (typeof binding === "string") return binding;
  if (typeof binding.get === "function") return String((await binding.get()) || "");
  return "";
}

async function stripeRequest(stripeSecret, path, options = {}) {
  if (!stripeSecret) throw new Error("Stripe is not configured.");
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${stripeSecret}`,
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe request failed.");
  return data;
}

async function handlePayments(request, env, path) {
  const stripeSecret = await getStripeSecret(env);
  if (!stripeSecret) return json(request, env, { ok: false, error: "Stripe is not configured." }, 503);
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return json(request, env, { ok: false, error: "Content-Type must be application/json." }, 415);
  }

  const body = await request.json();
  const projectId = String(body.projectId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(projectId)) {
    return json(request, env, { ok: false, error: "A valid project is required." }, 400);
  }

  if (path === "/payments/create-checkout") {
    const product = PAYMENT_PRODUCTS[body.projectType];
    const origin = validCheckoutOrigin(body.origin);
    const email = String(body.email || "").trim().slice(0, 254);
    if (!product) return json(request, env, { ok: false, error: "Invalid project type." }, 400);
    if (!origin) return json(request, env, { ok: false, error: "Checkout must start from getfrontlift.com." }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(request, env, { ok: false, error: "A valid customer email is required." }, 400);

    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("success_url", origin + "/payment-success?session_id={CHECKOUT_SESSION_ID}");
    form.set("cancel_url", origin + "/scope");
    form.set("customer_email", email);
    form.set("client_reference_id", projectId);
    form.set("metadata[project_id]", projectId);
    form.set("metadata[project_type]", body.projectType);
    form.set("payment_intent_data[metadata][project_id]", projectId);
    form.set("payment_intent_data[metadata][project_type]", body.projectType);
    form.set("line_items[0][quantity]", "1");
    form.set("line_items[0][price_data][currency]", "usd");
    form.set("line_items[0][price_data][unit_amount]", String(product.amount));
    form.set("line_items[0][price_data][product_data][name]", product.name);
    form.set("line_items[0][price_data][product_data][description]", product.description);

    const session = await stripeRequest(stripeSecret, "/checkout/sessions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    return json(request, env, { ok: true, url: session.url, sessionId: session.id });
  }

  const sessionId = String(body.sessionId || "").trim();
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) {
    return json(request, env, { ok: false, error: "A valid checkout session is required." }, 400);
  }
  const session = await stripeRequest(stripeSecret, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  const matches = session.client_reference_id === projectId;
  return json(request, env, {
    ok: true,
    paid: matches && session.payment_status === "paid" && session.status === "complete",
    matches,
    status: session.status,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
  });
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
        version: "1.1.1",
        stripeConfigured: Boolean(await getStripeSecret(env)),
        aiConfigured: Boolean(env.AI),
      });
    }

    if (request.method === "POST" && ["/payments/create-checkout", "/payments/verify"].includes(path)) {
      try {
        return await handlePayments(request, env, path);
      } catch (error) {
        const message = error?.message || "Payment request failed.";
        console.error(JSON.stringify({ requestId, path, message }));
        return json(request, env, { ok: false, error: message, requestId }, 422);
      }
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
