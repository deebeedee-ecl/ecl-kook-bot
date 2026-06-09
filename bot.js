require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");

console.log("ECL info bot starting");

const TOKEN = process.env.KOOK_BOT_TOKEN;
const API_BASE = "https://www.kookapp.cn/api/v3";
const SITE_URL = process.env.ECL_SITE_URL || "https://eclchina.lol";
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || "1969692300297863";
const RECONNECT_DELAY_MS = 5000;

if (!TOKEN) {
  console.error("Missing KOOK_BOT_TOKEN in .env");
  process.exit(1);
}

function getUrl(path) {
  return `${SITE_URL}${path}`;
}

function formatCommands() {
  return [
    "ECL Bot Commands",
    "",
    "- !ping",
    "- !help / !commands",
    "- !elo / !leaderboard",
    "",
    "The bot is stripped back for now. Scheduling, reports, teams, standings, and results are offline while we rebuild.",
  ].join("\n");
}

function formatWelcomeMessage() {
  return [
    "Welcome to the Expat China League (ECL)",
    "",
    `ELO leaderboard: ${getUrl("/stats/leaderboard")}`,
    "",
    "Use !help to see what the bot can do.",
  ].join("\n");
}

async function sendChannelMessage(targetId, content) {
  try {
    await axios.post(
      `${API_BASE}/message/create`,
      {
        target_id: targetId,
        content,
        type: 1,
      },
      {
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    console.log("Sent message");
    return true;
  } catch (err) {
    console.error("Send message error:", err.response?.data || err.message);
    return false;
  }
}

async function sendWelcomeMessage() {
  await sendChannelMessage(WELCOME_CHANNEL_ID, formatWelcomeMessage());
}

async function getGateway() {
  const res = await axios.get(`${API_BASE}/gateway/index`, {
    headers: {
      Authorization: `Bot ${TOKEN}`,
    },
    timeout: 15000,
  });

  return res.data.data.url.replace("compress=1", "compress=0");
}

function parsePacket(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    try {
      const inflated = zlib.inflateSync(raw);
      return JSON.parse(inflated.toString());
    } catch (err) {
      console.error("Parse packet failed:", err.message);
      return null;
    }
  }
}

async function handleCommand(event, command) {
  const targetId = event.target_id;

  if (command === "!ping") {
    await sendChannelMessage(targetId, "pong");
    return;
  }

  if (command === "!help" || command === "!commands") {
    await sendChannelMessage(targetId, formatCommands());
    return;
  }

  if (command === "!elo" || command === "!leaderboard") {
    await sendChannelMessage(
      targetId,
      `ELO leaderboard: ${getUrl("/stats/leaderboard")}`
    );
    return;
  }

  await sendChannelMessage(
    targetId,
    "Unknown command. Use !help to see what I can do."
  );
}

let ws = null;
let heartbeat = null;
let reconnectTimer = null;

function clearHeartbeat() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((err) => {
      console.error("Reconnect failed:", err.message);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

async function startBot() {
  const gatewayUrl = await getGateway();
  console.log("Connecting to:", gatewayUrl);

  ws = new WebSocket(gatewayUrl);
  let lastSn = 0;

  ws.on("open", () => {
    console.log("Bot connected to KOOK");
  });

  ws.on("message", async (raw) => {
    const packet = parsePacket(raw);
    if (!packet) return;

    if (typeof packet.sn === "number") {
      lastSn = packet.sn;
    }

    if (packet.s === 1) {
      clearHeartbeat();
      heartbeat = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ s: 2, sn: lastSn }));
        }
      }, 30000);
      return;
    }

    if (packet.s === 3) return;
    if (packet.s !== 0 || !packet.d) return;

    const event = packet.d;

    if (event.type === 255 && event.extra?.type === "joined_guild") {
      await sendWelcomeMessage();
      return;
    }

    const rawContent =
      event?.extra?.kmarkdown?.raw_content ?? event?.content ?? "";
    const content = String(rawContent).trim();

    if (!content.startsWith("!")) return;

    const command = content.split(/\s+/)[0].toLowerCase();
    await handleCommand(event, command);
  });

  ws.on("close", () => {
    console.log("WebSocket closed");
    clearHeartbeat();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

startBot().catch((err) => {
  console.error("Initial startBot error:", err.message);
  scheduleReconnect();
});
