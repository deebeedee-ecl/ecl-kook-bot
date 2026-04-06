require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const zlib = require("zlib");

console.log("🚀 NEW VERSION IS RUNNING");

const TOKEN = process.env.KOOK_BOT_TOKEN || "1/NDY1Njk=/aF4Tn0nAGxyBEjkIJMP+yw==";
const API_BASE = "https://www.kookapp.cn/api/v3";
const WELCOME_CHANNEL_ID = "1969692300297863";
const SCHEDULE_CHANNEL_ID = "6687085374683659";

// =============================
// ADMINS
// =============================
const admins = {
  "3149507900": {
    nickname: "dbd",
    roleLabel: "Head Admin",
  },
  "2980365563": {
    nickname: "Soul",
    roleLabel: "ECL Admin",
  },
  "2789357366": {
    nickname: "Joe",
    roleLabel: "ECL Admin",
  },
};

// =============================
// CAPTAINS / TEAMS
// =============================
const captains = {
  "2796070748": {
    nickname: "Dixon",
    teamName: "Bean In Your Mum",
    tag: "BIY",
  },
  "2181323461": {
    nickname: "Shidian",
    teamName: "NiuNiuPower",
    tag: "NIU",
  },
  "2831795126": {
    nickname: "Poopswag",
    teamName: "Zycope & Friends",
    tag: "ZAF",
  },
  "1405022101": {
    nickname: "Sheniqua",
    teamName: "Make France Great Again",
    tag: "MFG",
  },
  "3741548599": {
    nickname: "Bunnieh",
    teamName: "Exiled Bunzz",
    tag: "EB",
  },
  "2522160383": {
    nickname: "Flan",
    teamName: "Flanmingos",
    tag: "FLA",
  },
};

// =============================
// TEMP STORAGE (resets on restart)
// =============================
const scheduleSessions = {};
const cancelSessions = {};
const reportSessions = {};
const proposals = [];
const confirmedMatches = [];
const reports = [];

let nextProposalId = 1;
let nextMatchId = 1;
let nextReportId = 1;

if (!TOKEN) {
  console.error("❌ Missing bot token");
  process.exit(1);
}

function isAdmin(userId) {
  return !!admins[String(userId)];
}

function getAdmin(userId) {
  return admins[String(userId)] || null;
}

function getCaptain(userId) {
  return captains[String(userId)] || null;
}

function getAvailableOpponents(authorId) {
  const myCaptain = getCaptain(authorId);
  if (!myCaptain) return [];

  return Object.entries(captains)
    .filter(([userId]) => String(userId) !== String(authorId))
    .map(([userId, captain]) => ({
      userId,
      nickname: captain.nickname,
      teamName: captain.teamName,
      tag: captain.tag,
    }));
}

function getMyScheduledMatches(authorId) {
  const captain = getCaptain(authorId);
  if (!captain) return [];

  return confirmedMatches.filter(
    (match) =>
      match.status === "scheduled" &&
      (match.teamA === captain.teamName || match.teamB === captain.teamName)
  );
}

function getAccessibleMatchesForCancel(authorId) {
  if (isAdmin(authorId)) {
    return confirmedMatches.filter((match) => match.status === "scheduled");
  }

  return getMyScheduledMatches(authorId);
}

function getAccessibleMatchesForReport(authorId) {
  if (isAdmin(authorId)) {
    return confirmedMatches.filter((match) => match.status === "scheduled");
  }

  return getMyScheduledMatches(authorId);
}

function formatCommands() {
  return `📘 ECL Bot Commands / 指令列表

General / 通用:
• !ping
• !commands
• !whoami
• !captains
• !teams

Scheduling / 赛程:
• !schedule
• !cancel

Reporting / 赛果上报:
• !report

Views / 查看:
• !proposals
• !matches
• !reports`;
}

function formatProposal(proposal) {
  return `Proposal #${proposal.id}
${proposal.fromTeam} [${proposal.fromTag}] vs ${proposal.toTeam} [${proposal.toTag}]
Time / 时间: ${proposal.dateTime}
Format / 赛制: ${proposal.format}
Status / 状态: ${proposal.status}`;
}

