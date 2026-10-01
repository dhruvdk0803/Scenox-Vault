import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { logger } from '../lib/logger';

let transporter: Transporter | null = null;

export function isMailConfigured() {
  return config().smtp.enabled;
}

function getTransport(): Transporter {
  if (!transporter) {
    const s = config().smtp;
    transporter = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: s.user ? { user: s.user, pass: s.password } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transporter;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

/** Send an email. Throws when SMTP is not configured or delivery fails (callers record the outcome). */
export async function sendMail(msg: MailMessage): Promise<void> {
  if (!isMailConfigured()) throw new Error('SMTP is not configured');
  const info = await getTransport().sendMail({ from: config().smtp.from, ...msg });
  logger.info({ messageId: info.messageId, subject: msg.subject }, 'email sent');
}

/** Verify SMTP connectivity (System Health). Returns null when OK, else the error message. */
export async function verifyMail(): Promise<string | null> {
  if (!isMailConfigured()) return 'not configured';
  try {
    await getTransport().verify();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Minimal, inline-styled transactional email layout. All interpolated values must be pre-escaped. */
export function emailLayout(opts: { title: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string; brand: string; color?: string }) {
  const color = opts.color ?? '#4F46E5';
  const cta = opts.ctaUrl
    ? `<p style="margin:28px 0 8px"><a href="${opts.ctaUrl}" style="background:${color};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${opts.ctaLabel ?? 'Open'}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e4e4e7;border-radius:12px">
<tr><td style="padding:28px 32px 8px;font-size:13px;font-weight:600;color:#71717a;letter-spacing:.02em">${opts.brand}</td></tr>
<tr><td style="padding:0 32px 28px"><h1 style="font-size:20px;line-height:28px;margin:8px 0 16px">${opts.title}</h1>
<div style="font-size:14px;line-height:22px;color:#3f3f46">${opts.bodyHtml}</div>${cta}</td></tr>
</table><p style="font-size:12px;color:#a1a1aa;margin-top:16px">Sent by ${opts.brand}</p></td></tr></table></body></html>`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
