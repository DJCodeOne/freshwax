-- Add image_scan_results table (previously created inline by image-scan cron)
CREATE TABLE IF NOT EXISTS image_scan_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_date TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER NOT NULL,
  prefix TEXT NOT NULL,
  webp_exists INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
