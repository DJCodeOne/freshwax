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
    slug: 'discover-exclusive-vinyl-releases',
    title: 'Discover Exclusive Vinyl Releases on Fresh Wax',
    excerpt: 'Explore our curated collection of jungle and drum & bass vinyl releases from independent artists worldwide.',
    featuredImage: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80',
    category: 'Releases',
    publishedAt: '2025-01-15',
    author: 'Fresh Wax',
    tags: ['vinyl', 'releases', 'jungle', 'drum and bass'],
    content: `
      <p>At Fresh Wax, we're passionate about bringing you the finest vinyl releases from the jungle and drum & bass underground. Our platform connects you directly with independent artists and labels who are pushing the boundaries of the sound we all love.</p>

      <h2>Why Vinyl Still Matters</h2>
      <p>In an age of streaming and digital downloads, vinyl remains the gold standard for serious collectors and DJs. There's something irreplaceable about the warmth of analogue sound, the ritual of dropping the needle, and the tangible connection to the music you love.</p>
      <p>Our vinyl section features exclusive pressings, limited editions, and reissues of classic tracks that defined the scene. Each release is carefully selected to ensure you're getting music that matters.</p>

      <h2>Supporting Independent Artists</h2>
      <p>When you buy vinyl through Fresh Wax, you're directly supporting the artists and labels who create the music. We believe in fair compensation for creators, which is why we've built a platform that puts artists first.</p>
      <p>Every purchase helps fund future releases, studio time, and keeps the underground scene alive and thriving.</p>

      <h2>Browse Our Collection</h2>
      <p>Head over to our <a href="/releases">Releases</a> section to explore the latest additions. Whether you're after deep jungle rollers, technical DnB, or anything in between, you'll find something to add to your crate.</p>
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
    slug: 'crates-curated-playlists',
    title: 'Crates: Curated Playlists for Every Mood',
    excerpt: 'Discover hand-picked selections organised by vibe, tempo, and style for the perfect listening experience.',
    featuredImage: 'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=800&q=80',
    category: 'Playlists',
    publishedAt: '2025-01-03',
    author: 'Fresh Wax',
    tags: ['playlists', 'crates', 'curated', 'discovery'],
    content: `
      <p>Sometimes you know exactly what vibe you're after. Our Crates feature organises the best tracks and mixes by mood, tempo, and style, making it easy to find exactly what you need.</p>

      <h2>Expertly Curated</h2>
      <p>Each crate is put together by selectors who know the music inside out. Whether you're after deep liquid rollers for a Sunday morning or dark steppers for a late-night session, we've got a crate for that.</p>

      <h2>Discover New Music</h2>
      <p>Crates are a brilliant way to discover new tracks and artists. Each playlist is designed to flow, introducing you to music you might have missed while keeping the energy consistent.</p>

      <h2>Growing Collection</h2>
      <p>We're constantly adding new crates to our collection. From era-specific selections to label showcases, there's always something new to explore.</p>

      <h2>Categories Include:</h2>
      <ul>
        <li>Deep & Liquid</li>
        <li>Jump Up & Dancefloor</li>
        <li>Classic Jungle</li>
        <li>Atmospheric & Intelligent</li>
        <li>Dark & Minimal</li>
        <li>Label Spotlights</li>
      </ul>

      <p>Explore our <a href="/crates">Crates</a> section and dig into something new.</p>
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
