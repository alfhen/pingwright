import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunCa } from './ca.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagreeve-ca-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createRunCa', () => {
  it('writes the certificate 0644 in a 0755 directory and removes it on close', () => {
    const ca = createRunCa(root);
    const dir = dirname(ca.certPath);
    expect(statSync(ca.certPath).mode & 0o777).toBe(0o644);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    ca.close();
    expect(existsSync(dir)).toBe(false);
  });

  it('writes no private key to any file', () => {
    const ca = createRunCa(root);
    ca.leafFor('graph.facebook.com');
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(join(f.parentPath, f.name), 'utf8')).not.toContain('PRIVATE KEY');
    }
    ca.close();
  });

  it('signs leaf certificates for a host and for an IP, and caches them', () => {
    const ca = createRunCa(root);
    const caCert = new X509Certificate(ca.certPem);
    const leaf = ca.leafFor('Graph.Facebook.com');
    const x = new X509Certificate(leaf.certPem);
    expect(x.verify(caCert.publicKey)).toBe(true);
    expect(x.checkHost('graph.facebook.com')).toBeTruthy();
    expect(ca.leafFor('graph.facebook.com')).toBe(leaf);
    const ip = new X509Certificate(ca.leafFor('127.0.0.1').certPem);
    expect(ip.checkIP('127.0.0.1')).toBeTruthy();
    ca.close();
  });

  it('makes a different CA each run', () => {
    const a = createRunCa(root);
    const b = createRunCa(root);
    expect(a.certPem).not.toBe(b.certPem);
    a.close();
    b.close();
  });
});
