// Script to create a comprehensive test release in Firestore
const https = require('https');

const releaseId = 'test_full_release_' + Date.now();
const now = new Date().toISOString();
const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

const release = {
  fields: {
    // Core identifiers
    id: { stringValue: releaseId },
    title: { stringValue: "Neon Nights EP" },
    releaseName: { stringValue: "Neon Nights EP" },
    artist: { stringValue: "Test Artist DNB" },
    artistName: { stringValue: "Test Artist DNB" },

    // Artwork URLs
    coverUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code_One-1765545036887_Code_One-1765426238911_Code_One-1765411329722_square-image.webp" },
    coverArtUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code_One-1765545036887_Code_One-1765426238911_Code_One-1765411329722_square-image.webp" },
    artworkUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code_One-1765545036887_Code_One-1765426238911_Code_One-1765411329722_square-image.webp" },
    thumbUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code_One-1765545036887_Code_One-1765426238911_Code_One-1765411329722_square-image.webp" },
    imageUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code_One-1765545036887_Code_One-1765426238911_Code_One-1765411329722_square-image.webp" },

    // Genre
    genre: { stringValue: "Drum and Bass" },
    subGenre: { stringValue: "Liquid / Neurofunk" },

    // Label info
    labelName: { stringValue: "Fresh Wax Recordings" },
    labelCode: { stringValue: "FWX-TEST-001" },
    catalogNumber: { stringValue: "FWX-TEST-001" },

    // Copyright
    copyrightYear: { integerValue: "2025" },
    copyrightHolder: { stringValue: "Test Artist DNB / Fresh Wax Recordings" },
    publishingRights: { stringValue: "All Rights Reserved" },
    publishingCompany: { stringValue: "Fresh Wax Publishing" },
    recordingYear: { stringValue: "2025" },
    recordingLocation: { stringValue: "London, UK" },
    masteredBy: { stringValue: "FW Mastering Studios" },

    // Dates
    releaseDate: { stringValue: now.split('T')[0] },
    originalReleaseDate: { stringValue: "2025-12-01" },
    officialReleaseDate: { stringValue: now.split('T')[0] },

    // Description
    description: { stringValue: "A test EP showcasing the full release upload flow with all metadata fields populated. This release demonstrates how the Fresh Wax platform handles comprehensive artist submissions including multiple tracks, pricing tiers, and vinyl options." },
    releaseDescription: { stringValue: "A test EP showcasing the full release upload flow with all metadata fields populated. This release demonstrates how the Fresh Wax platform handles comprehensive artist submissions including multiple tracks, pricing tiers, and vinyl options." },

    // Pricing
    pricePerSale: { doubleValue: 9.99 },
    trackPrice: { doubleValue: 2.49 },
    pricing: {
      mapValue: {
        fields: {
          digital: { doubleValue: 9.99 },
          track: { doubleValue: 2.49 },
          vinyl: { doubleValue: 24.99 }
        }
      }
    },

    // Vinyl
    vinylRelease: { booleanValue: true },
    vinylPrice: { doubleValue: 24.99 },
    vinylRecordCount: { stringValue: "100" },
    vinylSize: { stringValue: "12 inch" },
    vinylWeight: { stringValue: "180g" },
    vinylRPM: { stringValue: "45" },
    pressingPlant: { stringValue: "GZ Media" },
    expectedShippingDate: { stringValue: futureDate },
    vinyl: {
      mapValue: {
        fields: {
          price: { doubleValue: 24.99 },
          recordCount: { integerValue: "100" },
          available: { booleanValue: true }
        }
      }
    },

    // Limited edition
    hasLimitedEdition: { booleanValue: true },
    limitedEditionType: { stringValue: "Colored Vinyl" },
    limitedEditionDetails: { stringValue: "Limited to 50 copies on translucent red vinyl with signed artwork insert" },

    // Flags
    hasPreOrder: { booleanValue: false },
    preOrderDate: { stringValue: "" },
    hasExplicitContent: { booleanValue: false },
    primaryLanguage: { stringValue: "Instrumental" },
    upcEanCode: { stringValue: "1234567890123" },

    // Release type
    releaseType: { stringValue: "EP" },
    type: { stringValue: "ep" },

    // Social links
    socialLinks: {
      mapValue: {
        fields: {
          spotify: { stringValue: "https://open.spotify.com/artist/test" },
          soundcloud: { stringValue: "https://soundcloud.com/testartistdnb" },
          instagram: { stringValue: "https://instagram.com/testartistdnb" },
          bandcamp: { stringValue: "https://testartistdnb.bandcamp.com" }
        }
      }
    },

    // Status - must be 'pending' for anonymous create per Firestore rules
    status: { stringValue: "pending" },
    published: { booleanValue: false },
    approved: { booleanValue: false },
    storage: { stringValue: "r2" },

    // Timestamps
    createdAt: { stringValue: now },
    updatedAt: { stringValue: now },
    processedAt: { stringValue: now },
    approvedAt: { stringValue: now },
    rejectedAt: { nullValue: null },

    // Stats
    plays: { integerValue: "0" },
    downloads: { integerValue: "0" },
    views: { integerValue: "0" },
    likes: { integerValue: "0" },

    // Ratings
    ratings: {
      mapValue: {
        fields: {
          average: { doubleValue: 0 },
          count: { integerValue: "0" },
          total: { integerValue: "0" },
          userRatings: { mapValue: { fields: {} } }
        }
      }
    },
    overallRating: {
      mapValue: {
        fields: {
          average: { doubleValue: 0 },
          count: { integerValue: "0" },
          total: { integerValue: "0" },
          fiveStarCount: { integerValue: "0" }
        }
      }
    },

    // Submission info
    submissionId: { stringValue: "test_submission_" + Date.now() },
    submittedBy: { stringValue: "Test User" },
    email: { stringValue: "test@freshwax.co.uk" },

    // Metadata
    metadata: {
      mapValue: {
        fields: {
          submittedBy: { stringValue: "Test User" },
          email: { stringValue: "test@freshwax.co.uk" },
          notes: { stringValue: "Full test release with all fields populated for testing purposes" },
          uploadSource: { stringValue: "manual-test" }
        }
      }
    },

    // Tracks
    tracks: {
      arrayValue: {
        values: [
          {
            mapValue: {
              fields: {
                trackNumber: { integerValue: "0" },
                displayTrackNumber: { integerValue: "1" },
                title: { stringValue: "Mispent" },
                trackName: { stringValue: "Mispent" },
                artist: { stringValue: "Test Artist DNB" },
                featured: { stringValue: "" },
                remixer: { stringValue: "" },
                bpm: { integerValue: "174" },
                key: { stringValue: "A minor" },
                duration: { stringValue: "6:34" },
                trackISRC: { stringValue: "GBTEST0000001" },
                mp3Url: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Mispent.wav" },
                wavUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Mispent.wav" },
                previewUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Mispent.wav" },
                storage: { stringValue: "r2" },
                comments: { arrayValue: {} },
                ratings: {
                  mapValue: {
                    fields: {
                      average: { integerValue: "0" },
                      count: { integerValue: "0" },
                      total: { integerValue: "0" }
                    }
                  }
                }
              }
            }
          },
          {
            mapValue: {
              fields: {
                trackNumber: { integerValue: "1" },
                displayTrackNumber: { integerValue: "2" },
                title: { stringValue: "Drift" },
                trackName: { stringValue: "Drift" },
                artist: { stringValue: "Test Artist DNB" },
                featured: { stringValue: "Flames" },
                remixer: { stringValue: "" },
                bpm: { integerValue: "172" },
                key: { stringValue: "F minor" },
                duration: { stringValue: "7:38" },
                trackISRC: { stringValue: "GBTEST0000002" },
                mp3Url: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Drift%20feat.%20Flames%20-%20Master.wav" },
                wavUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Drift%20feat.%20Flames%20-%20Master.wav" },
                previewUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Drift%20feat.%20Flames%20-%20Master.wav" },
                storage: { stringValue: "r2" },
                comments: { arrayValue: {} },
                ratings: {
                  mapValue: {
                    fields: {
                      average: { integerValue: "0" },
                      count: { integerValue: "0" },
                      total: { integerValue: "0" }
                    }
                  }
                }
              }
            }
          },
          {
            mapValue: {
              fields: {
                trackNumber: { integerValue: "2" },
                displayTrackNumber: { integerValue: "3" },
                title: { stringValue: "The Speed Of Dark" },
                trackName: { stringValue: "The Speed Of Dark" },
                artist: { stringValue: "Test Artist DNB" },
                featured: { stringValue: "" },
                remixer: { stringValue: "" },
                bpm: { integerValue: "175" },
                key: { stringValue: "G minor" },
                duration: { stringValue: "5:40" },
                trackISRC: { stringValue: "GBTEST0000003" },
                mp3Url: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20The%20Speed%20Of%20Dark.mp3" },
                wavUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20The%20Speed%20Of%20Dark.mp3" },
                previewUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20The%20Speed%20Of%20Dark.mp3" },
                storage: { stringValue: "r2" },
                comments: { arrayValue: {} },
                ratings: {
                  mapValue: {
                    fields: {
                      average: { integerValue: "0" },
                      count: { integerValue: "0" },
                      total: { integerValue: "0" }
                    }
                  }
                }
              }
            }
          },
          {
            mapValue: {
              fields: {
                trackNumber: { integerValue: "3" },
                displayTrackNumber: { integerValue: "4" },
                title: { stringValue: "Entropic Consciousness" },
                trackName: { stringValue: "Entropic Consciousness" },
                artist: { stringValue: "Test Artist DNB" },
                featured: { stringValue: "" },
                remixer: { stringValue: "DJ Shadow VIP" },
                bpm: { integerValue: "170" },
                key: { stringValue: "D minor" },
                duration: { stringValue: "6:16" },
                trackISRC: { stringValue: "GBTEST0000004" },
                mp3Url: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Entropic%20Consciousness.mp3" },
                wavUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Entropic%20Consciousness.mp3" },
                previewUrl: { stringValue: "https://cdn.freshwax.co.uk/submissions/Code_One-1765771210267/Code%20One%20-%20Entropic%20Consciousness.mp3" },
                storage: { stringValue: "r2" },
                comments: { arrayValue: {} },
                ratings: {
                  mapValue: {
                    fields: {
                      average: { integerValue: "0" },
                      count: { integerValue: "0" },
                      total: { integerValue: "0" }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    }
  }
};

// Create document in Firestore
const apiKey = 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g';
const projectId = 'freshwax-store';
const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/releases?documentId=${releaseId}&key=${apiKey}`;

const data = JSON.stringify(release);

const options = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = https.request(url, options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('SUCCESS! Test release created.');
      console.log('Release ID:', releaseId);
      console.log('View at: https://freshwax.co.uk/item/' + releaseId);
      console.log('Admin: https://freshwax.co.uk/admin/releases/manage');
    } else {
      console.log('Status:', res.statusCode);
      console.log('Response:', body);
    }
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.write(data);
req.end();
