import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

/** Connector tokens, and environment-set secrets as `env:<set>:<NAME>` (CR-11). */
export type CredentialKey = 'shortcut' | 'github' | 'telegram' | 'telegram-password' | `env:${string}`;

/**
 * Connector tokens, encrypted with Electron safeStorage (rule 7). The file only ever holds ciphertext.
 * On Linux, ADE refuses to store tokens when safeStorage would fall back to plain text.
 */
export class CredentialStore {
  private readonly file: string;

  constructor(userData: string) {
    this.file = join(userData, 'credentials.bin.json');
  }

  backend(): string {
    if (process.platform === 'linux') return safeStorage.getSelectedStorageBackend();
    return process.platform === 'win32' ? 'dpapi' : 'keychain';
  }

  /** Electron 45: the async safeStorage API; the sync one is deprecated. */
  async available(): Promise<boolean> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    if (process.platform === 'linux') {
      const b = safeStorage.getSelectedStorageBackend();
      if (b === 'basic_text' || b === 'unknown') return false;
    }
    return true;
  }

  private load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Connector tokens only; environment secrets are never listed. */
  stored(): CredentialKey[] {
    return (Object.keys(this.load()) as CredentialKey[]).filter((k) => !k.startsWith('env:'));
  }

  async set(key: CredentialKey, secret: string): Promise<void> {
    if (!(await this.available())) {
      throw new Error('No secure credential store is available. On Linux, install and unlock a keyring (GNOME Keyring or KWallet).');
    }
    const encrypted = (await safeStorage.encryptStringAsync(secret)).toString('base64');
    const data = this.load();
    data[key] = encrypted;
    writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }

  async get(key: CredentialKey): Promise<string | null> {
    const value = this.load()[key];
    if (!value || !(await this.available())) return null;
    // Data written with the old encryptString decrypts here too. When the key was rotated, store it again.
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'));
    if (shouldReEncrypt) await this.set(key, result).catch(() => undefined);
    return result;
  }

  delete(key: CredentialKey): void {
    const data = this.load();
    delete data[key];
    writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }
}
