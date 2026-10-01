import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { audit } from '../lib/activity';
import { validationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { parse } from '../lib/validate';
import { deleteBrandingKey, readImageUpload, storeBrandingImage } from '../services/branding';
import { emailLayout, escapeHtml, isMailConfigured, sendMail } from '../services/mailer';
import { getSettings, getSettingsDTO, updateSettings } from '../services/settings';
import { emailSchema, extensionList, hexColor, positiveIntOrNull } from '../services/validation';

const percent = z.number().int('Must be a whole number.').min(50, 'Must be between 50 and 99.').max(99, 'Must be between 50 and 99.');
const hours = z.number().int('Must be a whole number.').min(1, 'Must be between 1 and 720.').max(720, 'Must be between 1 and 720.');

export const updateSettingsSchema = z.strictObject({
  branding: z
    .strictObject({
      companyName: z.string().trim().min(1, 'Required.').max(100),
      primaryColor: hexColor.transform((v) => v.toUpperCase()),
      portalTitle: z.string().trim().min(1, 'Required.').max(120),
      supportEmail: z
        .union([z.literal(''), z.null(), emailSchema])
        .transform((v) => (v === '' ? null : v)),
    })
    .partial(),
  notifications: z
    .strictObject({
      adminEmails: z.array(emailSchema).max(20, 'At most 20 emails.').transform((l) => [...new Set(l)]),
      notifyOnUploadComplete: z.boolean(),
      notifyOnUploadFailed: z.boolean(),
      notifyClientReceipt: z.boolean(),
      diskWarningPercent: percent,
      diskCriticalPercent: percent,
    })
    .partial(),
  security: z
    .strictObject({
      blockedExtensions: extensionList(500),
      blockExecutables: z.boolean(),
      adminSessionHours: hours,
      portalSessionHours: hours,
    })
    .partial(),
  retention: z
    .strictObject({
      incompleteUploadHours: hours,
      exportHours: hours,
      activityLogDays: z.number().int().min(0, 'Must be 0 or more.').max(3650, 'Must be at most 3650.'),
    })
    .partial(),
  uploads: z.strictObject({ defaultMaxFileSizeBytes: positiveIntOrNull, defaultPortalQuotaBytes: positiveIntOrNull }).partial(),
}).partial();

const testEmailSchema = z.strictObject({ to: emailSchema });

export default async function settingsRoutes(app: FastifyInstance) {
  const view = { preHandler: app.requirePermission('settings.view') };
  const manage = { preHandler: app.requirePermission('settings.manage') };

  app.get('/', view, async () => getSettingsDTO());

  app.patch('/', manage, async (req) => {
    const patch = parse(updateSettingsSchema, req.body);
    if (patch.notifications && (patch.notifications.diskWarningPercent !== undefined || patch.notifications.diskCriticalPercent !== undefined)) {
      const cur = (await getSettings()).notifications;
      const warn = patch.notifications.diskWarningPercent ?? cur.diskWarningPercent;
      const crit = patch.notifications.diskCriticalPercent ?? cur.diskCriticalPercent;
      if (warn >= crit) {
        throw validationError(
          { fields: { 'notifications.diskWarningPercent': 'The warning level must be lower than the critical level.' } },
          'The warning level must be lower than the critical level.',
        );
      }
    }
    await updateSettings(patch, req.user!.id);
    await audit(req, { action: 'settings.updated', resourceType: 'settings', metadata: { sections: Object.keys(patch) } });
    return getSettingsDTO();
  });

  async function setImage(req: FastifyRequest, kind: 'logo' | 'favicon') {
    const img = await readImageUpload(req, { allowIcon: kind === 'favicon' });
    const key = await storeBrandingImage(kind, img);
    const field = kind === 'logo' ? 'logoKey' : 'faviconKey';
    const previous = (await getSettings()).branding[field];
    await updateSettings({ branding: { [field]: key } }, req.user!.id);
    await deleteBrandingKey(previous);
    await audit(req, { action: 'settings.updated', resourceType: 'settings', metadata: { sections: ['branding'], changed: kind } });
    return getSettingsDTO();
  }

  async function removeImage(req: FastifyRequest, kind: 'logo' | 'favicon') {
    const field = kind === 'logo' ? 'logoKey' : 'faviconKey';
    const previous = (await getSettings()).branding[field];
    await updateSettings({ branding: { [field]: null } }, req.user!.id);
    await deleteBrandingKey(previous);
    await audit(req, { action: 'settings.updated', resourceType: 'settings', metadata: { sections: ['branding'], removed: kind } });
    return getSettingsDTO();
  }

  app.post('/logo', manage, (req) => setImage(req, 'logo'));
  app.delete('/logo', manage, (req) => removeImage(req, 'logo'));
  app.post('/favicon', manage, (req) => setImage(req, 'favicon'));
  app.delete('/favicon', manage, (req) => removeImage(req, 'favicon'));

  app.post('/test-email', manage, async (req) => {
    const { to } = parse(testEmailSchema, req.body);
    if (!isMailConfigured()) {
      return { ok: false, message: 'Email is not configured. Set the SMTP_* environment variables and restart the server.' };
    }
    const { branding } = await getSettings();
    try {
      await sendMail({
        to,
        subject: `Test email from ${branding.companyName}`,
        text: `This is a test email from ${branding.companyName}. If you can read this, your email settings work.`,
        html: emailLayout({
          title: 'Test email',
          bodyHtml: `<p>This is a test email from ${escapeHtml(branding.companyName)}. If you can read this, your email settings work.</p>`,
          brand: escapeHtml(branding.companyName),
          color: branding.primaryColor,
        }),
      });
    } catch (err) {
      logger.warn({ err, smtpHost: config().smtp.host }, 'test email failed');
      return { ok: false, message: `The test email could not be sent: ${(err as Error).message.slice(0, 200)}` };
    }
    await audit(req, { action: 'settings.test_email', resourceType: 'settings', metadata: { to } });
    return { ok: true, message: `Test email sent to ${to}.` };
  });
}
