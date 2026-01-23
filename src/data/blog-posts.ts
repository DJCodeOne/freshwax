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
      <p>Head over to our <a href="/releases">Releases</a> section to explore the latest drops. Whether you're after deep jungle rollers, technical DnB, or anything in between, you'll find fresh music to add to your collection.</p>
    `
  },
  {
    slug: 'dj-mixes-underground-sounds',
    title: 'DJ Mixes: Your Gateway to Underground Sounds',
    excerpt: 'Stream curated DJ mixes from talented selectors spanning jungle, drum & bass, and beyond.',
    featuredImage: 'https://images.unsplash.com/photo-1571266028243-e4733b0f0bb0?w=800&q=80',
    category: 'Mixes',
    publishedAt: '2025-01-12',
    author: 'Fresh Wax',
    tags: ['dj mixes', 'streaming', 'jungle', 'drum and bass'],
    content: `
      <p>Our DJ Mixes section is your portal to hours of carefully curated selections from some of the most talented DJs in the scene. Whether you're looking for background vibes while you work or fuel for your next rave, we've got you covered.</p>

      <h2>Discover New Selectors</h2>
      <p>Fresh Wax is committed to showcasing both established names and rising talent. Our mixes come from DJs who live and breathe jungle and drum & bass, bringing you selections that go beyond the obvious choices.</p>
      <p>Each mix tells a story, taking you on a journey through the depths of the underground.</p>

      <h2>Free to Stream</h2>
      <p>All our mixes are completely free to stream. We believe great music should be accessible to everyone. Simply hit play and let the selectors take you on a journey.</p>

      <h2>Submit Your Mix</h2>
      <p>Are you a DJ with a fire selection to share? We're always looking for new talent. Get in touch through our partner application to submit your mix for consideration.</p>

      <p>Check out our <a href="/mixes">DJ Mixes</a> section and discover your new favourite selector.</p>
    `
  },
  {
    slug: 'fresh-wax-merch-collection',
    title: 'Fresh Wax Merch: Wear Your Sound',
    excerpt: 'Rep the underground with our exclusive merchandise collection designed for true heads.',
    featuredImage: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800&q=80',
    category: 'Merch',
    publishedAt: '2025-01-10',
    author: 'Fresh Wax',
    tags: ['merchandise', 'clothing', 'streetwear'],
    content: `
      <p>Fresh Wax isn't just about the music – it's a lifestyle. Our merchandise collection lets you wear your passion for jungle and drum & bass with pride.</p>

      <h2>Quality You Can Feel</h2>
      <p>We don't do cheap throwaway fashion. Every item in our collection is made from premium materials, designed to last. From heavyweight cotton tees to cosy hoodies, our merch is built for real life.</p>

      <h2>Designs That Matter</h2>
      <p>Our designs are created by artists who understand the culture. Each piece reflects the energy and aesthetic of the scene, from subtle nods that only the heads will recognise to bold statements that turn heads.</p>

      <h2>Limited Drops</h2>
      <p>Many of our items are released as limited editions, so when they're gone, they're gone. Keep an eye on our socials and sign up to our newsletter to be the first to know about new drops.</p>

      <p>Browse our full <a href="/merch">Merch Collection</a> and find your new favourite piece.</p>
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

      <p>Check out our <a href="/sample-packs">Sample Packs</a> and start building your next banger.</p>
    `
  },
  {
    slug: 'live-streaming-fresh-wax',
    title: 'Live Streaming: Experience Fresh Wax Live',
    excerpt: 'Tune into live DJ sets, exclusive performances, and real-time interaction with the community.',
    featuredImage: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80',
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
      <p>Fresh Wax Plus members can broadcast their own sets through our platform. It's a great way to build your audience and connect with like-minded heads from around the world.</p>

      <p>Head to our <a href="/live">Live</a> section to see what's streaming now or check the schedule for upcoming sessions.</p>
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

      <p>Start digging in <a href="/crates">Crates</a> and find your next holy grail.</p>
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
