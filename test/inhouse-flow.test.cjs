const assert = require("node:assert/strict");
const test = require("node:test");
const {
  inhouseCommandErrorMessage,
  kookApiResponseSucceeded,
  shouldMoveInhousePlayers,
} = require("../inhouse-flow.cjs");

test("ready moves players only when the API returned real instructions", () => {
  assert.equal(
    shouldMoveInhousePlayers("!ready", {
      moveInstructions: [{ kookUserId: "player-1", targetChannelId: "blue" }],
    }),
    true,
  );
  assert.equal(shouldMoveInhousePlayers("!ready", { moveInstructions: [] }), false);
  assert.equal(
    shouldMoveInhousePlayers("!inhouse", {
      moveInstructions: [{ kookUserId: "player-1", targetChannelId: "blue" }],
    }),
    false,
  );
});

test("timeout message explains the safe recovery flow", () => {
  const message = inhouseCommandErrorMessage({ code: "ECONNABORTED" });

  assert.match(message, /Type !status first/);
  assert.match(message, /type !ready once/);
});

test("API reply remains the preferred inhouse error", () => {
  assert.equal(
    inhouseCommandErrorMessage({
      response: { data: { reply: "Server-provided recovery message" } },
      message: "Fallback",
    }),
    "Server-provided recovery message",
  );
});

test("KOOK move requires an application-level success code", () => {
  assert.equal(kookApiResponseSucceeded({ data: { code: 0 } }), true);
  assert.equal(kookApiResponseSucceeded({ data: { code: 40000 } }), false);
  assert.equal(kookApiResponseSucceeded({ data: {} }), false);
});
