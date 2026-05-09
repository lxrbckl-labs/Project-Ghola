// Webview-side entry. Compiled to dist/webview.js as a browser IIFE.
// Plain TS + DOM only — no framework, no markdown lib (renders prompts as <pre>).

import type {
  AgentStatusSummary,
  HostToWebviewMessage,
  ModuleSummary,
  WebviewToHostMessage,
} from '../protocol';
import type { SettingsField } from '../../manifest/types';

interface VsCodeApi {
  postMessage(msg: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState<T = unknown>(): T | undefined;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

type SectionId =
  | 'general'
  | 'modules'
  | 'agents:tpm'
  | 'agents:swe'
  | 'agents:qa'
  | 'sessions';

interface UIState {
  activeSection: SectionId;
  modules: ModuleSummary[];
  settingsValues: Record<string, unknown>;
  dirty: boolean;
  composedPrompts: Record<string, string>;
  agents: AgentStatusSummary[];
}

const state: UIState = {
  activeSection: 'general',
  modules: [],
  settingsValues: {},
  dirty: false,
  composedPrompts: {},
  agents: [],
};

const root = document.getElementById('app')!;

function init(): void {
  render();
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'getSettings' });
  window.addEventListener('message', (ev) => {
    handleMessage(ev.data as HostToWebviewMessage);
  });
}

function handleMessage(msg: HostToWebviewMessage): void {
  switch (msg.type) {
    case 'modulesChanged':
      state.modules = msg.modules;
      render();
      // Refresh prompts whenever modules change.
      ['tpm', 'swe', 'qa'].forEach((id) =>
        vscode.postMessage({ type: 'getComposedPrompt', agent: id }),
      );
      break;
    case 'settingsLoaded':
      state.settingsValues = msg.values ?? {};
      state.dirty = false;
      render();
      break;
    case 'settingsSaved':
      if (msg.ok) {
        state.dirty = false;
        render();
      } else {
        // Best-effort surface; real toast UX is future work.
        console.error('[nomeda] save failed', msg.error);
      }
      break;
    case 'composedPromptUpdated':
      state.composedPrompts[msg.agent] = msg.prompt;
      render();
      break;
    case 'agentStateUpdated':
      state.agents = msg.agents;
      render();
      break;
  }
}

function setSection(id: SectionId): void {
  state.activeSection = id;
  if (id.startsWith('agents:')) {
    const agentId = id.split(':')[1]!;
    if (!(agentId in state.composedPrompts)) {
      vscode.postMessage({ type: 'getComposedPrompt', agent: agentId });
    }
  }
  render();
}

function render(): void {
  root.innerHTML = '';
  root.appendChild(renderRail());
  root.appendChild(renderContent());
}

function renderRail(): HTMLElement {
  const rail = el('aside', { class: 'rail' });
  rail.appendChild(railHeader('General'));
  rail.appendChild(railItem('general', 'Overview'));
  rail.appendChild(railHeader('Modules'));
  rail.appendChild(railItem('modules', 'All modules'));
  rail.appendChild(railHeader('Agents'));
  rail.appendChild(railItem('agents:tpm', 'TPM', true));
  rail.appendChild(railItem('agents:swe', 'SWE', true));
  rail.appendChild(railItem('agents:qa', 'QA', true));
  rail.appendChild(railHeader('Sessions'));
  rail.appendChild(railItem('sessions', 'Session control'));
  return rail;
}

function railHeader(text: string): HTMLElement {
  const e = el('div', { class: 'rail-section' });
  e.textContent = text;
  return e;
}

function railItem(id: SectionId, label: string, sub = false): HTMLElement {
  const cls = `rail-item${sub ? ' sub' : ''}${state.activeSection === id ? ' active' : ''}`;
  const btn = el('button', { class: cls });
  btn.textContent = label;
  btn.addEventListener('click', () => setSection(id));
  return btn;
}

