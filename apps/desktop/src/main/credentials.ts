import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

/** Connector tokens, and environment-set secrets as `env:<set>:<NAME>` (CR-11). */
export type CredentialKey = 'shortcut' | 'github' | `env:${string}`;

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

  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
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

  set(key: CredentialKey, secret: string): void {
    if (!this.available()) {
      throw new Error('No secure credential store is available. On Linux, install and unlock a keyring (GNOME Keyring or KWallet).');
    }
    const data = this.load();
    data[key] = safeStorage.encryptString(secret).toString('base64');
    writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }

  get(key: CredentialKey): string | null {
    const value = this.load()[key];
    if (!value || !this.available()) return null;
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  }

  delete(key: CredentialKey): void {
    const data = this.load();
    delete data[key];
    writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }
}
