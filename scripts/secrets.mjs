#!/usr/bin/env node
/**
 * @fileoverview secrets — tiny encrypted secrets vault (zero dependencies).
 *
 * Every secret is AES-256-GCM encrypted at rest with a key derived from your
 * passphrase via scrypt. The vault file lives OUTSIDE the repo by default
 * ( ~/.apex-secrets/vault.json ) so it can never be committed or pushed.
 *
 * Usage:
 *   node scripts/secrets.mjs init                      create the vault
 *   node scripts/secrets.mjs set   <name>              store a secret (masked stdin prompt)
 *   node scripts/secrets.mjs set   <name> --value x    store from a literal (careful: shell history!)
 *   node scripts/secrets.mjs set   <name> --env VAR    store from an environment variable
 *   node scripts/secrets.mjs get   <name>              print a secret
 *   node scripts/secrets.mjs list                      list stored names (no values)
 *   node scripts/secrets.mjs rm    <name>              delete one secret
 *   node scripts/secrets.mjs path                      print vault location
 *   node scripts/secrets.mjs wipe                      delete the ENTIRE vault
 *
 * Flags:
 *   --vault <path>     override vault location (default ~/.apex-secrets/vault.json)
 *   --passphrase <p>   supply passphrase non-interactively (or SECRETS_PASSPHRASE env)
 */

import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync,
} from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

// ============================================================================
// Constants
// ============================================================================

const VAULT_VERSION = 1;
const DEFAULT_VAULT = join(homedir(), '.apex-secrets', 'vault.json');
const KDF = Object.freeze({ N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 });

// ============================================================================
// CLI plumbing
// ============================================================================

function parseArgs(argv) {
  const args = { _: [], vaultPath: null, passphrase: null, value: null, env: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') args.vaultPath = argv[++i];
    else if (a === '--passphrase') args.passphrase = argv[++i];
    else if (a === '--value') args.value = argv[++i];
    else if (a === '--env') args.env = argv[++i];
    else if (a === '--json') args.json = true;
    else args._.push(a);
  }
  return args;
}

function fail(msg) {
  console.error(`[secrets] ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[secrets] ${msg}`);
}

// ---- masked prompt (raw mode; falls back to plain line on non-TTY) ----
function promptHidden(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (!process.stdin.isTTY) {
      process.stdout.write(query);
      const onData = (d) => {
        cleanup();
        resolve(d.toString().replace(/[\r\n]+$/, ''));
      };
      const onEnd = () => {
        cleanup();
        resolve('');
      };
      const cleanup = () => {
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
        rl.close();
      };
      process.stdin.once('data', onData);
      process.stdin.once('end', onEnd);
      process.stdin.resume();
      return;
    }
    process.stdout.write(query);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let buf = '';
    const onData = (c) => {
      const s = c.toString();
      if (s === '\r' || s === '\n') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        cleanup();
        resolve(buf);
      } else if (s === '\u0003') { // Ctrl-C
        process.stdin.setRawMode(false);
        cleanup();
        process.exit(130);
      } else if (s === '\u007f' || s === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      rl.close();
    };
    process.stdin.on('data', onData);
    rl.once('close', cleanup);
  });
}

async function resolvePassphrase(args, confirm = false) {
  if (args.passphrase) {
    if (confirm) warn('--passphrase supplied; skipping confirmation prompt');
    return args.passphrase;
  }
  const envP = process.env.SECRETS_PASSPHRASE;
  if (envP) return envP;
  const p1 = await promptHidden('Passphrase: ');
  if (!p1) fail('empty passphrase is not allowed');
  if (confirm) {
    const p2 = await promptHidden('Confirm passphrase: ');
    if (p1 !== p2) fail('passphrases do not match');
  }
  return p1;
}

// ============================================================================
// Vault crypto
// ============================================================================

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KDF.keyLen, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem,
  });
}

function encryptVault(records, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(records), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: VAULT_VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  };
}

