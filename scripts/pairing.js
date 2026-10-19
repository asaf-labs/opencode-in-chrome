import { writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig } from '../bridge/config.js';

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const platforms = [
  {
    id: 'darwin',
    label: 'macOS',
    instructions:
      'Click <strong>Load unpacked</strong>, then press <strong>⌘⇧G (Command + Shift + G)</strong> in the folder picker. Paste the copied extension folder path, press <strong>Return</strong>, then click <strong>Select</strong>.',
  },
  {
    id: 'win32',
    label: 'Windows',
    instructions:
      'Click <strong>Load unpacked</strong>. Paste the copied extension folder path into the folder picker’s address bar, press <strong>Enter</strong>, then click <strong>Select Folder</strong>.',
  },
  {
    id: 'linux',
    label: 'Linux',
    instructions:
      'Click <strong>Load unpacked</strong>. Press <strong>Ctrl + L</strong> in the folder picker to enter the copied extension folder path, then open or select that folder. If your picker does not support this shortcut, browse to the folder below.',
  },
];

function platformTab({ id, label }, selected) {
  return `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${id === selected}" tabindex="${id === selected ? 0 : -1}">${label}</button>`;
}

function platformPanel({ id, instructions }, selected) {
  return `<div role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"${id === selected ? '' : ' hidden'}><p>${instructions}</p></div>`;
}

export function pairingHTML(config, root, platform = process.platform) {
  validateConfig(config);
  const selected = platforms.some(({ id }) => id === platform) ? platform : 'linux';
  const extensionPath = (platform === 'win32' ? path.win32 : path.posix).join(root, 'extension');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Pair OpenCode in Chrome</title><style>
body{max-width:720px;margin:48px auto;padding:0 24px;background:#101014;color:#eee;font:16px/1.6 system-ui}
h1{color:#fb923c}code,input{font-family:monospace}input{display:block;box-sizing:border-box;width:100%;padding:12px;background:#202026;color:#fff;border:1px solid #555;border-radius:6px}button{margin:12px 8px 12px 0;padding:10px 16px;cursor:pointer}code{overflow-wrap:anywhere}li{margin-bottom:12px}
[role="tablist"]{display:flex;flex-wrap:wrap;gap:8px}[role="tab"]{background:#202026;color:#eee;border:1px solid #555;border-radius:6px}[role="tab"][aria-selected="true"]{border-color:#fb923c;color:#fb923c}button:focus-visible{outline:2px solid #fb923c;outline-offset:3px}
</style></head><body><h1>Pair OpenCode in Chrome</h1>
<p>This page is local and contains your private pairing token. Do not share it, screenshot it, or upload it.</p>
<ol><li>In a dedicated Chrome profile, open <code>chrome://extensions</code> and enable Developer mode.</li>
<li><strong>Load the extension</strong>. Instructions for this computer are selected automatically; switch tabs if needed.
<div role="tablist" aria-label="Operating system">${platforms.map((item) => platformTab(item, selected)).join('')}</div>
<label for="extension-path">Extension folder</label><input id="extension-path" readonly value="${escape(extensionPath)}">
<button type="button" id="copy-path">Copy extension folder path</button><span id="path-result" role="status"></span>
${platforms.map((item) => platformPanel(item, selected)).join('')}</li>
<li>Open the extension toolbar popup. Set a profile name such as <strong>Work</strong> or <strong>Personal</strong>, and set its URL to <code>http://127.0.0.1:${config.port}</code>.</li>
<li>Copy the token below into the popup, choose <strong>Save &amp; enable browser</strong>, and accept the website permission prompt.</li>
<li>In the target project's OpenCode session, open <code>/mcps</code> and connect <code>chrome</code>. The popup should say <strong>Ready — sessions can open tabs</strong>.</li></ol>
<label for="token">Pairing token</label><input id="token" type="password" readonly value="${config.token}" autocomplete="off">
<button id="copy">Copy token</button><button id="reveal">Show / hide token</button><span id="result" role="status"></span>
<p>After pairing, run <code>npm run doctor</code> from the extension repository. You can close or delete this page; regenerate it with <code>npm run pair</code> if needed.</p>
<p>To opt in another Chrome profile, install/load the same extension folder in that profile, then repeat pairing with this URL/token and a different name. Each profile gets its own persistent ID. In OpenCode, use <code>list_profiles</code> and <code>select_profile</code> to choose. Closing or disabling one profile never selects another account automatically.</p>
<script>
const tabs=Array.from(document.querySelectorAll('[role="tab"]'));
function selectTab(tab){
  for(const item of tabs){
    const selected=item===tab;
    item.setAttribute('aria-selected',String(selected));
    item.tabIndex=selected?0:-1;
    document.getElementById(item.getAttribute('aria-controls')).hidden=!selected;
  }
}
for(const tab of tabs){
  tab.onclick=()=>selectTab(tab);
  tab.onkeydown=(event)=>{
    let index=tabs.indexOf(tab);
    if(event.key==='ArrowRight')index=(index+1)%tabs.length;
    else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;
    else if(event.key==='Home')index=0;
    else if(event.key==='End')index=tabs.length-1;
    else return;
    event.preventDefault();
    selectTab(tabs[index]);
    tabs[index].focus();
  };
}
async function copyInput(input,result){
  try{await navigator.clipboard.writeText(input.value);result.textContent='Copied'}
  catch{
    if(input.type==='password')input.type='text';
    input.focus();input.select();
    result.textContent=document.getElementById('tab-darwin').getAttribute('aria-selected')==='true'?'Press Cmd+C to copy':'Press Ctrl+C to copy';
  }
}
document.getElementById('copy-path').onclick=()=>copyInput(document.getElementById('extension-path'),document.getElementById('path-result'));
const token=document.getElementById('token');
document.getElementById('reveal').onclick=()=>{token.type=token.type==='password'?'text':'password'};
document.getElementById('copy').onclick=()=>copyInput(token,document.getElementById('result'));
</script></body></html>`;
}

export async function writePairingPage(config, root, filename) {
  await writeFile(filename, pairingHTML(config, root), { mode: 0o600 });
  await chmod(filename, 0o600);
}
