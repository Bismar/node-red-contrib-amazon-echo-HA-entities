// nodes/amazon-echo-hub.js
// Amazon Echo Hub (HA Entities) — Datech behaviour + HA-entities device support

module.exports = function (RED) {
  "use strict";

  const helpers  = require("./lib/helpers.js")();
  const HueColor = require("hue-colors").default;

  //
  // ───────────────────────────────────────────────
  //  HUB NODE
  // ───────────────────────────────────────────────
  //
  function AmazonEchoHubNode(config) {
    RED.nodes.createNode(this, config);
    const hubNode = this;

    // Port
    const port =
      config.port > 0 && config.port < 65536
        ? config.port
        : 80;

    // Map new HA-entities UI options back to original config.processinput
    let mappedProcessInput = 0;
    switch (config.processMode) {
      case "disabled":
        mappedProcessInput = 0;
        break;
      case "discovery":
        mappedProcessInput = 1; // process only
        break;
      case "commands":
      case "all":
      default:
        mappedProcessInput = 2; // process + output
        break;
    }

    // Preserve an explicit processinput value if present (for safety)
    if (typeof config.processinput !== "number") {
      config.processinput = mappedProcessInput;
    }

    // Discovery flag (support new discoveryEnabled + legacy discovery)
    const discoveryEnabled =
      typeof config.discoveryEnabled === "boolean"
        ? config.discoveryEnabled
        : !!config.discovery;

    //
    // SSDP server (Hue bridge emulation)
    //
    const ssdpServer = ssdp(port, config);
    if (discoveryEnabled) {
      ssdpServer.start();
    }

    //
    // HTTP server (Hue REST API)
    //
    const graceMilliseconds = 500;
    const stoppable = require("stoppable");
    const http      = require("http");
    const express   = require("express");
    const app       = express();
    const httpServer = stoppable(http.createServer(app), graceMilliseconds);

    httpServer.on("error", function (error) {
      hubNode.status({
        fill:  "red",
        shape: "ring",
        text:  "Unable to start on port " + port
      });
      RED.log.error(error);
    });

    httpServer.listen(port, function (error) {
      if (error) {
        hubNode.status({
          fill:  "red",
          shape: "ring",
          text:  "Unable to start on port " + port
        });
        RED.log.error(error);
        return;
      }

      hubNode.status({
        fill:  "green",
        shape: "dot",
        text:  "online"
      });

      // REST API routes
      api(app, hubNode, config);
    });

    //
    // Handle Node-RED input messages (original Datech behaviour)
    //
    hubNode.on("input", function (msg) {
      let nodeDeviceId = null;

      if (typeof msg.payload === "object" && msg.payload !== null) {
        if ("nodeid" in msg.payload && msg.payload.nodeid !== null) {
          nodeDeviceId = msg.payload.nodeid;
          delete msg.payload.nodeid;
        } else if ("nodename" in msg.payload && msg.payload.nodename !== null) {
          getDevices().forEach(function (device) {
            if (msg.payload.nodename === device.name) {
              nodeDeviceId = device.id;
            }
          });
          delete msg.payload.nodename;
        }
      }

      if (config.processinput > 0 && nodeDeviceId !== null) {
        const deviceid = helpers.formatUUID(nodeDeviceId);

        const meta = {
          insert: {
            by:      "input",
            details: {}
          }
        };

        const deviceAttributes = setDeviceAttributes(
          deviceid,
          msg.payload,
          meta,
          hubNode.context()
        );

        // Output if:
        // - 'Process and output' (2), OR
        // - 'Process and output on state change' (3 and changes exist)
        if (
          config.processinput === 2 ||
          (config.processinput === 3 &&
            Object.keys(deviceAttributes.meta.changes).length > 0)
        ) {
          payloadHandler(hubNode, deviceid, msg.topic);
        }
      }
    });

    //
    // Cleanup on close
    //
    hubNode.on("close", function (removed, done) {
      try {
        ssdpServer.stop();
      } catch (e) {
        // ignore
      }

      httpServer.stop(function () {
        if (typeof done === "function") done();
        RED.log.info("Alexa Local Hub closing done...");
      });

      setImmediate(function () {
        httpServer.emit("close");
      });
    });
  }

  //
  // Register HA-entities hub node type
  //
  RED.nodes.registerType(
    "amazon-echo-hub-ha-entities",
    AmazonEchoHubNode,
    {}
  );

  //
  // ───────────────────────────────────────────────
  //  HUE REST API
  // ───────────────────────────────────────────────
  //
  function api(app, hubNode, config) {
    const Mustache      = require("mustache");
    const fs            = require("fs");
    const bodyParser    = require("body-parser");
    const apiTemplateDir =
      __dirname + "/resources/api/hue/templates";

    app.use(
      bodyParser.json({
        type: "*/*"
      })
    );

    app.use(function (err, req, res, next) {
      if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        RED.log.debug(
          "Error: Invalid JSON request: " + JSON.stringify(err.body)
        );
      }
      next();
    });

    app.use(function (req, res, next) {
      if (Object.keys(req.body || {}).length > 0) {
        RED.log.debug("Request body: " + JSON.stringify(req.body));
      }
      next();
    });

    // /description.xml
    app.get("/description.xml", function (req, res) {
      const template = fs
        .readFileSync(apiTemplateDir + "/description.xml")
        .toString();

      const data = {
        address:  req.hostname,
        port:     req.connection.localPort,
        huehubid: helpers.getHueHubId(config)
      };

      const output = Mustache.render(template, data);

      res.type("application/xml");
      res.send(output);
    });

    // /api (user registration)
    app.post("/api", function (req, res) {
      const template = fs
        .readFileSync(apiTemplateDir + "/registration.json", "utf8")
        .toString();

      const data = {
        username: "c6260f982b43a226b5542b967f612ce"
      };

      let output = Mustache.render(template, data);
      output = JSON.parse(output);

      res.json(output);
    });

    // /api/nouser/config
    app.get("/api/nouser/config", function (req, res) {
      const template = fs
        .readFileSync(apiTemplateDir + "/nouser/config.json", "utf8")
        .toString();

      const data = {};
      let output = Mustache.render(template, data);
      output = JSON.parse(output);

      res.json(output);
    });

    // /api/:username/config
    app.get("/api/:username/config", function (req, res) {
      const template = fs
        .readFileSync(apiTemplateDir + "/config.json", "utf8")
        .toString();

      const data = {
        address:  req.hostname,
        username: req.params.username,
        date:     new Date().toISOString().split(".").shift()
      };

      let output = Mustache.render(template, data);
      output = JSON.parse(output);

      res.json(output);
    });

    // /api/:username  (full state)
    app.get("/api/:username", function (req, res) {
      const lightsTemplate = fs
        .readFileSync(apiTemplateDir + "/lights/all.json", "utf8")
        .toString();
      const template = fs
        .readFileSync(apiTemplateDir + "/state.json", "utf8")
        .toString();

      const data = {
        lights:   getDevicesAttributes(hubNode.context()),
        address:  req.hostname,
        username: req.params.username,
        date:     new Date().toISOString().split(".").shift(),
        uniqueid: function () {
          return helpers.hueUniqueId(this.id);
        }
      };

      let output = Mustache.render(template, data, {
        lightsTemplate: lightsTemplate
      });
      output = JSON.parse(output);
      delete output.lights.last;

      res.json(output);
    });

    // /api/:username/lights
    app.get("/api/:username/lights", function (req, res) {
      const template = fs
        .readFileSync(apiTemplateDir + "/lights/all.json", "utf8")
        .toString();

      const data = {
        lights:   getDevicesAttributes(hubNode.context()),
        date:     new Date().toISOString().split(".").shift(),
        uniqueid: function () {
          return helpers.hueUniqueId(this.id);
        }
      };

      let output = Mustache.render(template, data);
      output = JSON.parse(output);
      delete output.last;

      res.json(output);
    });

    // /api/:username/lights/:id
    app.get("/api/:username/lights/:id", function (req, res) {
      const template = fs
        .readFileSync(apiTemplateDir + "/lights/get-state.json", "utf8")
        .toString();

      let deviceName = "";
      getDevices().forEach(function (device) {
        if (req.params.id === device.id) deviceName = device.name;
      });

      const data = getDeviceAttributes(req.params.id, hubNode.context());
      data.name  = deviceName;
      data.date  = new Date().toISOString().split(".").shift();

      let output = Mustache.render(template, data);
      output = JSON.parse(output);

      res.json(output);
    });

    // PUT /api/:username/lights/:id/state
    app.put("/api/:username/lights/:id/state", function (req, res) {
      const meta = {
        insert: {
          by: "alexa",
          details: {
            ip:
              req.headers["x-forwarded-for"] ||
              req.connection.remoteAddress ||
              "",
            user_agent: req.headers["user-agent"]
          }
        }
      };

      setDeviceAttributes(req.params.id, req.body, meta, hubNode.context());

      const template = fs
        .readFileSync(apiTemplateDir + "/lights/set-state.json", "utf8")
        .toString();

      const data = getDeviceAttributes(req.params.id, hubNode.context());

      let output = Mustache.render(template, data);
      output = JSON.parse(output);

      res.json(output);

      // Emit Device message to Node-RED
      payloadHandler(hubNode, req.params.id);
    });
  }

  //
  // ───────────────────────────────────────────────
  //  SSDP (Hue bridge discovery)
  // ───────────────────────────────────────────────
  //
  function ssdp(port, config) {
    const SsdpServer = require("node-ssdp").Server;
    const server = new SsdpServer({
      location: {
        port: port,
        path: "/description.xml"
      },
      udn:      "uuid:" + helpers.getHueHubId(config),
      ssdpSig:  "FreeRTOS/7.4.2 UPnP/1.0 IpBridge/1.16.0",
      ssdpTtl:  2,
      explicitSocketBind: true
    });

    server._extraHeaders = Object.assign({}, server._extraHeaders, {
      "hue-bridgeid":  "AABBCCDDFF001122",
      "CACHE-CONTROL": "max-age=100"
    });

    server.addUSN("upnp:rootdevice");
    server.addUSN("urn:schemas-upnp-org:device:basic:1");

    return server;
  }

  //
  // ───────────────────────────────────────────────
  //  HELPERS (state storage)
  // ───────────────────────────────────────────────
  //
  function getOrDefault(key, defaultValue, context) {
    let value = null;
    const storageValue = context.get(key);

    if (storageValue !== undefined) {
      value = Object.assign({}, storageValue);
    }

    return valueOrDefault(value, defaultValue);
  }

  function valueOrDefault(value, defaultValue) {
    if (value === undefined || value === null) {
      value = defaultValue;
    }
    return value;
  }

  // NOTE: now supports BOTH original `amazon-echo-device`
  // and new `amazon-echo-device-ha-entities` device nodes.
  function getDevices() {
    const devices = [];

    RED.nodes.eachNode(function (node) {
      if (
        node.type === "amazon-echo-device" ||
        node.type === "amazon-echo-device-ha-entities"
      ) {
        devices.push({
          id:   helpers.formatUUID(node.id),
          name: node.name
        });
      }
    });

    return devices;
  }

  function getDeviceAttributes(id, context) {
    const defaultAttributes = {
      on:          false,
      bri:         254,
      percentage:  100,
      hue:         0,
      sat:         254,
      xy:          [0.6484272236872118, 0.33085610147277794],
      ct:          199,
      rgb:         [254, 0, 0],
      colormode:   "ct",
      meta:        {}
    };

    return getOrDefault(id, defaultAttributes, context);
  }

  function getDevicesAttributes(context) {
    const devices = getDevices();
    const devicesAttributes = [];

    for (let key in devices) {
      const attributes = getDeviceAttributes(devices[key].id, context);
      devicesAttributes.push(Object.assign({}, attributes, devices[key]));
    }

    return devicesAttributes;
  }

  function setDeviceAttributes(id, attributes, meta, context) {
    // Reset meta attribute
    meta.insert.details.date = new Date();
    meta.input   = attributes;
    meta.changes = {};

    const saved = getDeviceAttributes(id, context);
    const current = {};

    // Set defaults
    for (let key in saved) {
      current[key] = valueOrDefault(attributes[key], saved[key]);
    }

    // Color temperature
    if (attributes.ct !== undefined) {
      current.colormode = "ct";
    }

    // Hue + Sat → XY/RGB
    if (attributes.hue !== undefined && attributes.sat !== undefined) {
      const hueColor = HueColor.fromHsb(current.hue, current.sat, current.bri);
      const cie = hueColor.toCie();
      const rgb = hueColor.toRgb();
      current.xy  = [cie[0] || 0, cie[1] || 0];
      current.rgb = rgb;
      current.colormode = "hs";
    }

    // XY → Hue/Sat/RGB
    if (
      attributes.xy !== undefined &&
      Array.isArray(attributes.xy) &&
      attributes.xy.length === 2
    ) {
      const hueColor = HueColor.fromCIE(current.xy[0], current.xy[1], current.bri);
      const hsb = hueColor.toHsb();
      const rgb = hueColor.toRgb();
      current.hue = hsb[0] || 0;
      current.sat = hsb[1] || 0;
      current.rgb = rgb;
      current.colormode = "hs";
    }

    // RGB → Hue/Sat/Bri/XY
    if (
      attributes.rgb !== undefined &&
      Array.isArray(attributes.rgb) &&
      attributes.rgb.length === 3
    ) {
      const hueColor = HueColor.fromRgb(current.rgb[0], current.rgb[1], current.rgb[2]);
      const hsb = hueColor.toHsb();
      const cie = hueColor.toCie();
      current.hue = hsb[0] || 0;
      current.sat = hsb[1] || 0;
      current.bri = hsb[2] || 0;
      current.xy  = [cie[0] || 0, cie[1] || 0];
      current.colormode = "hs";
    }

    // Brightness percentage
    current.percentage = Math.floor((current.bri / 253) * 100);

    // Populate meta.changes
    for (let key in saved) {
      if (JSON.stringify(saved[key]) !== JSON.stringify(current[key])) {
        meta.changes[key] = saved[key];
      }
    }

    // Attach meta + persist
    current.meta = meta;
    context.set(id, current);

    // Convenience payload
    current.payload = current.on ? "on" : "off";

    return getOrDefault(id, current, context);
  }

  //
  // ───────────────────────────────────────────────
  //  OUTPUT HANDLER (hub → Node-RED msg)
  // ───────────────────────────────────────────────
  //
  function payloadHandler(hubNode, deviceId, topic = null) {
    const msg = getDeviceAttributes(deviceId, hubNode.context());
    msg.deviceid = deviceId;
    if (topic !== null) {
      msg.topic = topic;
    }
    hubNode.send(msg);
  }
};
