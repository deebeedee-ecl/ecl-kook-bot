require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");

console.log("🚀 ECL BOT STARTING");

const TOKEN = process.env.KOOK_BOT_TOKEN;
const API_BASE = "https://www.kookapp.cn/api/v3";

const WEBSITE_BASE_URL =
  process.env.WEBSITE_BASE_URL || "https://eclchina.lol";
const OCR_BASE_URL =
  process.env.OCR_BASE_URL || "https://ecl-ocr-production.up.railway.app";
const WEBSITE_API_TOKEN = process.env.WEBSITE_API_TOKEN || "";

const WELCOME_CHANNEL_ID = "1969692300297863";
const CAPTAINS_CHAT_CHANNEL_ID = "8269169887027285";
const ECL_HUB_CHANNEL_ID = "6687085374683659";

const ALLOWED_COMMAND_CHANNEL_IDS = new Set([
  CAPTAINS_CHAT_CHANNEL_ID,
  ECL_HUB_CHANNEL_ID,
]);

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const OCR_TIMEOUT_MS = 180 * 1000;
const WEBSITE_TIMEOUT_MS = 30 * 1000;
const RECONNECT_DELAY_MS = 5000;

// =============================
// ADMINS
// =============================
const admins = {
  "3149507900": {
    nickname: "dbd",
    roleLabel: "Head Admin",
    supreme: true,
  },
  "2980365563": {
    nickname: "Soul",
    roleLabel: "ECL Admin",
    supreme: false,
  },
  "2789357366": {
    nickname: "Joe",
    roleLabel: "ECL Admin",
    supreme: false,
  },
};

// =============================
// TEAMS / CAPTAINS / TEAM IDS
// =============================
const teamsByTag = {
  BIY: {
    tag: "BIY",
    teamName: "Bean In Your Mum",
    teamId: "9a25fe77-db90-4bde-9918-6c34a69e2a8d",
    captainId: "2796070748",
    captainNickname: "Dixon",
  },
  NIU: {
    tag: "NIU",
    teamName: "NiuNiuPower",
    teamId: "3a935485-b3fc-4c4e-9c0a-7184f8f01e60",
    captainId: "3933904036",
    captainNickname: "Zeus",
  },
  ZAF: {
    tag: "ZAF",
    teamName: "Zycope & Friends",
    teamId: "9011e35c-0268-4503-bd56-0ee86879ce5e",
    captainId: "2831795126",
    captainNickname: "Poopswag",
  },
  MFG: {
    tag: "MFG",
    teamName: "Make France Great Again",
    teamId: "4ec54c7e-3762-4336-a7fc-8be88688e26d",
    captainId: "1405022101",
    captainNickname: "Sheniqua",
  },
  EB: {
    tag: "EB",
    teamName: "Exiled Bunzz",
    teamId: "e0ea817b-a770-44fe-81ff-9f3906875e83",
    captainId: "3557600370",
    captainNickname: "Exile",
  },
  FLA: {
    tag: "FLA",
    teamName: "Flanmingos",
    teamId: "0ce4c650-b196-44ba-baf8-31928e1c48bc",
    captainId: "2522160383",
    captainNickname: "Flan",
  },
};

const teams = Object.values(teamsByTag);

const captainsByUserId = {};
for (const team of teams) {
  captainsByUserId[team.captainId] = {
    nickname: team.captainNickname,
    teamName: team.teamName,
    tag: team.tag,
    teamId: team.teamId,
  };
}

// =============================
// TEMP STORAGE (resets on restart)
// =============================
const scheduleSessions = {};
const cancelSessions = {};
const resultSessions = {};
const resendSessions = {};
const proposals = [];
const reports = [];
const submittedGames = {}; // key: `${matchId}:${gameNumber}`

let nextProposalId = 1;
let nextReportId = 1;

if (!TOKEN) {
  console.error("❌ Missing KOOK_BOT_TOKEN");
  process.exit(1);
}

// =============================
// HELPERS
// =============================
function nowMs() {
  return Date.now();
}

function isAdmin(userId) {
  return !!admins[String(userId)];
}

function isSupremeAdmin(userId) {
  return !!admins[String(userId)]?.supreme;
}

function getAdmin(userId) {
  return admins[String(userId)] || null;
}

function getCaptain(userId) {
  return captainsByUserId[String(userId)] || null;
}

function isCaptain(userId) {
  return !!getCaptain(userId);
}

function isAdminOrCaptain(userId) {
  return isAdmin(userId) || isCaptain(userId);
}

function makeSession(step, extra = {}) {
  return {
    ...extra,
    step,
    createdAt: extra.createdAt ?? nowMs(),
    updatedAt: nowMs(),
  };
}

function touchSession(session) {
  if (!session) return session;
  session.updatedAt = nowMs();
  return session;
}

function isSessionExpired(session) {
  if (!session) return true;
  return nowMs() - (session.updatedAt || session.createdAt || 0) > SESSION_TIMEOUT_MS;
}

function cleanupExpiredSessions() {
  const buckets = [scheduleSessions, cancelSessions, resultSessions, resendSessions];

  for (const bucket of buckets) {
    for (const userId of Object.keys(bucket)) {
      if (isSessionExpired(bucket[userId])) {
        delete bucket[userId];
      }
    }
  }
}

function clearUserSessions(userId) {
  delete scheduleSessions[userId];
  delete cancelSessions[userId];
  delete resultSessions[userId];
  delete resendSessions[userId];
}

function isDirectMessageEvent(event) {
  return !event?.extra?.guild_id;
}

function isAllowedCommandContext(event) {
  if (isDirectMessageEvent(event)) return true;
  const targetId = String(event.target_id || "");
  return ALLOWED_COMMAND_CHANNEL_IDS.has(targetId);
}

function getAvailableOpponentsByTag(excludeTag) {
  return teams.filter((team) => team.tag !== excludeTag);
}

function getAllTeamsSorted() {
  return [...teams].sort((a, b) => a.teamName.localeCompare(b.teamName));
}

function getFormatOptions() {
  return ["BO1", "BO2", "BO3", "BO5"];
}

function getGameCountFromFormat(format) {
  if (format === "BO1") return 1;
  if (format === "BO2") return 2;
  if (format === "BO3") return 3;
  if (format === "BO5") return 5;
  return 1;
}

