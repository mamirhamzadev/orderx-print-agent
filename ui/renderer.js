const pairBadge = document.getElementById("pair-badge");
const pairCopy = document.getElementById("pair-copy");
const pairForm = document.getElementById("pair-form");
const pairCode = document.getElementById("pair-code");
const pairSubmit = document.getElementById("pair-submit");
const pairHint = document.getElementById("pair-hint");
const unpairButton = document.getElementById("unpair-button");

const setText = (el, value) => {
  if (el) el.textContent = value;
};

const showHint = (message, isError = false) => {
  if (!pairHint) return;
  pairHint.classList.toggle("error", Boolean(isError && message));
  setText(pairHint, message || "");
};

const render = (status) => {
  if (pairSubmit) pairSubmit.disabled = false;
  if (pairCode) {
    pairCode.disabled = false;
    pairCode.readOnly = false;
  }

  if (status?.paired) {
    pairBadge.className = "badge ok";
    setText(pairBadge, "Paired");
    setText(pairCopy, "Paired. The local service is running. Manage printers from POS Web.");
    pairForm.hidden = true;
    unpairButton.hidden = false;
    showHint("");
    return;
  }

  pairForm.hidden = false;
  unpairButton.hidden = true;
  setText(
    pairCopy,
    "Enter the code from POS Web → Settings → Printers, then Confirm. The local service starts automatically.",
  );

  if (status?.pairingError || status?.lastError) {
    pairBadge.className = "badge";
    setText(pairBadge, "Not paired");
    showHint(status.pairingError || status.lastError, true);
  } else if (status?.pendingPairing) {
    pairBadge.className = "badge warn";
    setText(pairBadge, "Waiting");
    showHint("Waiting for POS Web to confirm this code…");
  } else {
    pairBadge.className = "badge";
    setText(pairBadge, "Not paired");
    showHint("");
  }
};

const submitPairingCode = async () => {
  showHint("");
  if (pairSubmit) pairSubmit.disabled = true;
  try {
    const status = await window.printAgent.setPendingCode(pairCode.value);
    render(status);
  } catch (error) {
    showHint(error?.message || "Could not save pairing code", true);
  } finally {
    if (pairSubmit) pairSubmit.disabled = false;
  }
};

pairForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitPairingCode();
});

pairSubmit?.addEventListener("click", async (event) => {
  event.preventDefault();
  await submitPairingCode();
});

unpairButton?.addEventListener("click", async () => {
  if (!window.confirm("Unpair this agent? The local service will stop.")) return;
  try {
    const status = await window.printAgent.unpair();
    pairForm?.reset();
    if (pairCode) pairCode.value = "";
    if (pairSubmit) pairSubmit.disabled = false;
    render(status);
  } catch (error) {
    showHint(error?.message || "Could not unpair", true);
  }
});

window.printAgent.onStatus(render);
window.printAgent.getStatus().then(render).catch((error) => {
  showHint(error?.message || "Could not read agent status", true);
});
