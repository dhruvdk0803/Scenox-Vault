/** DEVELOPMENT ONLY seed: owner account, three sample clients and one portal each. */
import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { hashPassword } from '../lib/password';
import { decryptPortalUrl, generatePortalToken } from '../services/portal-tokens';
import { closeDb, getDb } from './index';
import { clients, portals, users } from './schema';

async function seed() {
  if (config().isProd && !process.argv.includes('--force')) {
    throw new Error('Refusing to seed a production database. Pass --force if you really mean it.');
  }
  const db = getDb();
  const email = 'admin@scenox.local';
  const password = process.env.SEED_ADMIN_PASSWORD || 'scenox-dev-password';

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let ownerId = existing?.id;
  if (!existing) {
    const [u] = await db
      .insert(users)
      .values({ email, name: 'Admin', role: 'owner', passwordHash: await hashPassword(password), passwordChangedAt: new Date() })
      .returning();
    ownerId = u.id;
    console.log(`Created owner ${email} / ${password}`);
  } else {
    console.log(`Owner ${email} already exists (password unchanged).`);
  }

  const in14Days = new Date(Date.now() + 14 * 86_400_000);
  const samples = [
    { client: { name: 'ABC Company', company: 'ABC Company Ltd', email: 'hello@abc.example' }, portal: { name: 'ABC Uploads', password: 'client-pass-123' } },
    { client: { name: 'XYZ Retail', company: 'XYZ Retail Inc', email: 'team@xyz.example' }, portal: { name: 'XYZ Product Photos', expiresAt: in14Days } },
    { client: { name: 'Northwind Studio', company: 'Northwind Studio', email: 'studio@northwind.example' }, portal: { name: 'Northwind Assets' } },
  ];

  for (const s of samples) {
    let [client] = await db.select().from(clients).where(eq(clients.name, s.client.name)).limit(1);
    client ??= (await db.insert(clients).values({ ...s.client, createdBy: ownerId }).returning())[0];
    let [portal] = await db.select().from(portals).where(and(eq(portals.clientId, client.id), eq(portals.name, s.portal.name))).limit(1);
    if (!portal) {
      const tok = generatePortalToken();
      const { password: portalPassword, ...rest } = s.portal as { name: string; password?: string; expiresAt?: Date };
      [portal] = await db
        .insert(portals)
        .values({
          ...rest,
          clientId: client.id,
          tokenHash: tok.tokenHash,
          tokenEncrypted: tok.tokenEncrypted,
          tokenPreview: tok.tokenPreview,
          passwordHash: portalPassword ? await hashPassword(portalPassword) : null,
          createdBy: ownerId,
        })
        .returning();
    }
    const note = s.portal.password ? ` (password: ${s.portal.password})` : s.portal.expiresAt ? ' (expires in 14 days)' : '';
    console.log(`${client.name} → ${portal.name}: ${decryptPortalUrl(portal)}${note}`);
  }
}

seed()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
