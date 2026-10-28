import { store } from "../store.js";
import { recoverConfig } from "../ws.js";
import { toast } from "./toast.js";

let recoveryNotice;

function show(body) {
  recoveryNotice = toast.warn({
    id: "config-recovery",
    title: "Settings file needs recovery",
    body,
    duration: 0,
    action: { label: "Recover", onClick: () => recoverConfig() },
  });
}

export function initConfigRecovery() {
  store.on("config", (event) => {
    if (event.recovery?.message) show(event.recovery.message);
    else {
      recoveryNotice?.dismiss();
      recoveryNotice = null;
    }
  });
  store.on("config:updateFailed", (event) => {
    if (event.code === "config_recovery_required") show(event.error || "Settings were not saved.");
  });
  store.on("config:recovered", (event) => {
    if (event.success && event.recovered) {
      recoveryNotice = null;
      toast.success({
        id: "config-recovery",
        title: "Settings recovered",
        body: event.preserved
          ? `Original bytes were archived as ${event.preserved}. A new default config was written.`
          : "A new default config is in use.",
      });
    } else if (event.success === false) {
      recoveryNotice = toast.error({
        id: "config-recovery", title: "Recovery failed",
        body: event.error || "The original config was left in place.",
        duration: 0,
        action: { label: "Retry", onClick: () => recoverConfig() },
      });
    }
  });
}
