export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CONFIGURATION: Replace this with the actual URL of your Master Proxy worker
    const MASTER_PROXY_HOST = 'your-master-proxy.workers.dev';

    // 1. Validate that we have a target URL before bothering the Master
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing ?url parameter in Transmitter', { status: 400 });
    }

    // 2. Construct the URL for the Master Proxy
    // We keep the pathname and search params (url, format, filename, download) intact
    const masterUrl = new URL(request.url);
    masterUrl.host = MASTER_PROXY_HOST;
    masterUrl.protocol = 'https:';

    try {
      // 3. Forward the request to the Master Proxy
      // We pass the original headers (optional, but good for passing User-Agent if needed)
      const masterResponse = await fetch(masterUrl.toString(), {
        method: request.method,
        headers: request.headers,
        redirect: 'follow'
      });

      // 4. Create a new response to send back to the user
      // We stream the body directly from the Master to save memory
      const response = new Response(masterResponse.body, masterResponse);

      // Ensure CORS is set on the final leg (in case Master headers get stripped by intermediate hops)
      response.headers.set('Access-Control-Allow-Origin', '*');

      return response;

    } catch (err) {
      return new Response(`Transmitter Error: ${err.message}`, { status: 502 });
    }
  }
};

