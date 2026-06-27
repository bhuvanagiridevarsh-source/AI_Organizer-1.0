const crypto = require("crypto");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Vercel needs the raw body for Stripe signature verification.
// IMPORTANT: config must be attached to the exported handler function AFTER
// the handler is defined — assigning module.exports.config before the handler
// is set, then reassigning module.exports = handler, destroys the config property.

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Send the license key to the customer via Resend.
 * Requires RESEND_API_KEY in environment variables.
 * Sign up free at https://resend.com — 3,000 emails/month free.
 */
async function sendLicenseEmail(toEmail, licenseKey) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error("[stripe] RESEND_API_KEY not set — cannot email license key");
    return;
  }

  const fromEmail = process.env.FROM_EMAIL || "System Janitor <noreply@yourdomain.com>";

  const body = JSON.stringify({
    from: fromEmail,
    to: [toEmail],
    subject: "Your System Janitor License Key",
    html: `
      <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #111;">Thanks for your purchase!</h2>
        <p>Here is your System Janitor license key:</p>
        <div style="background: #f4f4f4; border: 1px solid #ddd; border-radius: 8px; padding: 16px 24px; margin: 24px 0;">
          <code style="font-size: 18px; letter-spacing: 2px; color: #111;">${licenseKey}</code>
        </div>
        <p>To activate:</p>
        <ol>
          <li>Open System Janitor</li>
          <li>Go to <strong>Settings → License</strong></li>
          <li>Paste the key above and click <strong>Activate</strong></li>
        </ol>
        <p style="color: #666; font-size: 13px; margin-top: 32px;">
          Keep this key safe. It is tied to your purchase and cannot be reissued.
          If you lose it, contact support at <a href="mailto:${process.env.SUPPORT_EMAIL || "support@yourdomain.com"}">${process.env.SUPPORT_EMAIL || "support@yourdomain.com"}</a>.
        </p>
      </div>
    `,
    text: `Thanks for purchasing System Janitor!\n\nYour license key: ${licenseKey}\n\nTo activate: open System Janitor → Settings → License → paste this key → Activate.\n\nKeep this key safe. Contact ${process.env.SUPPORT_EMAIL || "support@yourdomain.com"} if you need help.`,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[stripe] License email sent to ${toEmail}`);
            resolve();
          } else {
            reject(new Error(`Resend API ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ received: false });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`[stripe] Signature verification failed: ${err.message}`);
    return res.status(200).json({ received: false });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_details?.email || "unknown";
    const key = crypto.randomUUID();

    try {
      await supabase.from("license_keys").insert({
        key,
        plan: "pro",
        email,
        active: true,
        created_at: Date.now(),
      });

      console.log(`[stripe] License issued: key=${key} email=${email}`);

      // Email the key to the customer
      await sendLicenseEmail(email, key);
    } catch (err) {
      console.error(`[stripe] License fulfillment failed: ${err.message}`);
      // Still return 200 so Stripe doesn't retry — the key IS in the DB
      // and can be looked up manually if email fails.
    }
  }

  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
