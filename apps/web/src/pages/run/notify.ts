import { useEffect, useRef, useState } from "react";
import { isActive, runStateLabel } from "../../app/format.js";

/**
 * "Tell me when it ends, pauses or needs me": a system notification when a run this page watches stops working. The
 * choice is this browser's own and kept in local storage; storage that cannot be read reads as off.
 */
const KEY = "arbitra.notify-on-stop";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.Notification === "function";
}

function stored(): boolean {
  try { return window.localStorage.getItem(KEY) === "on"; } catch { return false; }
}

/** The choice, and a setter that asks the browser's permission when it is turned on. */
export function useNotifyChoice(): readonly [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => notificationsSupported() && stored() && window.Notification.permission === "granted");
  const choose = (next: boolean): void => {
    const keep = (value: boolean): void => { try { window.localStorage.setItem(KEY, value ? "on" : "off"); } catch { /* the choice lasts for this page only */ } setOn(value); };
    if (!next || !notificationsSupported()) { keep(false); return; }
    if (window.Notification.permission === "granted") { keep(true); return; }
    void window.Notification.requestPermission().then((permission) => keep(permission === "granted"), () => keep(false));
  };
  return [on, choose];
}

/** Fires the notification when `state` moves from working to stopped, if the person asked for it. */
export function useNoticeOnStop(state: string | null, title: string): void {
  const previous = useRef(state);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (!isActive(before) || isActive(state) || state === null || !notificationsSupported() || !stored() || window.Notification.permission !== "granted") return;
    try { new window.Notification(`arbitra · ${title}`, { body: `The run is ${runStateLabel(state).text}.` }); } catch { /* a notification that cannot be shown changes nothing on the page */ }
  }, [state, title]);
}
