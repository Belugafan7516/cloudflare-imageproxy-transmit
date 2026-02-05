/**
 * MASTER PROXY (The Frontend)
 * * Role: Rewrites HTML/CSS, strips Security checks, handles Downloads.
 * * UI: Retro Terminal / CRT Monitor Style.
 */

// !!! CONFIGURATION !!!
// This must be the URL of your OTHER worker (The Middleman).
const MIDDLEMAN_URL = "https://masterproxy.powerstudios.workers.dev/";

export default {
  async fetch(request, env, ctx) {
    // Dynamic: Always use the current worker's URL as the base
    const masterUrl = new URL(request.url);
    const shouldDownload = masterUrl.searchParams.has("download");

    // --- 1. URL PARSING & LANDING PAGE ---
    let targetUrlStr = masterUrl.pathname.slice(1) + masterUrl.search;
    
    // Clean up the URL string
    if (shouldDownload) {
      targetUrlStr = targetUrlStr.replace(/[?&]download(=[^&]*)?$/, "").replace(/[?&]$/, "");
    }

    // If no URL is provided, show the Retro Landing Page
    if (!targetUrlStr || targetUrlStr === "/" || targetUrlStr === "/favicon.ico") {
      return new Response(landingHtml(masterUrl.hostname), { headers: { "Content-Type": "text/html" } });
    }

    // Fix Protocol
    if (!targetUrlStr.startsWith("http")) {
      targetUrlStr = targetUrlStr.startsWith("www.") ? "https://" + targetUrlStr : "https://" + targetUrlStr;
    }

    // --- 2. FETCH FROM MIDDLEMAN ---
    const middlemanRequestUrl = `${MIDDLEMAN_URL}?q=${encodeURIComponent(targetUrlStr)}`;

    try {
      const proxyHeaders = new Headers(request.headers);
      // Clean headers
      ["Host", "cf-connecting-ip", "cf-worker", "cf-ray", "x-forwarded-for"].forEach(h => proxyHeaders.delete(h));

      const response = await fetch(middlemanRequestUrl, {
        method: request.method,
        headers: proxyHeaders,
        body: request.body
      });

      // --- 3. PREPARE FOR REWRITING ---
      let targetUrlObj;
      try { targetUrlObj = new URL(targetUrlStr); } catch (e) { targetUrlObj = new URL("https://example.com"); }

      // Clean Security Headers
      const newHeaders = new Headers(response.headers);
      [
        "Content-Security-Policy", "Content-Security-Policy-Report-Only",
        "X-Frame-Options", "X-XSS-Protection", "Strict-Transport-Security"
      ].forEach(h => newHeaders.delete(h));

      // Fix Redirects
      const location = newHeaders.get("Location");
      if (location) {
        try {
          const absLoc = new URL(location, targetUrlObj.href);
          newHeaders.set("Location", `${masterUrl.origin}/${absLoc.href}`);
        } catch(e) {}
      }

      // Fix Cookies
      const setCookie = newHeaders.get("Set-Cookie");
      if (setCookie) {
        newHeaders.set("Set-Cookie", setCookie.replace(/Domain=[^;]+($|;)/gi, ""));
      }

      // --- 4. CONTENT REWRITING ---
      const contentType = newHeaders.get("Content-Type") || "";

      // A. CSS Files
      if (contentType.includes("text/css") && !shouldDownload) {
        let css = await response.text();
        css = css.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
          if (url.startsWith("data:") || url.startsWith("#")) return match;
          try {
            const absUrl = new URL(url, targetUrlObj.href);
            return `url(${quote}${masterUrl.origin}/${absUrl.href}${quote})`;
          } catch(e) { return match; }
        });
        return new Response(css, { status: response.status, headers: newHeaders });
      }

      // B. HTML Files
      if (contentType.includes("text/html") && !shouldDownload) {
        const res = new Response(response.body, { status: response.status, headers: newHeaders });
        return new HTMLRewriter()
          .on("*", new IntegrityRemover())
          .on("a", new UrlRewriter("href", masterUrl, targetUrlObj))
          .on("form", new UrlRewriter("action", masterUrl, targetUrlObj))
          .on("img", new UrlRewriter("src", masterUrl, targetUrlObj))
          .on("img", new SrcsetRewriter(masterUrl, targetUrlObj))
          .on("link", new UrlRewriter("href", masterUrl, targetUrlObj))
          .on("script", new UrlRewriter("src", masterUrl, targetUrlObj))
          .on("iframe", new UrlRewriter("src", masterUrl, targetUrlObj))
          .on("source", new UrlRewriter("src", masterUrl, targetUrlObj))
          .on("source", new SrcsetRewriter(masterUrl, targetUrlObj))
          .on('meta[http-equiv="Content-Security-Policy"]', { element(e) { e.remove(); } })
          .transform(res);
      }

      // C. Download Handling
      if (shouldDownload) {
        let filename = "download";
        const parts = targetUrlObj.pathname.split('/');
        if (parts.length > 0 && parts[parts.length-1].includes('.')) filename = parts[parts.length-1];
        newHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);
      }

      return new Response(response.body, { status: response.status, headers: newHeaders });

    } catch (e) {
      return new Response("Master Proxy Error: " + e.message, { status: 500 });
    }
  }
};

