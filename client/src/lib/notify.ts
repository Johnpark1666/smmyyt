// Native notification helpers — Windows toast + taskbar flash
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const win = getCurrentWindow();

/** OS toast + taskbar flash (Critical) */
export async function notify(title: string, body: string): Promise<void> {
  try {
    await invoke('notify', { title, body });
  } catch {
    /* toast unavailable */
  }
  try {
    await win.requestUserAttention(1);
  } catch {
    /* flash unavailable */
  }
}