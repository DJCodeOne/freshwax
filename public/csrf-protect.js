// csrf-protect.js
// Global fetch interceptor for CSRF double-submit cookie pattern.
// Automatically adds X-CSRF-Token header to all same-origin state-changing requests.
// Also strips "Authorization: Bearer null/undefined" so the server falls through
// to __session cookie auth (used when Firebase Auth client-side persistence fails
// and currentUser.getIdToken() returns null).
// Must be loaded BEFORE any fetch() calls on the page.
(function() {
  var originalFetch = window.fetch;

  function isInvalidBearer(value) {
    if (!value) return true;
    var lower = String(value).toLowerCase().trim();
    return lower === 'bearer null' || lower === 'bearer undefined' || lower === 'bearer ';
  }

  function stripInvalidAuth(headers) {
    if (!headers) return headers;
    if (headers instanceof Headers) {
      if (isInvalidBearer(headers.get('Authorization'))) headers.delete('Authorization');
      return headers;
    }
    if (Array.isArray(headers)) {
      return headers.filter(function(h) {
        return !(h[0].toLowerCase() === 'authorization' && isInvalidBearer(h[1]));
      });
    }
    var out = {};
    for (var k in headers) {
      if (k.toLowerCase() === 'authorization' && isInvalidBearer(headers[k])) continue;
      out[k] = headers[k];
    }
    return out;
  }

  window.fetch = function(input, init) {
    init = init || {};
    init.headers = stripInvalidAuth(init.headers);
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
