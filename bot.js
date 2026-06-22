require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");
const crypto = require("crypto");

console.log("ECL info bot starting");

const TOKEN = process.env.KOOK_BOT_TOKEN;
const API_BASE = "https://www.kookapp.cn/api/v3";
const SITE_URL = process.env.ECL_SITE_URL || "https://eclchina.lol";
const KOOK_VERIFY_SECRET = process.env.ECL_KOOK_BOT_SECRET;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || "1969692300297863";
const RANKED_INHOUSE_CATEGORY_ID = process.env.KOOK_RANKED_INHOUSE_CATEGORY_ID || "8024346698320304";
const RANKED_INHOUSE_CHANNEL_ID = process.env.KOOK_RANKED_INHOUSE_CHANNEL_ID || "4175549527235352";
const ADMIN_KOOK_IDS = new Set([
  "678146923",    // doolittlesy
  "3929770295",   // MAD CUZ BAD
  "2796070748",   // Dixon
  "3149507900",   // muiri
  ...String(process.env.ADMIN_KOOK_IDS || "").split(",").map((id) => id.trim()).filter(Boolean),
]);
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
    "- !inhouse (check voice channel roster)",
    "- !ready (balance teams + create IH #XXX)",
    "- !status",
    "- !report (list unreported games)",
    "- !report 1 (preview game from lzyumi)",
    "- !confirm (submit previewed game)",
    "- !cancel (cancel pending report or active session)",
    "- !refresh (admin)",
    "",
    "Flow: !inhouse → !ready → play → !report → !report 1 → !confirm",
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
    .map((user) => {
      // Kook returns either flat { id, username } or nested { user: { id, username } }
      const u = user.user || user;
      const id = String(u.id || u.user_id || user.id || user.user_id || "");
      const username = u.username || u.nickname || u.name || user.username || user.nickname || "";
      return { id, userId: id, username, nickname: username };
    })
    .filter((user) => user.id);
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

// ─── Lzyumi helpers (runs on bot machine = residential IP, not cloud-blocked) ──

const LZYUMI_BASE = "https://a.2025lol.top/lzyumi/lol/info";

const CHINA_SERVERS = {
  1: "艾欧尼亚",
  14: "黑色玫瑰",
  31: "峡谷之巅",
  30: "男爵领域",
  3: "祖安",
  4: "诺克萨斯",
  16: "恕瑞玛",
};

function createLzyumiSignature() {
  const now = new Date();
  const MM = String(now.getMonth() + 1);
  const DD = String(now.getDate());
  const HH = String(now.getHours());
  const mm = String(now.getMinutes());
  const ss = String(now.getSeconds());
  const signSource = `dld${MM.padStart(2, "0")}o${DD.padStart(2, "0")}u${HH.padStart(2, "0")}d${mm.padStart(2, "0")}o${ss.padStart(2, "0")}dld`;
  const lzyumiSign = crypto.createHash("md5").update(signSource).digest("hex");
  const signStr = `${MM}${DD}${HH}${mm}${ss}${MM.length * 3}${DD.length * 3}${HH.length * 3}${mm.length * 3}${ss.length * 3}`;
  return { lzyumiSign, signStr };
}

const LZYUMI_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Referer: "https://a.2025lol.top/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function lzyumiFetch(url) {
  const res = await axios.get(url, { headers: LZYUMI_HEADERS, timeout: 15000 });
  return res.data;
}

