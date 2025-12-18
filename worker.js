export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Replace with your actual deployed master-proxy URL
    const MASTER_PROXY_URL = env.MASTER_URL || "https://master-proxy.yourname.workers.dev";

    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('Transmitter: Missing ?url', { status: 400 });
    }

    // Forward the exact search params to the master proxy
    const masterTarget = new URL(MASTER_PROXY_URL);
    masterTarget.search = url.search;

    try {
      const response = await fetch(masterTarget.toString(), {
        method: request.method,
        headers: request.headers,
        redirect: 'follow'
      });

      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('X-Proxy-Chain', 'Transmitter-to-Master');
      
      return newResponse;
    } catch (err) {
      return new Response(`Transmitter failed to connect to Master: ${err.message}`, { status: 502 });
    }
  }
};

