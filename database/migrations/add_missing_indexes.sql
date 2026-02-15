-- Migration: Add missing indexes for commonly queried columns
-- Tables: pending_orders, image_scan_results, sales_ledger, error_logs
-- All indexes use IF NOT EXISTS for safe re-runs

-- =============================================
-- PENDING_ORDERS
-- Table created inline by stripe/webhook.ts and paypal/capture-order.ts
-- Queried by admin/pending-orders.ts (WHERE status = ? ORDER BY created_at DESC)
-- Updated by webhook/capture (WHERE stripe_session_id = ?)
-- =============================================
CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON pending_orders(status);
CREATE INDEX IF NOT EXISTS idx_pending_orders_created ON pending_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_orders_email ON pending_orders(customer_email);
-- stripe_session_id already has UNIQUE constraint which acts as an index

-- =============================================
-- IMAGE_SCAN_RESULTS
-- Table created inline by cron/image-scan.ts
-- Cleaned up with DELETE WHERE scan_date < datetime(...)
-- Queried by admin for images needing conversion
-- =============================================
CREATE INDEX IF NOT EXISTS idx_image_scan_date ON image_scan_results(scan_date);
CREATE INDEX IF NOT EXISTS idx_image_scan_prefix ON image_scan_results(prefix);
CREATE INDEX IF NOT EXISTS idx_image_scan_webp ON image_scan_results(webp_exists);

-- =============================================
-- SALES_LEDGER
-- customer_id queried in delete-account.ts (WHERE customer_id = ?)
-- customer_email useful for order lookups by email
-- created_at used for time-based queries and cleanup
-- =============================================
CREATE INDEX IF NOT EXISTS idx_ledger_customer_id ON sales_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_customer_email ON sales_ledger(customer_email);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON sales_ledger(created_at DESC);

-- =============================================
-- ERROR_LOGS
-- endpoint column queried in admin/errors.ts search (LIKE on endpoint)
-- level column useful for filtering by severity
-- user_id useful for per-user error lookups
-- =============================================
CREATE INDEX IF NOT EXISTS idx_errors_endpoint ON error_logs(endpoint);
CREATE INDEX IF NOT EXISTS idx_errors_level ON error_logs(level);
CREATE INDEX IF NOT EXISTS idx_errors_user ON error_logs(user_id);
