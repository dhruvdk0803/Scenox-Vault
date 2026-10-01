/**
 * Admin CLI.
 *   node dist/cli.js create-owner --email you@example.com --name "Your Name"
 *   node dist/cli.js reset-password --email you@example.com
 *   node dist/cli.js list-users
 * The password comes from $SCENOX_PASSWORD or an interactive (hidden) prompt.
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from './db';
import { users } from './db/schema';
import { logActivity } from './lib/activity';
import { hashPassword, passwordProblems } from './lib/password';
import { revokeUserSessions } from './services/auth';
import { emailSchema, isUniqueViolation } from './services/validation';

class CliError extends Error {}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = 'true';
  }
  return flags;
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) });
    process.stdout.write(question);
    muted = hidden;
    rl.question('', (answer) => {
      muted = false;
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.SCENOX_PASSWORD;
  const password = fromEnv ?? (await ask('Password: ', true));
  if (!fromEnv) {
    const again = await ask('Confirm password: ', true);
    if (again !== password) throw new CliError('Passwords do not match.');
  }
  const problem = passwordProblems(password);
  if (problem) throw new CliError(problem);
  return password;
}

function requireEmail(flags: Record<string, string>) {
  const r = emailSchema.safeParse(flags.email ?? '');
  if (!r.success) throw new CliError('Provide a valid --email.');
  return r.data;
}

async function createOwner(flags: Record<string, string>) {
  const email = requireEmail(flags);
  const name = (flags.name ?? '').trim();
  if (!name || name === 'true') throw new CliError('Provide --name.');
  const password = await readPassword();
  try {
    const [u] = await getDb()
      .insert(users)
      .values({ email, name, role: 'owner', passwordHash: await hashPassword(password), passwordChangedAt: new Date() })
      .returning();
    await logActivity({ actorType: 'system', actorLabel: 'cli', action: 'user.created', resourceType: 'user', resourceId: u.id, metadata: { name, email, role: 'owner', via: 'cli' } });
    console.log(`Created owner ${u.email} (${u.id}).`);
  } catch (err) {
    if (isUniqueViolation(err)) throw new CliError(`A user with email ${email} already exists.`);
    throw err;
  }
}

async function resetPassword(flags: Record<string, string>) {
  const email = requireEmail(flags);
  const [user] = await getDb().select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (!user) throw new CliError(`No user with email ${email}.`);
  const password = await readPassword();
  await getDb()
    .update(users)
    .set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await revokeUserSessions(user.id);
  await logActivity({ actorType: 'system', actorLabel: 'cli', action: 'user.updated', resourceType: 'user', resourceId: user.id, metadata: { name: user.name, passwordReset: true, via: 'cli' } });
  console.log(`Password updated for ${user.email}. All sessions were signed out.`);
}

async function listUsers() {
  const rows = await getDb().select().from(users).orderBy(users.createdAt);
  if (rows.length === 0) return console.log('No users yet.');
  for (const u of rows) {
    console.log([u.email.padEnd(36), u.role.padEnd(7), u.status.padEnd(8), u.name].join('  '));
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  switch (command) {
    case 'create-owner':
      return createOwner(flags);
    case 'reset-password':
      return resetPassword(flags);
    case 'list-users':
      return listUsers();
    default:
      console.log('Usage:\n  cli create-owner --email <email> --name <name>\n  cli reset-password --email <email>\n  cli list-users\n\nSet SCENOX_PASSWORD to avoid the interactive password prompt.');
      if (command) process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof CliError ? `Error: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb().then(() => process.exit()));
