const crypto = require("crypto");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const https = require("https");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Subscription statuses that grant access
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function sendLicenseEmail(toEmail, licenseKey) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error("[stripe] RESEND_API_KEY not set — cannot email license key");
    return;
  }

  const fromEmail = process.env.FROM_EMAIL || "AI Organizer <noreply@yourdomain.com>";

  const body = JSON.stringify({
    from: fromEmail,
    to: [toEmail],
    subject: "Your AI Organizer Subscription Key",
    html: `
      <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #111;">Thanks for subscribing!</h2>
        <p>Here is your AI Organizer license key:</p>
        <div style="background: #f4f4f4; border: 1px solid #ddd; border-radius: 8px; padding: 16px 24px; margin: 24px 0;">
          <code style="font-size: 18px; letter-spacing: 2px; color: #111;">${licenseKey}</code>
        </div>
        <p>To activate:</p>
        <ol>
          <li>Open AI Organizer</li>
          <li>Go to <strong>Settings → License</strong></li>
          <li>Paste the key above and click <strong>Activate</strong></li>
        </ol>
        <p>Your key stays active as long as your subscription is active. You can manage your subscription at any time from the Settings panel.</p>
        <p style="color: #666; font-size: 13px; margin-top: 32px;">
          If you need help, contact <a href="mailto:${process.env.SUPPORT_EMAIL || "support@yourdomain.com"}">${process.env.SUPPORT_EMAIL || "support@yourdomain.com"}</a>.
        </p>
      </div>
    `,
    text: `Thanks for subscribing to AI Organizer!\n\nYour license key: ${licenseKey}\n\nTo activate: open AI Organizer → Settings → License → paste this key → Activate.\n\nYour key stays active as long as your subscription is active.\n\nContact ${process.env.SUPPORT_EMAIL || "support@yourdomain.com"} if you need help.`,
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
            console.log(`[stripe] Subscription key emailed to ${toEmail}`);
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

async function handleCheckoutCompleted(session) {
  // Only handle subscription checkouts
  if (session.mode !== "subscription") return;

  const subscriptionId = session.subscription;
  const customerId = session.customer;
  const email = session.customer_details?.email || "unknown";
  const key = crypto.randomUUID();

  try {
    await supabase.from("license_keys").insert({
      key,
      plan: "pro",
      email,
      active: true,
      created_at: Date.now(),
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: customerId,
      subscription_status: "active",
    });

    console.log(`[stripe] Subscription key issued: key=${key} email=${email} sub=${subscriptionId}`);
    await sendLicenseEmail(email, key);
  } catch (err) {
    console.error(`[stripe] Subscription fulfillment failed: ${err.message}`);
  }
}

async function handleSubscriptionUpdated(subscription) {
  const isActive = ACTIVE_STATUSES.has(subscription.status);
  const { error } = await supabase
    .from("license_keys")
    .update({ active: isActive, subscription_status: subscription.status })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error(`[stripe] Failed to update subscription ${subscription.id}: ${error.message}`);
  } else {
    console.log(`[stripe] Subscription ${subscription.id} → status=${subscription.status} active=${isActive}`);
  }
}

async function handleSubscriptionDeleted(subscription) {
  const { error } = await supabase
    .from("license_keys")
    .update({ active: false, subscription_status: "canceled" })
    .eq("stripe_subscription_id", subscription.id);

  if (error) {
    console.error(`[stripe] Failed to cancel subscription ${subscription.id}: ${error.message}`);
  } else {
    console.log(`[stripe] Subscription ${subscription.id} canceled → key deactivated`);
  }
}

async function handleInvoicePaid(invoice) {
  // Reactivate key when a past_due subscription recovers
  if (!invoice.subscription) return;
  const { error } = await supabase
    .from("license_keys")
    .update({ active: true, subscription_status: "active" })
    .eq("stripe_subscription_id", invoice.subscription);

  if (error) {
    console.error(`[stripe] Failed to reactivate on invoice.paid for sub ${invoice.subscription}: ${error.message}`);
  } else {
    console.log(`[stripe] Sub ${invoice.subscription} reactivated on invoice.paid`);
  }
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

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object);
      break;
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event.data.object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object);
      break;
    case "invoice.paid":
      await handleInvoicePaid(event.data.object);
      break;
    default:
      // Unhandled event — ignore
      break;
  }

  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
