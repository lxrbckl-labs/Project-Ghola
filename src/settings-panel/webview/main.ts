// Webview-side entry. Compiled to dist/webview.js as a browser IIFE.
// Plain TS + DOM only — no framework, no markdown lib (renders prompts as <pre>).

import type {
  HostToWebviewMessage,
  ModuleSummary,
  PromptFragmentDetail,
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

/**
 * Modules-tab navigation state. The tab is either showing the list of all
 * modules or a single module's detail page. Detail pages render inline prompt
 * content fetched from the host; switching tabs or pressing Back resets to
 * 'list' and clears any cached detail payloads.
 */
type ModuleView = { mode: 'list' } | { mode: 'detail'; moduleId: string };

interface UIState {
  activeSection: SectionId;
  modules: ModuleSummary[];
  settingsValues: Record<string, unknown>;
  dirty: boolean;
  composedPrompts: Record<string, string>;
  /** Current view inside the Modules tab. Ephemeral. */
  moduleView: ModuleView;
  /** Per-module detail payloads keyed by moduleId. Populated by 'moduleDetail' messages. */
  moduleDetails: Record<string, PromptFragmentDetail[]>;
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
  moduleView: { mode: 'list' },
  moduleDetails: {},
  moduleSearch: '',
  sessionCommand: 'claude',
};

const root = document.getElementById('app')!;

// Inline 16x16 monochrome SVG icons — fill="currentColor" so they pick up the
// surrounding text color (VS Code foreground / button foreground). Path data
// taken from Codicons (refresh, chevron-right, arrow-left) and trimmed.
const REFRESH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>`;

const CHEVRON_RIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.7 13.7l-.7-.7L9.6 8.4 5 3.8l.7-.7L11.1 8.4l-5.4 5.3z"/></svg>`;

const ARROW_LEFT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 7.5h-9.79l3.65-3.65-.71-.7L1.5 8l5.15 5.15.71-.7-3.65-3.65H13.5v-1.3z"/></svg>`;

function init(): void {
  render();
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'getSettings' });
  window.addEventListener('message', (ev) => {
    handleMessage(ev.data as HostToWebviewMessage);
  });
  // Escape pops the detail view back to the list (Modules tab only).
  // Guard against firing when the user is typing in an input field, where
  // Escape is a common "clear/cancel" gesture that should not navigate away.
  window.addEventListener('keydown', (ev) => {
    if (
      ev.key === 'Escape' &&
      state.activeSection === 'modules' &&
      state.moduleView.mode === 'detail' &&
      !(ev.target instanceof HTMLInputElement) &&
      !(ev.target instanceof HTMLSelectElement) &&
      !(ev.target instanceof HTMLTextAreaElement)
    ) {
      backToModuleList();
    }
  });
}

function handleMessage(msg: HostToWebviewMessage): void {
  switch (msg.type) {
    case 'modulesChanged':
      state.modules = msg.modules;
      // If a detail view is open for a module that no longer exists, pop back to list.
      if (state.moduleView.mode === 'detail') {
        const currentId = state.moduleView.moduleId;
        if (!state.modules.some((m) => m.id === currentId)) {
          state.moduleView = { mode: 'list' };
        }
      }
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
    case 'moduleDetail':
      // Cache the payload regardless. Only re-render if it's still the viewed module.
      state.moduleDetails[msg.moduleId] = msg.fragments;
      if (
        state.moduleView.mode === 'detail' &&
        state.moduleView.moduleId === msg.moduleId
      ) {
        render();
      }
      break;
  }
}

