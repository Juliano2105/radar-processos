// Confere a extensão antes de publicar: JSONs válidos, JS sem erro de sintaxe,
// arquivos citados no manifest existem e nenhum segredo foi esquecido no código.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = 'extensao';
let erros = 0;
const falha = (msg) => { console.error(`✗ ${msg}`); erros++; };

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
JSON.parse(readFileSync(join(DIR, 'rules.json'), 'utf8'));

const citados = new Set([
  manifest.background && manifest.background.service_worker,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
  ...((manifest.declarative_net_request || {}).rule_resources || []).map((r) => r.path),
].filter(Boolean));
for (const f of citados) if (!existsSync(join(DIR, f))) falha(`manifest cita ${f}, que não existe`);

const arquivos = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? arquivos(join(d, n)) : [join(d, n)]));
for (const f of arquivos(DIR)) {
  if (f.endsWith('.js')) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { falha(`sintaxe em ${f}: ${e.stderr}`); }
  }
  if (/\.(js|html|json|css)$/.test(f)) {
    const t = readFileSync(f, 'utf8');
    if (/sk-ant-[\w-]{10,}|AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(t)) falha(`possível segredo em ${f}`);
  }
}

if (erros) { console.error(`${erros} problema(s) — publicação cancelada.`); process.exit(1); }
console.log(`✓ Extensão OK (${manifest.name} ${manifest.version})`);
