import crypto from 'node:crypto';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function cspSource(nonceValue: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';`;
}
