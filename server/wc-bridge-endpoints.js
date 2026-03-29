
  // ── WC Relay Bridge ────────────────────────────────────────────────────────
  // Proxies WalletConnect relay WebSocket messages via HTTP polling.
  // Chrome MV3 service workers can't receive WebSocket push notifications.
  if (url.pathname.startsWith("/wc-bridge")) {
    const origin = req.headers.origin || "";
    const isExtOrigin = /^chrome-extension:\/\/[a-z]{32}$/.test(origin);
    const bridgeCors = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-AlgoVoi-Key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (isExtOrigin) bridgeCors["Access-Control-Allow-Origin"] = origin;

    if (req.method === "OPTIONS") {
      res.writeHead(204, bridgeCors);
      res.end();
      return;
    }

    // Auth check
    const apiKey = req.headers["x-algovoi-key"] || "";
    const ALGOVOI_API_KEY = process.env.ALGOVOI_API_KEY || "55318ce48a353fe5d9a01bd85c4c4c52dd73d2197512f42c1ad41b443de4ca85";
    if (apiKey !== ALGOVOI_API_KEY) {
      res.writeHead(401, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    // POST /wc-bridge/listen — start listening on a relay topic
    if (url.pathname === "/wc-bridge/listen" && req.method === "POST") {
      let body;
      try { body = await parseBody(req); } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const { topic, wsUrl } = body;
      // XXIII-1: validate topic is a 64-char hex string (WC topic format)
      if (!topic || !/^[a-f0-9]{64}$/.test(topic)) {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid topic format" }));
        return;
      }
      // XXIII-2: wsUrl must be wss:// to relay.walletconnect.org (prevent SSRF)
      if (!wsUrl || !/^wss:\/\/relay\.walletconnect\.(org|com)\//.test(wsUrl)) {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid relay URL" }));
        return;
      }
      await startListener(topic, wsUrl);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /wc-bridge/:topic — poll for messages
    const topicMatch = url.pathname.match(/^\/wc-bridge\/([a-f0-9]{64})$/);
    if (topicMatch && req.method === "GET") {
      const topic = topicMatch[1];
      const messages = getMessages(topic);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ messages }));
      return;
    }

    // POST /wc-bridge/:topic — agent pushes a message directly (bypasses relay)
    if (topicMatch && req.method === "POST") {
      const topic = topicMatch[1];
      let body;
      try { body = await parseBody(req); } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      // XXIII-3: validate message exists and isn't oversized
      if (!body.message || typeof body.message !== "string" || body.message.length > 10000) {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Missing or oversized message" }));
        return;
      }
      pushMessage(topic, {
        topic,
        message: body.message,
        publishedAt: body.publishedAt || Date.now(),
      });
      console.log(`[wc-bridge] Direct push for ${topic.slice(0,8)} (${body.message.length} chars)`);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /wc-bridge/stop — stop listening
    if (url.pathname === "/wc-bridge/stop" && req.method === "POST") {
      let body;
      try { body = await parseBody(req); } catch { body = {}; }
      if (body.topic) stopListener(body.topic);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json", ...bridgeCors });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }

