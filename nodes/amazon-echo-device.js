// nodes/amazon-echo-device.js
// Amazon Echo Device (HA Entities) — filters (Area/Label/Domain) + Device/Entity lookups
const WebSocket = require("ws");

module.exports = function (RED) {

  // ───────────────────────────────────────────────
  //  RUNTIME NODE
  // ───────────────────────────────────────────────
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
      const _done = done || function () {};

      try {
        const nodeDeviceId = node.deviceid || node.id;

        // Only intercept messages targeted at this deviceid
        if (msg && msg.deviceid && msg.deviceid === nodeDeviceId) {
          if (typeof msg.payload !== "object" || msg.payload === null) {
            msg.payload = { value: msg.payload };
          }
          msg.payload.haDeviceId = node.haDeviceId || "";
          msg.payload.haEntityId = node.haEntityId || "";
          _send(msg);
          return _done();
        }

        // Otherwise just pass through
        _send(msg);
        _done();

      } catch (err) {
        node.error(err, msg);
        _done(err);
      }
    });

    node.on("close", (done) => done());
  }

  RED.nodes.registerType("amazon-echo-device-ha-entities", AmazonEchoDeviceNode);

  // ───────────────────────────────────────────────
  //  HELPERS
  // ───────────────────────────────────────────────
  function resolveHaServer(RED, serverId) {
    let inst = null;
    if (serverId) {
      inst = RED.nodes.getNode(serverId) || null;
      const { wsUrl, token } = getHaUrlAndToken(RED, inst, serverId);
      if (wsUrl && token) return inst;
    }

    const configs = [];
    if (RED.nodes.eachConfig) RED.nodes.eachConfig(n => configs.push(n));
    const serverCfgs = configs.filter(n => n.type === "server");
    for (const cfg of serverCfgs) {
      const inst2 = RED.nodes.getNode(cfg.id);
      const { wsUrl, token } = getHaUrlAndToken(RED, inst2, cfg.id);
      if (wsUrl && token) return inst2;
    }
    return null;
  }

  function getHaUrlAndToken(RED, haServer, serverId) {
    if (!haServer) return { baseUrl: null, wsUrl: null, token: null };

    const addonMode =
      !!process.env.SUPERVISOR_TOKEN ||
      haServer?.config?.addon === true ||
      haServer?.addon === true ||
      haServer?.useAddon === true;

    if (addonMode && process.env.SUPERVISOR_TOKEN) {
      return {
        baseUrl: "http://supervisor/core",
        wsUrl: "ws://supervisor/core/websocket",
        token: process.env.SUPERVISOR_TOKEN
      };
    }

    const baseUrl =
      (typeof haServer.getUrl === "function" && haServer.getUrl()) ||
      haServer?.url ||
      haServer?.config?.url ||
      haServer?.client?.websocketUrl ||
      haServer?.client?.baseUrl ||
      null;

    const creds     = serverId ? (RED.nodes.getCredentials(serverId) || null) : null;
    const nodeCreds = haServer && haServer.credentials ? haServer.credentials : null;

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
      wsUrl = String(baseUrl)
        .replace(/^http:/i, "ws:")
        .replace(/^https:/i, "wss:");
      if (!/\/api\/websocket$/i.test(wsUrl)) {
        wsUrl = wsUrl.replace(/\/+$/,"") + "/api/websocket";
      }
    }

    return { baseUrl, wsUrl, token };
  }

  function wsCall(wsUrl, token, msg) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let nextId = 1;

      ws.on("open", () => {
        ws.once("message", rawHello => {
          let hello;
          try { hello = JSON.parse(rawHello); } catch (e) { return reject(e); }
          if (hello.type !== "auth_required") return reject(new Error("Unexpected HA hello"));

          ws.send(JSON.stringify({ type: "auth", access_token: token }));

          ws.once("message", rawAuth => {
            let auth;
            try { auth = JSON.parse(rawAuth); } catch (e) { return reject(e); }
            if (auth.type !== "auth_ok") return reject(new Error("HA auth failed"));

            const id = nextId++;
            ws.send(JSON.stringify(Object.assign({ id }, msg)));

            ws.on("message", rawMsg => {
              let resp;
              try { resp = JSON.parse(rawMsg); } catch (e) { return; }
              if (resp.id === id) {
                ws.close();
                if (resp.success === false) {
                  return reject(
                    new Error(
                      (resp.error && resp.error.message) || "HA command failed"
                    )
                  );
                }
                resolve(resp.result || []);
              }
            });
          });
        });
      });

      ws.on("error", reject);
    });
  }

  function detectModes(attrs) {
    const out = {};
    if (!attrs || typeof attrs !== "object") return out;

    const keys = [
      "hvac_modes", "preset_modes", "fan_modes", "swing_modes",
      "swing_mode_list", "speed_list", "effect_list",
      "source_list", "input_source_list",
      "supported_color_modes", "color_modes",
      "modes", "supported_features_list"
    ];

    keys.forEach(k => {
      const v = attrs[k];
      if (Array.isArray(v) && v.length) out[k] = v;
    });

    Object.keys(attrs).forEach(k => {
      if ((/_modes$|_list$/i).test(k) && Array.isArray(attrs[k]) && attrs[k].length) {
        if (!out[k]) out[k] = attrs[k];
      }
    });

    return out;
  }

  // ───────────────────────────────────────────────
  //  ADMIN API ENDPOINTS
  // ───────────────────────────────────────────────

  // Filters: areas, labels, and all domains (unfiltered)
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/filters",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const [areas, labels, devices, entities] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/area_registry/list" }),
          wsCall(wsUrl, token, { type: "config/label_registry/list" }).catch(() => []),
          wsCall(wsUrl, token, { type: "config/device_registry/list" }),
          wsCall(wsUrl, token, { type: "config/entity_registry/list" })
        ]);

        const domainCounts = {};
        (entities || []).forEach(e => {
          const domain = e && e.entity_id && e.entity_id.split(".")[0];
          if (!domain) return;
          domainCounts[domain] = (domainCounts[domain] || 0) + 1;
        });

        res.json({
          total_devices: Array.isArray(devices) ? devices.length : 0,
          areas:  (areas  || []).map(a => ({ area_id: a.area_id, name: a.name || a.area_id })),
          labels: (labels || []).map(l => ({ label_id: l.label_id, name: l.name || l.label_id })),
          domains: Object.keys(domainCounts).sort().map(d => ({
            domain: d,
            count:  domainCounts[d]
          }))
        });

      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Domains filtered by area+label, counts based on devices
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/domains",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const areaId  = (req.query.area  || "").trim();
        const labelId = (req.query.label || "").trim();

        const [entities, devices] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/entity_registry/list" }),
          wsCall(wsUrl, token, { type: "config/device_registry/list" })
        ]);

        const entsByDevice = new Map();
        (entities || []).forEach(e => {
          if (!e || !e.device_id) return;
          if (!entsByDevice.has(e.device_id)) entsByDevice.set(e.device_id, []);
          entsByDevice.get(e.device_id).push(e);
        });

        const matchingDevices = (devices || []).filter(d => {
          const ents = entsByDevice.get(d.id) || [];

          if (areaId) {
            const matchArea = (d.area_id === areaId) || ents.some(e => e.area_id === areaId);
            if (!matchArea) return false;
          }

          if (labelId) {
            const matchLabel = ents.some(e => {
              const labels = Array.isArray(e.labels) ? e.labels : [];
              return labels.includes(labelId);
            });
            if (!matchLabel) return false;
          }

          return true;
        });

        const domainCounts = {};
        matchingDevices.forEach(d => {
          const ents = entsByDevice.get(d.id) || [];
          ents.forEach(e => {
            const domain = e.entity_id.split(".")[0];
            if (!domain) return;
            domainCounts[domain] = (domainCounts[domain] || 0) + 1;
          });
        });

        const out = Object.keys(domainCounts).sort().map(d => ({
          domain: d,
          count:  domainCounts[d]
        }));

        res.json(out);

      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Devices filtered by area/label/domain
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/devices",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const [entities, devices] = await Promise.all([
          wsCall(wsUrl, token, { type: "config/entity_registry/list" }),
          wsCall(wsUrl, token, { type: "config/device_registry/list" })
        ]);

        const entsByDevice = new Map();
        (entities || []).forEach(e => {
          if (!e || !e.device_id) return;
          if (!entsByDevice.has(e.device_id)) entsByDevice.set(e.device_id, []);
          entsByDevice.get(e.device_id).push(e);
        });

        const areaId  = (req.query.area  || "").trim();
        const labelId = (req.query.label || "").trim();
        const domain  = (req.query.domain|| "").trim();

        const filtered = (devices || []).filter(d => {
          const ents = entsByDevice.get(d.id) || [];

          if (areaId) {
            const matchArea =
              d.area_id === areaId ||
              ents.some(e => e.area_id === areaId);
            if (!matchArea) return false;
          }

          if (labelId) {
            const matchLabel = ents.some(e => {
              const labels = Array.isArray(e.labels) ? e.labels : [];
              return labels.includes(labelId);
            });
            if (!matchLabel) return false;
          }

          if (domain) {
            const matchDomain = ents.some(e => {
              const dom = e.entity_id && e.entity_id.split(".")[0];
              return dom === domain;
            });
            if (!matchDomain) return false;
          }

          return true;
        });

        const out = filtered.map(d => {
          const name =
            d.name_by_user ||
            d.name ||
            [d.manufacturer, d.model].filter(Boolean).join(" ") ||
            d.id;
          return { id: d.id, name, displayName: name };
        });

        res.json(out);

      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Entities filtered by device
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entities",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const deviceId = (req.query.device || "").trim();
        const entities = await wsCall(wsUrl, token, { type: "config/entity_registry/list" });

        const filtered = (entities || []).filter(e => !deviceId || e.device_id === deviceId);

        res.json(
          filtered.map(e => ({
            entity_id: e.entity_id,
            name: e.name || e.original_name || "",
            displayName: e.name || e.original_name || e.entity_id
          }))
        );

      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // Entity info (for future preview UI)
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/entity_info",
    RED.auth.needsPermission("flows.read"),
    async (req, res) => {
      try {
        const haServer = resolveHaServer(RED, req.query.server);
        const entityId = (req.query.entity || "").trim();
        if (!haServer) return res.status(400).send("Home Assistant server config node not found");
        if (!entityId) return res.status(400).send("Missing entity id");

        const { wsUrl, token } = getHaUrlAndToken(RED, haServer, req.query.server);
        if (!wsUrl || !token) return res.status(400).send("HA URL/token missing on selected server");

        const states = await wsCall(wsUrl, token, { type: "get_states" });
        const st = Array.isArray(states)
          ? states.find(s => s && s.entity_id === entityId)
          : null;

        const attrs = (st && st.attributes) ? st.attributes : {};
        const modes = detectModes(attrs);

        res.json({
          entity_id: entityId,
          state: st ? st.state : null,
          attributes: attrs,
          detected_modes: modes
        });

      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // NEW: resolve the HA server from the Hub node for the editor
  RED.httpAdmin.get(
    "/amazon-echo-ha-entities/hub_server",
    RED.auth.needsPermission("flows.read"),
    (req, res) => {
      try {
        const hubs = [];
        if (RED.nodes.eachNode) {
          RED.nodes.eachNode(n => {
            if (n && n.type === "amazon-echo-hub-ha-entities") {
              hubs.push(n);
            }
          });
        }

        if (!hubs.length) {
          return res.status(404).send("No Amazon Echo Hub (HA) nodes found");
        }

        const hub = hubs[0]; // if multiple hubs, we just use the first one
        res.json({ hubId: hub.id, haServer: hub.haServer });

      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

};
