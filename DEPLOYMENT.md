# Clientli — Production Deployment Guide

## Architecture

```
GitHub (source) → GitHub Actions (CI/CD)
    ↓                        ↓
Cloudflare Pages        Cloudflare Workers
(static site)           (API proxy)
    ↓                        ↓
Firebase Auth         DeepSeek AI  ←  ~20× cheaper than GPT-4
Firebase Firestore    Stripe Payments
```

---

## What you need (all free tiers available)

| Service | Cost | Purpose |
|---------|------|---------|
| GitHub | Free | Code hosting + CI/CD |
| Cloudflare Pages | Free | Static site hosting |
| Cloudflare Workers | Free (100k req/day) | API proxy |
| Firebase | Free (Spark plan) | Auth + database |
| DeepSeek | ~$0.001/1k tokens | AI features |
| Stripe | Free + 2.9% per txn | Payments |

---

## STEP 1 — Firebase setup (15 min)

1. Go to https://console.firebase.google.com
2. Click "Create project" → name it "clientli"
3. Enable **Authentication**:
   - Authentication → Sign-in method → Enable **Email/Password**
   - Authentication → Sign-in method → Enable **Google** (optional)
4. Enable **Firestore**:
   - Firestore Database → Create database → Start in **production mode**
   - Rules tab → paste contents of `firestore.rules` → Publish
5. Get your config:
   - Project Settings → Your apps → Add app → Web
   - Copy the firebaseConfig object
6. Open `site/app.html` → find `FIREBASE_CONFIG` → paste your values
7. Also paste your `projectId` into `worker/wrangler.toml`

---

## STEP 2 — DeepSeek API key (5 min)

1. Go to https://platform.deepseek.com
2. Create account → API Keys → Create key
3. Copy the key (starts with `sk-`)
4. **Cost**: DeepSeek V3 = $0.27/million input tokens, $1.10/million output tokens
   - Compare: GPT-4o = ~$15/million tokens → DeepSeek is ~20× cheaper

---

## STEP 3 — Stripe setup (20 min)

1. Go to https://stripe.com → create account
2. Dashboard → Products → Add product:
   - **Clientli Pro Monthly**: $19/month (recurring)
   - **Clientli Pro Annual**: $180/year (recurring)
   - **Clientli Studio**: $49/month (recurring)
3. Copy each Price ID (starts with `price_`)
4. Open `site/app.html` → find `STRIPE_PRICES` → paste your Price IDs
5. Also paste your Publishable Key (starts with `pk_live_`)
6. Get your Secret Key (starts with `sk_live_`) — for the Worker secret
7. Webhooks → Add endpoint:
   - URL: `https://clientli-api.YOUR_SUBDOMAIN.workers.dev/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
              `customer.subscription.deleted`, `invoice.payment_failed`
   - Copy the Webhook Signing Secret (starts with `whsec_`)

---

## STEP 4 — Cloudflare setup (10 min)

1. Go to https://dash.cloudflare.com → create account
2. **Workers & Pages** → Create → Pages → Connect to Git → select your repo
   - Build settings: Framework = None, Output = `site`, Build command = (leave empty)
   - Save → Deploy
3. **Workers & Pages** → Create → Worker → name it `clientli-api`
   - You'll deploy via CLI in Step 6

---

## STEP 5 — GitHub repository (5 min)

1. Create new repo at https://github.com/new → name `clientli`
2. Upload all files from this zip to the repo
3. Add GitHub Secrets (Settings → Secrets → Actions → New secret):
   ```
   CLOUDFLARE_API_TOKEN   → Cloudflare → My Profile → API Tokens → Create Token (use "Edit Cloudflare Workers" template)
   CLOUDFLARE_ACCOUNT_ID  → Cloudflare → right sidebar → Account ID
   ```

---

## STEP 6 — Deploy Worker with secrets (10 min)

Install Wrangler CLI:
```bash
npm install -g wrangler
wrangler login
```

Set all secrets (these are NEVER committed to git):
```bash
cd worker

wrangler secret put DEEPSEEK_API_KEY
# → paste your DeepSeek key when prompted

wrangler secret put FIREBASE_PROJECT_ID
# → paste your Firebase Web API Key (from Project Settings → General → Web API Key)

wrangler secret put STRIPE_SECRET_KEY
# → paste sk_live_... key

wrangler secret put STRIPE_WEBHOOK_SECRET
# → paste whsec_... key

# Deploy the worker
wrangler deploy
```

Copy your Worker URL (shown after deploy, e.g. `https://clientli-api.abc123.workers.dev`)
→ Open `site/app.html` → find `WORKER_URL` → paste it

---

## STEP 7 — Final app.html config

Open `site/app.html` and set these values:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            "AIza...",          // Firebase Web API Key
  authDomain:        "clientli-xxx.firebaseapp.com",
  projectId:         "clientli-xxx",
  storageBucket:     "clientli-xxx.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123:web:abc",
};

const WORKER_URL = "https://clientli-api.abc123.workers.dev";

const STRIPE_PUBLISHABLE_KEY = "pk_live_...";

const STRIPE_PRICES = {
  pro_monthly: "price_...",
  pro_annual:  "price_...",
  studio:      "price_...",
};

const DEV_MODE = false;    // ← SET THIS TO false FOR PRODUCTION
```

---

## STEP 8 — Push and go live

```bash
git add .
git commit -m "Production deployment"
git push origin main
```

GitHub Actions will automatically:
1. Deploy the site to Cloudflare Pages
2. Deploy the Worker to Cloudflare Workers

Your site will be live at `https://clientli.pages.dev` (or your custom domain).

---

## Custom domain

1. Cloudflare Pages → your project → Custom domains → Add
2. Enter your domain (e.g. `clientli.app`)
3. If domain is on Cloudflare: auto-configured
4. If domain is elsewhere: add the CNAME record shown

---

## Costs at scale

| Users | Firebase | Cloudflare | DeepSeek | Stripe | Total |
|-------|----------|------------|----------|--------|-------|
| 0–100 | Free | Free | ~$0 | $0 | **$0/mo** |
| ~500  | Free | Free | ~$2 | % of revenue | **~$2/mo** |
| ~5000 | ~$25 | $5 | ~$15 | % of revenue | **~$45/mo** |

Firebase Spark (free): 50k reads/day, 20k writes/day, 1GB storage
Cloudflare Workers free: 100k requests/day
DeepSeek: pay per token — extremely cheap

---

## DEV_MODE

Keep `DEV_MODE = true` while testing locally — everything uses localStorage,
no Firebase or Stripe calls are made. Set to `false` only when all config values above are filled in.

Demo account always works in DEV_MODE:
- Email: demo@clientli.app
- Password: demo1234

---

## Support

- Firebase docs: https://firebase.google.com/docs
- DeepSeek API: https://platform.deepseek.com/docs
- Cloudflare Workers: https://developers.cloudflare.com/workers
- Stripe docs: https://stripe.com/docs
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler
