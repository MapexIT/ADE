import { main } from './bridge.ts';
import { useStore } from './store.ts';

/**
 * Copies text through the main process: the renderer is refused every permission, clipboard writes included, so
 * `navigator.clipboard.writeText` fails there. Says Copied, or why it could not.
 */
export async function copyText(text: string, done = 'Copied.'): Promise<boolean> {
  try {
    await main('main.copyText', { text });
    useStore.getState().toast(done);
    return true;
  } catch (err) {
    useStore.getState().toast(`Could not copy: ${(err as Error).message}`, 'danger');
    return false;
  }
}
