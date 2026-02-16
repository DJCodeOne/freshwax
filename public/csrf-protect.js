// csrf-protect.js
// Global fetch interceptor for CSRF double-submit cookie pattern.
// Automatically adds X-CSRF-Token header to all same-origin state-changing requests.
// Must be loaded BEFORE any fetch() calls on the page.
(function() {
  var originalFetch = window.fetch;
  window.fetch = function(input, init) {
    init = init || {};
    var method = (init.method || 'GET').toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
      var isSameOrigin = !url || url.startsWith('/') || url.startsWith(location.origin);
      if (isSameOrigin) {
        var meta = document.querySelector('meta[name="csrf-token"]');
        var token = meta ? meta.getAttribute('content') : '';
        if (token) {
          if (init.headers instanceof Headers) {
            if (!init.headers.has('X-CSRF-Token')) init.headers.set('X-CSRF-Token', token);
          } else if (Array.isArray(init.headers)) {
            var hasIt = init.headers.some(function(h) { return h[0].toLowerCase() === 'x-csrf-token'; });
            if (!hasIt) init.headers.push(['X-CSRF-Token', token]);
          } else {
            init.headers = Object.assign({}, init.headers || {});
            if (!init.headers['X-CSRF-Token']) init.headers['X-CSRF-Token'] = token;
          }
        }
      }
    }
    return originalFetch.call(this, input, init);
  };
})();