function getBestOfFromFormat(format) {
  return getGameCountFromFormat(format);
}

function getPublicGameLabel(gameNumber) {
  return `G${String(gameNumber).padStart(3, "0")}`;
}

function getSubmittedGameKey(matchId, gameNumber) {
  return `${matchId}:${gameNumber}`;
}

function markGameSubmitted(matchId, gameNumber, extra = {}) {
  submittedGames[getSubmittedGameKey(matchId, gameNumber)] = {
    status: "submitted",
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function markGameFailed(matchId, gameNumber, extra = {}) {
  submittedGames[getSubmittedGameKey(matchId, gameNumber)] = {
    status: "failed",
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function getGameSubmissionState(matchId, gameNumber) {
  return submittedGames[getSubmittedGameKey(matchId, gameNumber)] || null;
}

function getMonthOptions() {
  return [
    { label: "April", month: 4 },
    { label: "May", month: 5 },
  ];
}

function getDayOptions(month) {
  if (month === 4) {
    return Array.from({ length: 11 }, (_, i) => 20 + i); // 20-30
  }
  if (month === 5) {
    return Array.from({ length: 20 }, (_, i) => 1 + i); // 1-20
  }
  return [];
}

function getTimeOptions() {
  const options = [];
  let hour = 14;
  let minute = 0;

  while (hour < 24 || (hour === 24 && minute === 0)) {
    const displayHour = hour === 24 ? 0 : hour;
    const hh = String(displayHour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    options.push(`${hh}:${mm}`);

    minute += 30;
    if (minute >= 60) {
      minute = 0;
      hour += 1;
    }
    if (hour === 24 && minute > 0) break;
  }

  if (!options.includes("00:00")) {
    options.push("00:00");
  }

  return options;
}

function formatLocalDateTime(dateObj) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(dateObj);
  } catch {
    return dateObj.toISOString();
  }
}

function buildShanghaiIsoFromSelection(month, day, timeStr) {
  const [hourStr, minuteStr] = timeStr.split(":");
  const monthPadded = String(month).padStart(2, "0");
  const dayPadded = String(day).padStart(2, "0");

  const source = `2026-${monthPadded}-${dayPadded}T${hourStr}:${minuteStr}:00+08:00`;
  return new Date(source).toISOString();
}

function formatScheduleDisplay(month, day, timeStr) {
  const monthName = month === 4 ? "April" : "May";
  return `${monthName} ${day}, 2026 — ${timeStr}`;
}

function formatCommands() {
  return `📘 ECL Bot Commands / 指令列表

General / 通用:
• !ping
• !status
• !commands
• !help
• !me
• !captains
• !teams

Public info / 信息:
• !matches
• !mygames
• !leaderboard
• !standings

Scheduling / 赛程:
• !schedule
• !accept PROPOSAL_ID
• !reject PROPOSAL_ID
• !cancel
• !unschedule

Results / 赛果:
• !report
• !resend

Admin / 管理:
• Head Admin can schedule, cancel, submit, and resend any game.`;
}

function formatProposal(proposal) {
  return `Proposal #${proposal.id}
${proposal.fromTeam} [${proposal.fromTag}] vs ${proposal.toTeam} [${proposal.toTag}]
Time / 时间: ${proposal.scheduleDisplay}
Format / 赛制: ${proposal.format}
Status / 状态: ${proposal.status}`;
}

function formatLiveMatch(match) {
  const displayTime = match.scheduledAt
    ? formatLocalDateTime(new Date(match.scheduledAt))
    : "Not scheduled";

  const format = `BO${match.bestOf || 1}`;

  return `${match.homeTeam?.name || "Unknown"} vs ${match.awayTeam?.name || "Unknown"} — ${displayTime} — ${format}`;
}

function formatPublicStandingsRow(row) {
  const diff = row.diff > 0 ? `+${row.diff}` : `${row.diff}`;
  return `${row.rank}. ${row.teamName} — P:${row.played} | GW:${row.gameW}-${row.gameL} | Diff:${diff} | Pts:${row.points}`;
}

function formatPublicLeaderboardRow(row) {
  return `${row.rank}. ${row.name} [${row.teamTag}] — ${row.elo} ELO | GP:${row.gamesPlayed} | WR:${row.winRate} | KDA:${row.kda} | MVP:${row.mvpCount} | ${row.streakLabel}`;
}

function getUserDisplayName(userId) {
  const admin = getAdmin(userId);
  if (admin) return `${admin.nickname} (${admin.roleLabel})`;

  const captain = getCaptain(userId);
  if (captain) {
    return `${captain.nickname} — ${captain.teamName} [${captain.tag}]`;
  }

  return `User ${userId}`;
}

function extractTextContent(event) {
  const rawContent =
    event?.extra?.kmarkdown?.raw_content ??
    event?.content ??
    "";

  return String(rawContent || "").trim();
}

function extractImageUrlFromText(text) {
  const match = text.match(/https?:\/\/\S+/i);
  return match ? match[0] : null;
}

function extractImageUrlFromEvent(event) {
  const text = extractTextContent(event);
  const urlFromText = extractImageUrlFromText(text);
  if (urlFromText) return urlFromText;

  const attachments =
    event?.extra?.attachments ||
    event?.attachments ||
    [];

  if (Array.isArray(attachments) && attachments.length > 0) {
    const first = attachments[0];
    return (
      first?.url ||
      first?.download_url ||
      first?.src ||
      null
    );
  }

  const extra = event?.extra || {};
  if (extra?.attachment?.url) return extra.attachment.url;
  if (extra?.attachment?.download_url) return extra.attachment.download_url;

  return null;
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
    console.log("✅ Channel message sent");
    return true;
  } catch (err) {
    console.error("Send channel message error:", err.response?.data || err.message);
    return false;
  }
}

async function sendPrivateMessage(userId, content) {
  try {
    await axios.post(
      `${API_BASE}/direct-message/create`,
      {
        target_id: userId,
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
    console.log(`✅ DM sent to ${userId}`);
    return true;
  } catch (err) {
    console.error("DM send error:", err.response?.data || err.message);
    return false;
  }
}

async function replyToEvent(event, content) {
  const authorId = String(event.author_id);

  if (isDirectMessageEvent(event)) {
    return sendPrivateMessage(authorId, content);
  }

  return sendChannelMessage(String(event.target_id), content);
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

    await sendChannelMessage(WELCOME_CHANNEL_ID, welcomeMessage);
  } catch (err) {
    console.error("❌ Failed to send welcome message:", err.message);
  }
}

async function getGateway() {
  try {
    const res = await axios.get(`${API_BASE}/gateway/index`, {
      headers: {
        Authorization: `Bot ${TOKEN}`,
      },
      timeout: 15000,
    });

    let gatewayUrl = res.data.data.url;
    gatewayUrl = gatewayUrl.replace("compress=1", "compress=0");
    return gatewayUrl;
  } catch (err) {
    console.error("Gateway error:", err.response?.data || err.message);
    throw err;
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

function getWebsiteHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };

  if (WEBSITE_API_TOKEN) {
    headers.Authorization = `Bearer ${WEBSITE_API_TOKEN}`;
  }

  return headers;
}

async function websiteGet(path) {
  const url = `${WEBSITE_BASE_URL}${path}`;
  const res = await axios.get(url, {
    headers: getWebsiteHeaders(),
    timeout: WEBSITE_TIMEOUT_MS,
  });
  return res.data;
}

async function websitePost(path, body) {
  const url = `${WEBSITE_BASE_URL}${path}`;
  const res = await axios.post(url, body, {
    headers: getWebsiteHeaders(),
    timeout: WEBSITE_TIMEOUT_MS,
  });
  return res.data;
}

async function websitePatch(path, body) {
  const url = `${WEBSITE_BASE_URL}${path}`;
  const res = await axios.patch(url, body, {
    headers: getWebsiteHeaders(),
    timeout: WEBSITE_TIMEOUT_MS,
  });
  return res.data;
}

async function websiteDelete(path) {
  const url = `${WEBSITE_BASE_URL}${path}`;
  const res = await axios.delete(url, {
    headers: getWebsiteHeaders(),
    timeout: WEBSITE_TIMEOUT_MS,
  });
  return res.data;
}

async function fetchAllMatches() {
  const matches = await websiteGet("/api/matches");
  return Array.isArray(matches) ? matches : [];
}

async function fetchScheduledMatches() {
  const matches = await fetchAllMatches();
  return matches.filter((match) => match.status === "SCHEDULED");
}

function getMatchesForCaptain(matches, captain) {
  if (!captain) return [];
  return matches.filter(
    (match) =>
      match.homeTeamId === captain.teamId || match.awayTeamId === captain.teamId
  );
}

function canUserAccessMatch(userId, match) {
  if (isAdmin(userId)) return true;
  const captain = getCaptain(userId);
  if (!captain) return false;
  return match.homeTeamId === captain.teamId || match.awayTeamId === captain.teamId;
}

async function createRealMatch({
  homeTeam,
  awayTeam,
  format,
  scheduledIso,
  notes,
}) {
  return websitePost("/api/matches", {
    homeTeamId: homeTeam.teamId,
    awayTeamId: awayTeam.teamId,
    stage: "REGULAR_SEASON",
    bestOf: getBestOfFromFormat(format),
    scheduledAt: scheduledIso,
    status: "SCHEDULED",
    notes: notes || "Created via KOOK bot",
  });
}

async function cancelRealMatch(matchId, cancelledByUserId) {
  try {
    return await websitePatch(`/api/matches/${matchId}`, {
      status: "CANCELLED",
      notes: `Cancelled via KOOK bot by ${getUserDisplayName(cancelledByUserId)}`,
    });
  } catch (err) {
    console.warn("PATCH cancel failed, attempting DELETE fallback");
    return websiteDelete(`/api/matches/${matchId}`);
  }
}

async function callOcr(matchId, gameNumber, screenshotUrl) {
  const url = `${OCR_BASE_URL}/ocr`;
  const res = await axios.post(
    url,
    {
      matchId,
      gameNumber,
      screenshotUrl,
    },
    {
      timeout: OCR_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
  return res.data;
}

async function fetchStandings() {
  const data = await websiteGet("/api/standings");
  return Array.isArray(data) ? data : [];
}

async function fetchLeaderboard() {
  const data = await websiteGet("/api/leaderboard");
  return Array.isArray(data) ? data : [];
}

function formatCaptainsList() {
  return teams
    .map(
      (team) =>
        `• ${team.captainNickname} — ${team.teamName} [${team.tag}]`
    )
    .join("\n");
}

function formatTeamsList() {
  return teams.map((team) => `• ${team.teamName} [${team.tag}]`).join("\n");
}

async function announceMatchScheduled(match) {
  await sendChannelMessage(
    CAPTAINS_CHAT_CHANNEL_ID,
    `📅 Match Scheduled! / 比赛已安排！\n${formatLiveMatch(match)}`
  );
}

async function announceMatchCancelled(match) {
  await sendChannelMessage(
    CAPTAINS_CHAT_CHANNEL_ID,
    `🛑 Match Cancelled! / 比赛已取消！\n${formatLiveMatch(match)}`
  );
}

function getGameStatusLabel(matchId, gameNumber) {
  const state = getGameSubmissionState(matchId, gameNumber);
  if (!state) return "pending";
  return state.status || "pending";
}

function buildGameOptionsMessage(match, gameCount) {
  const lines = [];
  for (let i = 1; i <= gameCount; i++) {
    const label = getPublicGameLabel(i);
    const status = getGameStatusLabel(match.id, i);
    lines.push(`${i}. ${label} — ${status}`);
  }
  return lines.join("\n");
}

function getScheduleSummary({ homeTeam, awayTeam, month, day, timeStr, format }) {
  return `${homeTeam.teamName} [${homeTeam.tag}] vs ${awayTeam.teamName} [${awayTeam.tag}]
Time / 时间: ${formatScheduleDisplay(month, day, timeStr)}
Format / 赛制: ${format}`;
}

// =============================
// FLOW HANDLERS
// =============================
async function startScheduleFlow(event, authorId) {
  const admin = getAdmin(authorId);
  const captain = getCaptain(authorId);

  if (!admin && !captain) {
    await replyToEvent(
      event,
      "Only admins or captains can schedule matches.\n只有管理员或队长可以安排比赛。"
    );
    return;
  }

  clearUserSessions(authorId);

  if (admin) {
    const teamOptions = getAllTeamsSorted();

    scheduleSessions[authorId] = makeSession("choose_home_team", {
      isAdminFlow: true,
      teamOptions,
    });

    const message = teamOptions
      .map((team, index) => `${index + 1}. ${team.teamName} [${team.tag}]`)
      .join("\n");

    await replyToEvent(
      event,
      `Choose the first team / 请选择第一支队伍：\n\n${message}\n\nReply with a number / 回复对应数字。`
    );
    return;
  }

  const opponents = getAvailableOpponentsByTag(captain.tag);

  scheduleSessions[authorId] = makeSession("choose_opponent", {
    isAdminFlow: false,
    homeTeam: teamsByTag[captain.tag],
    opponents,
  });

  const message = opponents
    .map((team, index) => `${index + 1}. ${team.teamName} [${team.tag}]`)
    .join("\n");

  await replyToEvent(
    event,
    `Choose the opposing team / 请选择对手队伍：\n\n${message}\n\nReply with a number / 回复对应数字。`
  );
}

async function handleScheduleSession(event, authorId, content) {
  const session = scheduleSessions[authorId];
  if (!session) return false;

  if (isSessionExpired(session)) {
    delete scheduleSessions[authorId];
    await replyToEvent(
      event,
      "Your scheduling session expired. Please start again with !schedule.\n你的排期会话已过期，请重新输入 !schedule。"
    );
    return true;
  }

  touchSession(session);

  if (session.step === "choose_home_team") {
    const choice = Number(content);
    if (!Number.isInteger(choice) || choice < 1 || choice > session.teamOptions.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with a team number.\n无效选择，请回复队伍编号。"
      );
      return true;
    }

    const homeTeam = session.teamOptions[choice - 1];
    const opponents = getAvailableOpponentsByTag(homeTeam.tag);

    scheduleSessions[authorId] = makeSession("choose_opponent", {
      ...session,
      isAdminFlow: true,
      homeTeam,
      opponents,
    });

    const message = opponents
      .map((team, index) => `${index + 1}. ${team.teamName} [${team.tag}]`)
      .join("\n");

    await replyToEvent(
      event,
      `Choose the opposing team / 请选择对手队伍：\n\n${message}\n\nReply with a number / 回复对应数字。`
    );
    return true;
  }

  if (session.step === "choose_opponent") {
    const choice = Number(content);
    if (!Number.isInteger(choice) || choice < 1 || choice > session.opponents.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with a team number.\n无效选择，请回复队伍编号。"
      );
      return true;
    }

    const awayTeam = session.opponents[choice - 1];

    scheduleSessions[authorId] = makeSession("choose_month", {
      ...session,
      homeTeam: session.homeTeam,
      awayTeam,
    });

    await replyToEvent(
      event,
      `Choose month / 请选择月份：\n\n1. April\n2. May\n\nReply with a number / 回复对应数字。`
    );
    return true;
  }

  if (session.step === "choose_month") {
    const choice = Number(content);
    const monthOptions = getMonthOptions();

    if (!Number.isInteger(choice) || choice < 1 || choice > monthOptions.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with 1 or 2.\n无效选择，请回复 1 或 2。"
      );
      return true;
    }

    const month = monthOptions[choice - 1].month;
    const dayOptions = getDayOptions(month);

    scheduleSessions[authorId] = makeSession("choose_day", {
      ...session,
      month,
      dayOptions,
    });

    const dayMessage = dayOptions
      .map((day, index) => `${index + 1}. ${day}`)
      .join("\n");

    await replyToEvent(
      event,
      `Choose day / 请选择日期：\n\n${dayMessage}\n\nReply with a number / 回复对应数字。`
    );
    return true;
  }

  if (session.step === "choose_day") {
    const choice = Number(content);
    if (!Number.isInteger(choice) || choice < 1 || choice > session.dayOptions.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with a day number from the list.\n无效选择，请回复列表中的日期编号。"
      );
      return true;
    }

    const day = session.dayOptions[choice - 1];
    const timeOptions = getTimeOptions();

    scheduleSessions[authorId] = makeSession("choose_time", {
      ...session,
      day,
      timeOptions,
    });

    const timeMessage = timeOptions
      .map((time, index) => `${index + 1}. ${time}`)
      .join("\n");

    await replyToEvent(
      event,
      `Choose time / 请选择时间：\n\n${timeMessage}\n\nReply with a number / 回复对应数字。`
    );
    return true;
  }

  if (session.step === "choose_time") {
    const choice = Number(content);
    if (!Number.isInteger(choice) || choice < 1 || choice > session.timeOptions.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with a time number from the list.\n无效选择，请回复列表中的时间编号。"
      );
      return true;
    }

    const timeStr = session.timeOptions[choice - 1];
    const formats = getFormatOptions();

    scheduleSessions[authorId] = makeSession("choose_format", {
      ...session,
      timeStr,
      formats,
    });

    const formatMessage = formats
      .map((format, index) => `${index + 1}. ${format}`)
      .join("\n");

    await replyToEvent(
      event,
      `Choose format / 请选择赛制：\n\n${formatMessage}\n\nReply with a number / 回复对应数字。`
    );
    return true;
  }

  if (session.step === "choose_format") {
    const choice = Number(content);
    if (!Number.isInteger(choice) || choice < 1 || choice > session.formats.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with a format number.\n无效选择，请回复赛制编号。"
      );
      return true;
    }

    const format = session.formats[choice - 1];

    scheduleSessions[authorId] = makeSession("confirm_schedule", {
      ...session,
      format,
    });

    const summary = getScheduleSummary({
      homeTeam: session.homeTeam,
      awayTeam: session.awayTeam,
      month: session.month,
      day: session.day,
      timeStr: session.timeStr,
      format,
    });

    await replyToEvent(
      event,
      `Confirm schedule / 请确认赛程：\n\n${summary}\n\nReply with:\nconfirm\nor\ncancel`
    );
    return true;
  }

  if (session.step === "confirm_schedule") {
    const lowered = content.toLowerCase();

    if (lowered === "cancel") {
      delete scheduleSessions[authorId];
      await replyToEvent(event, "Scheduling cancelled.\n已取消排期。");
      return true;
    }

    if (lowered !== "confirm") {
      await replyToEvent(
        event,
        "Reply with confirm or cancel.\n请回复 confirm 或 cancel。"
      );
      return true;
    }

    const scheduledIso = buildShanghaiIsoFromSelection(
      session.month,
      session.day,
      session.timeStr
    );

    if (session.isAdminFlow) {
      try {
        const match = await createRealMatch({
          homeTeam: session.homeTeam,
          awayTeam: session.awayTeam,
          format: session.format,
          scheduledIso,
          notes: `Created by ${getUserDisplayName(authorId)} via KOOK bot`,
        });

        delete scheduleSessions[authorId];

        await replyToEvent(
          event,
          `✅ Match created successfully.\n${formatLiveMatch(match)}`
        );

        await announceMatchScheduled(match);
      } catch (err) {
        console.error("Create match error:", err.response?.data || err.message);
        await replyToEvent(
          event,
          "❌ Failed to create the match in the website system. Please contact admin."
        );
      }

      return true;
    }

    const proposal = {
      id: nextProposalId++,
      fromCaptainId: authorId,
      fromTeam: session.homeTeam.teamName,
      fromTag: session.homeTeam.tag,
      fromTeamId: session.homeTeam.teamId,
      toCaptainId: session.awayTeam.captainId,
      toTeam: session.awayTeam.teamName,
      toTag: session.awayTeam.tag,
      toTeamId: session.awayTeam.teamId,
      month: session.month,
      day: session.day,
      timeStr: session.timeStr,
      scheduledIso,
      scheduleDisplay: formatScheduleDisplay(session.month, session.day, session.timeStr),
      format: session.format,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    proposals.push(proposal);
    delete scheduleSessions[authorId];

    await replyToEvent(
      event,
      `✅ Proposal sent / 对局申请已发送。\n${formatProposal(proposal)}`
    );

    const dmWorked = await sendPrivateMessage(
      proposal.toCaptainId,
      `📩 Match proposal received / 收到比赛申请

${proposal.fromTeam} [${proposal.fromTag}] wants to play your team ${proposal.toTeam} [${proposal.toTag}].
${proposal.fromTeam} [${proposal.fromTag}] 想和你的队伍 ${proposal.toTeam} [${proposal.toTag}] 进行比赛。

Proposed time / 提议时间:
${proposal.scheduleDisplay}

Format / 赛制:
${proposal.format}

Reply with / 回复以下指令:
!accept ${proposal.id}
or
!reject ${proposal.id}`
    );

    if (!dmWorked) {
      await sendChannelMessage(
        CAPTAINS_CHAT_CHANNEL_ID,
        `📩 Captain approval needed / 需要队长确认\n${formatProposal(proposal)}\n\nOpposing captain can reply with:\n!accept ${proposal.id}\n!reject ${proposal.id}`
      );
    }

    return true;
  }

  return false;
}

