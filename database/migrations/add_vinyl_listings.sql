-- =============================================
-- VINYL LISTINGS (crates marketplace)
-- D1 Primary, Firebase backup
-- =============================================
CREATE TABLE IF NOT EXISTS vinyl_listings (
  id TEXT PRIMARY KEY,
  -- Seller info
  seller_id TEXT NOT NULL,
  seller_name TEXT,
  -- Record details
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  label TEXT,
  catalog_number TEXT,
  format TEXT DEFAULT 'LP',
  release_year INTEGER,
  genre TEXT,
  -- Condition (Goldmine scale)
  media_condition TEXT NOT NULL,
  sleeve_condition TEXT NOT NULL,
  condition_notes TEXT,
  -- Pricing
  price REAL NOT NULL,
  original_price REAL,
  discount_percent INTEGER DEFAULT 0,
  shipping_cost REAL DEFAULT 0,
  -- Deal info
  deal_type TEXT DEFAULT 'none',
  deal_description TEXT,
  -- Content
  description TEXT,
  images TEXT,  -- JSON array of URLs
  tracks TEXT,  -- JSON array of track objects
  -- Legacy audio (first track sample)
  audio_sample_url TEXT,
  audio_sample_duration INTEGER,
  -- Status
  status TEXT DEFAULT 'draft',  -- draft, published, sold, removed
  featured INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  -- Stats
  views INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  sold_at TEXT,
  deleted_at TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_seller ON vinyl_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_status ON vinyl_listings(status);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_genre ON vinyl_listings(genre);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_price ON vinyl_listings(price);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_published ON vinyl_listings(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_created ON vinyl_listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_featured ON vinyl_listings(featured, status);
CREATE INDEX IF NOT EXISTS idx_vinyl_listings_deals ON vinyl_listings(discount_percent, status);
