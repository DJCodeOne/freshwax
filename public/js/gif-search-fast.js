/**
 * FAST GIF SEARCH - Multi-Source Instant Search
 * Giphy + Tenor + Gfycat combined results
 * Instant insert on selection - no text, just GIF
 */

(function() {
  'use strict';

  const config = {
    giphyKey: '',
    tenorKey: '',
    gfycatClientId: '',
    limit: 20,
    debounceMs: 150,  // Fast debounce for instant feel
    preloadTrending: true
  };

  let searchCache = new Map();
  let trendingCache = null;
  let currentQuery = '';
  let searchTimeout = null;
  let onInsertCallback = null;

  // Create modal HTML
  function createModal() {
    if (document.getElementById('gif-modal')) return;

    const html = `
      <div id="gif-modal" class="gm" style="display:none">
        <div class="gm-backdrop"></div>
        <div class="gm-box">
          <div class="gm-head">
            <input type="text" id="gif-input" class="gm-input" placeholder="Search GIFs..." autocomplete="off" autofocus />
            <button class="gm-close" id="gif-close">✕</button>
          </div>
          <div class="gm-sources">
            <span class="gm-src giphy">GIPHY</span>
            <span class="gm-src tenor">TENOR</span>
            <span class="gm-src gfycat">GFYCAT</span>
          </div>
          <div id="gif-grid" class="gm-grid"></div>
          <div id="gif-status" class="gm-status"></div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    addStyles();
    attachEvents();
  }

  function addStyles() {
    if (document.getElementById('gm-styles')) return;
    const css = `
      <style id="gm-styles">
        .gm{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:1rem}
        .gm-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(4px)}
        .gm-box{position:relative;width:100%;max-width:650px;max-height:85vh;background:#1a1a2e;border:1px solid rgba(255,255,255,.1);border-radius:1rem;display:flex;flex-direction:column;overflow:hidden}
        .gm-head{display:flex;gap:.5rem;padding:1rem;border-bottom:1px solid rgba(255,255,255,.1)}
        .gm-input{flex:1;padding:.75rem 1rem;background:rgba(0,0,0,.5);border:2px solid rgba(99,102,241,.5);border-radius:.5rem;color:#fff;font-size:1rem;outline:none}
        .gm-input:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.2)}
        .gm-input::placeholder{color:rgba(255,255,255,.4)}
        .gm-close{width:40px;height:40px;background:rgba(255,255,255,.1);border:none;border-radius:.5rem;color:#fff;font-size:1.25rem;cursor:pointer;transition:all .15s}
        .gm-close:hover{background:#ef4444;transform:scale(1.05)}
        .gm-sources{display:flex;gap:.5rem;padding:.5rem 1rem;border-bottom:1px solid rgba(255,255,255,.05)}
        .gm-src{padding:.2rem .5rem;font-size:.65rem;font-weight:700;border-radius:.25rem;text-transform:uppercase;opacity:.7}
        .gm-src.giphy{background:linear-gradient(135deg,#00ff99,#00ccff);color:#000}
        .gm-src.tenor{background:#5865F2;color:#fff}
        .gm-src.gfycat{background:#1a1a1a;color:#fff;border:1px solid #333}
        .gm-grid{flex:1;overflow-y:auto;padding:.75rem;display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;min-height:200px}
        .gm-grid::-webkit-scrollbar{width:8px}
        .gm-grid::-webkit-scrollbar-track{background:rgba(0,0,0,.2)}
        .gm-grid::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:4px}
        .gm-item{position:relative;aspect-ratio:1;overflow:hidden;border-radius:.5rem;cursor:pointer;background:rgba(0,0,0,.3)}
        .gm-item:hover{transform:scale(1.05);z-index:1;box-shadow:0 8px 25px rgba(0,0,0,.5)}
        .gm-item img{width:100%;height:100%;object-fit:cover;transition:opacity .15s}
        .gm-item img.loading{opacity:.5}
        .gm-item .gm-tag{position:absolute;bottom:3px;right:3px;padding:1px 4px;font-size:.5rem;font-weight:700;border-radius:2px;opacity:.8}
        .gm-item .gm-tag.giphy{background:#00ff99;color:#000}
        .gm-item .gm-tag.tenor{background:#5865F2;color:#fff}
        .gm-item .gm-tag.gfycat{background:#1a1a1a;color:#fff}
        .gm-status{padding:.75rem;text-align:center;font-size:.8rem;color:rgba(255,255,255,.5);border-top:1px solid rgba(255,255,255,.05)}
        .gm-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3rem;color:rgba(255,255,255,.4)}
        .gm-empty span{font-size:3rem;margin-bottom:.5rem}
        .gm-loading{grid-column:1/-1;display:flex;align-items:center;justify-content:center;padding:2rem}
        .gm-spinner{width:30px;height:30px;border:3px solid rgba(255,255,255,.1);border-top-color:#6366f1;border-radius:50%;animation:gm-spin .6s linear infinite}
        @keyframes gm-spin{to{transform:rotate(360deg)}}
        @media(max-width:600px){.gm-grid{grid-template-columns:repeat(3,1fr)}}
        @media(max-width:400px){.gm-grid{grid-template-columns:repeat(2,1fr)}}
      </style>
    `;
    document.head.insertAdjacentHTML('beforeend', css);
  }

  function attachEvents() {
    const modal = document.getElementById('gif-modal');
    const backdrop = modal.querySelector('.gm-backdrop');
    const closeBtn = document.getElementById('gif-close');
    const input = document.getElementById('gif-input');

    backdrop.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);
    
    // INSTANT search on every keystroke
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (q.length < 2) {
        if (q.length === 0) showTrending();
        return;
      }
      
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => search(q), config.debounceMs);
    });

    // Enter key = immediate search
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimeout);
        search(input.value.trim());
      }
      if (e.key === 'Escape') closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display !== 'none') closeModal();
    });
  }

  // Open modal
  function openModal(insertCallback) {
    createModal();
    onInsertCallback = insertCallback;
    const modal = document.getElementById('gif-modal');
    const input = document.getElementById('gif-input');
    
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    input.value = '';
    input.focus();
    
    // Show trending immediately
    showTrending();
  }

  function closeModal() {
    const modal = document.getElementById('gif-modal');
    if (modal) {
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }
  }

  // Show trending GIFs (preloaded)
  async function showTrending() {
    const grid = document.getElementById('gif-grid');
    const status = document.getElementById('gif-status');
    
    if (trendingCache) {
      renderGifs(trendingCache);
      status.textContent = 'Trending GIFs';
      return;
    }

    grid.innerHTML = '<div class="gm-loading"><div class="gm-spinner"></div></div>';
    
    try {
      const gifs = await fetchTrending();
      trendingCache = gifs;
      renderGifs(gifs);
      status.textContent = 'Trending GIFs';
    } catch (e) {
      grid.innerHTML = '<div class="gm-empty"><span>🔥</span><p>Type to search GIFs</p></div>';
    }
  }

  // Fetch trending from all sources
  async function fetchTrending() {
    const results = await Promise.allSettled([
      fetchGiphyTrending(),
      fetchTenorTrending(),
      fetchGfycatTrending()
    ]);

    return combineAndShuffle(results);
  }

  // Main search function
  async function search(query) {
    if (!query || query.length < 2) return;
    
    currentQuery = query;
    const grid = document.getElementById('gif-grid');
    const status = document.getElementById('gif-status');

    // Check cache first
    if (searchCache.has(query)) {
      renderGifs(searchCache.get(query));
      status.textContent = `Results for "${query}"`;
      return;
    }

    grid.innerHTML = '<div class="gm-loading"><div class="gm-spinner"></div></div>';

    try {
      // Fetch from ALL sources in parallel
      const results = await Promise.allSettled([
        searchGiphy(query),
        searchTenor(query),
        searchGfycat(query)
      ]);

      // If query changed while fetching, abort
      if (query !== currentQuery) return;

      const gifs = combineAndShuffle(results);
      
      // Cache results
      searchCache.set(query, gifs);
      if (searchCache.size > 50) {
        const firstKey = searchCache.keys().next().value;
        searchCache.delete(firstKey);
      }

      renderGifs(gifs);
      status.textContent = gifs.length > 0 ? `${gifs.length} results for "${query}"` : 'No results found';
      
    } catch (e) {
      console.error('GIF search error:', e);
      grid.innerHTML = '<div class="gm-empty"><span>😕</span><p>Search failed. Try again.</p></div>';
    }
  }

  // Combine results from all sources and shuffle for variety
  function combineAndShuffle(results) {
    const all = [];
    
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        all.push(...r.value);
      }
    });

    // Shuffle for variety (Fisher-Yates)
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }

    return all;
  }

  // Render GIF grid
  function renderGifs(gifs) {
    const grid = document.getElementById('gif-grid');
    
    if (!gifs || gifs.length === 0) {
      grid.innerHTML = '<div class="gm-empty"><span>😕</span><p>No GIFs found</p></div>';
      return;
    }

    grid.innerHTML = '';
    
    gifs.forEach(gif => {
      if (!gif.url) return;
      
      const item = document.createElement('div');
      item.className = 'gm-item';
      
      const img = document.createElement('img');
      img.className = 'loading';
      img.loading = 'lazy';
      img.alt = gif.title || 'GIF';
      
      // Use smallest preview for speed
      img.src = gif.preview || gif.url;
      img.onload = () => img.classList.remove('loading');
      
      const tag = document.createElement('span');
      tag.className = `gm-tag ${gif.source}`;
      tag.textContent = gif.source.charAt(0).toUpperCase();
      
      item.appendChild(img);
      item.appendChild(tag);
      
      // INSTANT INSERT on click - no text, just GIF
      item.addEventListener('click', () => {
        if (onInsertCallback) {
          onInsertCallback({
            url: gif.url,
            preview: gif.preview,
            source: gif.source,
            width: gif.width,
            height: gif.height
          });
        }
        closeModal();
      });
      
      grid.appendChild(item);
    });
  }

  // ===== API FUNCTIONS =====

  // GIPHY
  async function searchGiphy(query) {
    if (!config.giphyKey) return [];
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${config.giphyKey}&q=${encodeURIComponent(query)}&limit=${config.limit}&rating=pg-13&bundle=low_bandwidth`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(g => ({
      id: g.id,
      url: g.images.fixed_height.url,
      preview: g.images.fixed_height_small?.url || g.images.preview_gif?.url || g.images.fixed_height.url,
      width: parseInt(g.images.fixed_height.width),
      height: parseInt(g.images.fixed_height.height),
      title: g.title,
      source: 'giphy'
    }));
  }

  async function fetchGiphyTrending() {
    if (!config.giphyKey) return [];
    const url = `https://api.giphy.com/v1/gifs/trending?api_key=${config.giphyKey}&limit=${config.limit}&rating=pg-13&bundle=low_bandwidth`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(g => ({
      id: g.id,
      url: g.images.fixed_height.url,
      preview: g.images.fixed_height_small?.url || g.images.preview_gif?.url,
      width: parseInt(g.images.fixed_height.width),
      height: parseInt(g.images.fixed_height.height),
      title: g.title,
      source: 'giphy'
    }));
  }

  // TENOR
  async function searchTenor(query) {
    if (!config.tenorKey) return [];
    const url = `https://tenor.googleapis.com/v2/search?key=${config.tenorKey}&q=${encodeURIComponent(query)}&limit=${config.limit}&contentfilter=medium&media_filter=tinygif,gif`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(g => ({
      id: g.id,
      url: g.media_formats?.gif?.url || g.media_formats?.mediumgif?.url,
      preview: g.media_formats?.tinygif?.url || g.media_formats?.nanogif?.url,
      width: g.media_formats?.gif?.dims?.[0] || 200,
      height: g.media_formats?.gif?.dims?.[1] || 200,
      title: g.content_description,
      source: 'tenor'
    }));
  }

  async function fetchTenorTrending() {
    if (!config.tenorKey) return [];
    const url = `https://tenor.googleapis.com/v2/featured?key=${config.tenorKey}&limit=${config.limit}&contentfilter=medium&media_filter=tinygif,gif`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(g => ({
      id: g.id,
      url: g.media_formats?.gif?.url || g.media_formats?.mediumgif?.url,
      preview: g.media_formats?.tinygif?.url || g.media_formats?.nanogif?.url,
      width: g.media_formats?.gif?.dims?.[0],
      height: g.media_formats?.gif?.dims?.[1],
      title: g.content_description,
      source: 'tenor'
    }));
  }

  // GFYCAT (via Redgifs API - gfycat merged with it)
  async function searchGfycat(query) {
    // Gfycat merged with Redgifs - using search endpoint
    try {
      const url = `https://api.gfycat.com/v1/gfycats/search?search_text=${encodeURIComponent(query)}&count=${config.limit}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.gfycats || []).map(g => ({
        id: g.gfyId,
        url: g.gifUrl || g.gif100pxUrl,
        preview: g.gif100pxUrl || g.gifUrl,
        width: g.width,
        height: g.height,
        title: g.title,
        source: 'gfycat'
      }));
    } catch {
      return [];
    }
  }

  async function fetchGfycatTrending() {
    try {
      const url = `https://api.gfycat.com/v1/gfycats/trending?count=${config.limit}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.gfycats || []).map(g => ({
        id: g.gfyId,
        url: g.gifUrl || g.gif100pxUrl,
        preview: g.gif100pxUrl || g.gifUrl,
        width: g.width,
        height: g.height,
        title: g.title,
        source: 'gfycat'
      }));
    } catch {
      return [];
    }
  }

  // ===== PUBLIC API =====

  window.initGifSearch = function(options) {
    Object.assign(config, options);
    createModal();
    
    // Preload trending on init
    if (config.preloadTrending) {
      fetchTrending().then(gifs => { trendingCache = gifs; });
    }
  };

  window.openGifSearch = function(callback) {
    openModal(callback);
  };

  window.closeGifSearch = closeModal;

  // Clear cache (useful if getting stale results)
  window.clearGifCache = function() {
    searchCache.clear();
    trendingCache = null;
  };

})();