async function startCancelFlow(event, authorId) {
  if (!isAdminOrCaptain(authorId)) {
    await replyToEvent(
      event,
      "Only admins or captains can cancel matches.\n只有管理员或队长可以取消比赛。"
    );
    return;
  }

  clearUserSessions(authorId);

  try {
    const scheduledMatches = await fetchScheduledMatches();
    const accessibleMatches = isAdmin(authorId)
      ? scheduledMatches
      : getMatchesForCaptain(scheduledMatches, getCaptain(authorId));

    if (accessibleMatches.length === 0) {
      await replyToEvent(
        event,
        "No scheduled matches available to cancel.\n目前没有可取消的已安排比赛。"
      );
      return;
    }

    cancelSessions[authorId] = makeSession("choose_match", {
      matches: accessibleMatches,
    });

    const message = accessibleMatches
      .map((match, index) => `${index + 1}. ${formatLiveMatch(match)}`)
      .join("\n");

    await replyToEvent(
      event,
      `Which match do you want to cancel?\n你想取消哪一场比赛？\n\n${message}\n\nReply with a number / 回复对应数字。`
    );
  } catch (err) {
    console.error("Start cancel flow error:", err.response?.data || err.message);
    await replyToEvent(
      event,
      "❌ Failed to load scheduled matches. Please try again."
    );
  }
}

