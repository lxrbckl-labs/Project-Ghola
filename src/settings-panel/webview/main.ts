// Webview-side entry. Compiled to dist/webview.js as a browser IIFE.
// Plain TS + DOM only — no framework, no markdown lib (renders prompts as <pre>).

import type {
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
  /** Module ids currently expanded in the Modules tab. Ephemeral. */
  expandedModules: Set<string>;
  /** Free-text filter for the Modules tab. Ephemeral; cleared on tab switch. */
  moduleSearch: string;
  /** Value of nomeda.sessionCommand VS Code configuration. */
  sessionCommand: string;
}

const state: UIState = {
  activeSection: 'general',
  modules: [],
  settingsValues: {},
  dirty: false,
  composedPrompts: {},
  expandedModules: new Set<string>(),
  moduleSearch: '',
  sessionCommand: 'claude',
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
      state.sessionCommand = msg.sessionCommand ?? 'claude';
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
  }
}

function setSection(id: SectionId): void {
  // Reset Modules-tab ephemeral UI state when leaving the Modules tab.
  if (state.activeSection === 'modules' && id !== 'modules') {
    state.moduleSearch = '';
    state.expandedModules.clear();
  }
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
  rail.appendChild(railItem('modules', 'Modules'));
  rail.appendChild(railHeader('Agents'));
  rail.appendChild(railItem('agents:tpm', 'TPM', true));
  rail.appendChild(railItem('agents:swe', 'SWE', true));
  rail.appendChild(railItem('agents:qa', 'QA', true));
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
  wrapper.appendChild(textEl('h1', 'Project Nomeda'));
  wrapper.appendChild(textEl('p', 'Modular multi-agent dev team for VS Code.', 'subtitle'));

  // Session command setting — persisted to VS Code workspace configuration.
  const sessionWrap = el('div', { class: 'setting' });
  const sessionHead = el('div', { class: 'setting-head' });
  const sessionLabel = el('label', { class: 'setting-label' });
  sessionLabel.textContent = 'Session command';
  sessionHead.appendChild(sessionLabel);
  sessionWrap.appendChild(sessionHead);
  const sessionInp = el('input', { class: 'setting-input' }) as HTMLInputElement;
  sessionInp.type = 'text';
  sessionInp.value = state.sessionCommand;
  sessionInp.addEventListener('blur', () => {
    state.sessionCommand = sessionInp.value;
    vscode.postMessage({
      type: 'updateConfiguration',
      section: 'nomeda',
      key: 'sessionCommand',
      value: sessionInp.value,
    });
  });
  sessionWrap.appendChild(sessionInp);
  sessionWrap.appendChild(
    textEl(
      'div',
      "Command phrase sent to the Nomeda Session terminal after launch (e.g. 'claude', 'claude --resume'). Leave empty to skip.",
      'setting-desc',
    ),
  );
  wrapper.appendChild(sessionWrap);

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
  wrapper.appendChild(
    textEl(
      'p',
      'Toggle modules on or off. Expand a module to view details and edit its settings.',
      'subtitle',
    ),
  );

  // The list is rendered into its own container so search input keystrokes
  // don't blow away the input element (and its focus/selection).
  const listWrap = el('div', { class: 'modules-list' });

  // Search bar — filters by id, name, description (case-insensitive).
  const searchWrap = el('div', { class: 'modules-search' });
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search modules…',
    'aria-label': 'Search modules',
  }) as HTMLInputElement;
  searchInput.value = state.moduleSearch;
  searchInput.addEventListener('input', () => {
    state.moduleSearch = searchInput.value;
    renderModulesList(listWrap);
  });
  searchWrap.appendChild(searchInput);
  wrapper.appendChild(searchWrap);

  if (state.modules.length === 0) {
    wrapper.appendChild(
      textEl(
        'div',
        'No modules discovered. Place modules under modules/ in your workspace and click Reload.',
        'empty',
      ),
    );
  }

  wrapper.appendChild(listWrap);
  renderModulesList(listWrap);

  const actions = el('div', { class: 'actions' });
  const reload = el('button', { class: 'secondary' });
  reload.textContent = 'Reload modules';
  reload.addEventListener('click', () => vscode.postMessage({ type: 'reloadModules' }));
  actions.appendChild(reload);
  wrapper.appendChild(actions);
}