function setSection(id: SectionId): void {
  // Reset Modules-tab ephemeral UI state when leaving the Modules tab.
  if (state.activeSection === 'modules' && id !== 'modules') {
    state.moduleSearch = '';
    state.moduleView = { mode: 'list' };
    state.moduleDetails = {};
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

/**
 * Modules tab dispatcher. Renders either the flat list of all modules or a
 * single module's detail page depending on `state.moduleView`.
 */
function renderModules(wrapper: HTMLElement): void {
  if (state.moduleView.mode === 'detail') {
    const targetId = state.moduleView.moduleId;
    const found = state.modules.find((x) => x.id === targetId);
    if (found) {
      renderModuleDetailView(wrapper, found);
      return;
    }
    // Module disappeared — fall through to list view.
    state.moduleView = { mode: 'list' };
  }
  renderModuleListView(wrapper);
}

function renderModuleListView(wrapper: HTMLElement): void {
  wrapper.appendChild(textEl('h1', 'Modules'));
  wrapper.appendChild(
    textEl(
      'p',
      'Toggle modules on or off. Click the chevron (›) to view a module\'s details and prompt content.',
      'subtitle',
    ),
  );

  // Horizontal divider between the subtitle and the search/reload row.
  wrapper.appendChild(el('hr', { class: 'modules-divider' }));

  // The list is rendered into its own container so search input keystrokes
  // don't blow away the input element (and its focus/selection).
  const listWrap = el('div', { class: 'modules-list' });

  // Search bar + inline reload icon. The bar is a flex row so the input grows
  // and the icon button sits flush on the right at a 28x28 hit target.
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

  const reloadBtn = el('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Reload modules',
    title: 'Reload modules',
  }) as HTMLButtonElement;
  reloadBtn.innerHTML = REFRESH_ICON_SVG;
  reloadBtn.addEventListener('click', () =>
    vscode.postMessage({ type: 'reloadModules' }),
  );
  searchWrap.appendChild(reloadBtn);
  wrapper.appendChild(searchWrap);

  // Structural modules (cores) are read directly by the composer and are not
  // user-toggleable; hide them from the list.
  const visibleModules = state.modules.filter((m) => m.structural !== true);

  if (state.modules.length === 0) {
    // No manifests on disk at all.
    wrapper.appendChild(
      textEl(
        'div',
        'No modules discovered. Place modules under modules/ in your workspace and click Reload.',
        'empty',
      ),
    );
  } else if (visibleModules.length === 0) {
    // Manifests exist but all are structural cores — nothing user-toggleable.
    wrapper.appendChild(
      textEl(
        'div',
        'No user-toggleable modules. Cores are loaded structurally and are not shown here.',
        'empty',
      ),
    );
  }

  wrapper.appendChild(listWrap);
  renderModulesList(listWrap);
}

function renderModulesList(container: HTMLElement): void {
  container.innerHTML = '';
  const q = state.moduleSearch.trim().toLowerCase();
  // Structural modules (cores) are hidden from the Modules tab list.
  const visibleModules = state.modules.filter((m) => m.structural !== true);
  const filtered = visibleModules.filter((m) => {
    if (!q) return true;
    const hay = [m.id, m.name, m.description ?? ''].join(' ').toLowerCase();
    return hay.includes(q);
  });

  if (q && filtered.length === 0) {
    container.appendChild(textEl('div', 'No modules match.', 'empty'));
    return;
  }

  filtered.forEach((m) => {
    container.appendChild(renderModuleRow(m));
  });
}

/**
 * Compact module row. Layout (left-to-right):
 *   [toggle: stop-propagation zone] [name/meta/desc: navigates to detail] [›]
 * The toggle's click handler stops propagation so flipping the enable state
 * doesn't also navigate into the detail view.
 */
function renderModuleRow(m: ModuleSummary): HTMLElement {
  const row = el('div', { class: 'module-row' });

  // Toggle zone — clicks here must not bubble up to the navigate handler.
  const toggleZone = el('div', { class: 'module-row-toggle' });
  toggleZone.addEventListener('click', (ev) => ev.stopPropagation());
  toggleZone.appendChild(
    renderToggle({
      checked: m.enabled,
      onChange: (next) => {
        vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: next });
      },
      ariaLabel: `Enable ${m.name}`,
    }),
  );
  row.appendChild(toggleZone);

  // Text zone — non-interactive; displays name, id, version, description.
  const textZone = el('div', { class: 'module-row-body' });
  const title = el('div', { class: 'module-title' });
  const nameEl = el('strong');
  nameEl.textContent = m.name;
  title.appendChild(nameEl);
  const metaEl = el('span', { class: 'meta' });
  metaEl.textContent = `  v${m.version}`;
  title.appendChild(metaEl);
  textZone.appendChild(title);
  if (m.description) {
    textZone.appendChild(textEl('div', m.description, 'desc'));
  }
  row.appendChild(textZone);

  // Chevron — the sole navigation affordance for this row.
  const chevron = el('button', {
    class: 'module-row-chevron',
    type: 'button',
    'aria-label': `Open ${m.name} details`,
    title: 'Open details',
  }) as HTMLButtonElement;
  chevron.innerHTML = CHEVRON_RIGHT_SVG;
  chevron.addEventListener('click', () => openModuleDetail(m.id));
  row.appendChild(chevron);

  return row;
}

function openModuleDetail(moduleId: string): void {
  state.moduleView = { mode: 'detail', moduleId };
  if (!state.moduleDetails[moduleId]) {
    vscode.postMessage({ type: 'requestModuleDetail', moduleId });
  }
  render();
}