async function handleCancelSession(event, authorId, content) {
  const session = cancelSessions[authorId];
  if (!session) return false;

  if (isSessionExpired(session)) {
    delete cancelSessions[authorId];
    await replyToEvent(
      event,
      "Your cancel session expired. Please start again with !cancel.\n你的取消会话已过期，请重新输入 !cancel。"
    );
    return true;
  }

  touchSession(session);

  if (session.step === "choose_match") {
    const choice = Number(content);

    if (!Number.isInteger(choice) || choice < 1 || choice > session.matches.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with the match number from the list.\n无效选择，请回复列表中的比赛编号。"
      );
      return true;
    }

    const selectedMatch = session.matches[choice - 1];

    if (!canUserAccessMatch(authorId, selectedMatch)) {
      await replyToEvent(
        event,
        "You do not have permission to cancel this match.\n你没有权限取消这场比赛。"
      );
      return true;
    }

    try {
      await cancelRealMatch(selectedMatch.id, authorId);
      delete cancelSessions[authorId];

      await replyToEvent(
        event,
        `🛑 Match cancelled successfully.\n${formatLiveMatch(selectedMatch)}`
      );

      await announceMatchCancelled(selectedMatch);
    } catch (err) {
      console.error("Cancel match error:", err.response?.data || err.message);
      await replyToEvent(
        event,
        "❌ Failed to cancel the match in the website system."
      );
    }

    return true;
  }

  return false;
}