function renderModulesList(container: HTMLElement): void {
  container.innerHTML = '';
  const q = state.moduleSearch.trim().toLowerCase();
  const filtered = state.modules.filter((m) => {
    if (!q) return true;
    const hay = [m.id, m.name, m.description ?? ''].join(' ').toLowerCase();
    return hay.includes(q);
  });

  if (q && filtered.length === 0) {
    container.appendChild(textEl('div', 'No modules match.', 'empty'));
    return;
  }

  filtered.forEach((m) => {
    container.appendChild(renderModuleCard(m));
  });
}

function renderModuleCard(m: ModuleSummary): HTMLElement {
  const card = el('div', { class: 'module-card' });
  const expanded = state.expandedModules.has(m.id);

  const row = el('div', { class: 'row' });

  // Left side: caret + name/meta.
  const left = el('div', { class: 'module-head' });

  const caret = el('button', {
    class: `caret${expanded ? ' open' : ''}`,
    'aria-label': expanded ? 'Collapse module details' : 'Expand module details',
    'aria-expanded': expanded ? 'true' : 'false',
    type: 'button',
  }) as HTMLButtonElement;
  caret.textContent = expanded ? '▼' : '▶'; // ▼ / ▶
  caret.addEventListener('click', () => {
    if (state.expandedModules.has(m.id)) state.expandedModules.delete(m.id);
    else state.expandedModules.add(m.id);
    render();
  });
  left.appendChild(caret);

  // Enable/disable toggle sits between caret and title (no text label — pill color conveys state).
  left.appendChild(
    renderToggle({
      checked: m.enabled,
      onChange: (next) => {
        vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: next });
      },
      ariaLabel: `Enable ${m.name}`,
    }),
  );

  const title = el('div', { class: 'module-title' });
  const nameEl = el('strong');
  nameEl.textContent = m.name;
  title.appendChild(nameEl);
  const metaEl = el('span', { class: 'meta' });
  metaEl.textContent = `  ${m.id} · v${m.version}`;
  title.appendChild(metaEl);
  left.appendChild(title);
  row.appendChild(left);
  card.appendChild(row);

  if (m.description) {
    card.appendChild(textEl('div', m.description, 'desc'));
  }
  card.appendChild(renderContribBadges(m));

  if (expanded) {
    card.appendChild(renderModuleDetails(m));
  }

  return card;
}

function renderModuleDetails(m: ModuleSummary): HTMLElement {
  const panel = el('div', { class: 'module-details' });
  panel.appendChild(textEl('div', 'Module Details', 'details-header'));

  const dl = el('dl', { class: 'details-list' });
  appendDef(dl, 'Version', m.version);
  appendDef(dl, 'Id', m.id);
  if (m.description) appendDef(dl, 'Description', m.description);

  const c = m.contributes;
  const fragCount = c?.promptFragments?.length ?? 0;
  const agentCount = c?.agents?.length ?? 0;
  const toolCount = c?.tools?.length ?? 0;
  const uiCount = c?.settingsPanelSections?.length ?? 0;

  if (fragCount > 0) {
    const targets = (c?.promptFragments ?? []).map((f) => f.target).join(', ');
    appendDef(dl, 'Prompt fragments', `${fragCount} (targets: ${targets})`);
  }
  if (agentCount > 0) {
    const ids = (c?.agents ?? []).map((a) => a.id).join(', ');
    appendDef(dl, 'Agents', `${agentCount} (${ids})`);
  }
  if (toolCount > 0) {
    const names = (c?.tools ?? []).map((t) => t.name).join(', ');
    appendDef(dl, 'Tools', `${toolCount} (${names})`);
  }
  if (uiCount > 0) {
    appendDef(dl, 'UI sections', String(uiCount));
  }
  panel.appendChild(dl);

  // Per-module settings editor.
  const fields = (c?.settings ?? {}) as Record<string, SettingsField>;
  const fieldEntries = Object.entries(fields);
  if (fieldEntries.length > 0) {
    panel.appendChild(textEl('div', 'Settings', 'details-header'));
    const settingsWrap = el('div', { class: 'module-settings' });
    fieldEntries.forEach(([key, field]) => {
      settingsWrap.appendChild(
        renderModuleSettingField(scopedKey(m.id, key), field),
      );
    });
    panel.appendChild(settingsWrap);
  } else {
    panel.appendChild(textEl('div', 'This module declares no settings.', 'empty'));
  }

  return panel;
}

