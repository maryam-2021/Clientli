/**
 * CLIENTLI — Cloudflare Worker v2
 * Secure API proxy: DeepSeek AI + Firebase Auth + Stripe Payments
 *
 * Deploy:
 *   wrangler deploy
 *
 * Set secrets BEFORE deploying (run each line, paste value when prompted):
 *   wrangler secret put DEEPSEEK_API_KEY
 *   wrangler secret put FIREBASE_WEB_API_KEY     ← Firebase Project Settings → Web API Key
 *   wrangler secret put FIREBASE_PROJECT_ID       ← Firebase Project ID (e.g. clientli-abc123)
 *   wrangler secret put STRIPE_SECRET_KEY
 *   wrangler secret put STRIPE_WEBHOOK_SECRET
 */

// ── Allowed CORS origins — add your domain here
const ALLOWED_ORIGINS = [
  'https://clientli.app',
  'https://www.clientli.app',
  'https://clientli.pages.dev',         // Cloudflare Pages default domain
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
  'null',                                // file:// local testing
];

export default {
  async fetch(request, env, ctx) {
    // ── CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, request, env);
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/health')                return handleHealth(env);
      if (path === '/api/ai'               && request.method === 'POST') return handleAI(request, env);
      if (path === '/api/stripe/checkout'  && request.method === 'POST') return handleStripeCheckout(request, env);
      if (path === '/api/stripe/portal'    && request.method === 'POST') return handleStripePortal(request, env);
      if (path === '/api/stripe/webhook'   && request.method === 'POST') return handleStripeWebhook(request, env);
      return corsResponse({ error: 'Not found' }, 404, request, env);
    } catch (err) {
      console.error('Worker error:', err);
      return corsResponse({ error: 'Internal server error', detail: err.message }, 500, request, env);
    }
  }
};

