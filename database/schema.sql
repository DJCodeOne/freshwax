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