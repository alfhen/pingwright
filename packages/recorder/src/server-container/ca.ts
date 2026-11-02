import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import forge from 'node-forge';

export interface LeafCertificate {
  readonly certPem: string;
  readonly keyPem: string;
}

export interface RunCa {
  /** Path of the CA certificate (PEM). The key is in no file. */
  readonly certPath: string;
  readonly certPem: string;
  leafFor(host: string): LeafCertificate;
  /** Removes the certificate directory. The key only ever lived in memory. */
  close(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function serial(): string {
  // The high bit stays clear so the DER integer is positive.
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

function newKeyPair(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priv = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  return { privateKey: priv, publicKey: forge.pki.rsa.setPublicKey(priv.n, priv.e) };
}

/** Makes a CA for one run. The certificate goes in a fresh directory under `tempRoot`. */
export function createRunCa(tempRoot: string): RunCa {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'tagreeve-ca-'));
  chmodSync(dir, 0o755);

  const caKeys = newKeyPair();
  const leafKeys = newKeyPair();
  const leafKeyPem = forge.pki.privateKeyToPem(leafKeys.privateKey);
  const now = Date.now();

  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = serial();
  caCert.validity.notBefore = new Date(now - 60 * 60 * 1000);
  caCert.validity.notAfter = new Date(now + 2 * DAY_MS);
  const caName = [{ name: 'commonName', value: `Tagreeve run CA ${randomBytes(4).toString('hex')}` }];
  caCert.setSubject(caName);
  caCert.setIssuer(caName);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(caCert);

  const certPath = join(dir, 'ca.pem');
  writeFileSync(certPath, certPem, { mode: 0o644 });
  chmodSync(certPath, 0o644);

  const leaves = new Map<string, LeafCertificate>();

  function leafFor(host: string): LeafCertificate {
    const name = host.toLowerCase();
    const cached = leaves.get(name);
    if (cached) return cached;
    const cert = forge.pki.createCertificate();
    cert.publicKey = leafKeys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(now - 60 * 60 * 1000);
    cert.validity.notAfter = new Date(now + 2 * DAY_MS);
    cert.setSubject([{ name: 'commonName', value: name.slice(0, 64) }]);
    cert.setIssuer(caCert.subject.attributes);
    const altName = isIP(name) ? { type: 7, ip: name } : { type: 2, value: name };
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [altName] },
    ]);
    cert.sign(caKeys.privateKey, forge.md.sha256.create());
    const leaf = { certPem: forge.pki.certificateToPem(cert), keyPem: leafKeyPem };
    leaves.set(name, leaf);
    return leaf;
  }

  return {
    certPath,
    certPem,
    leafFor,
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