function renderContent(): HTMLElement {
  const wrapper = el('section', { class: 'content' });
  switch (state.activeSection) {
    case 'general':
      renderGeneral(wrapper);
      break;
    case 'modules':
      renderModules(wrapper);
      break;
    case 'agents:tpm':
    case 'agents:swe':
    case 'agents:qa':
      renderAgent(wrapper, state.activeSection.split(':')[1]!);
      break;
    case 'sessions':
      renderSessions(wrapper);
      break;
  }
  return wrapper;
}

function renderGeneral(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Nomeda'));
  wrapper.appendChild(textEl('p', 'Modular multi-agent dev team for VS Code.', 'subtitle'));
  wrapper.appendChild(textEl('h2', 'Status'));
  const status = el('div', { class: 'status-row' });
  if (state.agents.length === 0) {
    status.textContent = 'No active session.';
  } else {
    state.agents.forEach((a) => {
      const dot = el('span', { class: `dot ${a.status}` });
      const lbl = el('span');
      lbl.textContent = `${a.id} (${a.status})`;
      const wrap = el('span');
      wrap.style.marginRight = '12px';
      wrap.appendChild(dot);
      wrap.appendChild(lbl);
      status.appendChild(wrap);
    });
  }
  wrapper.appendChild(status);

  // Custom settings sections placed in 'general' from any module.
  const customSections = state.modules
    .filter((m) => m.enabled)
    .flatMap((m) =>
      (m.contributes?.settingsPanelSections ?? [])
        .filter((s) => s.placement === 'general')
        .map((s) => ({ module: m, section: s })),
    );

  customSections.forEach(({ module, section }) => {
    wrapper.appendChild(textEl('h2', `${section.title} (${module.name})`));
    const fields = (module.contributes?.settings ?? {}) as Record<string, SettingsField>;
    Object.entries(fields).forEach(([key, field]) => {
      wrapper.appendChild(renderField(scopedKey(module.id, key), field));
    });
  });

  if (customSections.length > 0) {
    wrapper.appendChild(renderActions());
  }
}

function renderModules(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Modules'));
  wrapper.appendChild(textEl('p', 'Toggle modules on or off. Saving applies on session boot.', 'subtitle'));

  if (state.modules.length === 0) {
    wrapper.appendChild(textEl('div', 'No modules discovered. Place modules under .nomeda/modules/ in your workspace and click Reload.', 'empty'));
  }

  state.modules.forEach((m) => {
    const card = el('div', { class: 'module-card' });

    const row = el('div', { class: 'row' });
    const left = el('div');
    left.appendChild(textEl('strong', m.name));
    left.appendChild(textEl('span', `  ${m.id} · v${m.version}`, 'meta'));
    row.appendChild(left);

    const toggle = el('label', { class: 'toggle' }) as HTMLLabelElement;
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = m.enabled;
    input.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: input.checked });
    });
    toggle.appendChild(input);
    const lbl = el('span');
    lbl.textContent = m.enabled ? 'Enabled' : 'Disabled';
    toggle.appendChild(lbl);
    row.appendChild(toggle);
    card.appendChild(row);

    if (m.description) {
      card.appendChild(textEl('div', m.description, 'desc'));
    }
    card.appendChild(renderContribBadges(m));
    wrapper.appendChild(card);
  });

  const actions = el('div', { class: 'actions' });
  const reload = el('button', { class: 'secondary' });
  reload.textContent = 'Reload modules';
  reload.addEventListener('click', () => vscode.postMessage({ type: 'reloadModules' }));
  actions.appendChild(reload);
  wrapper.appendChild(actions);
}

