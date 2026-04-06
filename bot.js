require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");

console.log("🚀 NEW VERSION IS RUNNING");

const TOKEN = "1/NDY1Njk=/aF4Tn0nAGxyBEjkIJMP+yw==";
const API_BASE = "https://www.kookapp.cn/api/v3";
const WELCOME_CHANNEL_ID = "1969692300297863"; // replace this with your real channel ID

if (!TOKEN) {
  console.error("❌ Missing bot token");
  process.exit(1);
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
      }
    );
    console.log("✅ Sent:", content);
  } catch (err) {
    console.error("Send message error:", err.response?.data || err.message);
  }
}

async function sendWelcomeMessage() {
  try {
    const welcomeMessage = `🎉 Welcome to the Expat China League (ECL)
欢迎来到 Expat China League（ECL）

We’re a League of Legends community in China, active since 2016 — mixing expats and local players.
我们是一个在中国活跃的英雄联盟社区，成立于2016年，汇聚来自世界各地的玩家与中国本地玩家。

━━━━━━━━━━━━━━━

📌 Start here / 新手指南:
• Jump into any channel
• DM an admin if you need help
• Check the guide if you're new to CN servers

• 可以加入任意频道交流
• 有问题可以私信管理员
• 新玩家请查看新手指南

━━━━━━━━━━━━━━━

🚀 Want to play? / 想参加比赛？

Find a team or sign up as a free agent:
寻找队伍或以自由人身份报名：

https://eclchina.lol`;

    await axios.post(
      `${API_BASE}/message/create`,
      {
        target_id: WELCOME_CHANNEL_ID,
        content: welcomeMessage,
        type: 1,
      },
      {
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Welcome message sent");
  } catch (err) {
    console.error("❌ Failed to send welcome message:", err.response?.data || err.message);
  }
}

async function getGateway() {
  try {
    const res = await axios.get(`${API_BASE}/gateway/index`, {
      headers: {
        Authorization: `Bot ${TOKEN}`,
      },
    });

    let gatewayUrl = res.data.data.url;
    gatewayUrl = gatewayUrl.replace("compress=1", "compress=0");
    return gatewayUrl;
  } catch (err) {
    console.error("Gateway error:", err.response?.data || err.message);
    process.exit(1);
  }
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

async function startBot() {
  const gatewayUrl = await getGateway();
  console.log("Connecting to:", gatewayUrl);

  const ws = new WebSocket(gatewayUrl);

  let heartbeat = null;
  let lastSn = 0;

  ws.on("open", () => {
    console.log("✅ Bot connected to KOOK");
  });

  ws.on("message", async (raw) => {
    console.log("🔥 RAW MESSAGE RECEIVED");

    const packet = parsePacket(raw);
    if (!packet) return;

    console.log("📦 Packet s =", packet.s, "sn =", packet.sn ?? "none");

    if (typeof packet.sn === "number") {
      lastSn = packet.sn;
    }

    if (packet.s === 1) {
      console.log("🤝 HELLO:", packet.d);

      if (!heartbeat) {
        heartbeat = setInterval(() => {
          ws.send(JSON.stringify({ s: 2, sn: lastSn }));
          console.log("💓 Ping sent with sn =", lastSn);
        }, 30000);
        console.log("💓 Heartbeat started");
      }
      return;
    }

    if (packet.s === 3) {
      console.log("💚 PONG received");
      return;
    }

    if (packet.s === 0 && packet.d) {
      const event = packet.d;

      console.log("📨 FULL EVENT:", JSON.stringify(event, null, 2));

      // ----------------------------
      // 1. CHECK FOR USER JOIN EVENT
      // ----------------------------
      if (event.type === 255) {
        console.log("📢 System event detected");

        if (event.extra) {
          console.log("📢 System event extra:", JSON.stringify(event.extra, null, 2));
        }

        if (event.extra && event.extra.type === "joined_guild") {
          console.log("👤 New user joined the server");
          await sendWelcomeMessage();
          return;
        }
      }

      // ----------------------------
      // 2. NORMAL MESSAGE COMMANDS
      // ----------------------------
      const rawContent =
        event?.extra?.kmarkdown?.raw_content ??
        event?.content ??
        "";

      const content = String(rawContent).trim();
      console.log("📩 Parsed content:", content);

      if (!content) return;

      if (content === "!ping") {
        await sendChannelMessage(event.target_id, "pong");
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed");
    if (heartbeat) clearInterval(heartbeat);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

startBot();