async function startResultFlow(event, authorId, isResend = false) {
  if (!isAdminOrCaptain(authorId)) {
    await replyToEvent(
      event,
      "Only admins or captains can submit results.\n只有管理员或队长可以提交赛果。"
    );
    return;
  }

  if (isResend && !isAdmin(authorId)) {
    await replyToEvent(
      event,
      "!resend is admin only.\n只有管理员可以使用 !resend。"
    );
    return;
  }

  clearUserSessions(authorId);

  try {
    const scheduledMatches = await fetchScheduledMatches();
    const accessibleMatches = isAdmin(authorId)
      ? scheduledMatches
      : getMatchesForCaptain(scheduledMatches, getCaptain(authorId));

    if (accessibleMatches.length === 0) {
      await replyToEvent(
        event,
        "No scheduled matches available.\n目前没有可上报的已安排比赛。"
      );
      return;
    }

    const bucket = isResend ? resendSessions : resultSessions;
    bucket[authorId] = makeSession("choose_match", {
      matches: accessibleMatches,
      isResend,
    });

    const message = accessibleMatches
      .map((match, index) => `${index + 1}. ${formatLiveMatch(match)}`)
      .join("\n");

    await replyToEvent(
      event,
      `${isResend ? "Which match do you want to resend?" : "Which match are you reporting?"}
${isResend ? "你要重传哪一场比赛？" : "你要上报哪一场比赛？"}

${message}

Reply with a number / 回复对应数字。`
    );
  } catch (err) {
    console.error("Start result flow error:", err.response?.data || err.message);
    await replyToEvent(
      event,
      "❌ Failed to load scheduled matches. Please try again."
    );
  }
}

