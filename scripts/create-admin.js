'use strict';
/**
 * Crea o reinicia un administrador, o invita a un usuario existente.
 *
 *   node scripts/create-admin.js <email> [nombre]           → crea/actualiza admin y genera enlace de activación
 *   node scripts/create-admin.js <email> --password <clave> → fija la contraseña directamente
 *   node scripts/create-admin.js --invite <email>           → genera enlace de activación para un usuario ya existente
 */
const { users, store } = require('../server/db');
const auth = require('../server/auth');

const args = process.argv.slice(2);
if (!args.length) { console.error('Uso: node scripts/create-admin.js <email> [nombre] [--password <clave>]'); process.exit(1); }

function makeLink(u) {
  const token = auth.createToken(u.id, 'invite');
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/activar?token=${token}`;
}

if (args[0] === '--invite') {
  const row = users.byEmail(args[1]);
  if (!row) { console.error('No existe un usuario con ese email.'); process.exit(1); }
  console.log('Enlace de activación (válido 14 días):\n' + makeLink(users.get(row.id)));
  process.exit(0);
}

const email = args[0];
const pwIdx = args.indexOf('--password');
const password = pwIdx >= 0 ? args[pwIdx + 1] : null;
const name = (pwIdx >= 0 ? args.slice(1, pwIdx) : args.slice(1)).join(' ') || 'Administración';

let row = users.byEmail(email);
let u;
if (row) {
  u = users.update(row.id, { role: 'admin', active: true, name: name || row.name });
  console.log(`Usuario existente ${email} promovido a administrador.`);
} else {
  u = users.create({ email, name, role: 'admin', active: true });
  console.log(`Administrador creado: ${email}`);
}

if (password) {
  const problem = auth.passwordProblem(password);
  if (problem) { console.error('Contraseña no válida: ' + problem); process.exit(1); }
  users.setPassword(u.id, auth.hashPassword(password));
  console.log('Contraseña establecida. Ya puedes iniciar sesión.');
} else {
  console.log('\nAbre este enlace para crear la contraseña (válido 14 días):\n' + makeLink(u));
}
