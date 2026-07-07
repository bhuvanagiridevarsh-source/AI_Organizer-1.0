-- Run this once in the Supabase SQL Editor to create the license_keys table.

CREATE TABLE license_keys (
  key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'pro',
  email TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);

-- Device binding: caps how many machines one key can activate (default 2,
-- enforced in api/license/validate.js). Safe to add to an existing project —
-- validation fails OPEN until this table exists, so running this migration
-- late never locks out existing customers.
CREATE TABLE license_devices (
  key TEXT NOT NULL REFERENCES license_keys(key) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  registered_at BIGINT NOT NULL,
  PRIMARY KEY (key, device_id)
);
