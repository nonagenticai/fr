// src/services/signup/naming.ts — the workspace name an approval founds when nobody typed one.
//
// Same order as commonpractice services/onboarding-service.ts `defaultTenantName`: the company; else
// the organisation part of the email domain (`ann@mail.acme.co.uk` → `acme`) unless the domain is a
// public mailbox provider, where the requester's name is used; else the email's local part.
// `slugify` turns it into the tenant slug the provisioning engine keys the tenant on
// (`^[a-z0-9-]{2,40}$`, provision-user's own rule).

/** Public mailbox providers: an address there names a person, never an organisation. */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru',
  'hey.com', 'fastmail.com', 'tutanota.com', 'tuta.io', 'hotmail.co.uk', 'yahoo.co.uk', 'live.nl',
  'hotmail.nl', 'ziggo.nl', 'kpnmail.nl', 'xs4all.nl', 'planet.nl', 'home.nl', 'outlook.de',
  't-online.de', 'freenet.de', 'orange.fr', 'free.fr', 'laposte.net', 'wp.pl', 'o2.pl', 'onet.pl',
  'interia.pl', 'libero.it', 'qq.com', '163.com',
]);

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

/** `mail.acme.co.uk` → `acme`; `acme.com` → `acme`. */
export function organisationOfDomain(domain: string): string | null {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const last = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  if (labels.length >= 3 && last.length === 2 && SECOND_LEVEL.has(second)) return labels[labels.length - 3]!;
  return second;
}

export function defaultTenantName(row: { email: string; name: string | null; company: string | null }): string {
  const company = row.company?.trim();
  if (company) return company;
  const domain = emailDomain(row.email);
  if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) {
    const org = organisationOfDomain(domain);
    if (org) return org;
  }
  const name = row.name?.trim();
  if (name) return name;
  return row.email.split('@')[0] || 'workspace';
}

/** A tenant slug base (≤ 36 chars, leaving room for a `-10` suffix). */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : s.length === 1 ? `${s}-ws` : 'workspace';
}

/** `<base>`, `<base>-2` … `<base>-10`. */
export function slugCandidates(base: string, max = 10): string[] {
  const out = [base];
  for (let i = 2; i <= max; i++) out.push(`${base}-${i}`);
  return out;
}
