// src/data/blog-posts.ts
// Hardcoded blog posts data

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  featuredImage: string;
  category: string;
  publishedAt: string;
  author: string;
  tags: string[];
  content: string;
}

export const blogPosts: BlogPost[] = [
  {
    slug: 'go-live-from-your-phone',
    title: 'Go Live From Your Phone: No Software, No Laptop, No Problem',
    excerpt: 'DJs can now broadcast live on Fresh Wax straight from a mobile phone or tablet. No OBS, no BUTT, no complex setup — just tap and go.',
    featuredImage: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800&q=80',
    category: 'Live',
    publishedAt: '2026-03-08',
    author: 'Fresh Wax',
    tags: ['live streaming', 'mobile', 'go live', 'browser streaming', 'dj sets', 'WebRTC'],
    content: `
      <p>We've just rolled out a feature that a lot of DJs have been asking for: <strong>Go Live directly from your phone or tablet</strong>. No laptop required. No OBS. No BUTT. No messing about with audio routing software. Just open the page, hit Go Live, and you're broadcasting.</p>

      <h2>Why This Matters</h2>
      <p>Until now, going live on Fresh Wax meant setting up streaming software like OBS or BUTT on a laptop or desktop, configuring your audio source, and connecting to the server. That's fine if you've got the gear and the know-how, but not every DJ has access to a full studio setup every time they want to stream.</p>
      <p>Maybe you're at a mate's house playing tunes. Maybe you're at a party and want to share the vibe. Maybe you just don't own a laptop. Whatever the reason, this update means <strong>if you've got a phone, you can go live</strong>.</p>

      <h2>How It Works</h2>
      <p>If you're an approved DJ with a booked time slot, you'll see a "Go Live from Browser" link in the DJ Lobby. Tap it and you'll land on a purpose-built mobile streaming page. Here's what happens:</p>
      <ol>
        <li>Your phone's microphone picks up the audio (point it at the speakers)</li>
        <li>Optionally enable your camera for a video feed</li>
        <li>Tap <strong>Go Live</strong> — that's it, you're broadcasting</li>
      </ol>
      <p>The stream goes out to all listeners on the <a href="/live/">Live</a> page in real time. Chat, reactions, the lot — everything works exactly the same as a traditional stream.</p>

      <h2>Let's Be Honest About Audio Quality</h2>
      <p>We're not going to pretend this sounds the same as a proper studio stream. It doesn't. When you're streaming from a phone microphone pointed at speakers, you're going to get:</p>
      <ul>
        <li>Ambient room noise and crowd sounds</li>
        <li>Some compression and frequency loss from the phone mic</li>
        <li>Possible distortion if the volume is cranked</li>
      </ul>
      <p>But here's the thing: <strong>that's the charm</strong>. Some of the best pirate radio recordings sound rough as anything, and that raw energy is part of what makes them special. A phone stream from a house party has a vibe that a perfectly clean studio mix just doesn't capture.</p>
      <p>And for some DJs, this is the <strong>only option</strong>. If the choice is between streaming from your phone or not streaming at all, we'd rather you stream.</p>

      <h2>Tips for Better Mobile Streams</h2>
      <p>If you want to get the best possible quality from a phone stream, here are a few tips:</p>
      <ul>
        <li><strong>Get close to the speakers</strong> but not so close that the mic clips — find the sweet spot</li>
        <li><strong>Use a phone stand or prop it up</strong> so it stays steady, especially if you've got the camera on</li>
        <li><strong>Turn off notifications</strong> — you don't want WhatsApp pings interrupting your set</li>
        <li><strong>Keep the phone plugged in</strong> — streaming eats battery</li>
        <li><strong>WiFi over 4G/5G</strong> — more stable connection means fewer dropouts</li>
        <li><strong>Close other apps</strong> — free up as much processing power as possible</li>
      </ul>

      <h2>OBS Is Still King</h2>
      <p>If you've got access to a laptop and proper streaming software, that's still going to give you the best results. A direct audio feed into OBS or BUTT, properly configured, will always sound better than a phone mic in a room. The traditional setup isn't going anywhere — this is an <strong>additional option</strong>, not a replacement.</p>
      <p>Think of it like this: OBS is your studio session, phone streaming is your field recording. Both have their place.</p>

      <h2>Get Started</h2>
      <p>To use browser streaming, you need:</p>
      <ul>
        <li>An approved DJ account — either by hitting the required number of likes on your mixes, having a live code, or being approved by an admin</li>
        <li>A booked time slot on the <a href="/live/schedule/">schedule</a></li>
        <li>A phone or tablet with a working microphone</li>
        <li>A modern browser (Chrome, Safari, Firefox, Edge)</li>
      </ul>
      <p>That's it. No downloads, no config files, no port forwarding, no paid subscription required. Just book your slot, open the link, and go live.</p>

      <p>Head to the <a href="/live/">Live</a> section to see what's streaming now, or check the <a href="/live/schedule/">schedule</a> to book your next set.</p>
    `
  },
  {
    slug: 'discover-new-releases',
    title: 'Discover New Releases on Fresh Wax',
    excerpt: 'Explore the latest digital releases from jungle and drum & bass artists, with vinyl editions available on select titles.',
    featuredImage: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80',
    category: 'Releases',
    publishedAt: '2025-01-15',
    author: 'Fresh Wax',
    tags: ['releases', 'digital', 'vinyl', 'jungle', 'drum and bass'],
    content: `
      <p>Fresh Wax is your home for the latest jungle and drum & bass releases from independent artists and labels. Our releases section features brand new music available for digital download, with select titles also available on vinyl.</p>

      <h2>Digital First, Vinyl When It Counts</h2>
      <p>Most releases on Fresh Wax are digital, giving you instant access to high-quality downloads. But when labels decide to press vinyl, we've got you covered there too.</p>
      <p>Here's the best part: <strong>buy the vinyl and get the digital downloads free</strong>. No need to choose between formats – grab the wax and you'll have the digital files ready to go while you wait for your record to arrive.</p>

      <h2>Supporting Independent Artists</h2>
      <p>When you buy through Fresh Wax, you're directly supporting the artists and labels who create the music. We believe in fair compensation for creators, which is why we've built a platform that puts artists first.</p>
      <p>Every purchase helps fund future releases, studio time, and keeps the underground scene alive and thriving.</p>

      <h2>What You'll Find</h2>
      <ul>
        <li>Brand new digital releases in high-quality formats</li>
        <li>Vinyl editions on select titles</li>
        <li>Free digital downloads with vinyl purchases</li>
        <li>Exclusive releases you won't find elsewhere</li>
        <li>Direct support to artists and labels</li>
      </ul>

      <h2>Browse the Latest</h2>
      <p>Head over to our <a href="/releases/">Releases</a> section to explore the latest drops. Whether you're after deep jungle rollers, technical DnB, or anything in between, you'll find fresh music to add to your collection.</p>
    `
  },
  {
    slug: 'dj-mixes-underground-sounds',
    title: 'DJ Mixes: Your Gateway to Underground Sounds',
    excerpt: 'Stream curated DJ mixes from talented selectors spanning jungle, drum & bass, and beyond.',
    featuredImage: 'https://images.unsplash.com/photo-1619983081563-430f63602796?w=800&q=80',
    category: 'Mixes',
    publishedAt: '2025-01-12',
    author: 'Fresh Wax',
    tags: ['dj mixes', 'streaming', 'jungle', 'drum and bass', 'download'],
    content: `
      <p>Our DJ Mixes section is your portal to hours of carefully curated selections from some of the most talented DJs in the scene. Whether you're looking for background vibes while you work or fuel for your next rave, we've got you covered.</p>

      <h2>Discover New Selectors</h2>
      <p>Fresh Wax is committed to showcasing both established names and rising talent. Our mixes come from DJs who live and breathe jungle and drum & bass, bringing you selections that go beyond the obvious choices.</p>
      <p>Each mix tells a story, taking you on a journey through the depths of the underground.</p>

      <h2>Stream & Download</h2>
      <p>All mixes are free to stream instantly. Want to take a mix with you? Downloads are available too, so you can listen offline wherever you go.</p>

      <h2>Community Features</h2>
      <p>Each mix has its own page with everything you need:</p>
      <ul>
        <li><strong>Tracklisting</strong> – See what's in the mix</li>
        <li><strong>Reviews & Comments</strong> – Share your thoughts and read what others think</li>
        <li><strong>Ratings</strong> – Rate mixes and see community scores</li>
        <li><strong>Likes</strong> – Show love for your favourites</li>
        <li><strong>Share Links</strong> – Spread the word easily</li>
        <li><strong>DJ Info & Links</strong> – Connect with the selector</li>
      </ul>

      <h2>Upload Your Mix</h2>
      <p>Are you a DJ? Upload your mix directly to Fresh Wax for instant streaming and downloads. Add your tracklisting, description, artwork and links – then share it with the world. No waiting for approval, just upload and go live.</p>

      <p>Check out our <a href="/dj-mixes/">DJ Mixes</a> section and discover your new favourite selector.</p>
    `
  },
  {
    slug: 'merch-store-sound-systems-labels-djs',
    title: 'Merch Store: Rep Your Favourite Sound Systems, Labels & DJs',
    excerpt: 'Shop official merchandise from sound systems, labels, crews, DJs and Fresh Wax own brand - all in one place.',
    featuredImage: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800&q=80',
    category: 'Merch',
    publishedAt: '2025-01-10',
    author: 'Fresh Wax',
    tags: ['merchandise', 'clothing', 'sound systems', 'labels', 'djs'],
    content: `
      <p>Fresh Wax Merch is more than just our own brand – it's a marketplace where sound systems, labels, crews, and DJs can sell their official merchandise directly to fans.</p>

      <h2>One Stop Shop</h2>
      <p>No more hunting across different websites to find merch from your favourite artists. We bring together gear from across the scene in one place, making it easy to rep the sounds you love.</p>

      <h2>Who's Selling?</h2>
      <ul>
        <li><strong>Sound Systems</strong> – Official merch from legendary rigs and crews</li>
        <li><strong>Labels</strong> – Represent your favourite imprints</li>
        <li><strong>DJs & Producers</strong> – Support artists directly</li>
        <li><strong>Fresh Wax</strong> – Our own brand essentials</li>
      </ul>

      <h2>Quality Guaranteed</h2>
      <p>Every seller on our platform is verified, so you know you're getting authentic, official merchandise. No bootlegs, no knockoffs – just the real thing.</p>

      <h2>For Sellers</h2>
      <p>Got merch to sell? Whether you're a sound system, label, or artist, we make it easy. Just send us your stock and we do the rest – product photos, listing on the store, and shipping to customers. You get paid instantly when a sale completes.</p>
      <p>It's sale or return: you send stock to us at your expense, and if it doesn't sell, we return it at ours. Zero risk way to get your merch in front of the scene.</p>

      <p>Browse the <a href="/merch/">Merch Store</a> and find something to wear to the next dance.</p>
    `
  },
  {
    slug: 'sample-packs-for-producers',
    title: 'Sample Packs: Fuel Your Productions',
    excerpt: 'Professional-grade sample packs crafted by scene veterans for jungle and DnB producers.',
    featuredImage: 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&q=80',
    category: 'Production',
    publishedAt: '2025-01-08',
    author: 'Fresh Wax',
    tags: ['sample packs', 'production', 'music production', 'drums'],
    content: `
      <p>Every great track starts with the right sounds. Our sample packs are designed by producers who've been in the game for years, giving you access to the building blocks of authentic jungle and drum & bass.</p>

      <h2>Authentic Sounds</h2>
      <p>Forget generic sample packs that sound like everyone else. Our collections are crafted specifically for jungle and DnB production, featuring:</p>
      <ul>
        <li>Chopped breaks and drum hits</li>
        <li>Bass sounds from classic hardware</li>
        <li>Atmospheric textures and pads</li>
        <li>Vocal cuts and FX</li>
        <li>Reese basses and sub frequencies</li>
      </ul>

      <h2>Royalty-Free</h2>
      <p>All our sample packs are 100% royalty-free. Once you buy them, they're yours to use in your productions without any additional fees or licensing worries.</p>

      <h2>Made by Producers, for Producers</h2>
      <p>Every pack is created by artists who understand what you need in the studio. No filler, just quality sounds that will take your productions to the next level.</p>

      <p>Check out our <a href="/releases/">Releases</a> and start building your next banger.</p>
    `
  },
  {
    slug: 'live-streaming-fresh-wax',
    title: 'Live Streaming: Experience Fresh Wax Live',
    excerpt: 'Tune into live DJ sets, exclusive performances, and real-time interaction with the community.',
    featuredImage: 'https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=800&q=80',
    category: 'Live',
    publishedAt: '2025-01-05',
    author: 'Fresh Wax',
    tags: ['live streaming', 'dj sets', 'events', 'community'],
    content: `
      <p>Fresh Wax Live brings the rave to your living room. Our streaming platform hosts regular live DJ sets, giving you front-row access to performances from some of the best selectors in the scene.</p>

      <h2>Real-Time Connection</h2>
      <p>There's nothing quite like the energy of a live set. Our streaming sessions feature live chat, allowing you to connect with other ravers, send requests, and be part of the moment as it happens.</p>

      <h2>Regular Programming</h2>
      <p>We host regular streaming sessions throughout the week. Check our schedule to find out when your favourite DJs are going live, or just drop in whenever you see the live indicator.</p>

      <h2>Go Live Yourself</h2>
      <p>Approved DJs can broadcast their own sets through our platform. It's a great way to build your audience and connect with like-minded heads from around the world.</p>

      <p>Head to our <a href="/live/">Live</a> section to see what's streaming now or check the schedule for upcoming sessions.</p>
    `
  },
  {
    slug: 'crates-vinyl-marketplace',
    title: 'Crates: Buy & Sell Vinyl Collections',
    excerpt: 'Discover rare vinyl from collectors and sellers worldwide. Browse curated crates of jungle, drum & bass, and more.',
    featuredImage: 'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=800&q=80',
    category: 'Marketplace',
    publishedAt: '2025-01-03',
    author: 'Fresh Wax',
    tags: ['vinyl', 'crates', 'marketplace', 'collectors', 'rare records'],
    content: `
      <p>Fresh Wax Crates is our vinyl marketplace where collectors and sellers can list their record collections for sale. Think of it like Discogs, but built specifically for the jungle and drum & bass community.</p>

      <h2>For Buyers</h2>
      <p>Dig through carefully catalogued collections from vinyl enthusiasts around the world. Whether you're hunting for a rare white label, filling gaps in your collection, or discovering classic pressings you've never seen before, Crates connects you with sellers who share your passion.</p>
      <p>Each listing includes condition grading, photos, and detailed information so you know exactly what you're getting before you buy.</p>

      <h2>For Sellers</h2>
      <p>Got records gathering dust? Turn your collection into cash by listing on Crates. Our platform makes it easy to catalogue your vinyl, set your prices, and reach buyers who actually appreciate what you're selling.</p>
      <p>No listing fees for basic accounts – we only take a small commission when you make a sale.</p>

      <h2>What You'll Find</h2>
      <ul>
        <li>Rare jungle and drum & bass pressings</li>
        <li>Classic label back catalogues</li>
        <li>Test pressings and promos</li>
        <li>Full collection lots</li>
        <li>International sellers and buyers</li>
      </ul>

      <h2>Built for the Scene</h2>
      <p>Unlike generic marketplaces, Crates is designed by and for the jungle and DnB community. Sellers understand the music, and buyers know they're dealing with fellow heads who care about vinyl as much as they do.</p>

      <p>Start digging in <a href="/crates/">Crates</a> and find your next holy grail.</p>
    `
  }
];

// Helper to get post by slug
export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find(post => post.slug === slug);
}

// Get all categories
export function getCategories(): string[] {
  return [...new Set(blogPosts.map(p => p.category).filter(Boolean))];
}