async function handleResultLikeSession(event, authorId, content, isResend = false) {
  const bucket = isResend ? resendSessions : resultSessions;
  const session = bucket[authorId];
  if (!session) return false;

  if (isSessionExpired(session)) {
    delete bucket[authorId];
    await replyToEvent(
      event,
      `Your ${isResend ? "resend" : "report"} session expired. Please start again with ${isResend ? "!resend" : "!report"}.\n你的会话已过期，请重新开始。`
    );
    return true;
  }

  touchSession(session);

  if (session.step === "choose_match") {
    const choice = Number(content);

    if (!Number.isInteger(choice) || choice < 1 || choice > session.matches.length) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with the match number from the list.\n无效选择，请回复列表中的比赛编号。"
      );
      return true;
    }

    const selectedMatch = session.matches[choice - 1];
    const gameCount = Number(selectedMatch.bestOf || 1);

    bucket[authorId] = makeSession("choose_game", {
      ...session,
      selectedMatch,
      gameCount,
    });

    const gameOptions = buildGameOptionsMessage(selectedMatch, gameCount);

    await replyToEvent(
      event,
      `Which game?\n你要上报哪一局？\n\n${gameOptions}\n\nReply with a number / 回复对应数字。`
    );
    return true;
  }

  if (session.step === "choose_game") {
    const choice = Number(content);

    if (!Number.isInteger(choice) || choice < 1 || choice > session.gameCount) {
      await replyToEvent(
        event,
        "Invalid choice. Reply with the game number.\n无效选择，请回复局数编号。"
      );
      return true;
    }

    const selectedMatch = session.selectedMatch;
    const gameNumber = choice;
    const publicGameLabel = getPublicGameLabel(gameNumber);
    const state = getGameSubmissionState(selectedMatch.id, gameNumber);

    if (!isResend && state?.status === "submitted") {
      await replyToEvent(
        event,
        `${publicGameLabel} has already been submitted.\n${publicGameLabel} 已经提交过了。\n\nUse !resend if it failed before, or contact an admin if it was submitted incorrectly.`
      );
      delete bucket[authorId];
      return true;
    }

    bucket[authorId] = makeSession("await_screenshot", {
      ...session,
      selectedMatch,
      gameNumber,
      publicGameLabel,
    });

    await replyToEvent(
      event,
      `Please send the scoreboard screenshot for ${publicGameLabel}.\n请发送 ${publicGameLabel} 的战绩截图。\n\nYou can send a direct image URL.`
    );
    return true;
  }

  if (session.step === "await_screenshot") {
    const screenshotUrl = extractImageUrlFromText(content) || extractImageUrlFromEvent(event);

    if (!screenshotUrl) {
      await replyToEvent(
        event,
        "I couldn't find a screenshot URL. Please send a direct image URL.\n我没有找到截图链接，请发送可直接访问的图片链接。"
      );
      return true;
    }

    bucket[authorId] = makeSession("await_note", {
      ...session,
      screenshotUrl,
    });

    await replyToEvent(
      event,
      `Add a short note or type skip.\n请输入简短备注，或输入 skip 跳过。`
    );
    return true;
  }

  if (session.step === "await_note") {
    const note = content.toLowerCase() === "skip" ? "No note" : content;
    const publicGameLabel = session.publicGameLabel;
    const reporterName = getUserDisplayName(authorId);

    const report = {
      id: nextReportId++,
      matchId: session.selectedMatch.id,
      gameNumber: session.gameNumber,
      publicGameLabel,
      screenshotUrl: session.screenshotUrl,
      note,
      reporterId: authorId,
      reporterName,
      status: isResend ? "resending" : "processing",
      createdAt: new Date().toISOString(),
    };

    reports.push(report);
    delete bucket[authorId];

    await replyToEvent(
      event,
      `📸 Screenshot received for ${publicGameLabel}. Processing OCR...\n已收到 ${publicGameLabel} 的截图，正在处理 OCR。`
    );

    try {
      const ocrResult = await callOcr(
        session.selectedMatch.id,
        session.gameNumber,
        session.screenshotUrl
      );

      markGameSubmitted(session.selectedMatch.id, session.gameNumber, {
        publicGameLabel,
        ocrResult,
      });

      report.status = "submitted";
      report.ocrResult = ocrResult;

      const matchedPlayers = ocrResult?.matchedPlayers;
      const skippedPlayers = ocrResult?.skippedPlayers;

      let extraLine = "";
      if (
        typeof matchedPlayers === "number" ||
        typeof skippedPlayers === "number"
      ) {
        extraLine = `\nMatched: ${matchedPlayers ?? "?"} | Skipped: ${skippedPlayers ?? "?"}`;
      }

      await replyToEvent(
        event,
        `✅ ${publicGameLabel} processed successfully.${extraLine}`
      );
    } catch (err) {
      console.error("OCR error:", err.response?.data || err.message);

      markGameFailed(session.selectedMatch.id, session.gameNumber, {
        publicGameLabel,
        error: err.response?.data || err.message,
      });

      report.status = "failed";
      report.error = err.response?.data || err.message;

      await replyToEvent(
        event,
        `❌ ${publicGameLabel} failed to process.\nUse !resend if you want to try again, or contact an admin if it was submitted incorrectly.`
      );
    }

    return true;
  }

  return false;
}

