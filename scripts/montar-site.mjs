// Monta o site do GitHub Pages em _site/: página pública (docs/) + a tela da extensão em app/ no modo site.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';

const SAIDA = '_site';
const ARQUIVOS = ['app.html', 'app.css', 'app.js', 'lib.js', 'monitor.js', 'conta.js', 'site.js'];

rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(`${SAIDA}/app`, { recursive: true });
cpSync('docs', SAIDA, { recursive: true });
for (const f of ARQUIVOS) cpSync(`extensao/${f}`, `${SAIDA}/app/${f}`);
cpSync('extensao/icons', `${SAIDA}/app/icons`, { recursive: true });

const versao = (process.env.GITHUB_SHA || '').slice(0, 7) || JSON.parse(readFileSync('extensao/manifest.json', 'utf8')).version;
let html = readFileSync('extensao/app.html', 'utf8');
const antes = '<script src="conta.js"></script>';
if (!html.includes(antes)) throw new Error('app.html mudou: não achei conta.js');
html = html.replace(antes, `${antes}\n  <script src="monitor.js"></script>\n  <script src="site.js"></script>`);
// evita cache velho depois de cada atualização
html = html.replace(/(src|href)="(app\.css|app\.js|lib\.js|monitor\.js|conta\.js|site\.js)"/g, `$1="$2?v=${versao}"`);
html = html.replace('<title>Radar de Processos</title>', '<title>Radar de Processos</title>\n  <meta name="description" content="Consulte e monitore processos judiciais por CNPJ ou CPF, de graça.">');
writeFileSync(`${SAIDA}/app/index.html`, html);
rmSync(`${SAIDA}/app/app.html`);
if (!existsSync(`${SAIDA}/index.html`)) throw new Error('docs/index.html não existe');
writeFileSync(`${SAIDA}/.nojekyll`, '');
console.log(`✓ Site montado em ${SAIDA}/ (app ${versao})`);