function appendDef(dl: HTMLElement, term: string, value: string): void {
  const dt = el('dt');
  dt.textContent = term;
  const dd = el('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/**
 * Render a settings field inside a module's expanded panel.
 *
 * Differs from {@link renderField} in two ways:
 *   1. Uses the iOS-style toggle component for booleans (consistent with the
 *      module enable/disable affordance).
 *   2. Persists changes immediately on blur (text/number) or change
 *      (boolean/enum) via the existing `saveSettings` postMessage. No explicit
 *      Save button is needed since these are per-field auto-save semantics.
 */
function renderModuleSettingField(key: string, field: SettingsField): HTMLElement {
  const wrap = el('div', { class: 'setting' });

  const head = el('div', { class: 'setting-head' });
  const label = el('label', { class: 'setting-label' });
  label.textContent = field.label;
  head.appendChild(label);
  wrap.appendChild(head);

  const current = state.settingsValues[key] ?? field.default;

  if (field.type === 'boolean') {
    head.appendChild(
      renderToggle({
        checked: !!current,
        onChange: (next) => {
          state.settingsValues[key] = next;
          persistSettings();
        },
        ariaLabel: field.label,
      }),
    );
  } else if (field.type === 'enum') {
    const select = el('select', { class: 'setting-input' }) as HTMLSelectElement;
    (field.options ?? []).forEach((opt) => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt;
      o.textContent = opt;
      if (opt === current) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', () => {
      state.settingsValues[key] = select.value;
      persistSettings();
    });
    wrap.appendChild(select);
  } else if (field.type === 'number') {
    const inp = el('input', { class: 'setting-input' }) as HTMLInputElement;
    inp.type = 'number';
    if (current !== undefined && current !== null) inp.value = String(current);
    inp.addEventListener('blur', () => {
      const next = inp.value === '' ? undefined : Number(inp.value);
      state.settingsValues[key] = next;
      persistSettings();
    });
    wrap.appendChild(inp);
  } else {
    // string, path, or unknown — render text input.
    const inp = el('input', { class: 'setting-input' }) as HTMLInputElement;
    inp.type = 'text';
    if (current !== undefined && current !== null) inp.value = String(current);
    inp.addEventListener('blur', () => {
      state.settingsValues[key] = inp.value;
      persistSettings();
    });
    wrap.appendChild(inp);
  }

  if (field.description) {
    wrap.appendChild(textEl('div', field.description, 'setting-desc'));
  }
  return wrap;
}

/** Persist the current settingsValues to the host. */
function persistSettings(): void {
  vscode.postMessage({ type: 'saveSettings', values: state.settingsValues });
}

interface ToggleOptions {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  /** Optional textual on/off label rendered next to the switch. */
  labelText?: string;
}

/**
 * iOS-style toggle switch — pure CSS, hidden checkbox under a sliding pill.
 * The checkbox remains keyboard-operable (Tab to focus, Space to toggle) and
 * carries aria semantics for assistive tech.
 */
function renderToggle(opts: ToggleOptions): HTMLElement {
  const label = el('label', { class: 'switch' }) as HTMLLabelElement;
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = opts.checked;
  if (opts.ariaLabel) input.setAttribute('aria-label', opts.ariaLabel);
  input.addEventListener('change', () => {
    opts.onChange(input.checked);
  });
  label.appendChild(input);

  const slider = el('span', { class: 'slider', 'aria-hidden': 'true' });
  label.appendChild(slider);

  if (opts.labelText !== undefined) {
    const txt = el('span', { class: 'switch-label' });
    txt.textContent = opts.labelText;
    label.appendChild(txt);
  }
  return label;
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
    wrap.appendChild(
      renderToggle({
        checked: !!value,
        onChange: (next) => {
          state.settingsValues[key] = next;
          state.dirty = true;
          render();
        },
        ariaLabel: field.label,
      }),
    );
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
