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
// CAPTAINS / TEAMS
// =============================
const captains = {
  "3149507900": {
    teamName: "Test Team",
    tag: "TEST",
  },
  "2796070748": {
    teamName: "Bean In Your Mum",
    tag: "BIY",
  },
  "3933904036": {
    teamName: "NiuNiuPower",
    tag: "NIU",
  },
  "2831795126": {
    teamName: "Zycope & Friends",
    tag: "ZAF",
  },
  "1405022101": {
    teamName: "French Femboys",
    tag: "FF",
  },
};

// =============================
// TEMP STORAGE (resets on restart)
// =============================
const scheduleSessions = {};
const proposals = [];
const confirmedMatches = [];

let nextProposalId = 1;
let nextMatchId = 1;

if (!TOKEN) {
  console.error("❌ Missing bot token");
  process.exit(1);
}

function getCaptain(authorId) {
  return captains[String(authorId)] || null;
}

function getAvailableOpponents(authorId) {
  const myCaptain = getCaptain(authorId);
  if (!myCaptain) return [];

  return Object.entries(captains)
    .filter(([userId]) => String(userId) !== String(authorId))
    .map(([userId, captain]) => ({
      userId,
      teamName: captain.teamName,
      tag: captain.tag,
    }));
}

function formatCommands() {
  return `📘 ECL Bot Commands

General:
• !ping
• !commands
• !whoami
• !captains
• !teams

Scheduling:
• !schedule
• !accept PROPOSAL_ID
• !reject PROPOSAL_ID
• !cancel PROPOSAL_ID

Views:
• !proposals
• !matches

Notes:
• !schedule starts a guided flow
• choose a team by number
• then send date/time like: 2026-04-12 20:00`;
}

function formatProposal(proposal) {
  return `Proposal #${proposal.id}
${proposal.fromTeam} [${proposal.fromTag}] vs ${proposal.toTeam} [${proposal.toTag}]
Time: ${proposal.dateTime}
Status: ${proposal.status}`;
}

function formatMatch(match) {
  return `Match #${match.id}
${match.teamA} [${match.tagA}] vs ${match.teamB} [${match.tagB}]
Time: ${match.dateTime}
Status: ${match.status}`;
}

