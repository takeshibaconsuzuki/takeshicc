// Shared webview CSP plumbing so a tightened policy is defined in one place
// rather than copied per view.

export function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export function contentSecurityPolicy(scriptNonce: string, styleNonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${styleNonce}'`,
    `script-src 'nonce-${scriptNonce}'`,
  ].join('; ');
}
