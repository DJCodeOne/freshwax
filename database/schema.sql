-- Releases table
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  release_date TEXT NOT NULL,
  is_preorder INTEGER DEFAULT 0,
  has_vinyl INTEGER DEFAULT 0,
  vinyl_stock INTEGER DEFAULT 0,
  digital_price REAL NOT NULL,
  vinyl_price REAL,
  artwork_url TEXT NOT NULL,
  description TEXT,
  extra_notes TEXT,
  status TEXT DEFAULT 'pending',
  submission_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Tracks table
CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  track_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  audio_url TEXT NOT NULL,
  preview_url TEXT,
  duration INTEGER,
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
);

-- Create indexes for common queries
CREATE INDEX idx_releases_status ON releases(status);
CREATE INDEX idx_releases_date ON releases(release_date);
CREATE INDEX idx_tracks_release ON tracks(release_id);

-- User playlists table (migrated from Firebase)
CREATE TABLE IF NOT EXISTS user_playlists (
  user_id TEXT PRIMARY KEY,
  playlist TEXT NOT NULL DEFAULT '[]',  -- JSON array of playlist items
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_playlists_updated ON user_playlists(updated_at);

-- =============================================
-- RELEASES (migrated from Firebase)
-- Hybrid: indexed columns + full JSON document
-- =============================================
CREATE TABLE IF NOT EXISTS releases_v2 (
  id TEXT PRIMARY KEY,
  -- Key searchable/filterable fields
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  genre TEXT DEFAULT 'Jungle & D&B',
  release_date TEXT,
  status TEXT DEFAULT 'pending',  -- pending, approved, published, rejected
  published INTEGER DEFAULT 0,
  -- Pricing
  price_per_sale REAL DEFAULT 0,
  track_price REAL DEFAULT 0,
  vinyl_price REAL,
  vinyl_stock INTEGER DEFAULT 0,
  -- URLs (for quick access without parsing JSON)
  cover_url TEXT,
  thumb_url TEXT,
  -- Stats
  plays INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  rating_avg REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  -- Full document as JSON (contains all fields including tracks)
  data TEXT NOT NULL,  -- Full JSON document
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_releases_status ON releases_v2(status);
CREATE INDEX IF NOT EXISTS idx_releases_published ON releases_v2(published);
CREATE INDEX IF NOT EXISTS idx_releases_date ON releases_v2(release_date DESC);
CREATE INDEX IF NOT EXISTS idx_releases_artist ON releases_v2(artist_name);
CREATE INDEX IF NOT EXISTS idx_releases_genre ON releases_v2(genre);

-- =============================================
-- DJ MIXES (migrated from Firebase)
-- =============================================
CREATE TABLE IF NOT EXISTS dj_mixes (
  id TEXT PRIMARY KEY,
  -- Key searchable fields
  title TEXT NOT NULL,
  dj_name TEXT NOT NULL,
  user_id TEXT,
  genre TEXT DEFAULT 'Jungle & D&B',
  published INTEGER DEFAULT 1,
  -- URLs
  artwork_url TEXT,
  audio_url TEXT,
  -- Stats
  plays INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  -- Full document
  data TEXT NOT NULL,  -- Full JSON document
  -- Timestamps
  upload_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mixes_published ON dj_mixes(published);
CREATE INDEX IF NOT EXISTS idx_mixes_user ON dj_mixes(user_id);
CREATE INDEX IF NOT EXISTS idx_mixes_dj ON dj_mixes(dj_name);
CREATE INDEX IF NOT EXISTS idx_mixes_date ON dj_mixes(upload_date DESC);

-- =============================================
-- MERCH (migrated from Firebase)
-- =============================================
CREATE TABLE IF NOT EXISTS merch (
  id TEXT PRIMARY KEY,
  -- Key fields
  name TEXT NOT NULL,
  type TEXT,  -- tshirt, hoodie, etc.
  price REAL NOT NULL,
  stock INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1,
  -- URLs
  image_url TEXT,
  -- Full document
  data TEXT NOT NULL,  -- Full JSON document
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_merch_published ON merch(published);
CREATE INDEX IF NOT EXISTS idx_merch_type ON merch(type);

-- =============================================
-- COMMENTS (for releases and mixes)
-- =============================================
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  -- Foreign key - can be release or mix
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,  -- 'release' or 'mix'
  -- Comment data
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  avatar_url TEXT,
  comment TEXT,
  gif_url TEXT,
  approved INTEGER DEFAULT 1,
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id, item_type);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_date ON comments(created_at DESC);

-- =============================================
-- RATINGS (aggregate per release)
-- =============================================
CREATE TABLE IF NOT EXISTS ratings (
  release_id TEXT PRIMARY KEY,
  average REAL DEFAULT 0,
  count INTEGER DEFAULT 0,
  five_star_count INTEGER DEFAULT 0,
  last_rated_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- USER RATINGS (individual user ratings)
-- =============================================
CREATE TABLE IF NOT EXISTS user_ratings (
  id TEXT PRIMARY KEY,  -- release_id + '_' + user_id
  release_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL,  -- 1-5
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_ratings_release ON user_ratings(release_id);
CREATE INDEX IF NOT EXISTS idx_user_ratings_user ON user_ratings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ratings_unique ON user_ratings(release_id, user_id);

-- =============================================
-- LIVESTREAM SLOTS (migrated from Firebase)
-- For fast status checks without Firebase reads
-- =============================================
CREATE TABLE IF NOT EXISTS livestream_slots (
  id TEXT PRIMARY KEY,
  -- Key searchable fields
  dj_id TEXT,
  dj_name TEXT NOT NULL,
  title TEXT,
  genre TEXT,
  status TEXT DEFAULT 'scheduled',  -- scheduled, in_lobby, live, ended, cancelled
  -- Timing
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  -- Stream info
  stream_key TEXT,
  hls_url TEXT,
  is_relay INTEGER DEFAULT 0,
  relay_station_id TEXT,
  -- Full document as JSON
  data TEXT NOT NULL,
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_slots_status ON livestream_slots(status);
CREATE INDEX IF NOT EXISTS idx_slots_dj ON livestream_slots(dj_id);
CREATE INDEX IF NOT EXISTS idx_slots_start ON livestream_slots(start_time);
CREATE INDEX IF NOT EXISTS idx_slots_end ON livestream_slots(end_time);

-- =============================================
-- SALES LEDGER (primary read source, Firebase backup)
-- Immutable financial records for accurate revenue tracking
-- =============================================
CREATE TABLE IF NOT EXISTS sales_ledger (
  id TEXT PRIMARY KEY,
  -- Order reference
  order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  -- Timing (indexed for reporting)
  timestamp TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  -- Customer
  customer_id TEXT,
  customer_email TEXT NOT NULL,
  -- Artist/Seller (for payout tracking)
  artist_id TEXT,
  artist_name TEXT,
  submitter_id TEXT,
  submitter_email TEXT,
  -- Revenue breakdown
  subtotal REAL NOT NULL DEFAULT 0,
  shipping REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  gross_total REAL NOT NULL DEFAULT 0,
  -- Fees
  stripe_fee REAL DEFAULT 0,
  paypal_fee REAL DEFAULT 0,
  freshwax_fee REAL DEFAULT 0,
  total_fees REAL DEFAULT 0,
  -- Net revenue
  net_revenue REAL NOT NULL DEFAULT 0,
  -- Artist payout
  artist_payout REAL DEFAULT 0,
  artist_payout_status TEXT DEFAULT 'pending',  -- pending, paid, cancelled
  -- Payment info
  payment_method TEXT NOT NULL,  -- stripe, paypal, free, giftcard, manual
  payment_id TEXT,
  currency TEXT DEFAULT 'GBP',
  -- Order summary
  item_count INTEGER DEFAULT 0,
  has_physical INTEGER DEFAULT 0,
  has_digital INTEGER DEFAULT 0,
  -- Full document as JSON (contains items array)
  data TEXT NOT NULL,
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  corrected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_order ON sales_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order_number ON sales_ledger(order_number);
CREATE INDEX IF NOT EXISTS idx_ledger_timestamp ON sales_ledger(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_year_month ON sales_ledger(year, month);
CREATE INDEX IF NOT EXISTS idx_ledger_artist ON sales_ledger(artist_id);
CREATE INDEX IF NOT EXISTS idx_ledger_submitter ON sales_ledger(submitter_id);
CREATE INDEX IF NOT EXISTS idx_ledger_payout_status ON sales_ledger(artist_payout_status);
CREATE INDEX IF NOT EXISTS idx_ledger_payment_method ON sales_ledger(payment_method);

-- =============================================
-- VINYL SELLERS (settings for vinyl crate sellers)
-- D1 Primary, Firebase backup
-- =============================================
CREATE TABLE IF NOT EXISTS vinyl_sellers (
  id TEXT PRIMARY KEY,  -- user_id
  -- Store info
  store_name TEXT,
  location TEXT,
  description TEXT,
  discogs_url TEXT,
  -- UK Shipping
  shipping_single REAL DEFAULT 0,
  shipping_additional REAL DEFAULT 0,
  -- International shipping
  ships_international INTEGER DEFAULT 0,
  shipping_europe REAL DEFAULT 0,
  shipping_europe_additional REAL DEFAULT 0,
  shipping_worldwide REAL DEFAULT 0,
  shipping_worldwide_additional REAL DEFAULT 0,
  -- Full document as JSON
  data TEXT NOT NULL,
  -- Timestamps
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vinyl_sellers_store ON vinyl_sellers(store_name);