// ══════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════
function handleHealth(env) {
  return new Response(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      deepseek: !!env.DEEPSEEK_API_KEY,
      firebase: !!env.FIREBASE_WEB_API_KEY,
      stripe:   !!env.STRIPE_SECRET_KEY,
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}

// ══════════════════════════════════════════════════════
// AI — DeepSeek proxy
// ══════════════════════════════════════════════════════
async function handleAI(request, env) {
  // Verify user is authenticated
  const user = await verifyFirebaseToken(request, env);
  if (!user) return corsResponse({ error: 'Unauthorized' }, 401, request, env);

  const body = await request.json().catch(() => ({}));
  const { messages, mode } = body;
  if (!messages || !Array.isArray(messages)) {
    return corsResponse({ error: 'messages array required' }, 400, request, env);
  }

  const systemPrompts = {
    invoice:  'You are an expert freelance business consultant. Write professional, concise invoice content. Be specific and business-appropriate. No preamble — go straight to the content.',
    proposal: 'You are an assistant that helps freelancers write winning proposals and project quotes. If the request is for a standard proposal: Write a persuasive, clearly structured proposal that closes deals. Confident, professional tone. No preamble. If the request is to build a project quote with a rationale paragraph: 1. CALCULATE the price: - Base price = rate × hours (or flat rate × deliverable count) - If complexity is \"Moderate,\" note this in the rationale as justifying a slightly fuller estimate rather than silently inflating the number - If complexity is \"Complex,\" same — reflect it in the rationale, not by inventing a multiplier the user didn\'t specify - If rush job is yes, apply the rush premium percentage provided (default 20% if none given) and state this explicitly - Add any fixed costs provided, listed separately - Do not invent numbers. Only calculate from what the user gave you. 2. WRITE the rationale — a short paragraph, client-facing, that explains what\'s included and why the price is what it is. Focus on value and deliverables, not just hours. Avoid apologizing for the price or hedging. Output format: - A clear price breakdown (base cost, rush premium if applicable, fixed costs, total) - Then the client-facing rationale paragraph, ready to paste into an email or proposal. No preamble or explanation outside these two sections.',
    email:    'You are an assistant that helps freelancers write professional business communications. If the request is for a payment reminder email: - Match the tone precisely to the escalation stage requested — do not soften a \"final notice\" or overdo a \"first reminder.\" - Friendly (first reminder): Assume oversight, not bad faith. Warm, brief, no pressure. Include the invoice details as a helpful nudge, not an accusation. - Firm (second reminder): Direct and clear. State the amount and days overdue plainly. Ask for a specific action (payment or a response) by a specific date. No hostility, but no more assuming-the-best-either. - Final notice (serious): Formal, unambiguous, no exclamation points. State facts: amount, days overdue, prior reminders sent. State the next step clearly if payment isn\'t received (e.g., late fee applies, work pauses, collections/legal mention only if the user explicitly provided that as a term). Do not threaten anything the user didn\'t specify. - Never invent late fees, legal consequences, or payment terms the user didn\'t provide. If a late fee was provided, mention it factually at the firm and final stages, not the friendly stage. If the request is for a scope change request email: - Acknowledge the new request positively — don\'t make the client feel scolded for asking. - Clearly and specifically state what falls outside the original scope, referencing what was actually agreed. - Present the added cost/time as a natural consequence of doing the work properly, not as a penalty. - Offer a clear next step: proceed with the added cost, or scope it down to fit the original agreement. - Adjust tone per the freelancer\'s preference: Collaborative (frame it as \"let\'s figure out the best path together\"), Direct (state the scope boundary plainly, offer the two options, no extra cushioning), or Firm boundary (still polite, but leaves no ambiguity that the extra work requires extra payment before proceeding). - Never guess at numbers the freelancer didn\'t provide — if cost is blank, say a quote will follow separately. If the request is for a rate increase notice email: - State the increase clearly and early — don\'t bury it in pleasantries. - Give a specific effective date so the client has notice. - If a reason was provided, mention it briefly, in one sentence, without over-explaining or sounding defensive. - If relationship context was provided (e.g., years worked together), use it to add warmth, not to soften the actual message. - Do not apologize for the increase. Do not offer to negotiate the number in the email — if the client wants to discuss it, that happens in the reply, not by leaving the door open here. - Close with appreciation for the working relationship, but keep it brief. If the request is for a testimonial request email: - Keep it short, warm, and low-friction — the easier you make it for the client to respond, the more likely they will. - Include a brief, genuine note about the project going well. - Include a specific, easy ask (e.g., 2-3 sentences on what it was like to work together, or answering 2 short questions if the freelancer wants structure). - Include reassurance that it can be short and informal. For all emails: Keep it to one screen\'s worth of text, include a clear subject line, sign off with [Your name], and output only the email without any preamble or explanation.',
    insight:  'You are a freelance business analyst. Provide specific, data-driven, actionable insights with concrete next steps. Be direct and practical. No preamble.',
    general:  'You are a helpful assistant for freelance professionals. If the request is to evaluate a prospective client\'s first message or project brief for red flags: 1. Analyze the pasted text for these categories: - Scope clarity (is the deliverable specific or vague?), - Budget signals (is there any mention of budget, or is it absent entirely? If the freelancer provided their typical minimum, flag if the brief suggests a mismatch), - Timeline pressure (is there unrealistic urgency without matching clarity on scope?), - Communication red flags (vague decision-making, excessive free-work requests, or scope that keeps changing), - Green flags (note anything genuinely reassuring like clear deliverables, stated budget, realistic timeline, decisive language). 2. Output format: - A short overall risk read: Low / Medium / High, one sentence explaining why - A bulleted list of specific flags found (or \"No significant flags found\" if genuinely clean), each with a one-line reason - 2-3 suggested clarifying questions the freelancer could send back before agreeing to anything. Be calibrated, not alarmist — only flag genuine ambiguity or risk patterns. Do not tell the freelancer whether to take the job; give them the information to decide. If the request is to turn a client\'s rough, informal feedback into a polished, quotable case study blurb: - Preserve the client\'s authentic voice and meaning. - Do not invent claims, results, or specifics the client didn\'t actually say. - Tighten grammar and flow only; do not add superlatives or specifics that weren\'t present in the original. - Output the polished quote (1-3 sentences) attributed as \"— [Client name], [optional: role/company placeholder].\" - Output only the polished quote without any preamble or explanation. If the request is to draft starting-point contract clause language for a specified clause type: - Use plain, clear language over dense legalese where possible, since many freelancer contracts are read and signed by non-lawyers on both sides. - If the freelancer specified concrete terms (e.g., \"2 rounds of revisions\"), use exactly those — do not substitute your own numbers. - If no specific terms were given, draft reasonable placeholder language and clearly mark the placeholder values in brackets, e.g., \"[NUMBER] rounds of revisions,\" so the freelancer knows to fill them in rather than assuming the draft reflects their actual terms. - Keep the clause focused and short — this is one clause, not a full contract. - Always end the output with this exact note, unmodified: \"This is a starting draft, not a finished contract. Have it reviewed by a lawyer or adapted from a proper contract template before use — clause language has real legal weight.\" - Output only the clause text followed by the note above. No other preamble or explanation. Otherwise: Be concise, practical, and helpful.',
  };

  const systemPrompt = systemPrompts[mode] || systemPrompts.general;

  const deepseekRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model:       'deepseek-chat',   // V3 — cheapest, very capable
      max_tokens:  1000,
      temperature: 0.7,
      stream:      false,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    }),
  });

  if (!deepseekRes.ok) {
    const errText = await deepseekRes.text();
    console.error('DeepSeek error:', deepseekRes.status, errText);
    return corsResponse({ error: 'AI service unavailable', status: deepseekRes.status }, 502, request, env);
  }

  const data  = await deepseekRes.json();
  const text  = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};

  return corsResponse({ text, model: data.model, usage }, 200, request, env);
}

