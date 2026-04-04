-- Run this once in the Supabase SQL Editor to create the license_keys table.

CREATE TABLE license_keys (
  key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'pro',
  email TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);
