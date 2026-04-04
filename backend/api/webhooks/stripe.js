const crypto = require("crypto");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Vercel needs the raw body for Stripe signature verification
module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
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

      // TODO: Send license key email to customer here — log for now
      console.log(`[stripe] License issued: key=${key} email=${email}`);
    } catch (err) {
      console.error(`[stripe] DB insert failed: ${err.message}`);
    }
  }

  return res.status(200).json({ received: true });
};
