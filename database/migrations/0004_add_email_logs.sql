-- Migration 0004: Add email_logs table for transactional email tracking
-- Description: Tracks every email sent via the Resend API, including
--   message IDs, delivery status, retry outcomes, and error details.
--   Used by src/lib/email.ts sendResendEmail() function.
-- Applied to: freshwax-db
-- Idempotent: Yes (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS email_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT,                                   -- Resend message ID (null on failure)
  to_email    TEXT NOT NULL,                           -- Recipient email address
  subject     TEXT NOT NULL,                           -- Email subject (truncated to 500 chars)
  template    TEXT NOT NULL DEFAULT 'unknown',         -- Template/source identifier
  status      TEXT NOT NULL DEFAULT 'sent',            -- sent | failed | retried
  error       TEXT,                                    -- Error message (null on success)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))  -- ISO 8601 timestamp
);

-- Index for querying recent emails (admin dashboard, debugging)
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON email_logs(created_at DESC);

-- Index for filtering by status (e.g. show all failures)
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);

-- Index for looking up emails by recipient
CREATE INDEX IF NOT EXISTS idx_email_logs_to_email ON email_logs(to_email);

-- Index for filtering by template type
CREATE INDEX IF NOT EXISTS idx_email_logs_template ON email_logs(template);

-- Index for looking up by Resend message ID (for webhook correlation)
CREATE INDEX IF NOT EXISTS idx_email_logs_message_id ON email_logs(message_id);
