const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ valid: false });
  }

  try {
    const { key } = req.body || {};

    if (!key || typeof key !== "string") {
      return res.status(200).json({ valid: false });
    }

    const { data, error } = await supabase
      .from("license_keys")
      .select("plan")
      .eq("key", key)
      .eq("active", true)
      .single();

    if (error || !data) {
      return res.status(200).json({ valid: false });
    }

    return res.status(200).json({ valid: true, plan: data.plan });
  } catch {
    return res.status(200).json({ valid: false });
  }
};
