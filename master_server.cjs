"use strict";

// src/index.ts
var import_ws = require("ws");
var clients = /* @__PURE__ */ new Map();
var rooms = /* @__PURE__ */ new Map();
var events = [];
var bannedKeys = /* @__PURE__ */ new Set();
var bannedIps = /* @__PURE__ */ new Set();
var bannedKeyWords = [];
var util = {
  nickname(str) {
    return typeof str === "string" ? str.slice(0, 12) : "\u65E0\u540D\u73A9\u5BB6";
  },
  isBanned(str) {
    return bannedKeyWords.some((k) => str.includes(k));
  },
  sendl(client, ...args) {
    try {
      client.send(JSON.stringify(args));
    } catch {
      client.close();
    }
  },
  newId() {
    return Math.floor(1e9 + Math.random() * 9e9).toString();
  },
  buildRoomList() {
    const roomList = [];
    const clientCount = /* @__PURE__ */ new Map();
    rooms.forEach((room, key) => clientCount.set(key, 0));
    clients.forEach((c) => {
      if (c.room && !c.servermode) {
        const key = c.room.key;
        clientCount.set(key, (clientCount.get(key) || 0) + 1);
      }
    });
    rooms.forEach((room, key) => {
      const count = clientCount.get(key) || 0;
      if (room.servermode) {
        roomList.push("server");
      } else if (room.owner && room.config) {
        if (count === 0) {
          util.sendl(room.owner, "reloadroom");
        }
        roomList.push([
          room.owner.nickname,
          room.owner.avatar,
          room.config,
          count,
          room.key
        ]);
      }
    });
    return roomList;
  },
  buildClientList() {
    const out = [];
    clients.forEach((c) => {
      out.push([c.nickname, c.avatar, !c.room, c.status, c.wsid, c.onlineKey]);
    });
    return out;
  },
  updateRooms() {
    const roomList = util.buildRoomList();
    const clientList = util.buildClientList();
    clients.forEach((c) => {
      if (!c.room) util.sendl(c, "updaterooms", roomList, clientList);
    });
  },
  updateClients() {
    const list = util.buildClientList();
    clients.forEach((c) => {
      if (!c.room) util.sendl(c, "updateclients", list);
    });
  },
  checkEvents() {
    const now = Date.now();
    for (let i = 0; i < events.length; i++) {
      if (events[i].utc <= now) {
        events.splice(i--, 1);
      }
    }
    return events;
  },
  updateEvents() {
    util.checkEvents();
    clients.forEach((c) => {
      if (!c.room) util.sendl(c, "updateevents", events);
    });
  }
};
var handlers = {
  create(client, key, nickname, avatar, config, mode) {
    if (client.onlineKey !== key) return;
    client.nickname = util.nickname(nickname);
    client.avatar = avatar;
    const room = { key, owner: client };
    rooms.set(key, room);
    client.room = room;
    delete client.status;
    util.sendl(client, "createroom", key);
    util.updateRooms();
  },
  enter(client, key, nickname, avatar) {
    const room = rooms.get(key);
    if (!room) return util.sendl(client, "enterroomfailed");
    client.nickname = util.nickname(nickname);
    client.avatar = avatar;
    client.room = room;
    delete client.status;
    if (!room.owner) return util.sendl(client, "enterroomfailed");
    if (!room.config || room.config.gameStarted && (!room.config.observe || !room.config.observeReady)) {
      return util.sendl(client, "enterroomfailed");
    }
    client.owner = room.owner;
    util.sendl(room.owner, "onconnection", client.wsid);
    util.updateRooms();
  },
  changeAvatar(client, nickname, avatar) {
    client.nickname = util.nickname(nickname);
    client.avatar = avatar;
    util.updateClients();
  },
  key(client, id) {
    if (!id || typeof id !== "object") {
      util.sendl(client, "denied", "key");
      return client.close();
    }
    if (bannedKeys.has(id[0])) {
      bannedIps.add(client.clientIp);
      return client.close();
    }
    client.onlineKey = id[0];
    clearTimeout(client.keyCheck);
  },
  events(client, cfg, id, type) {
    if (bannedKeys.has(id) || typeof id !== "string" || client.onlineKey !== id) {
      bannedIps.add(client.clientIp);
      client.close();
      return;
    }
    let changed = false;
    const now = Date.now();
    if (typeof cfg === "string") {
      for (let ev of events) {
        if (ev.id === cfg) {
          if (type === "join" && !ev.members.includes(id)) {
            ev.members.push(id);
            changed = true;
          }
          if (type === "leave") {
            const idx = ev.members.indexOf(id);
            if (idx !== -1) {
              ev.members.splice(idx, 1);
              if (ev.members.length === 0) {
                const index = events.indexOf(ev);
                events.splice(index, 1);
              }
              changed = true;
            }
          }
        }
      }
    } else if (cfg && typeof cfg === "object" && "utc" in cfg && "day" in cfg && "hour" in cfg && "content" in cfg) {
      if (events.length >= 20) util.sendl(client, "eventsdenied", "total");
      else if (cfg.utc <= now) util.sendl(client, "eventsdenied", "time");
      else if (util.isBanned(cfg.content)) util.sendl(client, "eventsdenied", "ban");
      else {
        const item = {
          ...cfg,
          nickname: util.nickname(cfg.nickname),
          avatar: cfg.avatar || "caocao",
          creator: id,
          id: util.newId(),
          members: [id]
        };
        events.unshift(item);
        changed = true;
      }
    }
    if (changed) util.updateEvents();
  },
  config(client, config) {
    const room = client.room;
    if (!room || room.owner !== client) return;
    if (room.servermode) {
      room.servermode = false;
    }
    room.config = config;
    util.updateRooms();
  },
  status(client, str) {
    if (typeof str === "string") client.status = str;
    else delete client.status;
    util.updateClients();
  },
  send(client, id, message) {
    const target = clients.get(id);
    if (target && target.owner === client) {
      try {
        target.send(message);
      } catch {
        target.close();
      }
    }
  },
  close(client, id) {
    const target = clients.get(id);
    if (target && target.owner === client) target.close();
  }
};
var wss = new import_ws.WebSocketServer({ port: 8080 });
wss.on("connection", (ws, req) => {
  const client = ws;
  const ip = req.socket.remoteAddress ?? "";
  if (bannedIps.has(ip)) {
    util.sendl(client, "denied", "banned");
    return setTimeout(() => ws.close(), 500);
  }
  client.wsid = util.newId();
  client.clientIp = ip;
  clients.set(client.wsid, client);
  client.keyCheck = setTimeout(() => {
    util.sendl(client, "denied", "key");
    setTimeout(() => client.close(), 500);
  }, 2e3);
  util.sendl(
    client,
    "roomlist",
    util.buildRoomList(),
    util.checkEvents(),
    util.buildClientList(),
    client.wsid
  );
  client.heartbeat = setInterval(() => {
    if (client.beat) {
      client.close();
      clearInterval(client.heartbeat);
      return;
    }
    client.beat = true;
    try {
      client.send("heartbeat");
    } catch {
      client.close();
    }
  }, 6e4);
  client.on("message", (msg) => {
    const raw = msg.toString();
    if (raw === "heartbeat") {
      client.beat = false;
      return;
    }
    if (client.owner) {
      util.sendl(client.owner, "onmessage", client.wsid, raw);
      return;
    }
    let arr;
    try {
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error();
    } catch {
      util.sendl(client, "denied", "banned");
      return;
    }
    if (arr.shift() !== "server") return;
    const type = arr.shift();
    const handler = handlers[type];
    if (!handler) return;
    handler(client, ...arr);
  });
  client.on("close", () => {
    rooms.forEach((room, key) => {
      if (room.owner === client) {
        clients.forEach((c) => {
          if (c.room === room && c !== client) {
            util.sendl(c, "selfclose");
          }
        });
        rooms.delete(key);
      }
    });
    if (client.owner) util.sendl(client.owner, "onclose", client.wsid);
    clients.delete(client.wsid);
    if (client.room) util.updateRooms();
    else util.updateClients();
  });
});
console.log("Server listening on port 8080");
//# sourceMappingURL=index.cjs.map