// --- LOGIC HELPERS ---

class IntegrityRemover {
  element(e) { if (e.hasAttribute("integrity")) e.removeAttribute("integrity"); }
}

class UrlRewriter {
  constructor(attr, master, target) { this.attr = attr; this.master = master; this.target = target; }
  element(e) {
    const val = e.getAttribute(this.attr);
    if (!val || val.startsWith("data:") || val.startsWith("#") || val.startsWith("mailto:")) return;
    try {
      e.setAttribute(this.attr, `${this.master.origin}/${new URL(val, this.target.href).href}`);
    } catch(err) {}
  }
}

class SrcsetRewriter {
  constructor(master, target) { this.master = master; this.target = target; }
  element(e) {
    const val = e.getAttribute("srcset");
    if (!val) return;
    try {
      const newVal = val.split(",").map(part => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.lastIndexOf(" ");
        if (spaceIdx === -1) return `${this.master.origin}/${new URL(trimmed, this.target.href).href}`;
        const url = trimmed.substring(0, spaceIdx);
        const desc = trimmed.substring(spaceIdx);
        return `${this.master.origin}/${new URL(url, this.target.href).href}${desc}`;
      }).join(", ");
      e.setAttribute("srcset", newVal);
    } catch(err) {}
  }
}

// --- RETRO UI ---

function landingHtml(hostname) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TERMINAL PROXY</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
        
        body {
          margin: 0;
          padding: 0;
          background-color: #000;
          color: #33ff00;
          font-family: 'VT323', monospace;
          height: 100vh;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          text-shadow: 0 0 5px rgba(51, 255, 0, 0.7);
        }

        /* Scanline effect */
        body::before {
          content: " ";
          display: block;
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          right: 0;
          background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06));
          z-index: 2;
          background-size: 100% 2px, 3px 100%;
          pointer-events: none;
        }

        .crt-container {
          position: relative;
          z-index: 3;
          width: 100%;
          max-width: 700px;
          padding: 20px;
          border: 1px solid #33ff00;
          box-shadow: 0 0 20px rgba(51, 255, 0, 0.2);
          background: rgba(0, 20, 0, 0.8);
        }

        h1 {
          font-size: 40px;
          margin: 0 0 20px 0;
          letter-spacing: 2px;
          border-bottom: 2px dashed #33ff00;
          padding-bottom: 10px;
        }

        .status {
          margin-bottom: 30px;
          font-size: 18px;
        }

        .input-group {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }

        .prompt {
          font-size: 20px;
        }

        input[type="text"] {
          background: #001100;
          border: 2px solid #33ff00;
          color: #33ff00;
          font-family: 'VT323', monospace;
          font-size: 24px;
          padding: 10px;
          outline: none;
          width: 95%;
          box-shadow: 0 0 10px rgba(51, 255, 0, 0.1);
        }

        input[type="text"]:focus {
          background: #002200;
          box-shadow: 0 0 15px rgba(51, 255, 0, 0.4);
        }

        button {
          background: #33ff00;
          color: #000;
          border: none;
          font-family: 'VT323', monospace;
          font-size: 24px;
          padding: 10px 30px;
          cursor: pointer;
          font-weight: bold;
          margin-top: 10px;
          text-transform: uppercase;
        }

        button:hover {
          background: #000;
          color: #33ff00;
          border: 2px solid #33ff00;
        }

        .checkbox-container {
          margin-top: 15px;
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 20px;
        }

        input[type="checkbox"] {
          appearance: none;
          width: 20px;
          height: 20px;
          border: 2px solid #33ff00;
          background: #000;
          cursor: pointer;
          position: relative;
        }

        input[type="checkbox"]:checked {
          background: #33ff00;
        }
        
        /* Blinking cursor animation */
        .cursor {
          display: inline-block;
          width: 10px;
          height: 20px;
          background: #33ff00;
          animation: blink 1s infinite;
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      </style>
    </head>
    <body>
      <div class="crt-container">
        <h1>MASTER_PROXY_SYSTEM v2.0</h1>
        <div class="status">
          > CONNECTED TO: ${hostname}<br>
          > PROTOCOL: SECURE<br>
          > STATUS: <span style="color: #33ff00; text-decoration: blink;">ONLINE</span>
        </div>

        <form onsubmit="const u=document.getElementById('url').value; const d=document.getElementById('dl').checked; window.location.href='/'+u+(d?'?download=true':''); return false;">
          <div class="input-group">
            <div class="prompt">ENTER_TARGET_URL: <span class="cursor"></span></div>
            <input type="text" id="url" placeholder="https://example.com" autocomplete="off" autofocus>
            
            <div class="checkbox-container">
              <input type="checkbox" id="dl">
              <label for="dl">[FORCE_DOWNLOAD_MODE]</label>
            </div>
            
            <button type="submit">EXECUTE >></button>
          </div>
        </form>
      </div>
    </body>
    </html>
  `;
}