async function fetchLzyumiProfile(riotName, areaId, filter = 1, allCount = 10) {
  const { lzyumiSign, signStr } = createLzyumiSignature();
  const areaName = CHINA_SERVERS[areaId] || CHINA_SERVERS[1];
  const encoded = riotName.trim().replace(/#/g, "*~*~*");
  const params = [
    `nickname=${encodeURIComponent(encoded)}`,
    `allCount=${allCount}`,
    `areaId=${areaId}`,
    `areaName=${encodeURIComponent(areaName)}`,
    "seleMe=1",
    `filter=${filter}`,
    "openId=",
    `lzyumiSign=${lzyumiSign}`,
    `signStr=${signStr}`,
  ];
  return lzyumiFetch(`${LZYUMI_BASE}?${params.join("&")}`);
}

async function fetchLzyumiDetail(openId, gameId, areaId) {
  const { lzyumiSign, signStr } = createLzyumiSignature();
  const url = new URL(`${LZYUMI_BASE}/findOrderDetailInfoAll`);
  url.searchParams.set("openId", openId);
  url.searchParams.set("gameId", gameId);
  url.searchParams.set("areaId", String(areaId));
  url.searchParams.set("lzyumiSign", lzyumiSign);
  url.searchParams.set("signStr", signStr);
  return lzyumiFetch(url.toString());
}

async function fetchLzyumiRankedGames(riotName, riotTag, areaId) {
  const nickname = riotTag ? `${riotName}#${riotTag}` : riotName;
  const [soloJson, flexJson] = await Promise.all([
    fetchLzyumiProfile(nickname, areaId, 2, 20),
    fetchLzyumiProfile(nickname, areaId, 3, 20),
  ]);
  return {
    soloGames: Array.isArray(soloJson?.data) ? soloJson.data : [],
    flexGames: Array.isArray(flexJson?.data) ? flexJson.data : [],
  };
}

async function fetchLzyumiMatchForReport(riotName, areaId) {
  const profile = await fetchLzyumiProfile(riotName, areaId);
  const openId = profile?.battleInfo?.openId;
  const games = Array.isArray(profile?.data) ? profile.data : [];
  const latestGame = games.find((g) => g?.gameId);

  if (!openId || !latestGame?.gameId) {
    throw new Error(`Could not get openId or gameId from lzyumi for ${riotName}`);
  }

  const detail = await fetchLzyumiDetail(openId, latestGame.gameId, areaId);

  return {
    profile,
    gameId: latestGame.gameId,
    detail,
  };
}

// ──────────────────────────────────────────────────────────────────────────────

async function handleInhouseCommand(event, command, forceAdmin = false) {
  const members = await getVoiceMembers(RANKED_INHOUSE_CHANNEL_ID);
  const data = await callEclApi("/api/kook/inhouse", {
    command: command === "!forceready" ? "!ready" : command,
    channelId: RANKED_INHOUSE_CHANNEL_ID,
    members,
    isAdmin: forceAdmin || isAdminEvent(event),
  });

  await sendChannelMessage(event.target_id, data.reply || "Inhouse command completed.");

  if ((command === "!ready" || command === "!forceready") && Array.isArray(data.moveInstructions)) {
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

// ──────────────────────────────────────────────────────────────────────────────
// Multi-step !report state (in-memory; lost on restart, which is acceptable)
// ──────────────────────────────────────────────────────────────────────────────

const pendingReports = new Map();
// entry: {
//   stage: "selecting" | "confirming",
//   sessions: [...],          // from pending-sessions API
//   selectedSession: {...},   // set in "confirming" stage
//   rawMatchData: {...},      // set in "confirming" stage
//   ts: Date.now(),
// }
const PENDING_REPORT_TTL_MS = 10 * 60 * 1000; // 10 min

function clearStalePendingReports() {
  const now = Date.now();
  for (const [key, entry] of pendingReports.entries()) {
    if (now - entry.ts > PENDING_REPORT_TTL_MS) pendingReports.delete(key);
  }
}

function formatLzyumiMatchPreview(session, rawMatchData) {
  const { profile, gameId, detail } = rawMatchData;

  // Find the time string for this specific game
  const games = Array.isArray(profile?.data) ? profile.data : [];
  const matchEntry = games.find((g) => g?.gameId === gameId);
  const timeStr = matchEntry?.titleTime || "unknown time";

  // Group lzyumi players by their teamId
  const players = detail?.data?.wgBattleDetailInfo || [];
  const teamMap = {};
  for (const p of players) {
    const tid = String(p.teamId || "?");
    if (!teamMap[tid]) teamMap[tid] = [];
    const name = p.nickNameStr || p.nickName || "?";
    teamMap[tid].push(name);
  }

  const teamEntries = Object.entries(teamMap);
  const teamLines = teamEntries
    .map(([, names], i) => `${i === 0 ? "Blue" : "Red"} Team: ${names.join(", ")}`)
    .join("\n");

  const label = session.gameLabel || "IH Game";
  return [
    `**${label}** — ${timeStr}`,
    "",
    teamLines || "(No player data found)",
    "",
    "Is this your game? Type **!confirm** to submit, or **!cancel** to abort.",
  ].join("\n");
}

async function handleReportCommand(event, args) {
  clearStalePendingReports();
  const kookUserId = getKookUserId(event);
  const targetId = event.target_id;

  // ── "!report N" — user picked a game from the list ────────────────────────
  if (args.length > 0) {
    const selection = parseInt(args[0], 10);
    const entry = pendingReports.get(kookUserId);
    let sessions = entry?.sessions;

    // Re-fetch if no stored list or it's stale
    if (!sessions) {
      try {
        const res = await axios.get(`${SITE_URL}/api/kook/inhouse/pending-sessions`, {
          params: { kookUserId },
          headers: { "Content-Type": "application/json", "x-ecl-kook-secret": KOOK_VERIFY_SECRET },
          timeout: 15000,
        });
        sessions = res.data?.sessions || [];
      } catch (err) {
        await sendChannelMessage(targetId, `Could not fetch pending sessions: ${err.message}`);
        return;
      }
    }

    if (!sessions || sessions.length === 0) {
      await sendChannelMessage(targetId, "No pending inhouse games found.");
      pendingReports.delete(kookUserId);
      return;
    }

    const index = isNaN(selection) ? -1 : selection - 1;
    if (index < 0 || index >= sessions.length) {
      await sendChannelMessage(
        targetId,
        `Pick a number between 1 and ${sessions.length}. Type **!report** to see the list again.`,
      );
      return;
    }

    const selectedSession = sessions[index];
    await sendChannelMessage(targetId, `Fetching lzyumi data for ${selectedSession.gameLabel || "the selected game"}…`);

    // Get reporter info
    let reporterInfo = null;
    try {
      const res = await axios.get(`${SITE_URL}/api/kook/inhouse/reporter-info`, {
        params: { kookUserId },
        headers: { "Content-Type": "application/json", "x-ecl-kook-secret": KOOK_VERIFY_SECRET },
        timeout: 15000,
      });
      reporterInfo = res.data;
    } catch (err) {
      await sendChannelMessage(targetId, `Could not get your ECL profile: ${err.response?.data?.message || err.message}`);
      return;
    }

    // Fetch match from lzyumi
    let rawMatchData = null;
    try {
      rawMatchData = await fetchLzyumiMatchForReport(reporterInfo.riotName, reporterInfo.areaId);
    } catch (err) {
      await sendChannelMessage(
        targetId,
        `Could not fetch your latest game from lzyumi: ${err.message}\n` +
        `If Railway is IP-blocked, use the **Report Inhouse Game** button on the ECL website instead.`,
      );
      return;
    }

    // Store in pending map and show preview
    pendingReports.set(kookUserId, {
      stage: "confirming",
      sessions,
      selectedSession,
      rawMatchData,
      ts: Date.now(),
    });

    const preview = formatLzyumiMatchPreview(selectedSession, rawMatchData);
    await sendChannelMessage(targetId, preview);
    return;
  }

  // ── "!report" with no args — show the game list ───────────────────────────
  let sessions;
  try {
    const res = await axios.get(`${SITE_URL}/api/kook/inhouse/pending-sessions`, {
      params: { kookUserId },
      headers: { "Content-Type": "application/json", "x-ecl-kook-secret": KOOK_VERIFY_SECRET },
      timeout: 15000,
    });
    sessions = res.data?.sessions || [];
  } catch (err) {
    await sendChannelMessage(targetId, `Could not fetch inhouse sessions: ${err.message}`);
    return;
  }

  if (sessions.length === 0) {
    await sendChannelMessage(
      targetId,
      "No pending inhouse games found. Start a game with **!inhouse** and **!ready** first.",
    );
    return;
  }

  // Store session list in pending map
  pendingReports.set(kookUserId, { stage: "selecting", sessions, ts: Date.now() });

  const lines = sessions.map((s, i) => {
    const date = new Date(s.createdAt).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return `${i + 1}. **${s.gameLabel || "IH Game"}** — ${date}`;
  });

  // Always include the one-click browser link (bypasses IP block)
  const autoReportUrl = `${SITE_URL}/hub/me?autoreport=1`;

  await sendChannelMessage(
    targetId,
    [
      "Pending inhouse games:",
      ...lines,
      "",
      `**One-click report → ${autoReportUrl}**`,
      "(Opens your ECL profile and auto-submits the game — fastest method)",
      "",
      "Or type **!report 1** to preview first, then **!confirm** to submit.",
    ].join("\n"),
  );
}

async function handleConfirmCommand(event) {
  clearStalePendingReports();
  const kookUserId = getKookUserId(event);
  const targetId = event.target_id;

  const entry = pendingReports.get(kookUserId);
  if (!entry || entry.stage !== "confirming") {
    await sendChannelMessage(
      targetId,
      "Nothing to confirm. Type **!report** to start the report flow.",
    );
    return;
  }

  const { selectedSession, rawMatchData } = entry;

  const body = {
    command: "!report",
    reporterKookUserId: kookUserId,
    sessionId: selectedSession.id,
    rawMatchData,
  };

  const data = await callEclApi("/api/kook/inhouse/report", body);
  pendingReports.delete(kookUserId);
  await sendChannelMessage(targetId, data.reply || "Match reported successfully.");
}

const REFRESH_DELAY_MS = 2000;

async function handleRefreshCommand(event) {
  const targetId = event.target_id;

  if (!isAdminEvent(event)) {
    await sendChannelMessage(targetId, "Only admins can use !refresh.");
    return;
  }

  if (!KOOK_VERIFY_SECRET) {
    await sendChannelMessage(targetId, "Missing ECL_KOOK_BOT_SECRET — cannot authenticate with ECL.");
    return;
  }

  // Get stale/new players from ECL
  let profiles;
  try {
    const res = await axios.get(`${SITE_URL}/api/kook/refresh-players`, {
      headers: { "x-ecl-kook-secret": KOOK_VERIFY_SECRET },
      timeout: 15000,
    });
    profiles = res.data?.profiles || [];
  } catch (err) {
    await sendChannelMessage(targetId, `Refresh failed: ${err.response?.data?.message || err.message}`);
    return;
  }

  if (profiles.length === 0) {
    await sendChannelMessage(targetId, "All profiles are up to date. Nothing to refresh.");
    return;
  }

  await sendChannelMessage(targetId, `Refreshing ${profiles.length} player(s)... I will report back when done.`);

  let refreshed = 0;
  let failed = 0;
  const failedNames = [];

  for (const player of profiles) {
    try {
      const nickname = player.riotTag
        ? `${player.riotName}#${player.riotTag}`
        : player.riotName;
      const areaId = player.chinaServerId || 1;

      const [rawProfile, ranked] = await Promise.all([
        fetchLzyumiProfile(nickname, areaId, 1, 10),
        fetchLzyumiRankedGames(player.riotName, player.riotTag, areaId),
      ]);

      if (!rawProfile?.battleInfo) {
        console.warn(`[refresh] No battleInfo for ${player.displayName}`);
        failed++;
        failedNames.push(player.displayName);
      } else {
        await axios.post(
          `${SITE_URL}/api/kook/save-player-stats`,
          {
            profileId: player.id,
            rawProfile,
            soloGames: ranked.soloGames,
            flexGames: ranked.flexGames,
          },
          {
            headers: { "Content-Type": "application/json", "x-ecl-kook-secret": KOOK_VERIFY_SECRET },
            timeout: 15000,
          }
        );
        refreshed++;
        console.log(`[refresh] ✓ ${player.displayName} solo=${ranked.soloGames.length} flex=${ranked.flexGames.length}`);
      }
    } catch (err) {
      console.error(`[refresh] ✗ ${player.displayName}:`, err.message);
      failed++;
      failedNames.push(player.displayName);
    }

    await new Promise((r) => setTimeout(r, REFRESH_DELAY_MS));
  }

  const summary = [`Refresh complete. ${refreshed}/${profiles.length} updated.`];
  if (failedNames.length > 0) summary.push(`Failed: ${failedNames.join(", ")}`);
  await sendChannelMessage(targetId, summary.join(" "));
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

  if (command === "!status") {
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

  if (command === "!forceready") {
    if (!isAdminEvent(event)) {
      await sendChannelMessage(targetId, "Only admins can use !forceready.");
      return;
    }
    try {
      await handleInhouseCommand(event, "!forceready", true);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Forceready failed: ${message}`);
    }
    return;
  }

  if (command === "!report") {
    try {
      await handleReportCommand(event, args);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Report failed: ${message}`);
    }
    return;
  }

  if (command === "!confirm") {
    try {
      await handleConfirmCommand(event);
    } catch (err) {
      const message = err.response?.data?.reply || err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Confirm failed: ${message}`);
    }
    return;
  }

  if (command === "!cancel") {
    const kookUserId = getKookUserId(event);
    if (pendingReports.has(kookUserId)) {
      pendingReports.delete(kookUserId);
      await sendChannelMessage(targetId, "Cancelled. Type !report to start again.");
    } else {
      try {
        await handleStatusCommand(event, "!cancel");
      } catch (err) {
        const message = err.response?.data?.reply || err.response?.data?.message || err.message;
        await sendChannelMessage(targetId, `Command failed: ${message}`);
      }
    }
    return;
  }

  if (command === "!refresh") {
    try {
      await handleRefreshCommand(event);
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      await sendChannelMessage(targetId, `Refresh failed: ${message}`);
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


