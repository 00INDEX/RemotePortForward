import { addressOf, parseAddress, suggestedRemotePort, type RuleView, type Snapshot } from '../../protocol/src/types.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): { widths?: number[]; selected?: string } | undefined;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const app = document.querySelector<HTMLElement>('#app')!;
const saved = vscode.getState();
let snapshot: Snapshot = { supported: false, session: 'Disconnected', message: '', rules: [] };
let selected = saved?.selected ?? '';
let editing = false;
let signature = '';
let contextMenu: HTMLElement | undefined;
const widths = saved?.widths ?? [290, 210, 240, 130];
let feedback: { message: string; expires: number; copiedId?: string; copiedText?: string } | undefined;
const post = (message: unknown) => vscode.postMessage(message);
const persist = () => vscode.setState({ widths, selected });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
const icons: Record<string, string> = {
  add: 'M8 2v12M2 8h12', copy: 'M6 6h7v8H6zM3 11H2V2h8v1',
  stop: 'M4 4h8v8H4z', start: 'm5 3 7 5-7 5z', more: 'M3 7v2M8 7v2M13 7v2', close: 'm4 4 8 8M12 4l-8 8',
  check: 'm3 8 3 3 7-7',
};
function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', icons[name] ?? icons.more!);
  svg.append(path); return svg;
}
function button(name: string, title: string, callback: () => void): HTMLButtonElement {
  const node = element('button', 'icon-button'); node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
  node.dataset.action = name === 'check' ? 'copy' : name === 'start' || name === 'stop' ? 'toggle' : name;
  node.append(icon(name)); node.addEventListener('click', event => { event.stopPropagation(); callback(); }); return node;
}

const notice = element('div', 'notice'); notice.setAttribute('role', 'status');
const scroller = element('div', 'table-scroll');
const table = element('table', 'ports-table'); table.setAttribute('role', 'grid'); table.setAttribute('aria-label', 'Remote forwarded ports');
const colgroup = element('colgroup'); const thead = element('thead'); const header = element('tr');
const columns: HTMLTableColElement[] = [];
['Address', 'Forwarded Port', 'Running Process', 'Origin'].forEach((title, index) => {
  const col = element('col'); col.style.width = `${widths[index]}px`; columns.push(col); colgroup.append(col);
  const th = element('th', undefined, title); th.scope = 'col';
  const resize = element('span', 'resize-handle'); resize.tabIndex = 0; resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-label', `Resize ${title} column`); resize.setAttribute('aria-orientation', 'vertical');
  const change = (width: number) => { widths[index] = Math.max(100, Math.min(800, width)); col.style.width = `${widths[index]}px`; persist(); };
  resize.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); change(widths[index]! + (event.key === 'ArrowLeft' ? -10 : 10)); }
  });
  resize.addEventListener('pointerdown', event => {
    event.preventDefault(); const start = event.clientX, initial = widths[index]!;
    resize.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => change(initial + e.clientX - start);
    const up = () => { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', up); };
    resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', up);
  });
  th.append(resize); header.append(th);
});
thead.append(header);
const tbody = element('tbody');
table.append(colgroup, thead, tbody); scroller.append(table);
const add = element('button', 'add-port'); add.type = 'button'; add.append(icon('add'), document.createTextNode('Forward an Address'));
const form = element('form', 'add-form'); form.hidden = true;
const localInput = element('input'); localInput.type = 'text'; localInput.required = true;
localInput.placeholder = '192.168.1.20:8080'; localInput.setAttribute('aria-label', 'Target address');
const arrow = element('span', 'direction', '→');
const remoteInput = element('input'); remoteInput.type = 'number'; remoteInput.min = '1024'; remoteInput.max = '65535';
remoteInput.placeholder = 'Forwarded port'; remoteInput.setAttribute('aria-label', 'Forwarded port');
localInput.addEventListener('input', () => {
  localInput.setCustomValidity('');
  try { remoteInput.placeholder = `${suggestedRemotePort(parseAddress(localInput.value).port)} (default)`; } catch { remoteInput.placeholder = 'Forwarded port'; }
});
const submit = element('button', 'submit', 'Forward'); submit.type = 'submit';
const cancel = button('close', 'Cancel', () => { form.hidden = true; add.hidden = false; add.focus(); });
form.append(localInput, arrow, remoteInput, submit, cancel);
form.addEventListener('submit', event => {
  event.preventDefault();
  let target: { host: string; port: number };
  try { target = parseAddress(localInput.value); } catch (error) { localInput.setCustomValidity((error as Error).message); localInput.reportValidity(); return; }
  if (!form.reportValidity()) return;
  post({ type: 'add', address: localInput.value, remotePort: Number(remoteInput.value || suggestedRemotePort(target.port)) });
  form.reset(); form.hidden = true; add.hidden = false;
});
form.addEventListener('keydown', event => { if (event.key === 'Escape') cancel.click(); });
add.addEventListener('click', () => { form.hidden = false; add.hidden = true; localInput.focus(); });
const footer = element('div', 'footer'); const sessionLabel = element('span');
const logs = element('button', 'text-button', 'Show Log'); logs.addEventListener('click', () => post({ type: 'logs' }));
footer.append(sessionLabel, logs);
app.append(notice, scroller, add, form, footer);

