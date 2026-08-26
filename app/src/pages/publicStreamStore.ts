/**
 * Public streams have no ticket records for the wallet to enumerate (state
 * lives entirely in the `streams`/`stream_anchors` mappings, keyed by
 * `stream_id`, with no on-chain index of "streams by sender/receiver"). This
 * module remembers, per connected address, which stream ids the app has
 * created or been told about, in `localStorage`, so the UI has something to
 * list and refresh.
 */

const STORAGE_PREFIX = "zebec.publicStreams.";

function storageKey(address: string): string {
  return `${STORAGE_PREFIX}${address}`;
}

/** Known public stream ids for `address`, in the order they were added. */
export function loadKnownStreamIds(address: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(address));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Remember `streamId` for `address` (no-op if already known). */
export function addKnownStreamId(address: string, streamId: string): void {
  const ids = loadKnownStreamIds(address);
  if (ids.includes(streamId)) return;
  ids.push(streamId);
  try {
    localStorage.setItem(storageKey(address), JSON.stringify(ids));
  } catch {
    // localStorage unavailable (private browsing, quota) — best effort only.
  }
}
