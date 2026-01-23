// src/pages/api/seed-blog.ts
// One-time seed script for initial blog posts
// Call with: /api/seed-blog?key=YOUR_ADMIN_KEY
// DELETE THIS FILE after running once

import type { APIRoute } from 'astro';
import { setDocument, initFirebaseEnv } from '../../lib/firebase-rest';
import { getAdminKey } from '../../lib/admin';

export const prerender = false;

const blogPosts = [
  {
    id: 'discover-fresh-wax-vinyl-releases',
    title: 'Discover Fresh Wax: Your Gateway to Premium Jungle and Drum & Bass Vinyl',
    slug: 'discover-fresh-wax-vinyl-releases',
    excerpt: 'Explore our curated collection of jungle and drum & bass vinyl releases. From classic reissues to exclusive limited pressings, discover why vinyl enthusiasts choose Fresh Wax.',
    category: 'Releases',
    tags: ['vinyl', 'jungle', 'drum and bass', 'releases', 'music collection'],
    author: 'Fresh Wax',
    featuredImage: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=1200&h=630&fit=crop',
    content: `
<h2>The Heart of Underground Music: Our Vinyl Collection</h2>

<p>At Fresh Wax, we believe that jungle and drum & bass deserve to be heard the way they were meant to be experienced—on vinyl. Our carefully curated collection represents the finest releases from both established legends and emerging talent in the UK underground scene.</p>

<h3>Why Vinyl Still Matters in the Digital Age</h3>

<p>While streaming has made music more accessible than ever, true audiophiles and dedicated DJs understand that vinyl offers something irreplaceable. The warm analogue sound, the tangible connection to the music, and the artwork you can hold in your hands—these are experiences that digital simply cannot replicate.</p>

<p>Our releases are pressed on high-quality 180g vinyl, ensuring exceptional audio fidelity and durability. Each record is mastered specifically for vinyl by experienced engineers who understand the unique characteristics of the format.</p>

<h3>What You'll Find in Our Catalogue</h3>

<p>Our collection spans the full spectrum of jungle and drum & bass:</p>

<ul>
<li><strong>Classic Jungle</strong> – Ragga-infused breaks, chopped Amen patterns, and deep bass weight</li>
<li><strong>Liquid Drum & Bass</strong> – Soulful vocals, melodic compositions, and smooth rolling beats</li>
<li><strong>Neurofunk</strong> – Technical precision, dark atmospheres, and cutting-edge sound design</li>
<li><strong>Jump Up</strong> – High-energy dancefloor weapons designed for maximum impact</li>
<li><strong>Deep & Minimal</strong> – Stripped-back productions focused on groove and atmosphere</li>
</ul>

<h3>Limited Edition Pressings</h3>

<p>Many of our releases are limited to small quantities, making them genuine collector's items. We work directly with artists and labels to bring you exclusive pressings that you won't find anywhere else. When a release sells out, it's gone—so if you see something you love, don't hesitate.</p>

<h3>Supporting Independent Artists</h3>

<p>Every purchase directly supports the artists and producers who create this music. Unlike streaming platforms where artists receive fractions of pennies per play, vinyl sales provide meaningful income that allows creators to continue making the music we all love.</p>

<h3>How to Browse Our Releases</h3>

<p>Navigate to our <a href="/releases">Releases</a> page to explore our full catalogue. You can filter by genre, artist, or format, and preview tracks before purchasing. Each release page includes detailed information about the pressing, tracklist, and artist background.</p>

<p>New releases drop regularly, so bookmark us and check back often. You can also follow us on social media for announcements about upcoming drops and restocks.</p>
`
  },
  {
    id: 'dj-mixes-free-streaming',
    title: 'Free DJ Mixes: Hours of Jungle and Drum & Bass for Your Listening Pleasure',
    slug: 'dj-mixes-free-streaming',
    excerpt: 'Stream high-quality DJ mixes from talented selectors in the jungle and drum & bass scene. Discover new artists, explore different styles, and enjoy hours of free music.',
    category: 'DJ Mixes',
    tags: ['dj mixes', 'free music', 'streaming', 'jungle', 'drum and bass', 'podcasts'],
    author: 'Fresh Wax',
    featuredImage: 'https://images.unsplash.com/photo-1571266028243-e4733b0f0bb0?w=1200&h=630&fit=crop',
    content: `
<h2>Your Free Source for Quality DJ Mixes</h2>

<p>Whether you're working, working out, or warming up for a night out, our DJ Mixes section offers hours of carefully crafted sets from talented selectors across the jungle and drum & bass spectrum. Best of all? It's completely free to stream.</p>

<h3>Why DJ Mixes Matter</h3>

<p>A great DJ mix is more than just a playlist—it's a journey. Skilled selectors take you through peaks and valleys, building tension and releasing it, introducing you to tracks you've never heard while weaving in familiar favourites. It's an art form that deserves recognition.</p>

<p>Our mix series showcases both established names and rising stars, giving you a window into the diverse world of jungle and drum & bass DJing. Each mix is professionally recorded and mastered for optimal streaming quality.</p>

<h3>What Makes Our Mixes Special</h3>

<ul>
<li><strong>Curated Quality</strong> – Every mix is reviewed before being added to ensure consistent quality</li>
<li><strong>Diverse Styles</strong> – From deep rollers to high-energy jump up, we cover the full spectrum</li>
<li><strong>Regular Updates</strong> – New mixes added frequently to keep your rotation fresh</li>
<li><strong>Artist Spotlights</strong> – Get to know the selectors behind the decks</li>
<li><strong>Free Forever</strong> – No subscription required, no ads interrupting your flow</li>
</ul>

<h3>Discovering New Music Through Mixes</h3>

<p>One of the best ways to discover new music is through DJ mixes. When you hear a track that catches your ear, you can often find it in our releases section or reach out to us for an ID. Many listeners have built their vinyl collections by discovering artists through our mix series first.</p>

<h3>For DJs: Submit Your Mix</h3>

<p>Are you a DJ with a quality mix to share? We're always looking for new talent to feature on our platform. Reach out to us with a link to your mix and a brief bio. We listen to every submission and feature the best on our site.</p>

<h3>How to Listen</h3>

<p>Head to our <a href="/dj-mixes">DJ Mixes</a> page to start streaming. You can play mixes directly in your browser—no app download required. Our player continues playing as you browse other parts of the site, so you can shop for vinyl while enjoying a set.</p>
`
  },
  {
    id: 'fresh-wax-merch-official-clothing',
    title: 'Fresh Wax Merch: Represent the Underground with Official Clothing and Accessories',
    slug: 'fresh-wax-merch-official-clothing',
    excerpt: 'Show your love for jungle and drum & bass with our official merchandise. Premium quality t-shirts, hoodies, and accessories designed for the underground music community.',
    category: 'Merch',
    tags: ['merchandise', 'clothing', 't-shirts', 'hoodies', 'accessories', 'streetwear'],
    author: 'Fresh Wax',
    featuredImage: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=1200&h=630&fit=crop',
    content: `
<h2>Wear Your Sound: Fresh Wax Official Merchandise</h2>

<p>Music isn't just something you listen to—it's a lifestyle. Our merchandise line lets you represent the jungle and drum & bass community with pride, wearing designs that speak to the culture and history of UK underground music.</p>

<h3>Quality You Can Feel</h3>

<p>We don't do cheap promotional tat. Every piece of Fresh Wax merchandise is produced using premium materials and ethical manufacturing processes. Our t-shirts are 100% organic cotton, our hoodies are heavyweight and built to last, and our printing uses environmentally responsible inks.</p>

<p>When you buy Fresh Wax merch, you're getting something you'll want to wear again and again—not something that falls apart after a few washes.</p>

<h3>Designs That Mean Something</h3>

<p>Our designs draw inspiration from the rich visual history of jungle and drum & bass:</p>

<ul>
<li><strong>Classic Typography</strong> – Bold lettering inspired by rave flyer aesthetics</li>
<li><strong>Sound System Culture</strong> – Designs celebrating the bass-heavy heritage of UK music</li>
<li><strong>Artist Collaborations</strong> – Limited edition pieces created with artists from our roster</li>
<li><strong>Subtle Nods</strong> – For those who know, designs that fellow heads will recognise</li>
</ul>

<h3>Limited Runs</h3>

<p>Like our vinyl releases, many of our merchandise items are produced in limited quantities. When a design sells out, it may not return. This isn't artificial scarcity—it's about keeping things special and ensuring that what you own is genuinely rare.</p>

<h3>Size Guide and Fit</h3>

<p>We know that fit matters. Each product page includes detailed size guides with actual measurements, not just generic S/M/L descriptions. We offer inclusive sizing and aim to accommodate as many body types as possible. If you're unsure about sizing, reach out to us and we'll help you find the right fit.</p>

<h3>Browse the Collection</h3>

<p>Visit our <a href="/merch">Merch</a> section to see the current collection. Product photos show items as they actually appear, and we include multiple angles so you know exactly what you're getting. Free UK shipping on orders over a certain amount makes it easy to stock up.</p>
`
  },
  {
    id: 'sample-packs-music-production',
    title: 'Professional Sample Packs: Authentic Jungle and Drum & Bass Sounds for Producers',
    slug: 'sample-packs-music-production',
    excerpt: 'Elevate your productions with our professionally crafted sample packs. Drum breaks, bass loops, atmospheres, and more—all royalty-free and ready to use.',
    category: 'Production',
    tags: ['sample packs', 'music production', 'drums', 'bass', 'loops', 'royalty free'],
    author: 'Fresh Wax',
    featuredImage: 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=1200&h=630&fit=crop',
    content: `
<h2>Sounds for Producers, By Producers</h2>

<p>Creating authentic jungle and drum & bass requires the right sonic palette. Our sample packs are crafted by experienced producers who understand the genre inside and out, delivering sounds that sit perfectly in your mixes and carry the weight and character the music demands.</p>

<h3>What's Inside Our Packs</h3>

<p>Each sample pack is a comprehensive toolkit designed for serious production:</p>

<ul>
<li><strong>Drum Breaks</strong> – Meticulously processed breaks with punch and clarity</li>
<li><strong>One-Shots</strong> – Individual kicks, snares, hats, and percussion elements</li>
<li><strong>Bass Samples</strong> – Sub bass, reese bass, and mid-range growls</li>
<li><strong>Loops</strong> – Full drum loops, top loops, and percussion patterns</li>
<li><strong>Atmospheres</strong> – Pads, textures, and ambient elements</li>
<li><strong>FX</strong> – Risers, impacts, transitions, and ear candy</li>
</ul>

<h3>Professional Quality Standards</h3>

<p>All samples are delivered in 24-bit WAV format at 44.1kHz or higher. Every sound is carefully processed to ensure optimal levels, phase coherence, and frequency balance. We don't just record sounds—we craft them with the same attention to detail we'd apply to our own releases.</p>

<h3>100% Royalty-Free</h3>

<p>When you purchase a Fresh Wax sample pack, you receive a full royalty-free license. Use the sounds in your commercial releases, live performances, sync placements—wherever your music takes you. No additional fees, no complicated licensing agreements, no worrying about clearances.</p>

<h3>Genre-Authentic Sounds</h3>

<p>We don't make generic "EDM drum kits." Our packs are specifically designed for jungle and drum & bass production, with sounds that understand the genre's sonic requirements:</p>

<ul>
<li>Breaks with the right amount of grit and character</li>
<li>Bass sounds that translate properly on big systems</li>
<li>Atmospheres that complement rather than overwhelm</li>
<li>Drums that cut through dense mixes</li>
</ul>

<h3>Start Producing</h3>

<p>Browse our <a href="/samples">Sample Packs</a> section to find the sounds that will elevate your production. Each pack includes audio previews so you can hear exactly what you're getting before you buy. Compatible with all major DAWs including Ableton, FL Studio, Logic, and more.</p>
`
  },
  {
    id: 'live-streaming-events',
    title: 'Fresh Wax Live: Watch DJ Sets and Events Streamed Direct to Your Screen',
    slug: 'live-streaming-events',
    excerpt: 'Experience the energy of live DJ sets from anywhere in the world. Our live streaming platform brings the rave to your living room with high-quality video and audio.',
    category: 'Events',
    tags: ['live streaming', 'events', 'dj sets', 'live music', 'virtual events'],
    author: 'Fresh Wax',
    featuredImage: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1200&h=630&fit=crop',
    content: `
<h2>The Rave Comes to You</h2>

<p>Not everyone can make it to every event. Geography, work schedules, and life commitments mean that sometimes the best party is happening somewhere you can't be. Fresh Wax Live solves that problem by bringing world-class DJ performances directly to your screen.</p>

<h3>High-Quality Streaming Experience</h3>

<p>We've invested in professional streaming infrastructure to deliver an experience worthy of the artists we feature:</p>

<ul>
<li><strong>HD Video</strong> – Crystal clear visually, so you can see every mixer move</li>
<li><strong>High-Fidelity Audio</strong> – Properly mixed and mastered for your speakers or headphones</li>
<li><strong>Low Latency</strong> – Minimal delay so you can interact in real-time</li>
<li><strong>Reliable Streams</strong> – Professional-grade infrastructure that doesn't buffer or drop</li>
</ul>

<h3>More Than Just Music</h3>

<p>Our live streams create a sense of community. Chat with other viewers, send shoutouts, and share the experience with fellow junglists from around the world. It's the next best thing to being there—and sometimes, with the right sound system at home, it might even be better.</p>

<h3>Regular Programming</h3>

<p>We host live streams regularly, featuring:</p>

<ul>
<li>Resident DJ sessions</li>
<li>Guest artist takeovers</li>
<li>Label showcases</li>
<li>Special event broadcasts</li>
<li>Impromptu sessions when the mood strikes</li>
</ul>

<h3>How to Watch</h3>

<p>When we're live, you'll see the LIVE indicator in the header navigation. Click through to our <a href="/live">Live</a> page to join the stream. No account required to watch—just show up and enjoy the music. Create an account if you want to participate in chat and receive notifications about upcoming streams.</p>

<h3>Never Miss a Stream</h3>

<p>Follow us on social media for announcements about upcoming live events. We typically announce streams in advance so you can plan to tune in, but we also do surprise sessions—another reason to follow along.</p>
`
  },
  {
    id: 'crates-playlists-music-organisation',
    title: 'Crates: Organise Your Music Discovery with Custom Playlists',
    slug: 'crates-playlists-music-organisation',
    excerpt: 'Create personal crates to save and organise releases you love. Build wishlists, curate themed collections, and keep track of music you want to explore further.',
    category: 'Features',
    tags: ['crates', 'playlists', 'wishlist', 'music organisation', 'features'],
    author: 'Fresh Wax',
    featuredImage: 'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=1200&h=630&fit=crop',
    content: `
<h2>Your Personal Record Box</h2>

<p>Every serious record collector knows the importance of organisation. Our Crates feature brings the concept of the physical record crate into the digital realm, giving you a powerful way to save, sort, and manage the music you discover on Fresh Wax.</p>

<h3>What Are Crates?</h3>

<p>Crates are personal playlists where you can save releases from our catalogue. Think of them as digital record boxes that you can fill with music for different purposes:</p>

<ul>
<li><strong>Wishlist</strong> – Releases you want to purchase when funds allow</li>
<li><strong>DJ Sets</strong> – Potential selections for upcoming gigs</li>
<li><strong>Genres</strong> – Separate crates for liquid, neuro, jungle, etc.</li>
<li><strong>Moods</strong> – Music for different times and feelings</li>
<li><strong>Research</strong> – Tracks to investigate further</li>
</ul>

<h3>How Crates Help Your Discovery</h3>

<p>When you're browsing through hundreds of releases, it's easy to lose track of things that caught your ear. Crates solve this problem by letting you quickly save anything interesting with a single click. Come back later to review, compare, and decide what to add to your collection.</p>

<h3>Features of the Crates System</h3>

<ul>
<li>Create unlimited crates with custom names</li>
<li>Add any release with one click</li>
<li>Reorder tracks within crates</li>
<li>Move tracks between crates</li>
<li>Preview tracks directly from your crates</li>
<li>Quick-add to cart from crate view</li>
</ul>

<h3>Synced Across Devices</h3>

<p>Your crates are tied to your Fresh Wax account, meaning they sync across all your devices. Start building a crate on your laptop, add to it from your phone while commuting, and review it on your tablet at home. Your music organisation travels with you.</p>

<h3>Getting Started</h3>

<p>To use Crates, you'll need a free Fresh Wax account. Once logged in, you'll see the option to add releases to crates throughout the site. Visit the <a href="/crates">Crates</a> section to view and manage your collections. It's a simple feature that makes a big difference in how you interact with our catalogue.</p>
`
  }
];

export const GET: APIRoute = async ({ request, locals }) => {
  // Check for admin key in query params for this one-time seed
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const expectedKey = getAdminKey(locals);

  if (!key || key !== expectedKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Admin key required. Call with ?key=YOUR_ADMIN_KEY'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Initialize Firebase
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  const results: any[] = [];
  const now = new Date().toISOString();

  try {
    for (const post of blogPosts) {
      const { id, ...postData } = post;

      const fullPostData = {
        ...postData,
        status: 'published',
        views: 0,
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
        seoTitle: postData.title,
        seoDescription: postData.excerpt
      };

      try {
        await setDocument('blog-posts', id, fullPostData);
        results.push({ id, status: 'created', title: post.title });
      } catch (err: any) {
        results.push({ id, status: 'error', error: err.message });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Seeded ${results.filter(r => r.status === 'created').length} blog posts`,
      results
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
