import fs from 'node:fs';
import path from 'node:path';

export class CredentialStore {
  constructor({ filePath, encrypt, decrypt, available = () => true }) {
    this.filePath = filePath;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.available = available;
  }

  has() {
    return fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0;
  }

  save(value) {
    const secret = String(value ?? '').trim();
    if (!secret) throw new Error('API Key vazia');
    if (!this.available()) throw new Error('Armazenamento seguro indisponível neste sistema');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, this.encrypt(secret));
  }

  load() {
    if (!this.has()) return null;
    if (!this.available()) throw new Error('Armazenamento seguro indisponível neste sistema');
    return this.decrypt(fs.readFileSync(this.filePath));
  }

  clear() {
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true });
  }
}