function select(id: string): void {
  selected = id; persist();
  for (const row of tbody.rows) { const active = row.dataset.id === id; row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active)); row.tabIndex = active ? 0 : -1; }
}

function edit(cell: HTMLElement, value: string, type: 'text' | 'number', done: (text: string) => void, label = type === 'number' ? 'Forwarded port' : 'Port label'): void {
  if (editing) return; editing = true;
  const input = element('input', 'inline-input'); input.value = value; input.type = type;
  input.setAttribute('aria-label', label); input.required = label !== 'Port label';
  if (type === 'number') { input.min = '1024'; input.max = '65535'; } else input.maxLength = label === 'Target address' ? 260 : 80;
  cell.replaceChildren(input); input.focus(); input.select();
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('input', () => input.setCustomValidity(''));
  let finished = false;
  const finish = (commit: boolean) => {
    if (finished) return;
    if (commit && label === 'Target address') {
      try { parseAddress(input.value); } catch (error) { input.setCustomValidity((error as Error).message); }
    }
    if (commit && !input.reportValidity()) return;
    finished = true; editing = false;
    if (commit) done(input.value);
    signature = ''; render();
  };
  input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(false));
}

function closeMenu(): void { contextMenu?.remove(); contextMenu = undefined; }
function menu(rule: RuleView, x: number, y: number, row: HTMLTableRowElement): void {
  closeMenu(); select(rule.id);
  const popup = element('div', 'context-menu'); popup.setAttribute('role', 'menu');
  const actions: Array<[string, () => void]> = [
    [rule.status === 'listening' ? 'Stop Forwarding Port' : 'Start Forwarding Port', () => post({ type: rule.status === 'listening' ? 'stop' : 'start', id: rule.id })],
    ['Copy Forwarded Port', () => post({ type: 'copy', id: rule.id, kind: 'port' })],
    ['Copy Remote Address', () => post({ type: 'copy', id: rule.id, kind: 'address' })],
    ['Change Target Address…', () => edit(row.cells[0]!, addressOf(rule), 'text', address => post({ type: 'address', id: rule.id, address }), 'Target address')],
    ['Change Forwarded Port…', () => edit(row.cells[1]!, String(rule.remotePort), 'number', value => post({ type: 'remotePort', id: rule.id, port: Number(value) }))],
    ['Set Port Label…', () => edit(row.cells[0]!, rule.label, 'text', label => post({ type: 'rename', id: rule.id, label }))],
    [rule.autoStart ? '✓ Start When Workspace Opens' : 'Start When Workspace Opens', () => post({ type: 'autoStart', id: rule.id, enabled: !rule.autoStart })],
    ['Remove Port', () => post({ type: 'remove', id: rule.id })],
  ];
  for (const [title, action] of actions) {
    const item = element('button', 'menu-item', title); item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => { closeMenu(); action(); }); popup.append(item);
  }
  popup.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeMenu(); row.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const items = [...popup.querySelectorAll('button')], current = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  document.body.append(popup); contextMenu = popup;
  popup.style.left = `${Math.max(0, Math.min(x, innerWidth - popup.offsetWidth - 4))}px`;
  popup.style.top = `${Math.max(0, Math.min(y, innerHeight - popup.offsetHeight - 4))}px`;
  popup.querySelector('button')?.focus();
}

