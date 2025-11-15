// nodes/amazon-echo-device.js
// Amazon Echo Device (HA Entities) — Filters (Area/Label/Domain) + Device/Entity support
const WebSocket = require("ws");

module.exports = function (RED) {

  //
  // ───────────────────────────────────────────────
  // DEVICE NODE RUNTIME
  // ───────────────────────────────────────────────
  //
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name       = config.name || "";
    node.haAreaId   = config.haAreaId   || "";
    node.haLabelId  = config.haLabelId  || "";
    node.haDomain   = config.haDomain   || "";
    node.haDeviceId = config.haDeviceId || "";
    node.haEntityId = config.haEntityId || "";
    node.deviceid   = node.deviceid || config.deviceid || null;

    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || (() => {});

      try {
        const nodeDeviceId = node.deviceid || node.id;

        // Matching hub → device channel
        if (msg && msg.deviceid && msg.deviceid === nodeDeviceId) {
          if (typeof msg.payload !== "object") {
            msg.payload = { value: msg.payload };
          }

          // Attach HA entity info
          msg.payload.haDeviceId = node.haDeviceId || "";
          msg.payload.haEntityId = node.haEntityId || "";

          _send(msg);
          return _done();
        }

        _send(msg);
        _done();

      } catch (err) {
        node.error(err, msg);
        _done(err);
      }
    });

    node.on("close", done => done());
  }

  RED.nodes.registerType(
    "amazon-echo-device-ha-entities",
    AmazonEchoDeviceNode
  );

  //
  // ───────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────
  //
  function resolveHaServer(RED, serverId) {
    let inst = null;

    if (serverId) {
      inst = RED.nodes.getNode(serverId) || null;
      const { wsUrl, token } = getHaUrlAndToken(RED, inst, serverId);
      if (wsUrl && token) return inst;
    }

    const configs = [];
    if (RED.nodes.eachNode) RED.nodes.eachNode(n => configs.push(n));
    const serverCfgs = configs.filter(n => n.type === "server");

    for (const cfg of serverCfgs) {
      const inst2 = RED.nodes.getNode(cfg.id);
      const { wsUrl, token } = getHaUrlAndToken(RED, inst2, cfg.id);
      if (wsUrl && token) return inst2;
    }

    return null;
  }

  function getHaUrlAndToken(RED, haServer, serverId) {
    if (!haServer) return { wsUrl: null, token: null, baseUrl: null };

    const addon =
      process.env.SUPERVISOR_TOKEN ||
      haServer?.config?.addon ||
      haServer?.addon ||
      haServer?.useAddon;

    if (addon && process.env.SUPERVISOR_TOKEN) {
      return {
        baseUrl: "http://supervisor/core",
        wsUrl:   "ws://supervisor/core/websocket",
        token:   process.env.SUPERVISOR_TOKEN
      };
    }

    const baseUrl =
      (haServer.getUrl && haServer.getUrl()) ||
      haServer?.url ||
      haServer?.config?.url ||
      haServer?.client?.websocketUrl ||
      haServer?.client?.baseUrl ||
      null;

    const creds     = serverId ? RED.nodes.getCredentials(serverId) : null;
    const nodeCreds = haServer.credentials || null;

    const token =
      creds?.access_token ||
      creds?.token ||
      nodeCreds?.access_token ||
      nodeCreds?.token ||
      haServer?.client?.auth?.access_token ||
      haServer?.client?.token ||
      haServer?.connection?.options?.access_token ||
      null;

    let wsUrl = null;
    if (baseUrl) {
      wsUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      if (!/\/api\/websocket$/.test(wsUrl)) {
        wsUrl = wsUrl.replace(/\/+$/, "") + "/api/websocket";
      }
    }

    return { baseUrl, wsUrl, token };
  }

  function wsCall(wsUrl, token, msg) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let next = 1;

      ws.on("open", () => {
        ws.once("message", raw1 => {
          let hello;
          try { hello = JSON.parse(raw1); } catch (e) { return reject(e); }
          if (hello.type !== "auth_required") return reject("Bad hello");

          ws.send(JSON.stringify({ type:"auth", access_token: token }));

          ws.once("message", raw2 => {
            let auth;
            try { auth = JSON.parse(raw2); } catch (e) { return reject(e); }
            if (auth.type !== "auth_ok") return reject("Auth failed");

            const id = next++;
            ws.send(JSON.stringify({ ...msg, id }));

            ws.on("message", raw3 => {
              let r;
              try { r = JSON.parse(raw3); } catch { return; }
              if (r.id === id) {
                ws.close();
                if (r.success === false) return reject(r.error?.message || "HA error");
                return resolve(r.result || []);
              }
            });
          });
        });
      });

      ws.on("error", reject);
    });
  }

  //
  // ───────────────────────────────────────────────
  // ADMIN ENDPOINTS
  // ───────────────────────────────────────────────
  //

  //
  // NEW: Resolve Hub → serverId for Device editor
  //
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/hub_server",
    RED.auth.needsPermission("flows.read"),
    (req, res) => {
      try {
        const hubs = [];
        if (RED.nodes.eachNode) {
          RED.nodes.eachNode(n => {
            if (n.type === "amazon-echo-hub-ha-entities") hubs.push(n);
          });
        }

        if (!hubs.length) {
          return res.status(404).send("No Hub nodes found");
        }

        res.json({
          hubId: hubs[0].id,
          haServer: hubs[0].haServer
        });

      } catch (e) {
        res.status(500).send(e.message);
      }
    }
  );

  //
  // FILTERS — areas, labels, unfiltered domains
  //
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/filters",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {

      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("HA server not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!token || !wsUrl) return res.status(400).send("HA token/ws missing");

        const [areas, labels, devices, entities] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/area_registry/list" }),
          wsCall(wsUrl, token, { type: "config/label_registry/list" }).catch(() => []),
          wsCall(wsUrl, token, { type: "config/device_registry/list" }),
          wsCall(wsUrl, token, { type: "config/entity_registry/list" })
        ]);

        // Only count domains from entities
        const domainCounts = {};
        (entities || []).forEach(e => {
          if (!e || !e.entity_id) return;
          const dom = e.entity_id.split(".")[0];
          if (!dom) return;
          domainCounts[dom] = (domainCounts[dom] || 0) + 1;
        });

        res.json({
          total_devices: (devices || []).length,
          areas:  (areas  || []).map(a => ({ area_id:a.area_id, name:a.name || a.area_id })),
          labels: (labels || []).map(l => ({ label_id:l.label_id, name:l.name || l.label_id })),
          domains: Object.keys(domainCounts).sort().map(d => ({
            domain: d,
            count:  domainCounts[d]
          }))
        });

      } catch (e) {
        res.status(500).send(e.message);
      }
    }
  );

  //
  // DOMAINS — (device based) + virtual devices
  //
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/domains",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {

      try {
        const { server } = req.query;
        const haServer = resolveHaServer(RED, server);
        if (!haServer) return res.status(400).send("HA server not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, server);
        if (!token) return res.status(400).send("Missing token");

        const areaId  = (req.query.area  || "").trim();
        const labelId = (req.query.label || "").trim();

        const [entities, devices] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/entity_registry/list" }),
          wsCall(wsUrl, token, { type: "config/device_registry/list" })
        ]);

        const entsByDevice = new Map();
        (entities || []).forEach(e => {
          if (!e.device_id) return;
          if (!entsByDevice.has(e.device_id)) entsByDevice.set(e.device_id, []);
          entsByDevice.get(e.device_id).push(e);
        });

        //
        // STEP 1 — filter real hardware devices
        //
        const matchingDevices = (devices || []).filter(d => {
          const ents = entsByDevice.get(d.id) || [];

          if (areaId) {
            const areaMatch = d.area_id === areaId ||
              ents.some(e => e.area_id === areaId);
            if (!areaMatch) return false;
          }

          if (labelId) {
            const lblMatch = ents.some(e =>
              Array.isArray(e.labels) && e.labels.includes(labelId)
            );
            if (!lblMatch) return false;
          }

          return true;
        });

        //
        // STEP 2 — include GROUP ENTITIES as virtual devices
        //
        const virtualDevices = (entities || []).filter(e => {
          if (e.device_id) return false;       // skip real hw
          if (!e.entity_id) return false;
          const dom = e.entity_id.split(".")[0];
          if (!dom) return false;
          // Only treat valid device domains as virtual devices
          const allowed = ["light", "switch", "fan", "cover"];
          if (!allowed.includes(dom)) return false;

          // area/label filter applies
          if (areaId && e.area_id !== areaId) return false;
          if (labelId &&
              (!Array.isArray(e.labels) || !e.labels.includes(labelId)))
            return false;

          return true;
        });

        //
        // STEP 3 — count domains from BOTH real + virtual devices
        //
        const domainCounts = {};

        // real devices
        matchingDevices.forEach(d => {
          const ents = entsByDevice.get(d.id) || [];
          ents.forEach(e => {
            const dom = e.entity_id.split(".")[0];
            domainCounts[dom] = (domainCounts[dom] || 0) + 1;
          });
        });

        // virtual devices: counted once each
        virtualDevices.forEach(e => {
          const dom = e.entity_id.split(".")[0];
          domainCounts[dom] = (domainCounts[dom] || 0) + 1;
        });

        const out = Object.keys(domainCounts).sort().map(dom => ({
          domain: dom,
          count:  domainCounts[dom]
        }));

        res.json(out);

      } catch (e) {
        res.status(500).send(e.message);
      }

    }
  );

  //
  // DEVICES — include virtual devices (Option A)
  //
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/devices",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {

      try {
        const { server } = req.query;
        const haServer = resolveHaServer(RED, server);
        if (!haServer) return res.status(400).send("HA server not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, server);
        if (!token) return res.status(400).send("Missing token");

        const areaId  = (req.query.area  || "").trim();
        const labelId = (req.query.label || "").trim();
        const domain  = (req.query.domain|| "").trim();

        const [entities, devices] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/entity_registry/list" }),
          wsCall(wsUrl, token, { type: "config/device_registry/list" })
        ]);

        const entsByDevice = new Map();
        (entities || []).forEach(e => {
          if (!e.device_id) return;
          if (!entsByDevice.has(e.device_id)) entsByDevice.set(e.device_id, []);
          entsByDevice.get(e.device_id).push(e);
        });

        //
        // REAL DEVICES
        //
        const real = (devices || []).filter(d => {
          const ents = entsByDevice.get(d.id) || [];

          // area
          if (areaId) {
            const ok =
              d.area_id === areaId ||
              ents.some(e => e.area_id === areaId);
            if (!ok) return false;
          }

          // label
          if (labelId) {
            const ok = ents.some(e =>
              Array.isArray(e.labels) && e.labels.includes(labelId)
            );
            if (!ok) return false;
          }

          // domain
          if (domain) {
            const ok = ents.some(e =>
              e.entity_id.split(".")[0] === domain
            );
            if (!ok) return false;
          }

          return true;
        });

        //
        // VIRTUAL DEVICES (groups)
        //
        const virtual = (entities || []).filter(e => {
          if (e.device_id) return false;   // only virtual
          if (!e.entity_id) return false;

          const dom = e.entity_id.split(".")[0];
          const allowed = ["light", "switch", "fan", "cover"];
          if (!allowed.includes(dom)) return false;

          // area
          if (areaId && e.area_id !== areaId) return false;

          // label
          if (labelId &&
              (!Array.isArray(e.labels) || !e.labels.includes(labelId)))
            return false;

          // domain
          if (domain && dom !== domain) return false;

          return true;
        });

        //
        // MERGE + RETURN
        //
        const out = [];

        // real devices
        real.forEach(d => {
          const name =
            d.name_by_user ||
            d.name ||
            [d.manufacturer, d.model].filter(Boolean).join(" ") ||
            d.id;

          out.push({
            id:   d.id,
            name: name,
            displayName: name
          });
        });

        // virtual devices
        virtual.forEach(e => {
          const name = e.name || e.entity_id;
          out.push({
            id:   e.entity_id,   // virtual device ID
            name: name,
            displayName: name
          });
        });

        res.json(out);

      } catch (e) {
        res.status(500).send(e.message);
      }

    }
  );

  //
  // ENTITIES — unchanged (deviceId may now be e.entity_id)
  //
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entities",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {

      try {
        const serverId = req.query.server;
        const haServer = resolveHaServer(RED, serverId);

        if (!haServer) return res.status(400).send("No HA server");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, serverId);
        if (!token) return res.status(400).send("Missing token");

        const deviceId = (req.query.device || "").trim();
        const all = await wsCall(wsUrl, token, { type: "config/entity_registry/list" });

        // For virtual devices, deviceId === entity_id
        const filtered = (all || []).filter(e => {
          if (e.device_id) {
            return !deviceId || e.device_id === deviceId;
          } else {
            return deviceId === e.entity_id;
          }
        });

        res.json(
          filtered.map(e => ({
            entity_id:   e.entity_id,
            name:        e.name || e.original_name || "",
            displayName: e.name || e.original_name || e.entity_id
          }))
        );

      } catch (e) {
        res.status(500).send(e.message);
      }

    }
  );

  //
  // ENTITY INFO — unchanged
  //
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entity_info",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {

      try {
        const serverId = req.query.server;
        const entityId = (req.query.entity || "").trim();
        const haServer = resolveHaServer(RED, serverId);

        if (!haServer) return res.status(400).send("HA server missing");
        if (!entityId) return res.status(400).send("Missing entity id");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, serverId);
        if (!token) return res.status(400).send("Missing token");

        const states = await wsCall(wsUrl, token, { type: "get_states" });
        const st = (states || []).find(s => s.entity_id === entityId);

        const attrs = st?.attributes || {};
        res.json({
          entity_id: entityId,
          state:     st ? st.state : null,
          attributes: attrs,
          detected_modes: {}
        });

      } catch (e) {
        res.status(500).send(e.message);
      }

    }
  );
};