function isValidDateTime(input) {
  return /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(input);
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

      // Welcome event
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
      const captain = getCaptain(authorId);

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
            "Invalid choice. Reply with the team number from the list."
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
          `You chose ${selectedOpponent.teamName} [${selectedOpponent.tag}].\nNow send the proposed date/time like this:\nYYYY-MM-DD HH:MM\nExample: 2026-04-12 20:00`
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
            "Invalid date/time format.\nPlease use: YYYY-MM-DD HH:MM\nExample: 2026-04-12 20:00"
          );
          return;
        }

        const proposal = {
          id: nextProposalId++,
          fromCaptainId: authorId,
          fromTeam: captain.teamName,
          fromTag: captain.tag,
          toCaptainId: session.selectedOpponent.userId,
          toTeam: session.selectedOpponent.teamName,
          toTag: session.selectedOpponent.tag,
          dateTime: content,
          status: "pending",
          createdAt: new Date().toISOString(),
        };

        proposals.push(proposal);
        delete scheduleSessions[authorId];

        await sendChannelMessage(
          event.target_id,
          `✅ Proposal sent.\n${formatProposal(proposal)}`
        );

        const dmWorked = await sendPrivateMessage(
          proposal.toCaptainId,
          `📩 Match proposal received

${proposal.fromTeam} [${proposal.fromTag}] wants to play your team ${proposal.toTeam} [${proposal.toTag}].

Proposed time:
${proposal.dateTime}

Reply with:
!accept ${proposal.id}
or
!reject ${proposal.id}
or
!cancel ${proposal.id}`
        );

        if (!dmWorked) {
          await sendChannelMessage(
            SCHEDULE_CHANNEL_ID,
            `📩 Captain approval needed\n${formatProposal(proposal)}\nOpposing captain can reply with:\n!accept ${proposal.id}\n!reject ${proposal.id}\n!cancel ${proposal.id}`
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
        if (captain) {
          await sendChannelMessage(
            event.target_id,
            `You are registered as captain of ${captain.teamName} [${captain.tag}].`
          );
        } else {
          await sendChannelMessage(
            event.target_id,
            "Captain? No. Minion? Yes."
          );
        }
        return;
      }

      if (command === "!captains") {
        const captainList = Object.entries(captains)
          .map(
            ([userId, captain]) =>
              `• ${captain.teamName} [${captain.tag}] — Captain ID: ${userId}`
          )
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `👑 Current captains:\n\n${captainList}`
        );
        return;
      }

      if (command === "!teams") {
        const teamList = Object.values(captains)
          .map((captain) => `• ${captain.teamName} [${captain.tag}]`)
          .join("\n");

        await sendChannelMessage(
          event.target_id,
          `🛡️ Current teams:\n\n${teamList}`
        );
        return;
      }

      if (command === "!schedule") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Captain? No. Minion? Yes."
          );
          return;
        }

        const opponents = getAvailableOpponents(authorId);

        if (opponents.length === 0) {
          await sendChannelMessage(
            event.target_id,
            "No opponent teams are set up yet."
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
          `Okay, here is the list of teams.\nWho do you want to play against?\n\n${teamList}\n\nReply with a number.`
        );
        return;
      }

      if (command === "!accept") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Captain? No. Minion? Yes."
          );
          return;
        }

        const proposalId = Number(parts[1]);
        if (!proposalId) {
          await sendChannelMessage(
            event.target_id,
            "Usage: !accept PROPOSAL_ID"
          );
          return;
        }

        const proposal = proposals.find((p) => p.id === proposalId);

        if (!proposal) {
          await sendChannelMessage(
            event.target_id,
            `No proposal found with ID ${proposalId}.`
          );
          return;
        }

        if (proposal.toCaptainId !== authorId) {
          await sendChannelMessage(
            event.target_id,
            "Only the opposing captain can accept this proposal."
          );
          return;
        }

        if (proposal.status !== "pending") {
          await sendChannelMessage(
            event.target_id,
            `This proposal is already ${proposal.status}.`
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
          status: "scheduled",
          createdAt: new Date().toISOString(),
        };

        confirmedMatches.push(match);

        await sendChannelMessage(
          event.target_id,
          `✅ Proposal accepted.\n${formatProposal(proposal)}`
        );

        await sendPrivateMessage(
          proposal.fromCaptainId,
          `✅ Your proposal was accepted.\n${formatProposal(proposal)}`
        );

        await sendChannelMessage(
          SCHEDULE_CHANNEL_ID,
          `📅 Match Scheduled!\n${formatMatch(match)}`
        );
        return;
      }

      if (command === "!reject") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Captain? No. Minion? Yes."
          );
          return;
        }

        const proposalId = Number(parts[1]);
        if (!proposalId) {
          await sendChannelMessage(
            event.target_id,
            "Usage: !reject PROPOSAL_ID"
          );
          return;
        }

        const proposal = proposals.find((p) => p.id === proposalId);

        if (!proposal) {
          await sendChannelMessage(
            event.target_id,
            `No proposal found with ID ${proposalId}.`
          );
          return;
        }

        if (proposal.toCaptainId !== authorId) {
          await sendChannelMessage(
            event.target_id,
            "Only the opposing captain can reject this proposal."
          );
          return;
        }

        if (proposal.status !== "pending") {
          await sendChannelMessage(
            event.target_id,
            `This proposal is already ${proposal.status}.`
          );
          return;
        }

        proposal.status = "rejected";

        await sendChannelMessage(
          event.target_id,
          `❌ Proposal rejected.\n${formatProposal(proposal)}`
        );

        await sendPrivateMessage(
          proposal.fromCaptainId,
          `❌ Your proposal was rejected.\n${formatProposal(proposal)}`
        );
        return;
      }

      if (command === "!cancel") {
        if (!captain) {
          await sendChannelMessage(
            event.target_id,
            "Captain? No. Minion? Yes."
          );
          return;
        }

        const proposalId = Number(parts[1]);
        if (!proposalId) {
          await sendChannelMessage(
            event.target_id,
            "Usage: !cancel PROPOSAL_ID"
          );
          return;
        }

        const proposal = proposals.find((p) => p.id === proposalId);

        if (!proposal) {
          await sendChannelMessage(
            event.target_id,
            `No proposal found with ID ${proposalId}.`
          );
          return;
        }

        const isFromCaptain = proposal.fromCaptainId === authorId;
        const isToCaptain = proposal.toCaptainId === authorId;

        if (!isFromCaptain && !isToCaptain) {
          await sendChannelMessage(
            event.target_id,
            "Only captains involved in this proposal can cancel it."
          );
          return;
        }

        if (proposal.status !== "pending") {
          await sendChannelMessage(
            event.target_id,
            `This proposal is already ${proposal.status} and cannot be cancelled.`
          );
          return;
        }

        proposal.status = "cancelled";

        await sendChannelMessage(
          event.target_id,
          `🛑 Proposal cancelled.\n${formatProposal(proposal)}`
        );

        const otherCaptainId = isFromCaptain
          ? proposal.toCaptainId
          : proposal.fromCaptainId;

        await sendPrivateMessage(
          otherCaptainId,
          `🛑 A match proposal was cancelled.\n${formatProposal(proposal)}`
        );
        return;
      }

      if (command === "!proposals") {
        if (proposals.length === 0) {
          await sendChannelMessage(event.target_id, "No proposals yet.");
          return;
        }

        const message = proposals.map(formatProposal).join("\n\n");
        await sendChannelMessage(
          event.target_id,
          `📨 Current proposals:\n\n${message}`
        );
        return;
      }

      if (command === "!matches") {
        if (confirmedMatches.length === 0) {
          await sendChannelMessage(event.target_id, "No confirmed matches yet.");
          return;
        }

        const message = confirmedMatches.map(formatMatch).join("\n\n");
        await sendChannelMessage(
          event.target_id,
          `📅 Confirmed matches:\n\n${message}`
        );
        return;
      }

      await sendChannelMessage(
        event.target_id,
        "Unknown command. Use !commands to see what I can do."
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