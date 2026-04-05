require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");

const TOKEN = process.env.1/NDY1Njk=/aF4Tn0nAGxyBEjkIJMP+yw==;
const API_BASE = "https://www.kookapp.cn/api/v3";

if (!TOKEN) {
  console.error("1/NDY1Njk=/aF4Tn0nAGxyBEjkIJMP+yw==");
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