function formatMatch(match) {
  return `Match #${match.id}
${match.teamA} [${match.tagA}] vs ${match.teamB} [${match.tagB}]
Time / 时间: ${match.dateTime}
Format / 赛制: ${match.format}
Status / 状态: ${match.status}`;
}

function formatReport(report) {
  return `Report #${report.id}
Match #${report.matchId}
Game / 第几局: ${report.gameNumber}
Reporter / 提交人: ${report.reporterName}
Screenshot / 截图: ${report.screenshotUrl}
Note / 备注: ${report.note}
Status / 状态: ${report.status}`;
}

function isValidDateTime(input) {
  return /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(input);
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
      }
    );
    console.log(`✅ DM sent to ${userId}`);
    return true;
  } catch (err) {
    console.error("DM send error:", err.response?.data || err.message);
    return false;
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
    console.error(
      "❌ Failed to send welcome message:",
      err.response?.data || err.message
    );
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

      if (event.type === 255) {
        console.log("📢 System event detected");

        if (event.extra) {
          console.log(
            "📢 System event extra:",
            JSON.stringify(event.extra, null, 2)
          );
        }

        if (event.extra && event.extra.type === "joined_guild") {
          console.log("👤 New user joined the server");
          await sendWelcomeMessage();
          return;
        }
      }

      const rawContent =
        event?.extra?.kmarkdown?.raw_content ??
        event?.content ??
        "";

      const content = String(rawContent).trim();
      console.log("📩 Parsed content:", content);

      if (!content) return;

      const authorId = String(event.author_id);
      const admin = getAdmin(authorId);
      const captain = getCaptain(authorId);

      // =============================
      // CANCEL FLOW: choose match by number
      // =============================
      if (
        (admin || captain) &&
        cancelSessions[authorId] &&
        cancelSessions[authorId].step === "choose_match" &&
        !content.startsWith("!")
      ) {
        const session = cancelSessions[authorId];
        const choice = Number(content);

        if (
          !Number.isInteger(choice) ||
          choice < 1 ||
          choice > session.matches.length
        ) {
          await sendChannelMessage(
            event.target_id,
            "Invalid choice. Reply with the match number from the list.\n无效选择，请回复列表中的比赛编号。"
          );
          return;
        }

        const selectedMatch = session.matches[choice - 1];
        selectedMatch.status = "cancelled";
        delete cancelSessions[authorId];

        await sendChannelMessage(
          SCHEDULE_CHANNEL_ID,
          `🛑 Match Cancelled! / 比赛已取消！\n${formatMatch(selectedMatch)}`
        );

        return;
      }

      // =============================
      // REPORT FLOW STEP 1: choose match
      // =============================
      if (
        (admin || captain) &&
        reportSessions[authorId] &&
        reportSessions[authorId].step === "choose_match" &&
        !content.startsWith("!")
      ) {
        const session = reportSessions[authorId];
        const choice = Number(content);

        if (
          !Number.isInteger(choice) ||
          choice < 1 ||
          choice > session.matches.length
        ) {
          await sendChannelMessage(
            event.target_id,
            "Invalid choice. Reply with the match number from the list.\n无效选择，请回复列表中的比赛编号。"
          );
          return;
        }

        const selectedMatch = session.matches[choice - 1];
        const gameCount = getGameCountFromFormat(selectedMatch.format);

        reportSessions[authorId] = {
          step: "choose_game",
          selectedMatch,
          gameCount,
        };

        let gameOptions = "";
        for (let i = 1; i <= gameCount; i++) {
          gameOptions += `${i}. Game ${i}\n`;
        }

        await sendChannelMessage(
          event.target_id,
          `Which game are you reporting?\n你要上报哪一局？\n\n${gameOptions}\nReply with a number / 回复对应数字。`
        );
        return;
      }

      // =============================
      // REPORT FLOW STEP 2: choose game
      // =============================
      if (
        (admin || captain) &&
        reportSessions[authorId] &&
        reportSessions[authorId].step === "choose_game" &&
        !content.startsWith("!")
      ) {
        const session = reportSessions[authorId];
        const choice = Number(content);

        if (
          !Number.isInteger(choice) ||
          choice < 1 ||
          choice > session.gameCount
        ) {
          await sendChannelMessage(
            event.target_id,
            "Invalid choice. Reply with the game number.\n无效选择，请回复局数编号。"
          );
          return;
        }

        reportSessions[authorId] = {
          ...session,
          step: "await_screenshot",
          gameNumber: choice,
        };

        await sendChannelMessage(
          event.target_id,
          `Send the screenshot link for Game ${choice}.\n请发送第 ${choice} 局的截图链接。`
        );
        return;
      }

      // =============================
      // REPORT FLOW STEP 3: screenshot
      // =============================
      if (
        (admin || captain) &&
        reportSessions[authorId] &&
        reportSessions[authorId].step === "await_screenshot" &&
        !content.startsWith("!")
      ) {
        const session = reportSessions[authorId];

        reportSessions[authorId] = {
          ...session,
          step: "await_note",
          screenshotUrl: content,
        };

        await sendChannelMessage(
          event.target_id,
          `Add a short note or type skip.\n请输入简短备注，或输入 skip 跳过。`
        );
        return;
      }

      // =============================
      // REPORT FLOW STEP 4: note
      // =============================
      if (
        (admin || captain) &&
        reportSessions[authorId] &&
        reportSessions[authorId].step === "await_note" &&
        !content.startsWith("!")
      ) {
        const session = reportSessions[authorId];
        const note = content.toLowerCase() === "skip" ? "No note" : content;

        const reporterName = admin
          ? `${admin.nickname} (${admin.roleLabel})`
          : `${captain.nickname} — ${captain.teamName} [${captain.tag}]`;

        const report = {
          id: nextReportId++,
          matchId: session.selectedMatch.id,
          gameNumber: session.gameNumber,
          screenshotUrl: session.screenshotUrl,
          note,
          reporterId: authorId,
          reporterName,
          status: "pending",
          createdAt: new Date().toISOString(),
        };

        reports.push(report);
        delete reportSessions[authorId];

        await sendChannelMessage(
          event.target_id,
          `📸 Report submitted / 赛果已提交。\n${formatReport(report)}`
        );
        return;
      }

      // =============================
      // SCHEDULE FLOW STEP 1: TEAM CHOICE
      // =============================
      if (
        captain &&
        scheduleSessions[authorId] &&
        scheduleSessions[authorId].step === "choose_opponent" &&
        !content.startsWith("!")
      ) {
        const session = scheduleSessions[authorId];
        const choice = Number(content);

        if (
          !Number.isInteger(choice) ||
          choice < 1 ||
          choice > session.opponents.length
        ) {
          await sendChannelMessage(
            event.target_id,
            "Invalid choice. Reply with the team number from the list.\n无效选择，请回复列表中的队伍编号。"
          );
          return;
        }

        const selectedOpponent = session.opponents[choice - 1];

        scheduleSessions[authorId] = {
          ...session,
          step: "choose_datetime",
          selectedOpponent,
        };

        await sendChannelMessage(
          event.target_id,
          `You chose ${selectedOpponent.teamName} [${selectedOpponent.tag}].\n你选择了 ${selectedOpponent.teamName} [${selectedOpponent.tag}]。\n\nNow send the proposed date/time like this:\n请按以下格式发送比赛时间：\nYYYY-MM-DD HH:MM\nExample / 例如: 2026-04-12 20:00`
        );
        return;
      }

      // =============================
      // SCHEDULE FLOW STEP 2: DATETIME
      // =============================
      if (
        captain &&
        scheduleSessions[authorId] &&
        scheduleSessions[authorId].step === "choose_datetime" &&
        !content.startsWith("!")
      ) {
        const session = scheduleSessions[authorId];

        if (!isValidDateTime(content)) {
          await sendChannelMessage(
            event.target_id,
            "Invalid date/time format.\n格式错误。\nPlease use / 请使用: YYYY-MM-DD HH:MM\nExample / 例如: 2026-04-12 20:00"
          );
          return;
        }

        scheduleSessions[authorId] = {
          ...session,
          step: "choose_format",
          dateTime: content,
        };

        await sendChannelMessage(
          event.target_id,
          `Choose the match format / 请选择比赛赛制:\n\n1. BO1\n2. BO2\n3. BO3\n4. BO5\n\nReply with a number / 回复对应数字。`
        );
        return;
      }

      // =============================
      // SCHEDULE FLOW STEP 3: FORMAT
      // =============================
      if (
        captain &&
        scheduleSessions[authorId] &&
        scheduleSessions[authorId].step === "choose_format" &&
        !content.startsWith("!")
      ) {
        const session = scheduleSessions[authorId];
        const choice = Number(content);
        const formats = getFormatOptions();

        if (
          !Number.isInteger(choice) ||
          choice < 1 ||
          choice > formats.length
        ) {
          await sendChannelMessage(
            event.target_id,
            "Invalid choice. Reply with 1, 2, 3, or 4.\n无效选择，请回复 1、2、3 或 4。"
          );
          return;
        }

        const selectedFormat = formats[choice - 1];

        const proposal = {
          id: nextProposalId++,
          fromCaptainId: authorId,
          fromTeam: captain.teamName,
          fromTag: captain.tag,
          toCaptainId: session.selectedOpponent.userId,
          toTeam: session.selectedOpponent.teamName,
          toTag: session.selectedOpponent.tag,
          dateTime: session.dateTime,
          format: selectedFormat,
          status: "pending",
          createdAt: new Date().toISOString(),
        };

        proposals.push(proposal);
        delete scheduleSessions[authorId];

        await sendChannelMessage(
          event.target_id,
          `✅ Proposal sent / 对局申请已发送。\n${formatProposal(proposal)}`
        );

        const dmWorked = await sendPrivateMessage(
          proposal.toCaptainId,
          `📩 Match proposal received / 收到比赛申请

${proposal.fromTeam} [${proposal.fromTag}] wants to play your team ${proposal.toTeam} [${proposal.toTag}].
${proposal.fromTeam} [${proposal.fromTag}] 想和你的队伍 ${proposal.toTeam} [${proposal.toTag}] 进行比赛。

Proposed time / 提议时间:
${proposal.dateTime}

Format / 赛制:
${proposal.format}

Reply with / 回复以下指令:
!accept ${proposal.id}
or
!reject ${proposal.id}

If accepted, the match can be cancelled later if needed.
如果接受，之后如有需要可以取消比赛。`
        );

        if (!dmWorked) {
          await sendChannelMessage(
            SCHEDULE_CHANNEL_ID,
            `📩 Captain approval needed / 需要队长确认\n${formatProposal(proposal)}\n\nOpposing captain can reply with / 对方队长可回复：\n!accept ${proposal.id}\n!reject ${proposal.id}`
          );
        }

        return;
      }

      if (!content.startsWith("!")) return;

      const parts = content.split(" ");
      const command = parts[0].toLowerCase();

      if (command === "!ping") {
        await sendChannelMessage(event.target_id, "pong");
        return;
      }

      if (command === "!commands" || command === "!help") {
        await sendChannelMessage(event.target_id, formatCommands());
        return;
      }

      if (command === "!whoami") {
        if (admin) {
          await sendChannelMessage(
            event.target_id,
            `You are an admin (${admin.roleLabel}).\n你是管理员（${admin.roleLabel}）。`
          );
        } else if (captain) {
          await sendChannelMessage(
            event.target_id,
            `You are captain of ${captain.teamName} [${captain.tag}].\n你是 ${captain.teamName} [${captain.tag}] 的队长。`
          );
        } else {
          await sendChannelMessage(
            event.target_id,
            "Captain? No. Minion? Yes.\n你是队长吗？不是。你是小兵。"
          );
        }
        return;
      }

      if (command === "!captains") {
        const captainList = Object.values(captains)
          .map((c) => `• ${c.nickname} — ${c.teamName} [${c.tag}]`)
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `👑 Current captains / 当前队长:\n\n${captainList}`
        );
        return;
      }

      if (command === "!teams") {
        const teamList = Object.values(captains)
          .map((c) => `• ${c.teamName} [${c.tag}]`)
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `🛡️ Current teams / 当前队伍:\n\n${teamList}`
        );
        return;
      }

      if (command === "!schedule") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Only captains can schedule matches.\n只有队长可以安排比赛。"
          );
          return;
        }

        const opponents = getAvailableOpponents(authorId);

        if (opponents.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "No opponent teams are set up yet.\n目前还没有可选的对手队伍。"
          );
          return;
        }

        scheduleSessions[authorId] = {
          step: "choose_opponent",
          opponents,
        };

        const teamList = opponents
          .map((team, index) => `${index + 1}. ${team.teamName} [${team.tag}]`)
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `Okay, here is the list of teams.\n请选择你想对阵的队伍：\n\n${teamList}\n\nReply with a number / 回复对应数字。`
        );
        return;
      }

      if (command === "!accept") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Only captains can accept proposals.\n只有队长可以接受比赛申请。"
          );
          return;
        }

        const proposalId = Number(parts[1]);
        if (!proposalId) {
          await sendChannelMessage(
            event.target_id,
            "Usage / 用法: !accept PROPOSAL_ID"
          );
          return;
        }

        const proposal = proposals.find((p) => p.id === proposalId);

        if (!proposal) {
          await sendChannelMessage(
            event.target_id,
            `No proposal found with ID ${proposalId}.\n未找到编号为 ${proposalId} 的申请。`
          );
          return;
        }

        if (proposal.toCaptainId !== authorId) {
          await sendChannelMessage(
            event.target_id,
            "Only the opposing captain can accept this proposal.\n只有对方队长可以接受这场申请。"
          );
          return;
        }

        if (proposal.status !== "pending") {
          await sendChannelMessage(
            event.target_id,
            `This proposal is already ${proposal.status}.\n该申请当前状态为 ${proposal.status}。`
          );
          return;
        }

        proposal.status = "accepted";

        const match = {
          id: nextMatchId++,
          proposalId: proposal.id,
          teamA: proposal.fromTeam,
          tagA: proposal.fromTag,
          teamB: proposal.toTeam,
          tagB: proposal.toTag,
          dateTime: proposal.dateTime,
          format: proposal.format,
          status: "scheduled",
          createdAt: new Date().toISOString(),
        };

        confirmedMatches.push(match);

        await sendChannelMessage(
          event.target_id,
          `✅ Proposal accepted / 申请已接受。\n${formatProposal(proposal)}`
        );

        await sendPrivateMessage(
          proposal.fromCaptainId,
          `✅ Your proposal was accepted / 你的申请已被接受。\n${formatProposal(proposal)}`
        );

        await sendChannelMessage(
          SCHEDULE_CHANNEL_ID,
          `📅 Match Scheduled! / 比赛已安排！\n${formatMatch(match)}`
        );
        return;
      }

      if (command === "!reject") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Only captains can reject proposals.\n只有队长可以拒绝比赛申请。"
          );
          return;
        }

        const proposalId = Number(parts[1]);
        if (!proposalId) {
          await sendChannelMessage(
            event.target_id,
            "Usage / 用法: !reject PROPOSAL_ID"
          );
          return;
        }

        const proposal = proposals.find((p) => p.id === proposalId);

        if (!proposal) {
          await sendChannelMessage(
            event.target_id,
            `No proposal found with ID ${proposalId}.\n未找到编号为 ${proposalId} 的申请。`
          );
          return;
        }

        if (proposal.toCaptainId !== authorId) {
          await sendChannelMessage(
            event.target_id,
            "Only the opposing captain can reject this proposal.\n只有对方队长可以拒绝这场申请。"
          );
          return;
        }

        if (proposal.status !== "pending") {
          await sendChannelMessage(
            event.target_id,
            `This proposal is already ${proposal.status}.\n该申请当前状态为 ${proposal.status}。`
          );
          return;
        }

        proposal.status = "rejected";

        await sendChannelMessage(
          event.target_id,
          `❌ Proposal rejected / 申请已拒绝。\n${formatProposal(proposal)}`
        );

        await sendPrivateMessage(
          proposal.fromCaptainId,
          `❌ Your proposal was rejected / 你的申请被拒绝了。\n${formatProposal(proposal)}`
        );
        return;
      }

      if (command === "!cancel") {
        if (!admin && !captain) {
          await sendChannelMessage(
            event.target_id,
            "Only admins or captains can cancel matches.\n只有管理员或队长可以取消比赛。"
          );
          return;
        }

        const accessibleMatches = getAccessibleMatchesForCancel(authorId);

        if (accessibleMatches.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "You have no scheduled matches to cancel.\n你目前没有可取消的已安排比赛。"
          );
          return;
        }

        cancelSessions[authorId] = {
          step: "choose_match",
          matches: accessibleMatches,
        };

        const matchList = accessibleMatches
          .map((match, index) => {
            return `${index + 1}. ${match.teamA} vs ${match.teamB} — ${match.dateTime} — ${match.format}`;
          })
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `Which match do you want to cancel?\n你想取消哪一场比赛？\n\n${matchList}\n\nReply with a number / 回复对应数字。`
        );
        return;
      }

      if (command === "!report") {
        if (!admin && !captain) {
          await sendChannelMessage(
            event.target_id,
            "Only admins or captains can submit reports.\n只有管理员或队长可以提交赛果。"
          );
          return;
        }

        const accessibleMatches = getAccessibleMatchesForReport(authorId);

        if (accessibleMatches.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "You have no scheduled matches to report.\n你目前没有可上报的比赛。"
          );
          return;
        }

        reportSessions[authorId] = {
          step: "choose_match",
          matches: accessibleMatches,
        };

        const matchList = accessibleMatches
          .map((match, index) => {
            return `${index + 1}. ${match.teamA} vs ${match.teamB} — ${match.dateTime} — ${match.format}`;
          })
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `Which match are you reporting?\n你要上报哪一场比赛？\n\n${matchList}\n\nReply with a number / 回复对应数字。`
        );
        return;
      }

      if (command === "!proposals") {
        if (!admin && !captain) {
          await sendChannelMessage(
            event.target_id,
            "Only admins or captains can view proposals.\n只有管理员或队长可以查看申请。"
          );
          return;
        }

        if (proposals.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "No proposals yet.\n目前没有比赛申请。"
          );
          return;
        }

        const message = proposals.map(formatProposal).join("\n\n");
        await sendChannelMessage(
          event.target_id,
          `📨 Current proposals / 当前申请:\n\n${message}`
        );
        return;
      }

      if (command === "!matches") {
        if (!admin && !captain) {
          await sendChannelMessage(
            event.target_id,
            "Only admins or captains can view matches.\n只有管理员或队长可以查看比赛。"
          );
          return;
        }

        if (confirmedMatches.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "No confirmed matches yet.\n目前还没有已确认的比赛。"
          );
          return;
        }

        const message = confirmedMatches.map(formatMatch).join("\n\n");
        await sendChannelMessage(
          event.target_id,
          `📅 Confirmed matches / 已确认比赛:\n\n${message}`
        );
        return;
      }

      if (command === "!reports") {
        if (!admin && !captain) {
          await sendChannelMessage(
            event.target_id,
            "Only admins or captains can view reports.\n只有管理员或队长可以查看赛果。"
          );
          return;
        }

        if (reports.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "No reports yet.\n目前没有赛果记录。"
          );
          return;
        }

        const message = reports.map(formatReport).join("\n\n");
        await sendChannelMessage(
          event.target_id,
          `📸 Current reports / 当前赛果:\n\n${message}`
        );
        return;
      }

      await sendChannelMessage(
        event.target_id,
        "Unknown command. Use !commands to see what I can do.\n未知指令，请使用 !commands 查看可用功能。"
      );
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