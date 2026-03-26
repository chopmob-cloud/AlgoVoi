/**
 * Version check — polls the MCP server for the latest published version.
 *
 * Flow:
 *   1. On SW startup + daily alarm, fetches GET /version from MCP server
 *   2. Compares semver against chrome.runtime.getManifest().version
 *   3. If newer: stores update info in chrome.storage.local, sets badge
 *   4. Popup reads the stored info to show an "update available" banner
 *
 * The version.json on the server is the single source of truth.
 * To publish a notification, just edit /opt/ulumcp/app/version.json.
 */

import { STORAGE_KEY_AVAILABLE_UPDATE } from "@shared/constants";

const VERSION_CHECK_URL = "https://mcp.ilovechicken.co.uk/version";
const VERSION_CHECK_ALARM = "version-check";

export interface AvailableUpdate {
  latest: string;
  url: string;
  notes: string;
  mandatory: boolean;
}

/** Compare two semver strings. Returns true if remote > local. */
function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

/** Fetch version from server, compare, store + badge if newer. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  try {
    const resp = await fetch(VERSION_CHECK_URL, {
      cache: "no-cache",
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      latest?: string;
      url?: string;
      notes?: string;
      mandatory?: boolean;
    };
    if (!data.latest || typeof data.latest !== "string") return null;

    const current = chrome.runtime.getManifest().version;
    if (!isNewer(data.latest, current)) {
      // No update — clear any stale stored update
      await chrome.storage.local.remove(STORAGE_KEY_AVAILABLE_UPDATE);
      return null;
    }

    const update: AvailableUpdate = {
      latest: data.latest,
      url: data.url ?? "",
      notes: data.notes ?? "",
      mandatory: data.mandatory ?? false,
    };
    await chrome.storage.local.set({ [STORAGE_KEY_AVAILABLE_UPDATE]: update });
    chrome.action.setBadgeText({ text: "UPD" });
    chrome.action.setBadgeBackgroundColor({ color: "#F59E0B" }); // amber
    return update;
  } catch {
    // Network failure — silent, don't block startup
    return null;
  }
}

/** Register the daily alarm. Call once from index.ts. */
export function scheduleVersionCheck(): void {
  chrome.alarms.create(VERSION_CHECK_ALARM, {
    delayInMinutes: 1,         // first check ~1 min after startup
    periodInMinutes: 24 * 60,  // then every 24 hours
  });
}

/** Handle the alarm tick. Called from the alarms listener. */
export function handleVersionCheckAlarm(alarmName: string): boolean {
  if (alarmName !== VERSION_CHECK_ALARM) return false;
  checkForUpdate().catch(() => {});
  return true;
}

