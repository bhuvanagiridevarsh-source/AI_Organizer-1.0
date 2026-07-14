const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ error: "Method not allowed" });
  }

  try {
    const { key } = req.body || {};

    if (!key || typeof key !== "string" || key.length > 128) {
      return res.status(200).json({ error: "Invalid key" });
    }

    const { data, error } = await supabase
      .from("license_keys")
      .select("stripe_customer_id")
      .eq("key", key)
      .single();

    if (error || !data?.stripe_customer_id) {
      return res.status(200).json({ error: "No subscription found for this key" });
    }

    const returnUrl = process.env.PORTAL_RETURN_URL || "https://github.com/bhuvanagiridevarsh-source";

    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: returnUrl,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(`[billing/portal] Error: ${err.message}`);
    return res.status(200).json({ error: "Failed to create portal session" });
  }
};