// =============================
// COMMAND HANDLERS
// =============================
async function handleCommand(event, content) {
  console.log("⚙️ handleCommand called with:", JSON.stringify({
    authorId: event?.author_id,
    targetId: event?.target_id,
    guildId: event?.extra?.guild_id,
    content,
  }));

  const authorId = String(event.author_id);
  const admin = getAdmin(authorId);
  const captain = getCaptain(authorId);

  if (!content.startsWith("!")) {
    if (await handleCancelSession(event, authorId, content)) return;
    if (await handleResultLikeSession(event, authorId, content, false)) return;
    if (await handleResultLikeSession(event, authorId, content, true)) return;
    if (await handleScheduleSession(event, authorId, content)) return;
    return;
  }

  if (!isAllowedCommandContext(event)) {
    await replyToEvent(
      event,
      "Please use bot commands in Captains Chat, ECL HUB, or DM."
    );
    return;
  }

  const parts = content.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === "!ping") {
    await replyToEvent(event, "pong");
    return;
  }

  if (command === "!commands" || command === "!help") {
    await replyToEvent(event, formatCommands());
    return;
  }

  if (command === "!me" || command === "!whoami") {
    if (admin) {
      await replyToEvent(
        event,
        `You are an admin (${admin.roleLabel}).\n你是管理员（${admin.roleLabel}）。`
      );
      return;
    }

    if (captain) {
      await replyToEvent(
        event,
        `You are captain of ${captain.teamName} [${captain.tag}].\n你是 ${captain.teamName} [${captain.tag}] 的队长。`
      );
      return;
    }

    await replyToEvent(
      event,
      "Captain? No. Minion? Yes.\n你是队长吗？不是。你是小兵。"
    );
    return;
  }

  if (command === "!captains") {
    await replyToEvent(
      event,
      `👑 Current captains / 当前队长:\n\n${formatCaptainsList()}`
    );
    return;
  }

  if (command === "!teams") {
    await replyToEvent(
      event,
      `🛡️ Current teams / 当前队伍:\n\n${formatTeamsList()}`
    );
    return;
  }

  if (command === "!status") {
    const checks = [];

    checks.push("🤖 Bot: online");

    try {
      await websiteGet("/api/leaderboard");
      checks.push("🌐 Website API: online");
    } catch {
      checks.push("🌐 Website API: offline");
    }

    try {
      await axios.get(`${OCR_BASE_URL}/`, { timeout: 15000 });
      checks.push("🧠 OCR: online");
    } catch {
      checks.push("🧠 OCR: offline");
    }

    await replyToEvent(event, checks.join("\n"));
    return;
  }

  if (command === "!schedule") {
    await startScheduleFlow(event, authorId);
    return;
  }

  if (command === "!accept") {
    if (!captain && !isAdmin(authorId)) {
      await replyToEvent(
        event,
        "Only captains or admins can accept proposals.\n只有队长或管理员可以接受比赛申请。"
      );
      return;
    }

    const proposalId = Number(parts[1]);
    if (!proposalId) {
      await replyToEvent(event, "Usage: !accept PROPOSAL_ID");
      return;
    }

    const proposal = proposals.find((p) => p.id === proposalId);

    if (!proposal) {
      await replyToEvent(
        event,
        `No proposal found with ID ${proposalId}.\n未找到编号为 ${proposalId} 的申请。`
      );
      return;
    }

    if (!isAdmin(authorId) && proposal.toCaptainId !== authorId) {
      await replyToEvent(
        event,
        "Only the opposing captain can accept this proposal.\n只有对方队长可以接受这场申请。"
      );
      return;
    }

    if (proposal.status !== "pending") {
      await replyToEvent(
        event,
        `This proposal is already ${proposal.status}.\n该申请当前状态为 ${proposal.status}。`
      );
      return;
    }

    try {
      const homeTeam = teamsByTag[proposal.fromTag];
      const awayTeam = teamsByTag[proposal.toTag];

      const match = await createRealMatch({
        homeTeam,
        awayTeam,
        format: proposal.format,
        scheduledIso: proposal.scheduledIso,
        notes: `Created from proposal #${proposal.id} via KOOK bot`,
      });

      proposal.status = "accepted";
      proposal.matchId = match.id;
      proposal.acceptedAt = new Date().toISOString();

      await replyToEvent(
        event,
        `✅ Proposal accepted / 申请已接受。\n${formatProposal(proposal)}`
      );

      await sendPrivateMessage(
        proposal.fromCaptainId,
        `✅ Your proposal was accepted / 你的申请已被接受。\n${formatProposal(proposal)}`
      );

      await announceMatchScheduled(match);
    } catch (err) {
      console.error("Accept proposal create match error:", err.response?.data || err.message);
      await replyToEvent(
        event,
        "❌ Failed to create the real match in the website system."
      );
    }

    return;
  }

  if (command === "!reject") {
    if (!captain && !isAdmin(authorId)) {
      await replyToEvent(
        event,
        "Only captains or admins can reject proposals.\n只有队长或管理员可以拒绝比赛申请。"
      );
      return;
    }

    const proposalId = Number(parts[1]);
    if (!proposalId) {
      await replyToEvent(event, "Usage: !reject PROPOSAL_ID");
      return;
    }

    const proposal = proposals.find((p) => p.id === proposalId);

    if (!proposal) {
      await replyToEvent(
        event,
        `No proposal found with ID ${proposalId}.\n未找到编号为 ${proposalId} 的申请。`
      );
      return;
    }

    if (!isAdmin(authorId) && proposal.toCaptainId !== authorId) {
      await replyToEvent(
        event,
        "Only the opposing captain can reject this proposal.\n只有对方队长可以拒绝这场申请。"
      );
      return;
    }

    if (proposal.status !== "pending") {
      await replyToEvent(
        event,
        `This proposal is already ${proposal.status}.\n该申请当前状态为 ${proposal.status}。`
      );
      return;
    }

    proposal.status = "rejected";
    proposal.rejectedAt = new Date().toISOString();

    await replyToEvent(
      event,
      `❌ Proposal rejected / 申请已拒绝。\n${formatProposal(proposal)}`
    );

    await sendPrivateMessage(
      proposal.fromCaptainId,
      `❌ Your proposal was rejected / 你的申请被拒绝了。\n${formatProposal(proposal)}`
    );

    return;
  }

  if (command === "!cancel" || command === "!unschedule") {
    await startCancelFlow(event, authorId);
    return;
  }

  if (command === "!report") {
    await startResultFlow(event, authorId, false);
    return;
  }

  if (command === "!resend") {
    await startResultFlow(event, authorId, true);
    return;
  }

  if (command === "!matches") {
    try {
      const scheduledMatches = await fetchScheduledMatches();

      if (scheduledMatches.length === 0) {
        await replyToEvent(
          event,
          "No scheduled matches yet.\n目前还没有已安排的比赛。"
        );
        return;
      }

      const message = scheduledMatches
        .map((match, index) => `${index + 1}. ${formatLiveMatch(match)}`)
        .join("\n");

      await replyToEvent(
        event,
        `📅 Scheduled Matches / 已安排比赛:\n\n${message}`
      );
    } catch (err) {
      console.error("!matches error:", err.response?.data || err.message);
      await replyToEvent(event, "❌ Failed to load matches.");
    }
    return;
  }

  if (command === "!mygames") {
    if (!admin && !captain) {
      await replyToEvent(
        event,
        "Only admins or captains can use !mygames.\n只有管理员或队长可以使用 !mygames。"
      );
      return;
    }

    try {
      const scheduledMatches = await fetchScheduledMatches();
      const accessibleMatches = admin
        ? scheduledMatches
        : getMatchesForCaptain(scheduledMatches, captain);

      if (accessibleMatches.length === 0) {
        await replyToEvent(
          event,
          "You have no scheduled matches.\n你目前没有已安排的比赛。"
        );
        return;
      }

      const message = accessibleMatches
        .map((match, index) => `${index + 1}. ${formatLiveMatch(match)}`)
        .join("\n");

      await replyToEvent(
        event,
        `📅 Your Matches / 你的比赛:\n\n${message}`
      );
    } catch (err) {
      console.error("!mygames error:", err.response?.data || err.message);
      await replyToEvent(event, "❌ Failed to load your matches.");
    }
    return;
  }

  if (command === "!leaderboard") {
    try {
      const leaderboard = await fetchLeaderboard();

      if (leaderboard.length === 0) {
        await replyToEvent(event, "No leaderboard data yet.");
        return;
      }

      const message = leaderboard
        .slice(0, 10)
        .map(formatPublicLeaderboardRow)
        .join("\n");

      await replyToEvent(
        event,
        `🏆 Leaderboard (Top 10)\n\n${message}`
      );
    } catch (err) {
      console.error("!leaderboard error:", err.response?.data || err.message);
      await replyToEvent(event, "❌ Failed to load leaderboard.");
    }
    return;
  }

  if (command === "!standings") {
    try {
      const standings = await fetchStandings();

      if (standings.length === 0) {
        await replyToEvent(event, "No standings data yet.");
        return;
      }

      const message = standings
        .map(formatPublicStandingsRow)
        .join("\n");

      await replyToEvent(
        event,
        `📊 Standings\n\n${message}`
      );
    } catch (err) {
      console.error("!standings error:", err.response?.data || err.message);
      await replyToEvent(event, "❌ Failed to load standings.");
    }
    return;
  }

  if (command === "!proposals") {
    if (!isAdminOrCaptain(authorId)) {
      await replyToEvent(
        event,
        "Only admins or captains can view proposals.\n只有管理员或队长可以查看申请。"
      );
      return;
    }

    if (proposals.length === 0) {
      await replyToEvent(event, "No proposals yet.\n目前没有比赛申请。");
      return;
    }

    const message = proposals.map(formatProposal).join("\n\n");
    await replyToEvent(
      event,
      `📨 Current Proposals / 当前申请:\n\n${message}`
    );
    return;
  }

  await replyToEvent(
    event,
    "Unknown command. Use !commands to see what I can do.\n未知指令，请使用 !commands 查看可用功能。"
  );
}

