// E2E w prawdziwym VS Code: Playwright steruje Electronem VS Code z rozszerzeniem w trybie deweloperskim
// i zagląda do iframe z podglądem wewnątrz webview. Wymaga mdlive w PATH (z --embedded) i ekranu
// (xvfb-run, zobacz npm run test:e2e).
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), '..');
const screenshot = process.argv[2];

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), 'mdlive-vscode-'));
const workspace = join(root, 'workspace');

// MDLIVE_E2E_RESTRICTED=1: workspace otwarty w Restricted Mode (Workspace Trust bez pytania przy starcie)
const restricted = process.env.MDLIVE_E2E_RESTRICTED === '1';

// Ustawienia użytkownika: mdlive.trustedDirs obejmuje workspace, więc config.csx działa bez mdlive trust
// (o ile workspace jest zaufany). MDLIVE_PATH: inna binarka, np. wrapper z innymi --frame-ancestors.
const settings = {
  'mdlive.trustedDirs': [workspace],
  ...(process.env.MDLIVE_E2E_NO_STICKY === '1' ? { 'editor.stickyScroll.enabled': false } : {}),
  ...(process.env.MDLIVE_PATH ? { 'mdlive.path': process.env.MDLIVE_PATH } : {}),
  ...(restricted ? { 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.untrustedFiles': 'open' } : {}),
};
mkdirSync(join(root, 'user-data', 'User'), { recursive: true });
writeFileSync(join(root, 'user-data', 'User', 'settings.json'), JSON.stringify(settings));

mkdirSync(join(workspace, '.mdlive'), { recursive: true });
// Długi dokument dla scroll sync: 120 sekcji po nagłówku i akapicie
const sections = Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\nParagraph ${i} with some text.\n`).join('\n');
writeFileSync(join(workspace, 'doc.md'), '# Hello VS Code\n\nFirst paragraph.\n\n' + sections);
writeFileSync(join(workspace, '.mdlive', 'style.css'), 'h1 { color: rgb(200, 0, 0); }');
writeFileSync(join(workspace, '.mdlive', 'config.csx'), `
public class TitleConfig(ILogger<MdLiveConfigurator> logger) : MdLiveConfigurator(logger)
{
    public override Task<string?> ProvideTitle(MarkdownDocument document) => Task.FromResult<string?>("Title from config.csx");
}
`);

const vscodePath = await downloadAndUnzipVSCode({ version: 'stable', cachePath: join(extensionPath, 'test', '.vscode-test') });
const app = await electron.launch({
  executablePath: vscodePath,
  args: [
    workspace,
    join(workspace, 'doc.md'),
    `--extensionDevelopmentPath=${extensionPath}`,
    `--user-data-dir=${join(root, 'user-data')}`,
    `--extensions-dir=${join(root, 'extensions')}`,
    ...(restricted ? [] : ['--disable-workspace-trust']),
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
    '--no-sandbox',
  ],
  env: { ...process.env, XDG_DATA_HOME: join(root, 'data') },
});

const errors = [];
try {
  const window = await app.firstWindow();
  window.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await window.waitForSelector('.monaco-workbench', { timeout: 60000 });
  await window.waitForSelector('.tab[aria-label*="doc.md"]', { timeout: 30000 });
  await window.locator('.monaco-editor .view-lines').first().click();

  const runCommand = async (title) => {
    await window.keyboard.press('F1');
    await window.waitForSelector('.quick-input-widget input');
    await window.keyboard.type(title);
    await sleep(500);
    await window.keyboard.press('Enter');
  };

  await runCommand('MdLive: Open Preview to the Side');

  const previewFrame = async () => {
    for (let i = 0; i < 60; i++) {
      const frame = window.frames().find((f) => f.url().startsWith('http://127.0.0.1'));
      if (frame) {
        return frame;
      }
      await sleep(500);
    }
    return undefined;
  };

  let frame = await previewFrame();
  check('preview iframe appears in a webview', !!frame, frame?.url().replace(/#.*/, '#<token>'));
  if (!frame) {
    const csp = errors.filter((e) => /frame-ancestors/.test(e)).slice(0, 1);
    throw new Error(`no preview frame; frames: ${window.frames().map((f) => f.url().slice(0, 40)).join(', ')}; ${csp.join(' ')}`);
  }

  await frame.waitForFunction(() => document.querySelector('h1')?.textContent === 'Hello VS Code', null, { timeout: 15000 }).catch(() => {});
  check('document rendered by mdlive in the preview', await frame.evaluate(() => document.querySelector('h1')?.textContent === 'Hello VS Code'),
    (await frame.evaluate(() => document.body.innerText)).slice(0, 80).replace(/\n/g, ' | '));
  check('.mdlive/style.css applied', await frame.evaluate(() => getComputedStyle(document.querySelector('h1')).color === 'rgb(200, 0, 0)'));
  check('token removed from the iframe URL', !frame.url().includes('#'), frame.url());

  // config.csx: w zaufanym workspace mdlive.trustedDirs go obejmuje, w Restricted Mode --trust nie jest przekazywane
  if (restricted) {
    await frame.waitForFunction(() => !!document.getElementById('__mdlive-notice'), null, { timeout: 15000 }).catch(() => {});
    const notice = await frame.evaluate(() => document.getElementById('__mdlive-notice')?.textContent ?? '');
    check('Restricted Mode: trustedDirs not applied, config.csx not run', notice.includes('is not trusted') && (await frame.title()) === 'Hello VS Code',
      `${await frame.title()} / ${notice.slice(0, 60)}`);
  } else {
    await frame.waitForFunction(() => document.title === 'Title from config.csx', null, { timeout: 15000 }).catch(() => {});
    check('mdlive.trustedDirs: config.csx runs without mdlive trust', (await frame.title()) === 'Title from config.csx', await frame.title());
  }

  // Pisanie w edytorze trafia do podglądu bez zapisu
  await window.locator('.monaco-editor .view-lines').first().click();
  await window.keyboard.press('Control+End');
  await window.keyboard.type('\n\n## Typed live');
  await frame.waitForFunction(() => [...document.querySelectorAll('h2')].some((h) => h.textContent === 'Typed live'), null, { timeout: 10000 }).catch(() => {});
  check('typing updates the preview', await frame.evaluate(() => [...document.querySelectorAll('h2')].some((h) => h.textContent === 'Typed live')));

  // Scroll sync. Góra edytora: najmniejszy numer w marginesie, który jest jeszcze widoczny.
  const editorTopLine = () => window.evaluate(() => {
    const editor = document.querySelector('.editor-instance .monaco-editor');
    const top = editor.getBoundingClientRect().top;
    const numbers = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')]
      .filter((e) => e.getBoundingClientRect().bottom > top + 2)
      .map((e) => Number(e.textContent))
      .filter(Number.isFinite);
    return Math.min(...numbers);
  });
  const previewTopLine = () => frame.evaluate(() => window.mdlive.lineAtOffset(window.scrollY));
  // Prostokąt okna edytora, nie .view-lines: ten ma wysokość całego dokumentu i przesuwa się z przewijaniem
  const editorBox = await window.locator('.editor-instance .monaco-editor').first().boundingBox();
  const webviewBox = await window.locator('iframe.webview').first().boundingBox();

  // Kod -> podgląd: kółko nad edytorem
  // Od początku dokumentu, żeby oba widoki miały zapas w obie strony
  await window.mouse.click(editorBox.x + editorBox.width / 2, editorBox.y + 10);
  await window.keyboard.press('Control+Home');
  await sleep(800);
  await window.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2);
  for (let i = 0; i < 10; i++) {
    await window.mouse.wheel(0, 300);
    await sleep(50);
  }
  await sleep(1500);
  let e = await editorTopLine();
  let p = await previewTopLine();
  check('scrolling the editor scrolls the preview to the same line', e > 20 && Math.abs(p - e) <= 1.5, `editor ${e}, preview ${p.toFixed(1)}`);

  // Podgląd -> kod: kółko nad podglądem
  const beforeEditor = e;
  await window.mouse.move(webviewBox.x + webviewBox.width / 2, webviewBox.y + webviewBox.height / 2);
  await window.mouse.wheel(0, 3000);
  await sleep(1500);
  e = await editorTopLine();
  p = await previewTopLine();
  check('scrolling the preview scrolls the editor to the same line', e > beforeEditor + 20 && Math.abs(e - Math.floor(p)) <= 1,
    `editor ${beforeEditor} -> ${e}, preview ${p.toFixed(1)}`);

  // Bez ping-ponga: po zatrzymaniu nic się samo nie przesuwa
  await sleep(1500);
  const stillE = await editorTopLine();
  const stillP = await previewTopLine();
  check('no feedback loop: both stay where they are', stillE === e && Math.abs(stillP - p) < 0.01, `editor ${e} -> ${stillE}, preview ${p.toFixed(2)} -> ${stillP.toFixed(2)}`);

  // Pisanie w widocznym fragmencie nie przesuwa edytora (podgląd zmienia układ, ale to nie wraca do edytora)
  await window.mouse.click(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 3);
  await window.keyboard.type(' edited');
  await sleep(1500);
  const typedE = await editorTopLine();
  const typedP = await previewTopLine();
  check('typing does not make the editor jump, preview keeps its position', typedE === stillE && Math.abs(typedP - stillP) < 1.5 && typedE === Math.floor(typedP), `editor ${stillE} -> ${typedE}, preview ${typedP.toFixed(1)}`);

  // Przeładowanie webview: iframe ładuje się od nowa bez tokenu, sesję trzyma tylko ciasteczko Partitioned
  await runCommand('Developer: Reload Webviews');
  await sleep(3000);
  frame = await previewFrame();
  await frame?.waitForFunction(() => !!document.querySelector('h1'), null, { timeout: 15000 }).catch(() => {});
  const afterReload = frame ? await frame.evaluate(() => document.body.innerText) : '(no frame)';
  check('session survives a webview reload (partitioned cookie works in VS Code)', afterReload.includes('Hello VS Code') && !afterReload.includes('access token'),
    afterReload.slice(0, 80).replace(/\n/g, ' | '));

  check('no frame-ancestors / CSP violations', !errors.some((e) => /frame-ancestors|Content Security Policy/i.test(e)),
    errors.filter((e) => /Security Policy|frame/i.test(e)).slice(0, 2).join(' | ').slice(0, 200));

  if (screenshot) {
    await window.screenshot({ path: screenshot });
  }

  await runCommand('MdLive: Stop Preview');
  await sleep(1500);
  check('Stop closes the preview', !window.frames().some((f) => f.url().startsWith('http://127.0.0.1')));
} catch (error) {
  check('no exceptions', false, String(error).slice(0, 300));
  // Przy błędzie: powiadomienia VS Code (np. błąd startu mdlive) i zrzut ekranu
  const window = await app.firstWindow();
  const toasts = await window.locator('.notifications-toasts').innerText().catch(() => '');
  if (toasts.trim()) {
    console.log('VS Code notifications: ' + toasts.replace(/\s+/g, ' ').slice(0, 400));
  }
  if (screenshot) {
    await window.screenshot({ path: screenshot }).catch(() => {});
  }
} finally {
  await app.close();
}

process.exit(results.every(Boolean) ? 0 : 1);
