/** PL-05: what the host reports to main so closing the window can keep sessions running. */
export interface BackgroundState {
  /** Sessions that are starting, working or waiting on the user. */
  live: number;
  /** The "Keep sessions running when the window is closed" setting (on by default). */
  keepRunning: boolean;
}

export const KEEP_RUNNING_SETTING = 'app.keepRunningInBackground';

/** Whether closing the window should hide it instead of quitting. Pure. */
export function hideOnClose(state: BackgroundState, quitting: boolean): boolean {
  return !quitting && state.keepRunning && state.live > 0;
}

export function backgroundMessage(live: number): string {
  return live === 1 ? 'One session keeps running. ADE notifies you when it needs you.' : `${live} sessions keep running. ADE notifies you when they need you.`;
}