function render(): void {
  const message = feedback && feedback.expires > Date.now() ? feedback.message : snapshot.message;
  notice.textContent = message; notice.hidden = !message;
  sessionLabel.textContent = snapshot.session;
  add.disabled = !snapshot.supported;
  for (const row of tbody.rows) {
    const rule = snapshot.rules.find(rule => rule.id === row.dataset.id);
    if (rule) row.title = `${rule.status} · remote 127.0.0.1:${rule.remotePort} → ${addressOf(rule)}\n${rule.connections} active connections${rule.error ? `\n${rule.error}` : ''}`;
  }
  const next = JSON.stringify(snapshot.rules.map(rule => ({ ...rule, connections: 0 })));
  if (editing || next === signature || contextMenu) return;
  signature = next;
  const focused = tbody.contains(document.activeElement);
  const focusedId = document.activeElement?.closest<HTMLTableRowElement>('tr')?.dataset.id;
  const focusedAction = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.action : undefined;
  tbody.replaceChildren();
  snapshot.rules.forEach((rule, index) => {
    const row = element('tr'); row.dataset.id = rule.id; row.dataset.status = rule.status;
    row.tabIndex = selected === rule.id || (!selected && index === 0) ? 0 : -1;
    row.title = `${rule.status} · remote 127.0.0.1:${rule.remotePort} → ${addressOf(rule)}\n${rule.connections} active connections${rule.error ? `\n${rule.error}` : ''}`;
    const source = element('td');
    const sourceWrap = element('div', 'cell'); const status = element('span', `status-dot ${rule.error ? 'warning' : ''}`); status.setAttribute('aria-label', rule.error || rule.status);
    sourceWrap.append(status, element('span', 'port-label', rule.label ? `${rule.label} (${addressOf(rule)})` : addressOf(rule))); source.append(sourceWrap);
    const address = element('td'); const addressWrap = element('div', 'cell');
    addressWrap.append(element('span', 'address', String(rule.remotePort)));
    const actions = element('span', 'row-actions');
    const copied = feedback?.copiedId === rule.id && feedback.copiedText === String(rule.remotePort) && feedback.expires > Date.now();
    actions.append(button(copied ? 'check' : 'copy', copied ? `Copied ${rule.remotePort}` : 'Copy Forwarded Port', () => post({ type: 'copy', id: rule.id, kind: 'port' })),
      button(rule.status === 'listening' || rule.status === 'starting' ? 'stop' : 'start', rule.status === 'listening' || rule.status === 'starting' ? 'Stop Forwarding Port' : 'Start Forwarding Port', () => post({ type: rule.status === 'listening' || rule.status === 'starting' ? 'stop' : 'start', id: rule.id })));
    addressWrap.append(actions); address.append(addressWrap);
    const process = element('td', rule.process?.includes('(') ? undefined : 'muted', rule.process ?? 'Checking…'); process.title = rule.processDetail ?? 'Looking up the listening process on this computer.';
    const origin = element('td'); const originWrap = element('div', 'cell'); originWrap.append(element('span', undefined, rule.autoStart ? 'Workspace' : 'User'));
    originWrap.append(button('more', 'More Actions', () => { const rect = origin.getBoundingClientRect(); menu(rule, rect.left, rect.bottom, row); })); origin.append(originWrap);
    row.append(source, address, process, origin); row.classList.toggle('selected', selected === rule.id); row.setAttribute('aria-selected', String(selected === rule.id));
    row.addEventListener('click', () => { select(rule.id); row.focus(); });
    row.addEventListener('contextmenu', event => { event.preventDefault(); menu(rule, event.clientX, event.clientY, row); });
    source.addEventListener('dblclick', () => edit(source, addressOf(rule), 'text', address => post({ type: 'address', id: rule.id, address }), 'Target address'));
    address.addEventListener('dblclick', () => edit(address, String(rule.remotePort), 'number', value => post({ type: 'remotePort', id: rule.id, port: Number(value) })));
    row.addEventListener('keydown', event => {
      if (event.target !== row) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const target = snapshot.rules[Math.max(0, Math.min(snapshot.rules.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (target) { select(target.id); [...tbody.rows].find(row => row.dataset.id === target.id)?.focus(); }
      } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); post({ type: 'remove', id: rule.id }); }
      else if (event.key === 'Enter') post({ type: rule.status === 'listening' ? 'stop' : 'start', id: rule.id });
      else if (event.key === 'F2') edit(source, addressOf(rule), 'text', address => post({ type: 'address', id: rule.id, address }), 'Target address');
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = row.getBoundingClientRect(); menu(rule, rect.left + 20, rect.bottom, row); }
    });
    tbody.append(row);
  });
  if (focused) {
    const row = [...tbody.rows].find(row => row.dataset.id === (focusedId ?? selected));
    const action = focusedAction ? [...(row?.querySelectorAll('button') ?? [])].find(button => button.dataset.action === focusedAction) : undefined;
    (action ?? row)?.focus();
  }
}

document.addEventListener('pointerdown', event => { if (contextMenu && !contextMenu.contains(event.target as Node)) { closeMenu(); signature = ''; render(); } });
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'snapshot') { snapshot = message.snapshot as Snapshot; render(); }
  else if (message?.type === 'copied') {
    feedback = { message: `Copied ${message.text}`, copiedId: String(message.id), copiedText: String(message.text), expires: Date.now() + 3000 };
    signature = ''; render();
    setTimeout(() => { signature = ''; render(); }, 3100);
  } else if (message?.type === 'error') {
    feedback = { message: String(message.message), expires: Date.now() + 5000 }; render();
  }
});
render(); post({ type: 'ready' });
