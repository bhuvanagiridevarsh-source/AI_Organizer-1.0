# Launch Checklist — System Janitor

When you're ready to start charging customers, do these steps in order.

---

## Prerequisites
- Stripe account (https://stripe.com) — create a product and a checkout link
- Supabase account (https://supabase.com) — free tier is fine
- Resend account (https://resend.com) — free tier: 3,000 emails/month
- Vercel account (https://vercel.com) — free tier is fine

---

## Step 1 — Set up Supabase

1. Create a new Supabase project
2. Open the SQL editor and run the contents of `backend/schema.sql`
3. Copy your **Project URL** and **Service Role Key** from Settings → API

---

## Step 2 — Set up Resend (email delivery)

1. Sign up at https://resend.com
2. Add and verify a sending domain (e.g. noreply@yourdomain.com)
3. Copy your **API Key**

---

## Step 3 — Deploy the backend to Vercel ✅ DONE

Backend is already deployed at `https://backend-two-mu-53.vercel.app`.

Verify it's alive: `curl https://backend-two-mu-53.vercel.app/api/health`
→ should return `{"ok":true,"service":"system-janitor-backend"}`

If you ever need to redeploy (e.g. after adding env vars):
```bash
cd backend
npx vercel --prod --yes --scope bhuvanagiridevarsh-1107s-projects
```

---

## Step 4 — Set environment variables in Vercel

In the Vercel dashboard → your project → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | sk_live_... (from Stripe) |
| `STRIPE_WEBHOOK_SECRET` | whsec_... (from Stripe webhooks) |
| `SUPABASE_URL` | https://xyz.supabase.co |
| `SUPABASE_SERVICE_ROLE_KEY` | your service role key |
| `RESEND_API_KEY` | re_... (from Resend) |
| `FROM_EMAIL` | System Janitor <noreply@yourdomain.com> |
| `SUPPORT_EMAIL` | support@yourdomain.com |

Then redeploy: `npx vercel --prod` (or click Redeploy in the dashboard).

Verify the backend is alive: `curl https://YOUR_URL.vercel.app/api/health`
→ should return `{"ok":true}`

---

## Step 5 — Set up the Stripe webhook

1. In Stripe → Developers → Webhooks → Add endpoint
2. URL: `https://YOUR_URL.vercel.app/api/webhooks/stripe`
3. Events to listen for: `checkout.session.completed`
4. Copy the **Signing Secret** → put it in Vercel as `STRIPE_WEBHOOK_SECRET`

---

## Step 6 — Wire the app to the backend ✅ DONE

`src/main/services/licenseService.js` already points at the live backend:
```js
const LICENSE_API_URL = "https://backend-two-mu-53.vercel.app/api/license/validate";
```

No change needed here.

---

## Step 7 — Run the device-binding migration (one-time)

In the Supabase SQL Editor, run the `license_devices` block from `backend/schema.sql`
(just the second CREATE TABLE — `license_keys` already exists in prod).
This caps each key at 2 devices. Until you run it, validation "fails open"
(keys work everywhere), so there's no rush — but do it before launch.

Then redeploy the backend: `cd backend && npx vercel --prod --yes`

---

## Step 8 — Create your Stripe Payment Link

Stripe Dashboard → Payment Links → New → your System Janitor product.
Paste the link into `src/main/services/licenseService.js`:

```js
const CHECKOUT_URL = "https://buy.stripe.com/XXXX"; // ← your payment link
```

This powers the "Get a license" button on the in-app paywall. If left empty,
the paywall shows your support email instead of a dead button.

---

## Step 9 — Go live

In `src/main/services/licenseService.js`, change:

```js
const TESTING_MODE = false; // ← was true
```

Rebuild and ship. Done.

---

## How the flow works end-to-end

1. New user gets a **free trial: 300 file moves** (lifetime, per install) — no key needed
2. Trial runs out → in-app paywall with your Stripe Payment Link
3. Customer pays on Stripe checkout
4. Stripe fires `checkout.session.completed` to your webhook
5. Webhook generates a UUID license key, inserts it into Supabase, emails it to customer
6. Customer opens app → Settings → License → pastes key → clicks Activate
7. App calls `/api/license/validate` (with an anonymous device id — max 2 devices/key)
   → Supabase confirms → cached locally, re-checked every 24 h
8. Offline grace: a validated license keeps working **7 days** with no network,
   so travel or an outage never locks out a paying customer
9. Undo/redo and PII secure-move are NEVER license-gated — user data is never held hostage