// ══════════════════════════════════════════════════════
// STRIPE — Create checkout session
// ══════════════════════════════════════════════════════
async function handleStripeCheckout(request, env) {
  const user = await verifyFirebaseToken(request, env);
  if (!user) return corsResponse({ error: 'Unauthorized' }, 401, request, env);

  const body = await request.json().catch(() => ({}));
  const { priceId, successUrl, cancelUrl } = body;
  if (!priceId) return corsResponse({ error: 'priceId required' }, 400, request, env);

  const params = new URLSearchParams({
    'payment_method_types[]':         'card',
    'mode':                           'subscription',
    'line_items[0][price]':           priceId,
    'line_items[0][quantity]':        '1',
    'customer_email':                 user.email || '',
    'client_reference_id':            user.uid,
    'metadata[firebase_uid]':         user.uid,
    'allow_promotion_codes':          'true',
    'success_url':                    successUrl || 'https://clientli.app/app.html?upgraded=1',
    'cancel_url':                     cancelUrl  || 'https://clientli.app/app.html',
    'subscription_data[metadata][firebase_uid]': user.uid,
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type':   'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return corsResponse({ error: err.error?.message || 'Stripe error' }, 502, request, env);
  }

  const session = await res.json();
  return corsResponse({ url: session.url, sessionId: session.id }, 200, request, env);
}

// ══════════════════════════════════════════════════════
// STRIPE — Customer portal
// ══════════════════════════════════════════════════════
async function handleStripePortal(request, env) {
  const user = await verifyFirebaseToken(request, env);
  if (!user) return corsResponse({ error: 'Unauthorized' }, 401, request, env);

  const body = await request.json().catch(() => ({}));
  const { customerId, returnUrl } = body;
  if (!customerId) return corsResponse({ error: 'customerId required' }, 400, request, env);

  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer:   customerId,
      return_url: returnUrl || 'https://clientli.app/app.html',
    }),
  });

  const portal = await res.json();
  if (!res.ok) return corsResponse({ error: portal.error?.message || 'Portal error' }, 502, request, env);
  return corsResponse({ url: portal.url }, 200, request, env);
}