function decryptVault(blob, passphrase) {
  try {
    const key = deriveKey(passphrase, Buffer.from(blob.salt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('wrong passphrase or corrupted vault');
  }
}

// ============================================================================
// Vault IO
// ============================================================================

function vaultPath(args) {
  return args.vaultPath || DEFAULT_VAULT;
}

function loadBlob(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveBlob(path, blob) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(blob, null, 2), { mode: 0o600 });
}

function openVault(args, passphrase, { create = false } = {}) {
  const path = vaultPath(args);
  const blob = loadBlob(path);
  if (!blob) {
    if (!create) fail(`no vault at ${path} — run "node scripts/secrets.mjs init" first`);
    saveBlob(path, encryptVault({}, passphrase));
    warn(`vault created at ${path}`);
    return { records: {} };
  }
  if (blob.version !== VAULT_VERSION) fail(`unsupported vault version ${blob.version}`);
  return { records: decryptVault(blob, passphrase) };
}

function persist(args, passphrase, records) {
  saveBlob(vaultPath(args), encryptVault(records, passphrase));
}

// ============================================================================
// Commands
// ============================================================================

async function cmdInit(args) {
  const path = vaultPath(args);
  if (existsSync(path)) fail(`vault already exists at ${path}`);
  const passphrase = await resolvePassphrase(args, true);
  saveBlob(path, encryptVault({}, passphrase));
  console.log(`[secrets] vault initialized at ${path}`);
}

async function cmdSet(args, name) {
  const passphrase = await resolvePassphrase(args);
  const { records } = openVault(args, passphrase, { create: true });

  let value = args.value;
  if (value == null && args.env != null) {
    value = process.env[args.env];
    if (value == null) fail(`environment variable ${args.env} is not set`);
  }
  if (value == null) {
    value = (await promptHidden(`Value for "${name}": `)).trim();
  }
  if (!value) fail('empty value is not allowed');

  records[name] = { value, created: new Date().toISOString() };
  persist(args, passphrase, records);
  console.log(`[secrets] stored "${name}" (${value.length} chars)`);
}

async function cmdGet(args, name) {
  if (!name) fail('usage: secrets get <name>');
  const passphrase = await resolvePassphrase(args);
  const { records } = openVault(args, passphrase);
  if (!(name in records)) fail(`no secret named "${name}"`);
  if (args.json) {
    console.log(JSON.stringify(records[name]));
  } else {
    warn('printing a secret — be careful of terminal scrollback and chat logs');
    process.stdout.write(records[name].value + '\n');
  }
}

async function cmdList(args) {
  const passphrase = await resolvePassphrase(args);
  const { records } = openVault(args, passphrase);
  const names = Object.keys(records).sort();
  if (!names.length) {
    console.log('[secrets] vault is empty');
    return;
  }
  console.log('[secrets] stored names:');
  for (const n of names) console.log(`  - ${n}`);
}

async function cmdRm(args, name) {
  if (!name) fail('usage: secrets rm <name>');
  const passphrase = await resolvePassphrase(args);
  const { records } = openVault(args, passphrase);
  if (!(name in records)) fail(`no secret named "${name}"`);
  delete records[name];
  persist(args, passphrase, records);
  console.log(`[secrets] removed "${name}"`);
}

function cmdPath(args) {
  console.log(vaultPath(args));
}

function cmdWipe(args) {
  const path = vaultPath(args);
  if (!existsSync(path)) fail(`no vault at ${path}`);
  rmSync(path);
  console.log(`[secrets] vault wiped at ${path}`);
}

function help() {
  console.log(`
secrets — encrypted secrets vault (AES-256-GCM + scrypt, zero deps)

  init                      create the vault
  set   <name>              store a secret (masked prompt; or --value / --env)
  get   <name>              print a secret (requires --passphrase or SECRETS_PASSPHRASE)
  list                      list names (requires --passphrase or SECRETS_PASSPHRASE)
  rm    <name>              delete one secret
  path                      print vault location
  wipe                      delete the entire vault

Flags:
  --vault <path>            override vault file (default ~/.apex-secrets/vault.json)
  --passphrase <p>          non-interactive passphrase (or SECRETS_PASSPHRASE env)
  --value <v>               literal value for set (avoid: lands in shell history)
  --env <VAR>               take value from an environment variable
  --json                    machine-readable get output

Best practices:
  - Never paste a secret into a chat, issue tracker, or repo.
  - Prefer the masked prompt over --value so it stays out of shell history.
  - The vault lives outside the repo and is never committed.
`);
}

// ============================================================================
// Entry
// ============================================================================

const args = parseArgs(process.argv.slice(2));
const [command, name] = args._;

(async () => {
  switch (command) {
    case 'init': await cmdInit(args); break;
    case 'set':
      if (!name) fail('usage: secrets set <name>');
      await cmdSet(args, name); break;
    case 'get': await cmdGet(args, name); break;
    case 'list': await cmdList(args); break;
    case 'rm':
      if (!name) fail('usage: secrets rm <name>');
      await cmdRm(args, name); break;
    case 'path': cmdPath(args); break;
    case 'wipe': cmdWipe(args); break;
    case 'help':
    case undefined: help(); break;
    default: fail(`unknown command "${command}" — run "secrets help"`);
  }
})().catch((err) => fail(err.message));