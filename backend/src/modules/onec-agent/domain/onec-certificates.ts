import { createHash, X509Certificate } from 'node:crypto';

export class OnecCertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnecCertificateError';
  }
}

/**
 * Client certificate as forwarded by Traefik `passTLSClientCert` (pem=true):
 * URL-escaped base64 DER without PEM delimiters; a chain is comma-separated
 * with the leaf first. PEM delimiters are tolerated. Returns SHA-256(DER).
 */
export function fingerprintFromForwardedHeader(header: string | undefined): Buffer | null {
  if (!header) return null;
  let value: string;
  try {
    value = decodeURIComponent(header);
  } catch {
    return null;
  }
  const leaf = value.split(',')[0] ?? '';
  const body = leaf
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (body.length < 100 || body.length > 64 * 1024 || !/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  const der = Buffer.from(body, 'base64');
  if (der.length < 64) return null;
  return createHash('sha256').update(der).digest();
}

export interface ParsedCertificate {
  fingerprint: Buffer;
  subject: string | null;
  notBefore: Date | null;
  notAfter: Date | null;
}

/** Operator input: a PEM certificate, or a SHA-256 fingerprint (64 hex, colons/spaces allowed). */
export function parseCertificateInput(input: { pem?: string | null; sha256Fingerprint?: string | null }): ParsedCertificate {
  if (input.pem && input.pem.trim()) {
    if (/PRIVATE KEY/.test(input.pem)) throw new OnecCertificateError('Передан закрытый ключ; нужен только сертификат');
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(input.pem.trim());
    } catch {
      throw new OnecCertificateError('Не удалось прочитать сертификат (ожидается PEM)');
    }
    return {
      fingerprint: createHash('sha256').update(cert.raw).digest(),
      subject: cert.subject.slice(0, 1024),
      notBefore: new Date(cert.validFrom),
      notAfter: new Date(cert.validTo),
    };
  }
  if (input.sha256Fingerprint && input.sha256Fingerprint.trim()) {
    const hex = input.sha256Fingerprint.replace(/[\s:]/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new OnecCertificateError('Отпечаток SHA-256 должен содержать 64 шестнадцатеричных символа');
    return { fingerprint: Buffer.from(hex, 'hex'), subject: null, notBefore: null, notAfter: null };
  }
  throw new OnecCertificateError('Нужен PEM сертификата или отпечаток SHA-256');
}

export function formatFingerprint(fingerprint: Buffer): string {
  return fingerprint.toString('hex').toUpperCase().match(/.{2}/g)!.join(':');
}
