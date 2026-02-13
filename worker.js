/**
 * UNIFIED PROXY v9.0 (All-in-One)
 * * Role: Acts as BOTH Frontend (UI) and Backend (Fetcher).
 * * Usage: Deploy this single file. No configuration needed.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =================================================================================
    // SECTION A: BACKEND LOGIC (The Fetcher)
    // This runs if the request is trying to fetch data (has /__fetch path)
    // =================================================================================
    if (url.pathname === "/__fetch") {
      // Handle CORS Preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
          }
        });
      }

      const targetUrlStr = url.searchParams.get("q");
      if (!targetUrlStr) return new Response("No target", { status: 400 });

      let targetUrl;
      try { targetUrl = new URL(targetUrlStr); } catch (e) { return new Response("Invalid URL", { status: 400 }); }

      // Prepare Headers
      const newHeaders = new Headers(request.headers);
      newHeaders.delete("Host");
      newHeaders.set("Host", targetUrl.hostname);
      newHeaders.set("Referer", targetUrl.origin + "/");
      newHeaders.set("Origin", targetUrl.origin);
      ["cf-connecting-ip", "cf-worker", "cf-ray", "cf-visitor", "x-forwarded-for"].forEach(h => newHeaders.delete(h));

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: newHeaders,
          body: request.body,
          redirect: "manual"
        });

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Expose-Headers", "*");
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }

    // =================================================================================
    // SECTION B: FRONTEND LOGIC (The Interface)
    // This runs for normal user browsing
    // =================================================================================
    
    try {
      const shouldDownload = url.searchParams.has("download");
      let targetUrlStr = url.pathname.slice(1) + url.search;

      if (shouldDownload) {
        targetUrlStr = targetUrlStr.replace(/[?&]download(=[^&]*)?$/, "").replace(/[?&]$/, "");
      }

      // --- ORPHAN RECOVERY & SEARCH ---
      if (!targetUrlStr.startsWith("http")) {
        // Landing Page
        if (targetUrlStr === "" || targetUrlStr === "/") {
             return new Response(landingHtml(url.hostname), { headers: { "Content-Type": "text/html" } });
        }

        // Cookie Recovery
        const cookie = request.headers.get("Cookie") || "";
        const match = cookie.match(/__proxy_base=([^;]+)/);
        let recovered = false;
        
        if (match && match[1]) {
            try {
                const base = decodeURIComponent(match[1]);
                const parentUrl = new URL(base);
                const fixedUrl = new URL(targetUrlStr, parentUrl.href).href;
                return Response.redirect(`${url.origin}/${fixedUrl}`, 307);
            } catch(e) {}
        }

        // Fallback Search
        if (!targetUrlStr.includes("/") && !targetUrlStr.includes(".")) {
             targetUrlStr = "https://www.bing.com/search?q=" + encodeURIComponent(targetUrlStr);
        } else if (!targetUrlStr.startsWith("http")) {
             targetUrlStr = "https://" + targetUrlStr;
        }
      }

      // --- SELF-CALL TO BACKEND ---
      // We calculate our own backend URL dynamically
      const backendUrl = `${url.origin}/__fetch?q=${encodeURIComponent(targetUrlStr)}`;

      const proxyHeaders = new Headers(request.headers);
      ["Host", "cf-connecting-ip", "cf-worker", "x-forwarded-for", "Referer", "Origin"].forEach(h => proxyHeaders.delete(h));

      const response = await fetch(backendUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: request.body
      });

      // --- REWRITING ---
      let targetUrlObj;
      try { targetUrlObj = new URL(targetUrlStr); } catch (e) { targetUrlObj = new URL("https://example.com"); }

      const newHeaders = new Headers(response.headers);
      [
        "Content-Security-Policy", "Content-Security-Policy-Report-Only",
        "X-Frame-Options", "X-XSS-Protection", "Strict-Transport-Security"
      ].forEach(h => newHeaders.delete(h));

      newHeaders.append("Set-Cookie", `__proxy_base=${encodeURIComponent(targetUrlObj.href)}; Path=/; Secure; SameSite=None`);

      const location = newHeaders.get("Location");
      if (location) {
        try {
          const absLoc = new URL(location, targetUrlObj.href);
          newHeaders.set("Location", `${url.origin}/${absLoc.href}`);
        } catch(e) {}
      }

      const setCookie = newHeaders.get("Set-Cookie");
      if (setCookie) {
        newHeaders.set("Set-Cookie", setCookie.replace(/Domain=[^;]+($|;)/gi, ""));
      }

      const contentType = newHeaders.get("Content-Type") || "";

      // HTML Handling
      if (contentType.includes("text/html") && !shouldDownload) {
        const res = new Response(response.body, { status: response.status, headers: newHeaders });
        
        return new HTMLRewriter()
          .on("*", new IntegrityRemover())
          .on("head", new HeadInjector(url.origin, targetUrlObj.origin)) 
          .on("a", new UrlRewriter("href", url, targetUrlObj))
          .on("form", new UrlRewriter("action", url, targetUrlObj))
          .on("img", new UrlRewriter("src", url, targetUrlObj))
          .on("img", new SrcsetRewriter(url, targetUrlObj))
          .on("link", new UrlRewriter("href", url, targetUrlObj))
          .on("script", new UrlRewriter("src", url, targetUrlObj))
          .on("iframe", new UrlRewriter("src", url, targetUrlObj))
          .on("source", new UrlRewriter("src", url, targetUrlObj))
          .on("iframe", new AttributeRemover("sandbox"))
          .on('meta[http-equiv="Content-Security-Policy"]', { element(e) { e.remove(); } })
          .transform(res);
      }

      // CSS Handling
      if (contentType.includes("text/css") && !shouldDownload) {
        let css = await response.text();
        css = css.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, urlVal) => {
          if (urlVal.startsWith("data:") || urlVal.startsWith("#")) return match;
          try {
            const absUrl = new URL(urlVal, targetUrlObj.href);
            return `url(${quote}${url.origin}/${absUrl.href}${quote})`;
          } catch(e) { return match; }
        });
        return new Response(css, { status: response.status, headers: newHeaders });
      }

      if (shouldDownload) {
        let filename = "download";
        const parts = targetUrlObj.pathname.split('/');
        if (parts.length > 0 && parts[parts.length-1].includes('.')) filename = parts[parts.length-1];
        newHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
      }

      return new Response(response.body, { status: response.status, headers: newHeaders });

    } catch (e) {
      return new Response(errorHtml(e), { status: 500, headers: { "Content-Type": "text/html" } });
    }
  }
};

// --- CLASSES & HELPERS ---
// Same classes as before, just ensuring they use the passed-in URL logic correctly

class HeadInjector {
    constructor(proxyOrigin, targetOrigin) { 
        this.proxyOrigin = proxyOrigin; 
        this.targetOrigin = targetOrigin;
    }
    element(e) {
        e.prepend(`
        <script>
        (function() {
            const proxyOrigin = "${this.proxyOrigin}";
            const targetOrigin = "${this.targetOrigin}";
            function rewriteUrl(url) {
                if (!url || typeof url !== 'string') return url;
                if (url.startsWith(proxyOrigin)) return url; 
                if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
                if (url.startsWith('http')) return proxyOrigin + '/' + url;
                if (url.startsWith('//')) return proxyOrigin + '/https:' + url;
                if (url.startsWith('/')) {
                     const cleanTarget = targetOrigin.replace(/\\/$/, '');
                     return proxyOrigin + '/' + cleanTarget + url;
                }
                return url; 
            }
            document.addEventListener('click', function(e) {
                const anchor = e.target.closest('a');
                if (anchor && anchor.href) {
                    const originalUrl = anchor.getAttribute('href'); 
                    if (originalUrl && originalUrl.startsWith('http') && !originalUrl.startsWith(proxyOrigin)) {
                        e.preventDefault();
                        window.location.href = rewriteUrl(anchor.href);
                    }
                }
            }, true);
            document.addEventListener('submit', function(e) {
                const form = e.target;
                const action = form.getAttribute('action');
                if (action && !action.startsWith(proxyOrigin) && action.startsWith('http')) {
                     e.preventDefault();
                     form.setAttribute('action', rewriteUrl(action));
                     form.submit();
                }
            }, true);
            const originalFetch = window.fetch;
            window.fetch = function(input, init) {
                if (typeof input === 'string') input = rewriteUrl(input);
                else if (input instanceof Request && input.url) input = new Request(rewriteUrl(input.url), input);
                return originalFetch(input, init);
            };
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                return originalOpen.call(this, method, rewriteUrl(url), ...args);
            };
            const originalPushState = history.pushState;
            history.pushState = function(state, title, url) {
                if (url) url = rewriteUrl(url);
                return originalPushState.call(this, state, title, url);
            };
            const originalReplaceState = history.replaceState;
            history.replaceState = function(state, title, url) {
                if (url) url = rewriteUrl(url);
                return originalReplaceState.call(this, state, title, url);
            };
        })();
        </script>
        `, { html: true });
    }
}

class IntegrityRemover { element(e) { e.removeAttribute("integrity"); } }
class AttributeRemover { constructor(attr) { this.attr = attr; } element(e) { e.removeAttribute(this.attr); } }

class UrlRewriter {
  constructor(attr, masterUrl, targetUrlObj) { this.attr = attr; this.masterOrigin = masterUrl.origin; this.targetHref = targetUrlObj.href; }
  element(e) {
    const val = e.getAttribute(this.attr);
    if (!val || val.startsWith("data:") || val.startsWith("#") || val.startsWith("mailto:") || val.startsWith("javascript:")) return;
    try {
      e.setAttribute(this.attr, `${this.masterOrigin}/${new URL(val, this.targetHref).href}`);
    } catch(err) {}
  }
}

class SrcsetRewriter {
  constructor(masterUrl, targetUrlObj) { this.masterOrigin = masterUrl.origin; this.targetHref = targetUrlObj.href; }
  element(e) {
    const val = e.getAttribute("srcset");
    if (!val) return;
    try {
      const newVal = val.split(",").map(part => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.lastIndexOf(" ");
        if (spaceIdx === -1) return `${this.masterOrigin}/${new URL(trimmed, this.targetHref).href}`;
        const url = trimmed.substring(0, spaceIdx);
        const desc = trimmed.substring(spaceIdx);
        return `${this.masterOrigin}/${new URL(url, this.targetHref).href}${desc}`;
      }).join(", ");
      e.setAttribute("srcset", newVal);
    } catch(err) {}
  }
}

function errorHtml(e) {
  return `<html><body style="background:#000;color:red;font-family:monospace;padding:50px;"><h1>CRITICAL ERROR</h1><pre>${e.message}\n${e.stack}</pre><button onclick="window.location.href='/'">REBOOT</button></body></html>`;
}

function landingHtml(hostname) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TERMINAL PROXY</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
        body { margin: 0; padding: 0; background-color: #000; color: #33ff00; font-family: 'VT323', monospace; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        .crt-container { width: 100%; max-width: 700px; padding: 20px; border: 1px solid #33ff00; background: rgba(0, 20, 0, 0.8); }
        h1 { font-size: 40px; border-bottom: 2px dashed #33ff00; padding-bottom: 10px; }
        input[type="text"] { background: #001100; border: 2px solid #33ff00; color: #33ff00; font-family: 'VT323', monospace; font-size: 24px; padding: 10px; width: 95%; }
        button { background: #33ff00; color: #000; border: none; font-family: 'VT323', monospace; font-size: 24px; padding: 10px 30px; cursor: pointer; margin-top: 10px; }
      </style>
      <script>
        function go() {
            var u = document.getElementById('url').value.trim();
            var d = document.getElementById('dl').checked;
            if (u.indexOf('.') === -1 || u.indexOf(' ') !== -1) {
                u = 'https://www.bing.com/search?q=' + encodeURIComponent(u); 
            } else {
                if (!u.startsWith('http')) u = 'https://' + u;
            }
            window.location.href = '/' + u + (d ? '?download=true' : '');
            return false;
        }
      </script>
    </head>
    <body>
      <div class="crt-container">
        <h1>UNIFIED PROXY v9.0</h1>
        <form onsubmit="return go();">
           <div>ENTER_TARGET:</div>
           <input type="text" id="url" placeholder="google.com OR cats" autofocus>
           <div><input type="checkbox" id="dl"><label for="dl">FORCE_DOWNLOAD</label></div>
           <button type="submit">EXECUTE >></button>
        </form>
      </div>
    </body>
    </html>
  `;
}