// ══════════════════════════════════════════════════════
// STRIPE — Webhook handler
// ══════════════════════════════════════════════════════
async function handleStripeWebhook(request, env) {
  const sig     = request.headers.get('stripe-signature') || '';
  const rawBody = await request.text();

  // Verify signature
  const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON', { status: 400 }); }

  const obj         = event.data?.object || {};
  const firebaseUid = obj.metadata?.firebase_uid || obj.client_reference_id || null;

  if (firebaseUid) {
    const planMap = {
      'checkout.session.completed':    { plan: 'pro',     subscriptionStatus: 'active'    },
      'customer.subscription.updated': { plan: 'pro',     subscriptionStatus: 'active'    },
      'customer.subscription.deleted': { plan: 'starter', subscriptionStatus: 'cancelled' },
      'invoice.payment_failed':        { plan: 'pro',     subscriptionStatus: 'past_due'  },
    };
    const update = planMap[event.type];
    if (update) {
      await patchFirestoreUser(firebaseUid, {
        ...update,
        stripeCustomerId: obj.customer || '',
        updatedAt:        new Date().toISOString(),
      }, env);
    }
  }

  return new Response('OK', { status: 200 });
}

// ══════════════════════════════════════════════════════
// FIREBASE — Token verification
// Uses Firebase Auth REST API (no Admin SDK needed in Workers)
// ══════════════════════════════════════════════════════
async function verifyFirebaseToken(request, env) {
  // Local Development bypass
  if (env.ENVIRONMENT === 'development') {
    return { uid: 'demo-user', email: 'demo@clientli.app' };
  }

  try {
    const authHeader = request.headers.get('Authorization') || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return null;

    // Verify token via Firebase Auth REST API
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ idToken }),
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const u    = data.users?.[0];
    if (!u || u.disabled) return null;

    return { uid: u.localId, email: u.email || '' };
  } catch (e) {
    console.error('Token verify error:', e);
    return null;
  }
}

// ══════════════════════════════════════════════════════
// FIRESTORE — Patch user document via REST
// ══════════════════════════════════════════════════════
async function patchFirestoreUser(uid, data, env) {
  try {
    // Build Firestore field mask + fields
    const fields     = {};
    const updateMask = [];
    for (const [k, v] of Object.entries(data)) {
      updateMask.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`);
      fields[k] = typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) };
    }

    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}?${updateMask.join('&')}`;
    await fetch(url, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields }),
    });
  } catch (e) {
    console.error('Firestore patch error:', e);
  }
}

// ══════════════════════════════════════════════════════
// STRIPE — Webhook signature verification (Web Crypto)
// ══════════════════════════════════════════════════════
async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts     = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return false;

    const signed    = `${timestamp}.${payload}`;
    const keyData   = new TextEncoder().encode(secret);
    const msgData   = new TextEncoder().encode(signed);
    const key       = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuffer = await crypto.subtle.sign('HMAC', key, msgData);
    const expected  = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Timing-safe compare
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    console.error('Stripe sig verify error:', e);
    return false;
  }
}

// ══════════════════════════════════════════════════════
// CORS helper
// ══════════════════════════════════════════════════════
function corsResponse(data, status, request, env) {
  const origin        = request?.headers?.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const headers = {
    'Content-Type':                    'application/json',
    'Access-Control-Allow-Origin':     allowedOrigin,
    'Access-Control-Allow-Methods':    'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':    'Content-Type, Authorization',
    'Access-Control-Max-Age':          '86400',
    'Vary':                            'Origin',
  };

  const body = data !== null ? JSON.stringify(data) : null;
  return new Response(body, { status, headers });
}
