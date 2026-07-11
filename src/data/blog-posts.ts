// src/data/blog-posts.ts
// Hardcoded blog posts data

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  featuredImage: string;
  /** Optional dedicated social-share image (Facebook/Twitter card). Should be
   *  1200x630 (1.91:1) so the platforms don't crop it. Falls back to
   *  featuredImage. Set ogImageWidth/ogImageHeight to the real dimensions so the
   *  og:image:width/height tags are correct (otherwise SEO.astro assumes 800x800
   *  square and Facebook crops landscape images on all sides). */
  ogImage?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  category: string;
  publishedAt: string;
  author: string;
  tags: string[];
  content: string;
}

export const blogPosts: BlogPost[] = [
  {
    slug: 'what-is-jungle-music',
    title: 'What Is Jungle Music? A Beginner\'s Guide',
    excerpt: 'Chopped breakbeats, earth-moving sub-bass and soundsystem culture at 160 BPM. A beginner\'s guide to jungle music — where it came from, how it works, and where to start.',
    featuredImage: '/blog-what-is-jungle-music.webp',
    ogImage: '/blog-what-is-jungle-music-og.jpg',
    ogImageWidth: 1200,
    ogImageHeight: 630,
    category: 'Culture',
    publishedAt: '2026-07-11',
    author: 'Fresh Wax',
    tags: ['jungle', 'what is jungle', 'drum and bass', 'breakbeat', 'rave culture', 'uk music history', 'junglist'],
    content: `
      <p><strong>Jungle is a British dance music genre built on chopped-up breakbeats and heavyweight sub-bass, running at around 160&ndash;170 BPM.</strong> It grew out of the UK rave scene in the early 1990s, when producers — many of them Black British, raised on Jamaican soundsystem culture — began speeding up sampled funk drums and dropping reggae basslines underneath. The result sounded like nothing on earth: frantic and weightless up top, deep and slow underneath, equal parts hip-hop, ragga and rave. Jungle is the parent of drum &amp; bass, the sound of pirate radio London, and — thirty years on — one of the most influential genres Britain has ever produced.</p>
      <p>That's the short answer. Here's the proper one.</p>

      <h2>Where Jungle Came From</h2>
      <p>Jungle didn't appear from nowhere — it was made by collision. By 1991, Britain's rave scene was pushing breakbeat hardcore faster and darker: producers sampling American funk drum breaks and running them at rave tempos. At the same time, the UK's Caribbean communities had spent decades building soundsystem culture — bass-first music played loud through custom rigs, MCs toasting over instrumentals, exclusive dubplates cut to keep a crowd guessing.</p>
      <p>Jungle is what happened when those worlds fully merged. Take the rave's sped-up breakbeats and euphoria, hip-hop's sampling craft, and reggae's bass weight, patois and soundclash rituals — rewinds, MCs, dubplates — and you get a new genre entirely. It happened in London, Bristol and the Midlands between roughly 1991 and 1993, on cheap samplers in bedrooms, tested on pirate radio and settled on rave dancefloors. Early signposts like Lennie De Ice's "We Are I.E." sketched the blueprint; by 1993&ndash;94, jungle was fully itself.</p>

      <h2>The Sound: Four Ingredients</h2>
      <ul>
        <li><strong>Chopped breakbeats.</strong> Jungle drums aren't programmed from scratch — they're sampled funk breaks, sliced into individual hits and rebuilt into new patterns. The most famous is <a href="/blog/amen-break/">the Amen break</a>, six seconds of 1969 drumming that became the genre's national instrument, alongside breaks like Think and Apache.</li>
        <li><strong>Sub-bass.</strong> Under the drum chaos sits a bassline you feel in your chest before you hear it — pure reggae inheritance. The drums sprint at 160+; the bass often rolls at half that feel, which is why jungle sounds fast and slow at the same time.</li>
        <li><strong>Sampling as an art form.</strong> Ragga vocals, film dialogue, soul stabs, sirens — jungle tunes are collages, flipping fragments of other records into something new. It shares DNA with hip-hop production more than any other dance genre.</li>
        <li><strong>Soundsystem culture.</strong> MCs riding the rhythm, dubplate exclusives, the rewind when a tune is too good to let finish. Jungle is participatory — a dialogue between DJ, MC and crowd — and that culture came directly from Jamaica via Britain's soundsystems.</li>
      </ul>

      <h2>Why Is It Called "Jungle"?</h2>
      <p>The most common account traces the name back to Kingston, Jamaica, where "the Jungle" was the street name for the Arnett Gardens area — its residents "junglists". The phrase crossed into UK music through sampled soundclash tapes and toasts ("alla the junglists!"), and dancers began asking for the tunes with the junglist chants. Like most genre names it stuck by accident, and it carried baggage — parts of the media used it to paint the scene as dangerous, which junglists have pushed back on ever since. The name outlived the noise around it.</p>

      <h2>The Golden Era: 1993&ndash;96</h2>
      <p>For a few years jungle was the most exciting music in Britain, and it ran on its own infrastructure. Pirate stations like Kool FM broadcast it from tower blocks; raves and club nights like AWOL and Jungle Fever became institutions; dubplate culture meant the biggest tunes existed only as one-off acetates for months. In 1994 the sound broke the surface: M-Beat and General Levy's "Incredible" hit the UK Top 10, and a year later Goldie's <em>Timeless</em> put breakbeat science in the album charts and on television. Shy FX's "Original Nuttah", Remarc's "R.I.P.", Origin Unknown's "Valley of the Shadows" — this era produced anthems the scene still rewinds today.</p>

      <h2>Jungle vs Drum &amp; Bass</h2>
      <p>Around 1996&ndash;97 the scene's centre of gravity shifted: drums got more streamlined, the ragga influence receded in the big rooms, and the industry settled on a new name — drum &amp; bass. Whether jungle and D&amp;B are two genres or two eras of one genre is a debate that will outlive us all. The working answer: <strong>jungle leans into chopped breaks, reggae bass and soundsystem flavour; drum &amp; bass tends toward tighter two-step drums and cleaner production</strong> — and today the two happily coexist, often in the same set. We'll give that debate the full post it deserves soon.</p>

      <h2>Ten Tunes to Start With</h2>
      <ol>
        <li><strong>Lennie De Ice — We Are I.E. (1991)</strong> — the proto-jungle blueprint.</li>
        <li><strong>A Guy Called Gerald — 28 Gun Bad Boy (1992)</strong> — the Manchester connection.</li>
        <li><strong>Origin Unknown — Valley of the Shadows (1993)</strong> — "thirty-one seconds..." — the eeriest bassline in rave.</li>
        <li><strong>Shy FX &amp; UK Apachi — Original Nuttah (1994)</strong> — jungle's national anthem.</li>
        <li><strong>M-Beat ft. General Levy — Incredible (1994)</strong> — the Top 10 moment.</li>
        <li><strong>Remarc — R.I.P. (1994)</strong> — Amen chopping as a martial art.</li>
        <li><strong>Goldie — Inner City Life (1994)</strong> — jungle goes cinematic.</li>
        <li><strong>LTJ Bukem — Horizons (1995)</strong> — the deep, atmospheric end.</li>
        <li><strong>DJ Zinc — Super Sharp Shooter (1995)</strong> — hip-hop and jungle shaking hands.</li>
        <li><strong>Congo Natty — UK Allstars (various)</strong> — the ragga jungle flame-keeper.</li>
      </ol>

      <h2>Jungle Today</h2>
      <p>Jungle never died — it went underground and kept mutating, and the 2020s brought a full-blown resurgence: a new generation of producers like Nia Archives, Tim Reaper and Coco Bryce chopping breaks for new dancefloors, festival stages full of 160, and labels pressing jungle to vinyl again. That new wave is exactly what Fresh Wax exists for. Hear it in the catalogue — <a href="/item/s_r_s_FW-1782332853126/">100% JUNGLE VOL. 2 by S.R.S</a> does what it says on the tin, and <a href="/item/hangry_records_FW-1780739181417/">Hangry Records' Jungle &amp; DnB Vol.1</a> puts the modern sound on wax — or go deeper with <a href="/releases/">all releases</a>, the <a href="/dj-mixes/">DJ mixes</a>, and the <a href="/live/">live streams</a> where DJs run jungle sets direct to the community most weeks.</p>

      <h2>Quick Answers</h2>
      <ul>
        <li><strong>What BPM is jungle?</strong> Roughly 160&ndash;170 BPM today; the earliest tunes sat closer to 150&ndash;160.</li>
        <li><strong>Is jungle the same as drum &amp; bass?</strong> They're family — jungle came first; drum &amp; bass grew out of it. Junglists will debate the border forever.</li>
        <li><strong>Where did jungle start?</strong> The UK — above all London — in the early 1990s, from rave, hip-hop and Jamaican soundsystem culture colliding.</li>
        <li><strong>What's the most famous jungle sample?</strong> <a href="/blog/amen-break/">The Amen break</a> — read the full story.</li>
      </ul>
    `
  },
  {
    slug: 'amen-break',
    title: 'The Amen Break: The Most Sampled Drum Loop Ever',
    excerpt: 'Six seconds of drums from a 1969 funk B-side became the foundation of jungle and drum & bass. The story of the Amen break — and the drummer who never lived to see a penny of it.',
    featuredImage: '/blog-amen-break.webp',
    ogImage: '/blog-amen-break-og.jpg',
    ogImageWidth: 1200,
    ogImageHeight: 630,
    category: 'Culture',
    publishedAt: '2026-07-11',
    author: 'Fresh Wax',
    tags: ['amen break', 'jungle', 'drum and bass', 'sampling', 'breakbeat', 'music history', 'the winstons', 'gc coleman'],
    content: `
      <p>Somewhere in almost every jungle set you have ever heard — chopped, pitched up, flipped inside out — sits the same six seconds of drums, recorded in one take in 1969 by a funk band who thought so little of the track that they put it on a B-side. The song was <strong>"Amen, Brother" by The Winstons</strong>. The drummer was <strong>Gregory "G.C." Coleman</strong>. And the four bars he played about ninety seconds in have since been sampled more than any other piece of recorded music in history: hip-hop, jungle, drum &amp; bass, Britpop, adverts, even a primetime cartoon theme. This is the story of the Amen break — what it is, how it quietly conquered music, and why the only money that ever came back for it arrived decades late, as a thank-you cheque from the scene itself.</p>

      <h2>Six Seconds in 1969</h2>
      <p>The Winstons were a Washington, D.C. soul and funk outfit led by tenor saxophonist Richard Lewis Spencer. In 1969 they cut "Color Him Father", a heartfelt soul record that went on to win Spencer a Grammy for Best R&amp;B Song. Every single of the era needed a flip side, so the band knocked out an up-tempo instrumental take on the gospel standard "Amen" — the tune The Impressions had carried into the charts a few years earlier — and titled it "Amen, Brother".</p>
      <p>About one minute and twenty-six seconds in, the band drops out and Coleman plays four bars on his own. Two bars of his rolling groove, a third bar where the snare pattern shifts, and a fourth where he leaves the downbeat hanging and lands a displaced snare-and-crash figure that has hypnotised producers ever since. Roughly six seconds, around 136 BPM, recorded hot to tape with the whole kit bleeding together beautifully. Nobody involved gave it a second thought. "Amen, Brother" did its modest job as the flip of a hit, The Winstons moved on, and the break slept in record crates for the next seventeen years.</p>

      <h2>Why These Four Bars?</h2>
      <p>Plenty of old funk records have drum breaks. Why did this one take over the world? Listen closely and it starts to make sense:</p>
      <ul>
        <li><strong>Ghost notes everywhere.</strong> Between the backbeats Coleman feathers in quiet snare hits that give the pattern a rolling, human shuffle no drum machine of the era could fake.</li>
        <li><strong>Variation built in.</strong> It isn't one bar looped four times — it's a phrase with a beginning, a development and a punchline, so even the raw loop never feels static.</li>
        <li><strong>The bar-four stumble.</strong> That displaced crash is pure tension and release. It's the moment every junglist recognises in their spine.</li>
        <li><strong>The sound itself.</strong> Saturated, crunchy, mixed loud. Every hit cuts through, and — crucially for what came later — every hit chops out clean.</li>
      </ul>
      <p>Cut it apart and each slice is usable: kick, snare, hats, that ride-and-crash flourish. It isn't really a loop at all. It's a full drum kit with an attitude, free to anyone with a sampler.</p>

      <h2>Crate Diggers Give It a Second Life</h2>
      <p>The break's rebirth came in 1986, when "Amen, Brother" appeared on <strong>Ultimate Breaks &amp; Beats</strong> — a New York compilation series that collected drum-break records for DJs and producers, arriving at the exact moment affordable samplers did. Hip-hop got there first. Salt-N-Pepa's "I Desire" (1986) was among the earliest to flip it; Mantronix built "King of the Beats" (1988) around the break itself; and N.W.A laid it under "Straight Outta Compton" the same year. By the end of the decade the Amen was simply part of hip-hop's furniture.</p>

      <h2>The UK Mutation: Hardcore Into Jungle</h2>
      <p>Then Britain got hold of it, and the Amen stopped being a drum break and became the seed of an entire genre.</p>
      <p>Around 1990&ndash;92, UK hardcore producers were speeding breakbeats up to match rave tempos. Run the Amen at 150&ndash;160+ BPM and something magical happens: that human shuffle turns into pure forward motion. Armed with Akai samplers and an Atari ST running Cubase, producers went further than looping — they took the break apart hit by hit and rebuilt it. Resequenced. Reversed. Timestretched until the drums grind and shimmer with that metallic texture that became jungle's calling card. Tracks like Lennie De Ice's "We Are I.E." (1991) sketched the blueprint, and by 1993&ndash;94 jungle had fully arrived — with the Amen as its national instrument.</p>
      <p>Listen to Shy FX's "Original Nuttah" or Remarc's "R.I.P." and you're hearing Coleman's four bars turned into something he could never have imagined: a drum solo from 1969 running the dance at 160 BPM in a London rave twenty-five years later. "Amen tune" became its own category — it still is. Jungle grew into drum &amp; bass, and thirty years on, producers are still finding new ways to chop those same four bars. Every release on Fresh Wax stands somewhere downstream of them.</p>

      <h2>And Everywhere Else</h2>
      <p>The Amen's passport got stamped well beyond the rave. Oasis rode it through "D'You Know What I Mean?" at the height of Britpop. The <em>Futurama</em> theme is built on it. It has sold cars and trainers in adverts, and breakcore artists like Squarepusher and Aphex Twin turned extreme Amen surgery into a discipline of its own. <strong>WhoSampled catalogues it in more than six thousand tracks — the most sampled recording ever documented</strong> — and the real number is far higher, because no database will ever count every white-label jungle dubplate ever cut.</p>

      <h2>The Uncomfortable Part</h2>
      <p>Here's the thing every junglist should know: <strong>neither Coleman nor Spencer ever earned royalties from the break</strong>. The sampling era arrived before clearance culture did, and by the time the law caught up, the Amen was already everywhere and The Winstons weren't watching. Gregory Coleman died in 2006, destitute in Atlanta, very likely unaware that he was the most sampled drummer in human history. Richard Spencer, who held the copyright, said for decades that nobody had ever asked his permission.</p>
      <p>The scene did, eventually, put its hand in its pocket. In 2015 a British DJ, Martyn Webster, launched a crowdfunder — "The Winstons Amen Breakbeat Gesture" — and junglists around the world raised about &pound;24,000, presented to Spencer as an old-fashioned presentation cheque. To be clear about what that was: a voluntary thank-you from fans, not royalties, and not a settlement — and Coleman, the man who actually played the break, had already been gone nine years when it happened. But Spencer, who died in 2020, described it as the first real acknowledgement the record ever received. Both things are true at once: the music we love was built on six borrowed seconds that were never paid for, and the culture that borrowed them did — imperfectly, decades late — try to honour the men who made them.</p>

      <h2>Still Rolling</h2>
      <p>More than half a century on, the Amen is still load-bearing. The current jungle resurgence has a whole new generation slicing it up next to modern breaks, and you'll hear it — straight, chopped or in spirit — across our catalogue: it's in the DNA of records like <a href="/item/s_r_s_FW-1782332853126/">100% JUNGLE VOL. 2 by S.R.S</a> and <a href="/item/code_one_bakkus_FW-1775817379627/">The Jungle Disorder EP by Code One &amp; Bakkus</a>, and all over the sets in our <a href="/dj-mixes/">DJ mixes</a>. Fancy chopping breaks yourself? Our <a href="/samples/">sample packs</a> are the modern, cleared way to do exactly what the pioneers did with the Amen.</p>
      <p>Next time a switch-up sends the dance into the ceiling, spare a thought for G.C. Coleman: one take, four bars, 1969. The most influential six seconds ever committed to tape.</p>

      <h2>The Amen Break in Numbers</h2>
      <ul>
        <li><strong>Recorded:</strong> 1969 — B-side of The Winstons' "Color Him Father"</li>
        <li><strong>Drummer:</strong> Gregory "G.C." Coleman (1944&ndash;2006)</li>
        <li><strong>The break:</strong> 4 bars, about 6 seconds, starting around 1:26</li>
        <li><strong>Original tempo:</strong> roughly 136 BPM — jungle runs it at 160+</li>
        <li><strong>Documented samples:</strong> 6,000+ tracks on WhoSampled — the most of any recording</li>
        <li><strong>Sampling royalties:</strong> &pound;0 — the break was never licensed. The ~&pound;24,000 raised by fans in 2015 was a gesture to Richard Spencer, made nine years after Coleman's death.</li>
      </ul>
    `
  },
  {
    slug: 'remote-livestream-tethered-mobile',
    title: 'Stream From Anywhere — DJ-Quality Live Sets Over Mobile Data',
    excerpt: 'You can now run a full DJ-quality livestream from a remote venue with nothing but a mobile signal. BUTT and OBS hold a stable connection over a tethered phone or mobile hotspot — no fixed broadband required.',
    featuredImage: '/blog-stream-from-anywhere.webp',
    ogImage: '/blog-stream-from-anywhere-og.jpg',
    ogImageWidth: 1200,
    ogImageHeight: 630,
    category: 'Live',
    publishedAt: '2026-06-13',
    author: 'Fresh Wax',
    tags: ['live streaming', 'remote streaming', 'mobile data', 'tethering', 'mobile hotspot', 'BUTT', 'OBS', 'dj sets', 'remote venue', 'jungle', 'drum and bass'],
    content: `
      <p>Earlier this year we made it possible to <a href="/blog/go-live-from-your-phone/">go live straight from your phone</a> — mic pointed at the speakers, tap and broadcast. That's the zero-gear option, and it's still there. This update is the other end of the scale: <strong>a full, DJ-quality livestream from a remote venue with nothing but a mobile signal to get online</strong>.</p>
      <p>Tether a laptop to your phone, plug into a mobile hotspot, run off a pocket 4G/5G router — whatever gets you a connection — and you can now push a proper line-in feed (or full video) to Fresh Wax that <strong>holds</strong>, for the length of a set, without dropping every couple of minutes.</p>

      <h2>The Problem We Just Solved</h2>
      <p>Proper streaming software like <strong>BUTT</strong> and <strong>OBS</strong> always sounded better than a phone mic — but if you tried to run them over a mobile connection (tethering, a hotspot, a portable router), the stream would die roughly every two minutes and reconnect, leaving listeners with a stuttering, on-off mess.</p>
      <p>That wasn't your settings or your software. Mobile networks quietly tear down the kind of long-lived connection a stream needs, and a normal phone-camera stream survives that because of how it talks to the network — a studio audio stream didn't. We've now bridged that gap on our side. The result: <strong>BUTT and OBS stay connected over a tethered mobile link</strong>, the same way they do on home broadband.</p>

      <h2>What This Unlocks</h2>
      <p>If your only blocker to streaming a proper set was "there's no decent internet at the venue," that blocker is gone:</p>
      <ul>
        <li><strong>Remote venues and pop-ups</strong> with no fixed broadband</li>
        <li><strong>Outdoor sessions, raves, and festival sets</strong> running off a mobile router</li>
        <li><strong>Mate's house, a warehouse, a car park</strong> — anywhere you can get a signal</li>
        <li>Any spot where you've got the decks and the gear, just not a wired connection</li>
      </ul>
      <p>Bring your laptop, your soundcard, and a way online — that's the whole list now.</p>

      <h2>BUTT — Best Audio, Now Over Mobile</h2>
      <p><strong>BUTT (Broadcast Using This Tool)</strong> takes a clean line straight from your mixer or soundcard, so it's the best-sounding option for an audio set — no room noise, no phone-mic compression, just the mix. It's our recommended choice for most DJs, and it now survives a tethered mobile connection.</p>
      <p>Set it up once using the exact server details on your <a href="/account/streaming-setup/">Streaming Setup</a> page (they're also shown in the <a href="/account/dj-lobby/">DJ Lobby</a> when you go to stream). Use the details exactly as listed — that's what routes you through the connection that stays alive over mobile.</p>

      <h2>OBS — Video Over Mobile Too</h2>
      <p>Want a camera feed as well? <strong>OBS</strong> works over a tethered connection too, with two settings worth getting right when you're on mobile data:</p>
      <ul>
        <li><strong>Drop the video bitrate to around 2000 kbps.</strong> A mobile uplink doesn't have the headroom of home broadband. Push too high and frames drop — which can leave the stream connected but showing a black screen. ~2000 kbps keeps it smooth.</li>
        <li><strong>Set B-frames to 0</strong> in your encoder settings. This is what gives clean, glitch-free playback for viewers watching on phones — the bulk of your audience.</li>
      </ul>
      <p>Full step-by-step settings for both BUTT and OBS are on the <a href="/account/streaming-setup/">Streaming Setup</a> page.</p>

      <h2>Let's Be Honest About The Connection</h2>
      <p>This isn't magic — it's still a mobile connection, and physics applies. A few realities worth knowing:</p>
      <ul>
        <li><strong>Signal strength matters.</strong> One or two bars in a basement will struggle. A solid signal makes all the difference — check it before you start.</li>
        <li><strong>Keep the bitrate sensible.</strong> Mobile uplinks are narrower than your download speed suggests. Don't try to push a 6 Mbps stream up a flaky connection.</li>
        <li><strong>Audio-only (BUTT) is far lighter than video (OBS)</strong> — if the signal's marginal, run audio. It needs a fraction of the bandwidth and holds up better.</li>
        <li><strong>Keep the laptop and phone charged</strong> — tethering and encoding both eat battery fast.</li>
      </ul>
      <p>Within those limits, it's solid. We tested it streaming over a phone-tethered laptop on mobile data and held a clean connection for the length of a set with no drops.</p>

      <h2>Which Option Should I Use?</h2>
      <ul>
        <li><strong>Phone mic</strong> (<a href="/blog/go-live-from-your-phone/">go live from your phone</a>) — no gear, no laptop, raw and ready. The field recording.</li>
        <li><strong>BUTT</strong> — clean line-in audio from your mixer. The best-sounding option, now portable. The studio session, taken on the road.</li>
        <li><strong>OBS</strong> — audio plus a camera feed, if you want the visuals and have the bandwidth for it.</li>
      </ul>

      <h2>Get Started</h2>
      <p>To stream, you need:</p>
      <ul>
        <li>An approved DJ account and a booked slot on the <a href="/schedule/">schedule</a></li>
        <li>BUTT or OBS set up with the details from your <a href="/account/streaming-setup/">Streaming Setup</a> page</li>
        <li>A way online — tethered phone, mobile hotspot, or portable router</li>
      </ul>
      <p>Book your slot, get a signal, and go live from wherever the party is. See what's on now over on the <a href="/live/">Live</a> page.</p>
    `
  },
  {
    slug: 'welcome-hangry-records-jungle-dnb-vol-1',
    // Non-breaking spaces inside "Jungle & DnB Volume.1" keep that phrase
    // together as one unbreakable block, so the natural wrap lands at the
    // em-dash instead of mid-phrase between & and DnB.
    title: 'Welcome Hangry Records — Jungle & DnB Volume.1',
    excerpt: 'Hangry Records joins Fresh Wax with the re-issue of their first ever release: an eight-track jungle and drum & bass compilation, with the majority of profits going to mental health and homelessness charities.',
    featuredImage: 'https://cdn.freshwax.co.uk/releases/hangry_records_jungle_dnb_volume_1_1780739181417/cover.webp',
    category: 'Releases',
    publishedAt: '2026-06-06',
    author: 'Fresh Wax',
    tags: ['hangry records', 'compilation', 'various artists', 'jungle', 'drum and bass', 'release', 'charity', 'new label', 'london'],
    content: `
      <p>Fresh Wax is proud to welcome <strong>Hangry Records</strong> to the platform. The London-based non-profit label has been quietly putting out some of the rawest jungle and drum & bass coming out of the UK underground since 2020, and they've chosen to debut on Fresh Wax with the record that started it all — <strong>Jungle & DnB Volume.1</strong>, the very first release on the label, originally cut in April 2020 and now available here both as a full digital download and on a limited two-record vinyl pressing.</p>

      <h2>Who Hangry Are</h2>
      <p>The label puts it best in their own words: <em>"Hangry Records is a non-profit label. We want to help and bring awareness to worthy causes, whilst pushing and showing appreciation to underground producers that are killing it with their sound."</em></p>
      <p>That's the whole brief — underground producers, worthy causes. No A&R algorithm, no streaming-bait edits, no label politics. Just the music and where the money goes. Since Volume.1 dropped in 2020 they've released through to <em>Jungle & DnB Volume.5</em> (with Vol.6 in the works), built out the darker <em>Tunes From The Crypt</em> series across seven volumes, dropped <em>Femme Frequencies Volume.1</em> as an all-female lineup in 2025, and put out solo EPs from artists in their roster (SuM's <em>Ink Stains EP</em> being a recent highlight).</p>

      <h2>About The Release</h2>
      <p>Volume.1 is a properly stitched-together compilation, every track from a different producer in the underground. The pressing is split across two records — four tracks per record, two tracks per side — so it stays friendly to mix out of without cramming the wax.</p>

      <h3>Part 1</h3>
      <ol>
        <li><strong>Abstract Drumz — Higher</strong></li>
        <li><strong>MAC V — Panopticon</strong></li>
        <li><strong>Polarity — Final Heaven</strong></li>
        <li><strong>Sargy — Ultimate Reality</strong></li>
      </ol>

      <h3>Part 2</h3>
      <ol start="5">
        <li><strong>16AJ & Thermadore — FadeAway</strong></li>
        <li><strong>Illicit — Departures</strong></li>
        <li><strong>Mom$ — Vogued</strong></li>
        <li><strong>SuM — Time Wound</strong></li>
      </ol>

      <p>Eight producers, eight cuts across a two-record set. Amen breaks, sub pressure, dancefloor weight — proper underground jungle and drum & bass with the grit kept in. The kind of compilation that exists to back the artists on it: this is somebody's first credit, somebody's calling-card, somebody's statement of intent. Several of the names here — Sargy, Polarity, Abstract Drumz, SuM — have gone on to land tracks on later Hangry volumes, so Volume.1 is where the family tree starts.</p>

      <h2>The Cause Behind The Record</h2>
      <p>This is where Hangry separates itself from a regular drum and bass label. <strong>The majority of profits from this record go directly to charity</strong> — split between two organisations Hangry has been backing:</p>
      <ul>
        <li><strong><a href="https://www.crisis.org.uk/" target="_blank" rel="noopener">Crisis</a></strong> — the national charity for people experiencing homelessness in the UK.</li>
        <li><strong><a href="https://www.forwardtrust.org.uk/" target="_blank" rel="noopener">The Forward Trust</a></strong> — mental health and addiction support.</li>
      </ul>
      <p>The original 2020 cut of this record raised money for Mind and Shelter UK; the label-wide focus has since shifted toward Crisis and The Forward Trust, both doing work that hits close to home for communities the dance music scene draws from and gives back to. Every digital download, every vinyl shipped from this release contributes.</p>

      <h2>For Jake</h2>
      <p>The record carries a dedication — <em>"To our Soldier who gained his Wings too soon, Jake Arnold. Rest in Paradise and Parties 💚"</em>. Releases like this are how scenes remember the people who shaped them. The tracks are the celebration; the dedication is the love behind it.</p>

      <h2>Listen, Buy, Support</h2>
      <p>You can stream previews on the <a href="/item/hangry_records_FW-1780739181417/">release page</a> right now. Full digital download is £8.50 for all eight tracks, individual tracks are £2.50 each, and the vinyl is a two-record set — each record presses four of the eight tracks at £15 a piece. Grab one for half the pressing, or both for the full eight on wax. Each vinyl part includes the digital download for the four tracks pressed on that record (WAVs, MP3s and artwork land in your account the moment you click buy while the record itself is on its way) — to get the digital for all eight, either buy both parts or grab the full digital bundle separately for £8.50.</p>
      <p>Every purchase splits between the label and the charities. Whether you're playing it out, prepping a set, or just listening — you're backing the music and the cause at the same time.</p>

      <p><strong><a href="/item/hangry_records_FW-1780739181417/">Hear it & grab a copy →</a></strong></p>

      <h2>Find Hangry Records</h2>
      <p>If you want to dig deeper into the catalogue — and you should — Hangry are live on:</p>
      <ul>
        <li><a href="https://hangryrecords.bandcamp.com/" target="_blank" rel="noopener">Bandcamp</a> (the full back catalogue)</li>
        <li><a href="https://www.instagram.com/hangry_records/" target="_blank" rel="noopener">Instagram</a> (@hangry_records — release announcements, artist features)</li>
        <li><a href="https://soundcloud.com/hangryrecords" target="_blank" rel="noopener">SoundCloud</a></li>
        <li><a href="https://www.facebook.com/HangryRecordsLondon/" target="_blank" rel="noopener">Facebook</a></li>
      </ul>

      <p>Welcome to Fresh Wax, Hangry. Looking forward to whatever you drop next.</p>
    `
  },
  {
    slug: 'monthly-update-may-2026',
    title: "May 2026 Update — What's Freshly Cut",
    excerpt: "Busy month behind the scenes at Fresh Wax. Sign-in is smoother, stream keys are now permanent to your account, and payouts have been completely overhauled and reconciled.",
    featuredImage: '/blog-may-2026-update.jpg',
    category: 'Updates',
    publishedAt: '2026-05-11',
    author: 'Fresh Wax',
    tags: ['updates', 'platform', 'livestream', 'payouts', 'monthly update', 'may 2026'],
    content: `
      <p>Busy month behind the scenes at Fresh Wax. Here's what's been freshly cut.</p>

      <h2>For Everyone</h2>
      <p>Sign-in is smoother. A few things that used to trip people up:</p>
      <ul>
        <li><strong>Verify your email on your phone, then log in on your desktop</strong> — finally works without sending you back to the verification screen. The site now refreshes your verification state on every sign-in, so a confirmation on one device is recognised on every device.</li>
        <li><strong>After I ship an update to the site</strong>, you'll no longer get stuck in a "you're signed in but please sign in" loop. The site picks up new versions and refreshes itself in the background — silent, no popup, no logout. First click after a deploy just works.</li>
        <li><strong>More accurate fee totals</strong> across all the admin and dashboard views. What you see is what was actually charged — no more split-row rounding artifacts inflating or deflating the numbers.</li>
      </ul>

      <h2>For DJs</h2>
      <p><strong>Stream keys are now permanent to your account.</strong> Set them up in OBS once, and they stay valid every time you go live. No more updating settings each session. Your key is tied to your DJ account, not the specific slot — so as long as you have a booking active, the same key works.</p>
      <p>If you're broadcasting and nobody's booked after you, the slot now <strong>extends automatically</strong> so you can keep the set running past the hour mark. Listeners stay connected, no cut-off. The slot keeps rolling forward in hour-long increments until either someone else is queued or you decide to wrap up.</p>
      <p>DJ Lobby video preview is back in working order — you can now see your own OBS feed directly in the lobby while you're streaming, exactly as your listeners see it. Plus a handful of smaller livestream wrinkles ironed out: cleaner reconnection handling, more reliable preview thumbnails, and the broadcast mode toggle now actually persists between sessions.</p>

      <h2>For Artists &amp; Labels</h2>
      <p>I've completely overhauled how payouts are tracked. <strong>Multi-payee releases with split ownership</strong> (50/50 EPs, label-and-artist arrangements, anything where the sale needs to be divided between multiple people) are now handled automatically — your share is calculated and credited correctly, every time. No manual reconciliation needed on your end.</p>
      <p>I've also gone back through every historical sale and <strong>reconciled the books</strong> so everyone is paid the exact correct amount. Fees from PayPal (the actual rates they charge, not estimates) and Fresh Wax's 1% platform fee are now accurately reflected in your dashboard. If you had a £0.30 or £0.40 discrepancy sitting in your pending balance from an earlier sale, it's been corrected.</p>

      <h2>Behind The Scenes</h2>
      <p>A handful of smaller improvements you might not notice individually but add up:</p>
      <ul>
        <li>The admin payments page now shows order-level fee totals instead of per-payee slices, so the numbers on screen match what PayPal actually charged.</li>
        <li>Analytics reports correctly count orders even when they span multiple artists or include split payouts.</li>
        <li>Treasury reconciliation against the live PayPal balance, so I can spot any discrepancies before they become anyone's problem.</li>
        <li>Faster sign-in on slow connections and a couple of fixes to the partner approval flow.</li>
      </ul>

      <h2>Coming Up</h2>
      <p>More livestream features, deeper artist analytics, and the first of the regularly scheduled DJ residencies. Keep an eye on the live page over the next few weeks.</p>
      <p>If you hit anything weird, drop me a message — there's a contact form on the site and I read every email. Always listening, always tweaking.</p>

      <p><strong>Stay locked.</strong></p>
    `
  },
  {
    slug: 'final-polish-jungle-disorder-ep',
    title: 'Final Polish Before Launch — The Jungle Disorder EP Drops Friday',
    excerpt: 'Fresh Wax is in the final stretch before full production launch. To mark the occasion, Code One and DJ Bakkus drop The Jungle Disorder EP this Friday.',
    featuredImage: 'https://images.unsplash.com/photo-1571330735066-03aaa9429d89?w=800&q=80',
    category: 'Releases',
    publishedAt: '2026-04-09',
    author: 'Fresh Wax',
    tags: ['code one', 'dj bakkus', 'jungle disorder', 'ep', 'release', 'launch', 'jungle', 'drum and bass'],
    content: `
      <p>We're in the home stretch. After months of building, breaking, fixing and rebuilding, <strong>Fresh Wax is about to go fully live</strong>. The last few days are all about final polish — squashing the edge-case bugs, tightening up the checkout flow, ironing out the live stream UX, and making sure everything that should work, works.</p>

      <h2>What's Been Happening</h2>
      <p>If you've been around the site recently, you'll have seen things shifting daily. Some of the bigger changes landing this week:</p>
      <ul>
        <li><strong>Plus Membership through the bag</strong> — going Plus is now part of the same checkout flow as everything else. One bag, one payment, one less thing to think about.</li>
        <li><strong>Smarter checkout</strong> — your details now save automatically after your first order, so future purchases pre-fill instantly.</li>
        <li><strong>Artist editing improvements</strong> — release pages now save catalogue numbers, genres, prices and tracklists reliably from the artist dashboard.</li>
        <li><strong>Go Live straight from your phone</strong> — the Live page now supports broadcasting directly from a mobile phone or tablet. No OBS, no BUTT, no laptop. Open the page, hit Go Live and you're streaming.</li>
        <li><strong>Live page polish</strong> — log-in prompts now use clean toast notifications instead of native browser alerts. The chat, shout-outs and reactions all behave properly when logged out.</li>
        <li><strong>New page backgrounds</strong> — the home, releases and crates pages now sit on top of blurred Fresh Wax graffiti artwork. Same vibe, more presence.</li>
        <li><strong>Cache and data fixes</strong> — release edits now propagate everywhere immediately, deletions actually delete, and the home page stops serving stale data.</li>
      </ul>
      <p>None of this is glamorous on its own, but together it's the difference between "demo" and "shop". We're nearly there.</p>

      <h2>To Mark The Moment — The Jungle Disorder EP, This Friday</h2>
      <p>Launches deserve a release. So this Friday, <strong>Code One and DJ Bakkus</strong> drop <strong>The Jungle Disorder EP</strong>, exclusive to Fresh Wax. Two producers, two takes on the sound that built this whole project — proper jungle and drum & bass made for the dance, not the algorithm.</p>
      <p>Expect rolling drums, deep low end, and the kind of energy that's been the foundation of every late-night session worth remembering. Available as digital download from launch.</p>

      <h2>Why It Matters</h2>
      <p>Fresh Wax was built so artists could put their music out without giving up half the value to a middleman. Every sale goes back into the scene — to the artists, to the labels, and into keeping the platform running. Friday's release isn't just a new EP, it's a statement of what Fresh Wax is here to do: get music from the people who make it straight to the people who play it.</p>

      <h2>Be Ready</h2>
      <p>If you haven't already, now's a good time to:</p>
      <ul>
        <li><a href="/register/">Create an account</a> so you're ready to grab the EP the moment it drops</li>
        <li><a href="/account/dashboard/">Go Plus</a> for unlimited mix uploads, longer streaming hours and member-only features</li>
        <li><a href="/live/">Have a look at the Live page</a> — and try the new mobile Go Live if you're a DJ</li>
      </ul>
      <p>This is just the beginning. We've got a stacked roadmap of releases, label partnerships and stream takeovers lined up for the months ahead. Friday is the starting line.</p>

      <p><strong>The Jungle Disorder EP — Code One x DJ Bakkus, out Friday on Fresh Wax. Lock it in.</strong></p>
    `
  },
  {
    slug: 'underground-lair-recordings-merch',
    title: 'New Merch Drop: Underground Lair Recordings',
    excerpt: 'Underground Lair Recordings has landed on Fresh Wax Merch with hoodies and t-shirts in a range of colours. Rep the label.',
    featuredImage: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800&q=80',
    category: 'Merch',
    publishedAt: '2026-03-08',
    author: 'Fresh Wax',
    tags: ['merch', 'underground lair recordings', 'hoodies', 't-shirts', 'clothing', 'jungle', 'drum and bass'],
    content: `
      <p>We're buzzing to announce that <strong>Underground Lair Recordings</strong> has just dropped their official merch on Fresh Wax. If you know the label, you already know the score — deep, dark jungle and drum & bass from some of the most respected names in the scene.</p>

      <h2>What's Available</h2>
      <p>The first drop includes:</p>
      <ul>
        <li><strong>Hoodies</strong> — heavyweight, comfortable, and built for those cold nights on the way to the dance. Available in a range of colours.</li>
        <li><strong>T-shirts</strong> — classic fit tees with the Underground Lair branding. Multiple colourways to choose from.</li>
      </ul>
      <p>All items feature the official Underground Lair Recordings artwork, so you're repping the label properly — no generic prints, just the real thing.</p>

      <h2>Why It Matters</h2>
      <p>When you buy merch through Fresh Wax, you're putting money directly back into the scene. Every sale supports the label, helps fund future releases, and keeps the underground moving. It's not just a hoodie — it's a statement that you back the music.</p>

      <h2>Multiple Colours</h2>
      <p>We know everyone's got their preference, so the range comes in different colours across both hoodies and tees. Whether you want something understated or something that stands out, there's an option for you. Check out the product pages to see what's in stock.</p>

      <h2>How It Works</h2>
      <p>Fresh Wax Merch is a marketplace where labels, sound systems, and DJs sell their official gear. We handle the listing, photos, and shipping — the label sends us the stock and we do the rest. It's sale or return, so there's zero risk for the sellers and you get authentic merch delivered to your door.</p>

      <p>Head over to the <a href="/merch/">Merch Store</a> and grab yours before they're gone.</p>
    `
  },
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
        <li>A booked time slot on the <a href="/schedule/">schedule</a></li>
        <li>A phone or tablet with a working microphone</li>
        <li>A modern browser (Chrome, Safari, Firefox, Edge)</li>
      </ul>
      <p>That's it. No downloads, no config files, no port forwarding, no paid subscription required. Just book your slot, open the link, and go live.</p>

      <p>Head to the <a href="/live/">Live</a> section to see what's streaming now, or check the <a href="/schedule/">schedule</a> to book your next set.</p>
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