function backToModuleList(): void {
  state.moduleView = { mode: 'list' };
  render();
}

/**
 * Single-module detail page. Renders the header (back / name / meta / toggle),
 * a Proactive pill (if set), description, the existing definition list, the
 * raw prompt content for each declared fragment, and (when present) the
 * module's settings editor.
 */
function renderModuleDetailView(wrapper: HTMLElement, m: ModuleSummary): void {
  const container = el('div', { class: 'module-detail' });

  // Header: back button + name/meta + enable toggle on the right.
  const header = el('div', { class: 'detail-header' });
  const back = el('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Back to module list',
    title: 'Back',
  }) as HTMLButtonElement;
  back.innerHTML = ARROW_LEFT_SVG;
  back.addEventListener('click', backToModuleList);
  header.appendChild(back);

  const headTitle = el('div', { class: 'detail-title' });
  const headName = el('strong');
  headName.textContent = m.name;
  headTitle.appendChild(headName);
  const headMeta = el('span', { class: 'meta' });
  headMeta.textContent = `  ${m.id} · v${m.version}`;
  headTitle.appendChild(headMeta);
  header.appendChild(headTitle);

  const headSpacer = el('div', { class: 'detail-spacer' });
  header.appendChild(headSpacer);

  header.appendChild(
    renderToggle({
      checked: m.enabled,
      onChange: (next) => {
        vscode.postMessage({ type: 'toggleModule', id: m.id, enabled: next });
      },
      ariaLabel: `Enable ${m.name}`,
    }),
  );
  container.appendChild(header);

  // Proactive pill — small badge near the top.
  if (m.proactive) {
    const pill = el('span', { class: 'proactive-pill' });
    pill.textContent = 'Proactive';
    container.appendChild(pill);
  }

  // Description block.
  if (m.description) {
    container.appendChild(textEl('div', m.description, 'desc'));
  }

  // Definition list (always rendered, no expander).
  const c = m.contributes;
  const dl = el('dl', { class: 'details-list' });
  appendDef(dl, 'Version', m.version);
  appendDef(dl, 'Id', m.id);

  const fragCount = c?.promptFragments?.length ?? 0;
  const agentCount = c?.agents?.length ?? 0;
  const toolCount = c?.tools?.length ?? 0;
  const uiCount = c?.settingsPanelSections?.length ?? 0;

  if (fragCount > 0) {
    const targets = (c?.promptFragments ?? []).map((f) => f.target).join(', ');
    appendDef(dl, 'Module content files', `${fragCount} (read on demand by: ${targets})`);
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
  container.appendChild(dl);

  // Prompt Content section — raw module .md text from the host.
  container.appendChild(textEl('div', 'Prompt Content', 'details-header'));
  const fragments = state.moduleDetails[m.id];
  if (fragments === undefined) {
    container.appendChild(textEl('div', 'Loading…', 'empty'));
  } else if (fragments.length === 0) {
    container.appendChild(
      textEl('div', 'This module declares no prompt content.', 'empty'),
    );
  } else {
    fragments.forEach((f) => {
      const head = el('div', { class: 'fragment-head' });
      head.textContent = `target: ${f.target} — ${basename(f.contentPath)}`;
      container.appendChild(head);
      const pre = el('pre', { class: 'prompt fragment' });
      if (f.error) {
        pre.textContent = `(read error: ${f.error})`;
      } else {
        pre.textContent = f.content;
      }
      container.appendChild(pre);
    });
  }

  // Settings editor (inline, no expander wrapping).
  const fields = (c?.settings ?? {}) as Record<string, SettingsField>;
  const fieldEntries = Object.entries(fields);
  if (fieldEntries.length > 0) {
    container.appendChild(textEl('div', 'Settings', 'details-header'));
    const settingsWrap = el('div', { class: 'module-settings' });
    fieldEntries.forEach(([key, field]) => {
      settingsWrap.appendChild(
        renderModuleSettingField(scopedKey(m.id, key), field),
      );
    });
    container.appendChild(settingsWrap);
  }

  wrapper.appendChild(container);
}

/** Strip the directory portion off a relative manifest path. */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
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

function renderAgent(wrapper: HTMLElement, agentId: string): void {
  wrapper.appendChild(textEl('h1', `Agent: ${agentId.toUpperCase()}`));
  wrapper.appendChild(textEl('p', 'Composed agent prompt: core definition, preamble, and Session Manifest. Module content is read on demand.', 'subtitle'));

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
