function shouldMoveInhousePlayers(command, data) {
  return (
    (command === "!ready" || command === "!forceready") &&
    Array.isArray(data?.moveInstructions) &&
    data.moveInstructions.length > 0
  );
}

function kookApiResponseSucceeded(response) {
  return response?.data?.code === 0;
}

function inhouseCommandErrorMessage(error) {
  if (error?.code === "ECONNABORTED") {
    return "ECL is still processing this command. Type !status first. If the inhouse is active but players were not moved, type !ready once to retry the saved Blue/Red voice moves safely.";
  }

  return (
    error?.response?.data?.reply ||
    error?.response?.data?.message ||
    error?.message ||
    "Unknown inhouse command error."
  );
}

module.exports = {
  inhouseCommandErrorMessage,
  kookApiResponseSucceeded,
  shouldMoveInhousePlayers,
};
