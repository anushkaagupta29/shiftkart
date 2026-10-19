// One-command local setup: env file, Postgres in Docker, migrations, seed.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const step = (m) => console.log(`\n▶ ${m}`);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Node ${process.versions.node} is too old. Install Node 20.12 or newer.`);
  process.exit(1);
}

step('Checking Docker');
try {
  execSync('docker info', { stdio: 'ignore' });
} catch {
  console.error('Docker is not running. Open Docker Desktop, wait until it says "running", then re-run `npm run setup`.');
  process.exit(1);
}

step('Creating .env');
if (existsSync('.env')) {
  console.log('.env already exists, keeping it');
} else {
  const filled = readFileSync('.env.example', 'utf8')
    .replace(/^DATA_KEY=$/m, `DATA_KEY=${randomBytes(32).toString('base64')}`)
    .replace(/^HASH_KEY=$/m, `HASH_KEY=${randomBytes(32).toString('base64')}`)
    .replace(/^SEED_STAFF_PASSWORD=$/m, `SEED_STAFF_PASSWORD=${randomBytes(9).toString('base64url')}`);
  writeFileSync('.env', filled, { mode: 0o600 });
  console.log('.env created with fresh random keys');
}

step('Starting Postgres (first run builds the image, ~1-2 min)');
run('docker compose -f infra/docker-compose.yml up -d --build --wait');

step('Running migrations');
run('npm run db:migrate');

step('Seeding sample data');
run('npm run db:seed');

console.log(`
✅ Setup done.

  npm run dev     start the API (http://localhost:4000) and admin console (http://localhost:3001)
  npm test        run all tests

Staff logins are listed in README.md. Password: SEED_STAFF_PASSWORD in .env
2FA code for a staff login:   npm run totp -- support@shiftkart.local
`);
