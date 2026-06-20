require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");

console.log("ECL info bot starting");

const TOKEN = process.env.KOOK_BOT_TOKEN;
const API_BASE = "https://www.kookapp.cn/api/v3";
const SITE_URL = process.env.ECL_SITE_URL || "https://eclchina.lol";
const KOOK_VERIFY_SECRET = process.env.ECL_KOOK_BOT_SECRET;
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
    "- !verify ECL-XXXXXX / !link ECL-XXXXXX",
    "",
    "Use !verify with your dashboard code to link your KOOK account to ECL.",
    "",
    "The bot is stripped back for now. Scheduling, reports, teams, standings, and results are offline while we rebuild.",
  ].join("\n");
}

function formatWelcomeMessage() {
  return [
    "🎉 Welcome to Expat China League (ECL)",
    "欢迎来到 Expat China League（ECL）",
    "",
    "ECL is a China-based League of Legends community for expats and local players.",
    "ECL 是一个面向外籍玩家与本地玩家的中国英雄联盟社区。",
    "",
    "To play ranked inhouses, create your ECL account and verify your KOOK:",
    "想参加排位内战，请先注册 ECL 账号并完成 KOOK 验证：",
    "",
    getUrl("/signup"),
    "",
    "After signup, send your Hub code here with:",
    "注册后，在这里发送你的 Hub 验证码：",
    "",
    "!verify ECL-XXXXXX",
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

function getKookUserId(event) {
  return (
    event.author_id ||
    event.extra?.author?.id ||
    event.extra?.user?.id ||
    event.user_id ||
    ""
  );
}

function getKookUsername(event) {
  return (
    event.extra?.author?.username ||
    event.extra?.author?.nickname ||
    event.extra?.user?.username ||
    event.extra?.user?.nickname ||
    ""
  );
}

async function verifyEclCode(event, code) {
  const targetId = event.target_id;
  const normalizedCode = String(code || "").trim().toUpperCase();

  if (!normalizedCode) {
    await sendChannelMessage(targetId, "Use: !verify ECL-XXXXXX");
    return;
  }

  if (!/^ECL-[A-Z0-9]{4,12}$/.test(normalizedCode)) {
    await sendChannelMessage(targetId, "That code does not look right. Copy the ECL code from your Hub dashboard.");
    return;
  }

  if (!KOOK_VERIFY_SECRET) {
    await sendChannelMessage(targetId, "KOOK verification is not configured yet. Missing ECL_KOOK_BOT_SECRET.");
    return;
  }

  const kookUserId = getKookUserId(event);
  const kookUsername = getKookUsername(event);

  if (!kookUserId) {
    await sendChannelMessage(targetId, "I could not read your KOOK user ID from this message. Try again in the ECL server.");
    return;
  }

  try {
    const res = await axios.post(
      `${SITE_URL}/api/kook/verify`,
      {
        code: normalizedCode,
        kookUserId,
        kookUsername,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-ecl-kook-secret": KOOK_VERIFY_SECRET,
        },
        timeout: 15000,
      }
    );

    if (res.data?.profileId || res.data?.message === "KOOK verification confirmed") {
      const displayName = res.data?.displayName ? ` ${res.data.displayName}` : "";
      await sendChannelMessage(targetId, `ECL account verified${displayName}. Your KOOK account is now linked.`);
      return;
    }

    await sendChannelMessage(targetId, res.data?.message || "Verification did not complete.");
  } catch (err) {
    const message = err.response?.data?.message || err.message || "Verification failed.";
    await sendChannelMessage(targetId, `Verification failed: ${message}`);
  }
}

async function handleCommand(event, command, args) {
  const targetId = event.target_id;

  if (command === "!ping") {
    await sendChannelMessage(targetId, "pong");
    return;
  }

  if (command === "!help" || command === "!commands") {
    await sendChannelMessage(targetId, formatCommands());
    return;
  }

  if (command === "!verify" || command === "!link") {
    await verifyEclCode(event, args[0]);
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

    const parts = content.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    await handleCommand(event, command, args);
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


