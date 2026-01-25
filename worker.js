/**
 * MASTER PROXY (The Frontend)
 * * Role: User Interface, HTML Rewriting, AND CSS Rewriting
 */

// !!! IMPORTANT: Put your Middleman Worker URL here !!!
const MIDDLEMAN_URL = "https://masterproxy.powerstudios.workers.dev/";

export default {
  async fetch(request, env, ctx) {
    const masterUrl = new URL(request.url);
    const shouldDownload = masterUrl.searchParams.has("download");
    
    // 1. Extract Target URL
    let targetUrlStr = masterUrl.pathname.slice(1) + masterUrl.search;
    if (shouldDownload) {
      targetUrlStr = targetUrlStr.replace(/[?&]download(=[^&]*)?$/, "");
      if (targetUrlStr.endsWith("?") || targetUrlStr.endsWith("&")) targetUrlStr = targetUrlStr.slice(0, -1);
    }

    // Landing Page
    if (!targetUrlStr || targetUrlStr === "/" || targetUrlStr === "/favicon.ico") {
      return new Response(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
          <h1>Master Proxy</h1>
          <form onsubmit="
            const url = document.getElementById('url').value;
            const isDownload = document.getElementById('download').checked;
            window.location.href = '/' + url + (isDownload ? '?download=true' : '');
            return false;
          ">
            <input type="text" id="url" placeholder="https://example.com" style="padding: 10px; width: 300px;">
            <button style="padding: 10px; cursor: pointer;">Go</button>
            <div style="margin-top: 15px;">
              <label><input type="checkbox" id="download"> Force Download</label>
            </div>
          </form>
        </div>
      `, { headers: { "Content-Type": "text/html" } });
    }

    // Fix Protocol
    let finalTarget = targetUrlStr;
    if (!finalTarget.startsWith("http")) {
      finalTarget = finalTarget.startsWith("www.") ? "https://" + finalTarget : "https://" + finalTarget;
    }

    // 2. Request to Middleman
    const middlemanRequestUrl = `${MIDDLEMAN_URL}?q=${encodeURIComponent(finalTarget)}`;

    try {
      const proxyHeaders = new Headers(request.headers);
      
      // Clean headers before sending to Middleman
      ["cf-connecting-ip", "cf-worker", "x-forwarded-for"].forEach(h => proxyHeaders.delete(h));

      const response = await fetch(middlemanRequestUrl, {
        method: request.method,
        headers: proxyHeaders, 
        body: request.body
      });

      let targetUrlObj;
      try { targetUrlObj = new URL(finalTarget); } catch (e) { targetUrlObj = new URL("https://example.com"); }

      // 3. Clean Response Headers (Security & Cookies)
      const newResponseHeaders = new Headers(response.headers);
      ["Content-Security-Policy", "X-Frame-Options", "X-XSS-Protection"].forEach(h => newResponseHeaders.delete(h));

      const setCookie = newResponseHeaders.get("Set-Cookie");
      if (setCookie) {
        newResponseHeaders.set("Set-Cookie", setCookie.replace(/Domain=[^;]+;/gi, ""));
      }

      // Handle Redirects (Location Header)
      const location = newResponseHeaders.get("Location");
      if (location) {
        try {
          // If the redirect is relative or absolute, we must wrap it in the proxy
          const absLoc = new URL(location, targetUrlObj.href);
          newResponseHeaders.set("Location", `${masterUrl.origin}/${absLoc.href}`);
        } catch(e) {}
      }

      // 4. Content Handling
      const contentType = newResponseHeaders.get("Content-Type") || "";

      // A. CSS REWRITING (Fixes "CSS does not render properly")
      // We must regex replace url(...) inside css files
      if (contentType.includes("text/css") && !shouldDownload) {
        let cssText = await response.text();
        
        // Regex to find url('...') or url("...") or url(...)
        // We replace it with the proxy version
        cssText = cssText.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
          if (url.startsWith("data:") || url.startsWith("#")) return match;
          try {
            const absUrl = new URL(url, targetUrlObj.href);
            return `url(${quote}${masterUrl.origin}/${absUrl.href}${quote})`;
          } catch (e) {
            return match;
          }
        });

        return new Response(cssText, {
          status: response.status,
          headers: newResponseHeaders
        });
      }

      // B. HTML REWRITING
      if (contentType.includes("text/html") && !shouldDownload) {
        const cleanResponse = new Response(response.body, {
            status: response.status,
            headers: newResponseHeaders
        });

        return new HTMLRewriter()
          .on("a", new AttributeRewriter("href", masterUrl, targetUrlObj))
          .on("form", new AttributeRewriter("action", masterUrl, targetUrlObj))
          .on("img", new AttributeRewriter("src", masterUrl, targetUrlObj))
          .on("img", new AttributeRewriter("srcset", masterUrl, targetUrlObj))
          .on("img", new AttributeRewriter("data-src", masterUrl, targetUrlObj))
          .on("link", new AttributeRewriter("href", masterUrl, targetUrlObj)) // CSS Links
          .on("script", new AttributeRewriter("src", masterUrl, targetUrlObj))
          .on("iframe", new AttributeRewriter("src", masterUrl, targetUrlObj))
          .on("source", new AttributeRewriter("src", masterUrl, targetUrlObj))
          .transform(cleanResponse);
      }

      // C. DEFAULT / DOWNLOAD
      if (shouldDownload) {
          let filename = "download";
          const pathSegments = targetUrlObj.pathname.split('/');
          const lastSegment = pathSegments[pathSegments.length - 1];
          if (lastSegment && lastSegment.includes('.')) filename = lastSegment;
          newResponseHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
      }

      return new Response(response.body, {
        status: response.status,
        headers: newResponseHeaders
      });

    } catch (e) {
      return new Response("Master Proxy Error: " + e.message, { status: 500 });
    }
  }
};

class AttributeRewriter {
  constructor(attributeName, masterUrl, targetUrlObj) {
    this.attributeName = attributeName;
    this.masterUrl = masterUrl;
    this.targetUrlObj = targetUrlObj;
  }
  element(element) {
    const value = element.getAttribute(this.attributeName);
    if (!value) return;

    if (this.attributeName === "srcset") {
      // Simple srcset rewriter
      const newSrcset = value.split(",").map(entry => {
          const parts = entry.trim().split(" ");
          const url = parts[0];
          try {
             const absUrl = new URL(url, this.targetUrlObj.href);
             parts[0] = `${this.masterUrl.origin}/${absUrl.href}`;
             return parts.join(" ");
          } catch(e) { return entry; }
      }).join(", ");
      element.setAttribute(this.attributeName, newSrcset);
      return;
    }

    if (value.startsWith("data:") || value.startsWith("mailto:") || value.startsWith("#")) return;
    try {
      const absoluteUrl = new URL(value, this.targetUrlObj.href);
      element.setAttribute(this.attributeName, `${this.masterUrl.origin}/${absoluteUrl.href}`);
    } catch (e) {}
  }
}


