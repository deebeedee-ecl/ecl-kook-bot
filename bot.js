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
const RANKED_INHOUSE_CHANNEL_ID = process.env.KOOK_RANKED_INHOUSE_CHANNEL_ID || "8024346698320304";
const ADMIN_KOOK_IDS = new Set(
  String(process.env.ADMIN_KOOK_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
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
    "- !welcome",
    "- !me",
    "- !rank",
    "- !elo / !leaderboard",
    "- !verify ECL-XXXXXX / !link ECL-XXXXXX",
    "- !inhouse",
    "- !ready",
    "- !status",
    "- !report",
    "- !cancel (admin)",
    "",
    "Use !verify with your dashboard code to link your KOOK account to ECL.",
  ].join("\n");
}

function formatWelcomeMessage() {
  return [
    "Welcome to the Expat China League (ECL)",
    "欢迎来到 Expat China League（ECL）",
    "",
    "We're a League of Legends community in China, active since 2016 - mixing expats and local players.",
    "我们是一个在中国活跃的英雄联盟社区，成立于2016年，汇聚来自世界各地的玩家与中国本地玩家。",
    "",
    "━━━━━━━━━━━━━━━",
    "",
    "Start here / 新手指南:",
    "- Jump into any channel",
    "- DM an admin if you need help",
    "- Check the guide if you're new to CN servers",
    "",
    "- 可以加入任意频道交流",
    "- 有问题可以私信管理员",
    "- 新玩家请查看新手指南",
    "",
    "━━━━━━━━━━━━━━━",
    "",
    "Want to play? / 想参加比赛？",
    "",
    "Find a team, sign up as a free agent, or verify your account for ranked inhouses:",
    "寻找队伍、以自由人身份报名，或验证账号参加排位内战：",
    "",
    SITE_URL,
    "",
    "To play ranked inhouses, create/log in to your ECL account, open your Hub/profile, copy your KOOK verification code, then type:",
    "如果想参加排位内战，请登录 ECL 账号，进入 Hub / 个人资料页面，复制 KOOK 验证码，然后输入：",
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

function siteHeaders() {
  return {
    "Content-Type": "application/json",
    "x-ecl-kook-secret": KOOK_VERIFY_SECRET,
  };
}

async function callEclApi(path, body) {
  if (!KOOK_VERIFY_SECRET) {
    throw new Error("Missing ECL_KOOK_BOT_SECRET.");
  }

  const res = await axios.post(`${SITE_URL}${path}`, body, {
    headers: siteHeaders(),
    timeout: 30000,
  });

  return res.data;
}

function getKookHeaders() {
  return {
    Authorization: `Bot ${TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function getVoiceMembers(channelId = RANKED_INHOUSE_CHANNEL_ID) {
  const res = await axios.get(`${API_BASE}/channel/user-list`, {
    params: {
      channel_id: channelId,
    },
    headers: getKookHeaders(),
    timeout: 15000,
  });

  const users = res.data?.data?.items || res.data?.data || [];
  if (!Array.isArray(users)) return [];

  return users
    .map((user) => ({
      id: String(user.id || user.user_id || ""),
      userId: String(user.id || user.user_id || ""),
      username: user.username || user.nickname || user.name || "",
      nickname: user.nickname || user.username || user.name || "",
    }))
    .filter((user) => user.id || user.userId);
}

async function moveVoiceUser(kookUserId, targetChannelId) {
  const payloads = [
    {
      target_id: targetChannelId,
      user_ids: [kookUserId],
    },
    {
      channel_id: targetChannelId,
      user_ids: [kookUserId],
    },
    {
      target_id: targetChannelId,
      user_id: kookUserId,
    },
  ];

  let lastError = null;

  for (const payload of payloads) {
    try {
      await axios.post(`${API_BASE}/channel/move-user`, payload, {
        headers: getKookHeaders(),
        timeout: 15000,
      });
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError?.response?.data || lastError?.message || "unknown error";
  console.error("Move user failed:", { kookUserId, targetChannelId, detail });
  return false;
}

async function moveInhousePlayers(moveInstructions) {
  const results = [];

  for (const instruction of moveInstructions || []) {
    const ok = await moveVoiceUser(instruction.kookUserId, instruction.targetChannelId);
    results.push({
      ...instruction,
      ok,
    });
  }

  return results;
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

function isAdminEvent(event) {
  const kookUserId = getKookUserId(event);
  return Boolean(kookUserId && ADMIN_KOOK_IDS.has(kookUserId));
}

function siteCommand(command) {
  if (command === "!elo") return "!leaderboard";
  return command;
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

async function handleSiteCommand(event, command) {
  const data = await callEclApi("/api/kook/commands", {
    command: siteCommand(command),
    kookUserId: getKookUserId(event),
    isAdmin: isAdminEvent(event),
  });

  await sendChannelMessage(event.target_id, data.reply || "Command completed.");
}

async function handleStatusCommand(event, command) {
  const members = await getVoiceMembers(RANKED_INHOUSE_CHANNEL_ID).catch(() => []);
  const data = await callEclApi("/api/kook/commands", {
    command: siteCommand(command),
    kookUserId: getKookUserId(event),
    members,
    isAdmin: isAdminEvent(event),
  });

  await sendChannelMessage(event.target_id, data.reply || "Status checked.");
}

async function handleInhouseCommand(event, command) {
  const members = await getVoiceMembers(RANKED_INHOUSE_CHANNEL_ID);
  const data = await callEclApi("/api/kook/inhouse", {
    command,
    channelId: RANKED_INHOUSE_CHANNEL_ID,
    members,
  });

  await sendChannelMessage(event.target_id, data.reply || "Inhouse command completed.");

  if (command === "!ready" && Array.isArray(data.moveInstructions)) {
    const moveResults = await moveInhousePlayers(data.moveInstructions);
    const failed = moveResults.filter((result) => !result.ok);

    if (failed.length === 0) {
      await sendChannelMessage(event.target_id, "Players moved to Blue Side and Red Side.");
      return;
    }

    await sendChannelMessage(
      event.target_id,
      `Teams are balanced, but I could not move ${failed.length} player(s). Please move manually if needed.`
    );
  }
}

async function handleReportCommand(event) {
  const data = await callEclApi("/api/kook/inhouse/report", {
    command: "!report",
    reporterKookUserId: getKookUserId(event),
  });

  await sendChannelMessage(event.target_id, data.reply || "Report completed.");
}

async function handleCommand(event, command, args) {
  const targetId = event.target_id;

  if (command === "!ping") {
    await sendChannelMessage(targetId, "pong");
    return;
  }

  if (command === "!help" || command === "!commands") {
    try {
      await handleSiteCommand(event, command);
    } catch {
      await sendChannelMessage(targetId, formatCommands());
    }
    return;
  }

  if (command === "!verify" || command === "!link") {
    await verifyEclCode(event, args[0]);
    return;
  }

  if (
    command === "!welcome" ||
    command === "!me" ||
    command === "!rank" ||
    command === "!elo" ||
    command === "!leaderboard"
  ) {
    try {
      await handleSiteCommand(event, command);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Command failed: ${message}`);
    }
    return;
  }

  if (command === "!status" || command === "!cancel") {
    try {
      await handleStatusCommand(event, command);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Command failed: ${message}`);
    }
    return;
  }

  if (command === "!inhouse" || command === "!ready") {
    try {
      await handleInhouseCommand(event, command);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Inhouse command failed: ${message}`);
    }
    return;
  }

  if (command === "!report") {
    try {
      await handleReportCommand(event);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Report failed: ${message}`);
    }
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
  console.log("Connecting to KOOK gateway");

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

    if (content) {
      console.log("Received message", {
        type: event.type,
        targetId: event.target_id,
        startsWithCommand: content.startsWith("!"),
      });
    }

    if (!content.startsWith("!")) return;

    const parts = content.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    console.log("Handling command", { command, targetId: event.target_id });
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