// =============================
// KOOK SOCKET
// =============================
let ws = null;
let heartbeat = null;
let reconnectTimer = null;
let reconnecting = false;

function clearHeartbeat() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    startBot().catch((err) => {
      console.error("Reconnect startBot error:", err.message);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

async function startBot() {
  cleanupExpiredSessions();

  const gatewayUrl = await getGateway();
  console.log("Connecting to:", gatewayUrl);

  ws = new WebSocket(gatewayUrl);
  let lastSn = 0;

  ws.on("open", () => {
    console.log("✅ Bot connected to KOOK");
  });

  ws.on("message", async (raw) => {
    const packet = parsePacket(raw);
    if (!packet) return;

    console.log("📦 PACKET:", JSON.stringify({
      s: packet?.s,
      sn: packet?.sn,
      hasD: !!packet?.d,
    }));

    if (typeof packet.sn === "number") {
      lastSn = packet.sn;
    }

    if (packet.s === 1) {
      console.log("🤝 HELLO");

      clearHeartbeat();
      heartbeat = setInterval(() => {
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ s: 2, sn: lastSn }));
            console.log("💓 Ping sent with sn =", lastSn);
          }
        } catch (err) {
          console.error("Heartbeat send error:", err.message);
        }
      }, 30000);

      return;
    }

    if (packet.s === 3) {
      console.log("💚 PONG received");
      return;
    }

    if (packet.s === 0 && packet.d) {
      const event = packet.d;

      try {
        console.log("📩 EVENT RECEIVED:", JSON.stringify({
          sn: packet.sn,
          type: event?.type,
          channel_type: event?.channel_type,
          target_id: event?.target_id,
          author_id: event?.author_id,
          content: event?.content,
          raw_content: event?.extra?.kmarkdown?.raw_content,
          extra_type: event?.extra?.type,
        }));

        console.log("📩 RAW EVENT:", JSON.stringify(packet.d));

        if (event.type === 255) {
          if (event.extra && event.extra.type === "joined_guild") {
            console.log("👤 New user joined the server");
            await sendWelcomeMessage();
            return;
          }
        }

        const content = extractTextContent(event);
        console.log("📝 Extracted content:", content);

        await handleCommand(event, content);
      } catch (err) {
        console.error("Event handling error:", err.stack || err.message);
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed");
    clearHeartbeat();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

setInterval(cleanupExpiredSessions, 60 * 1000);

startBot().catch((err) => {
  console.error("Initial startBot error:", err.message);
  scheduleReconnect();
});
