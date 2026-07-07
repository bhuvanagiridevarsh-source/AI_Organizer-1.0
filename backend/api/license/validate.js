const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// How many devices one license key may be active on.
// Override with MAX_DEVICES_PER_KEY in Vercel env vars if needed.
const MAX_DEVICES = parseInt(process.env.MAX_DEVICES_PER_KEY || "2", 10);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ valid: false });
  }

  try {
    const { key, device_id } = req.body || {};

    if (!key || typeof key !== "string" || key.length > 128) {
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

    // ── Device binding ─────────────────────────────────────────────
    // Old clients (< v1.0.9) send no device_id — stay back-compatible.
    if (device_id && typeof device_id === "string" && device_id.length <= 64) {
      try {
        const { data: devices, error: devErr } = await supabase
          .from("license_devices")
          .select("device_id")
          .eq("key", key);

        // If the devices table isn't migrated yet, fail OPEN (valid) —
        // never lock out paying customers because of our own migration lag.
        if (!devErr && Array.isArray(devices)) {
          const known = devices.some((d) => d.device_id === device_id);
          if (!known) {
            if (devices.length >= MAX_DEVICES) {
              return res.status(200).json({ valid: false, reason: "device_limit" });
            }
            await supabase.from("license_devices").insert({
              key,
              device_id,
              registered_at: Date.now(),
            });
          }
        }
      } catch {
        // Fail open on any device-binding error — key itself is valid.
      }
    }

    return res.status(200).json({ valid: true, plan: data.plan });
  } catch {
    return res.status(200).json({ valid: false });
  }
};