function renderContribBadges(m: ModuleSummary): HTMLElement {
  const c = m.contributes;
  const wrap = el('div', { class: 'contribs' });
  const items: Array<[string, number]> = [
    ['fragments', c?.promptFragments?.length ?? 0],
    ['agents', c?.agents?.length ?? 0],
    ['settings', Object.keys(c?.settings ?? {}).length],
    ['ui', c?.settingsPanelSections?.length ?? 0],
    ['tools', c?.tools?.length ?? 0],
  ];
  items.forEach(([label, n]) => {
    if (n > 0) {
      const b = el('span');
      b.textContent = `${label}: ${n}`;
      wrap.appendChild(b);
    }
  });
  return wrap;
}

function renderAgent(wrapper: HTMLElement, agentId: string): void {
  wrapper.appendChild(textEl('h1', `Agent: ${agentId.toUpperCase()}`));
  wrapper.appendChild(textEl('p', 'Live composed system prompt from currently enabled modules.', 'subtitle'));

  const prompt = state.composedPrompts[agentId];
  if (prompt === undefined) {
    wrapper.appendChild(textEl('div', 'Loading...', 'empty'));
    vscode.postMessage({ type: 'getComposedPrompt', agent: agentId });
    return;
  }
  const pre = el('pre', { class: 'prompt' });
  pre.textContent = prompt;
  wrapper.appendChild(pre);

  const refresh = el('button', { class: 'secondary' });
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () =>
    vscode.postMessage({ type: 'getComposedPrompt', agent: agentId }),
  );
  const actions = el('div', { class: 'actions' });
  actions.appendChild(refresh);
  wrapper.appendChild(actions);
}

function renderSessions(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Sessions'));
  wrapper.appendChild(textEl('p', 'Open a Nomeda session terminal in the editor area.', 'subtitle'));
  const open = el('button', { class: 'primary' });
  open.textContent = 'Open Session';
  open.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  const actions = el('div', { class: 'actions' });
  actions.appendChild(open);
  wrapper.appendChild(actions);
}

function renderField(key: string, field: SettingsField): HTMLElement {
  const wrap = el('div', { class: 'field' });
  const label = el('label');
  label.textContent = field.label;
  wrap.appendChild(label);
  if (field.description) {
    wrap.appendChild(textEl('div', field.description, 'desc'));
  }
  const value = state.settingsValues[key] ?? field.default;

  if (field.type === 'boolean') {
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = !!value;
    cb.addEventListener('change', () => {
      state.settingsValues[key] = cb.checked;
      state.dirty = true;
      render();
    });
    wrap.appendChild(cb);
  } else if (field.type === 'enum') {
    const select = el('select') as HTMLSelectElement;
    (field.options ?? []).forEach((opt) => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt;
      o.textContent = opt;
      if (opt === value) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', () => {
      state.settingsValues[key] = select.value;
      state.dirty = true;
      render();
    });
    wrap.appendChild(select);
  } else if (field.type === 'number') {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'number';
    if (value !== undefined) inp.value = String(value);
    inp.addEventListener('input', () => {
      state.settingsValues[key] = inp.value === '' ? undefined : Number(inp.value);
      state.dirty = true;
    });
    wrap.appendChild(inp);
  } else {
    const inp = el('input') as HTMLInputElement;
    inp.type = 'text';
    if (value !== undefined && value !== null) inp.value = String(value);
    inp.addEventListener('input', () => {
      state.settingsValues[key] = inp.value;
      state.dirty = true;
    });
    wrap.appendChild(inp);
  }
  return wrap;
}

function renderActions(): HTMLElement {
  const a = el('div', { class: 'actions' });
  const save = el('button', { class: 'primary' }) as HTMLButtonElement;
  save.textContent = state.dirty ? 'Save' : 'Saved';
  save.disabled = !state.dirty;
  save.addEventListener('click', () => {
    vscode.postMessage({ type: 'saveSettings', values: state.settingsValues });
  });
  a.appendChild(save);
  return a;
}

function scopedKey(moduleId: string, fieldKey: string): string {
  return `${moduleId}::${fieldKey}`;
}

function el(tag: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const e = el(tag, className ? { class: className } : undefined);
  e.textContent = text;
  return e;
}

init();
