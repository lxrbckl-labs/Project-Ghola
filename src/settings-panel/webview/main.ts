// Webview-side entry. Compiled to dist/webview.js as a browser IIFE.
// Plain TS + DOM only — no framework, no markdown lib (renders prompts as <pre>).

import type {
  HostToWebviewMessage,
  ModuleSummary,
  NamedConfiguration,
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

/**
 * Inline name-input state for the Configurations row. `false` when no inline
 * editor is active. `{ mode: 'create' }` when entering a name for a new
 * "Save as new" configuration. `{ mode: 'rename', id }` when editing the
 * name of an existing entry. Cleared on tab leave and after submit/cancel.
 */
type ConfigNameEditMode =
  | false
  | { mode: 'create' }
  | { mode: 'rename'; id: string };

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
  /** Current SWE agent counts pulled from `nomeda.swe.*` VS Code configuration. */
  sweConfig: { performanceCores: number; efficiencyCores: number };
  /** Current QA agent count pulled from `nomeda.qa.count` VS Code configuration. */
  qaConfig: { count: number };
  /** All named configurations known to the host. Updated by 'configurationsChanged'. */
  configurations: NamedConfiguration[];
  /** Currently active configuration id, or null when no preset is selected. */
  activeConfigurationId: string | null;
  /** True when the live module/settings state has diverged from the active config. */
  isConfigurationModified: boolean;
  /** Inline name-input state machine for create / rename UX. */
  configNameEditMode: ConfigNameEditMode;
  /** True when the Manage panel under the kebab is expanded (Modules tab only). */
  configManageOpen: boolean;
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
  sessionCommand: 'initiate',
  sweConfig: { performanceCores: 2, efficiencyCores: 1 },
  qaConfig: { count: 1 },
  configurations: [],
  activeConfigurationId: null,
  isConfigurationModified: false,
  configNameEditMode: false,
  configManageOpen: false,
};

const root = document.getElementById('app')!;

// Inline 16x16 monochrome SVG icons — fill="currentColor" so they pick up the
// surrounding text color (VS Code foreground / button foreground). Path data
// taken from Codicons (refresh, chevron-right, arrow-left) and trimmed.
const REFRESH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>`;

const CHEVRON_RIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.7 13.7l-.7-.7L9.6 8.4 5 3.8l.7-.7L11.1 8.4l-5.4 5.3z"/></svg>`;

const ARROW_LEFT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 7.5h-9.79l3.65-3.65-.71-.7L1.5 8l5.15 5.15.71-.7-3.65-3.65H13.5v-1.3z"/></svg>`;

const PLAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 6,20 20,12"/></svg>`;

// Floppy-disk save glyph. Sits in the save button next to module setting inputs;
// fill="currentColor" so it picks up the surrounding text color.
const SAVE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.353 1.146l1.5 1.5L15 3v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 14V2a1.5 1.5 0 0 1 1.5-1.5H13l.353.146zM2.5 1.5a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5H3v-5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 .5.5v5h.5a.5.5 0 0 0 .5-.5V3.207L12.793 1.5H11v3.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5V1.5H2.5zM5 1.5v3h5v-3H5zM4 14h8V9.5H4V14z"/></svg>`;

// Vertical ellipsis — the kebab "Manage" affordance on the Configurations row.
const KEBAB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>`;

// Plus glyph — the "Save as new" affordance.
const PLUS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.5 1h1v6h6v1h-6v6h-1V8h-6V7h6V1z"/></svg>`;

// Star glyph — marks a configuration as default.
const STAR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.96 4.05L14.5 6.2l-3.3 3.18.79 4.55L8 11.8l-3.99 2.13.79-4.55L1.5 6.2l4.54-.65L8 1.5z"/></svg>`;

// Pencil glyph — rename affordance in the Manage panel.
const PENCIL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.23 1l1.77 1.77-9.62 9.62L3 13.5l.11-2.39L12.73 1.5l.5-.5zM11.94 3.79L4.18 11.55l-.06 1.32 1.32-.06 7.76-7.76-1.26-1.26z"/></svg>`;

// Trash glyph — delete affordance in the Manage panel.
const TRASH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 1H6L5 2H2v1h1l1 11h8l1-11h1V2h-3l-1-1zm-3 4h1v8H7V5zm2 0h1v8H9V5zm-4 0h1v8H5V5z"/></svg>`;

// Check glyph — confirm action inside the inline name input.
const CHECK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0L1.72 9.28a.75.75 0 1 1 1.06-1.06l3 3 7-7a.75.75 0 0 1 1.06 0z"/></svg>`;

// X glyph — cancel action inside the inline name input.
const CLOSE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>`;

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
      state.sessionCommand = msg.sessionCommand ?? 'initiate';
      if (msg.swe) state.sweConfig = msg.swe;
      if (msg.qa) state.qaConfig = msg.qa;
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
    case 'configurationsChanged':
      state.configurations = msg.configurations;
      state.activeConfigurationId = msg.activeId;
      state.isConfigurationModified = msg.isModified;
      // If the active config has been deleted, drop any rename-in-progress
      // pointing at it. Create-mode is tied to user intent, not data — leave alone.
      if (state.configNameEditMode !== false && state.configNameEditMode.mode === 'rename') {
        const renameId = state.configNameEditMode.id;
        if (!state.configurations.some((c) => c.id === renameId)) {
          state.configNameEditMode = false;
        }
      }
      render();
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
  // Clear inline configuration name editor and manage panel on any tab leave —
  // both are tab-scoped ephemeral UI states.
  if (state.activeSection !== id) {
    state.configNameEditMode = false;
    state.configManageOpen = false;
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
  rail.appendChild(railItem('general', 'Session'));
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
  wrapper.appendChild(textEl('h1', 'Session'));
  wrapper.appendChild(textEl('p', 'Configure the command that launches your Nomeda agent team, then start a session.', 'subtitle'));

  // Horizontal divider between the header and the settings content.
  wrapper.appendChild(el('hr', { class: 'section-divider' }));

  // Initiation Command — label on its own line, then flex row with [input grows] [play button].
  const sessionLabel = el('label', { class: 'setting-label session-command-label' });
  sessionLabel.textContent = 'Initiation Command';
  wrapper.appendChild(sessionLabel);
  const sessionRow = el('div', { class: 'session-command-row' });
  const sessionInp = el('input', { class: 'setting-input session-command-input' }) as HTMLInputElement;
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
  sessionRow.appendChild(sessionInp);

  // Configuration dropdown sits between the command input and the play button.
  // It mirrors the same dropdown used on the Modules tab; selection drives the
  // active configuration which the host applies immediately.
  sessionRow.appendChild(renderConfigDropdown());

  const sessionBtn = el('button', {
    class: 'icon-button framed',
    type: 'button',
    'aria-label': 'Open Nomeda session',
    title: 'Open a new Nomeda session',
  }) as HTMLButtonElement;
  sessionBtn.innerHTML = PLAY_ICON_SVG;
  sessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  sessionRow.appendChild(sessionBtn);
  wrapper.appendChild(sessionRow);

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

  // Configurations row — preset selector + save buttons + kebab manage.
  // Lives between the subtitle and the section divider per the locked design.
  wrapper.appendChild(renderConfigurationsRow({ context: 'modules' }));

  // Horizontal divider between the subtitle and the search/reload row.
  wrapper.appendChild(el('hr', { class: 'section-divider' }));

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
    class: 'icon-button framed',
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

// ─── Configurations row helpers ──────────────────────────────────────────

interface ConfigRowOptions {
  /**
   * Where the row is being rendered. Currently 'modules' shows the full row
   * (dropdown + save buttons + kebab); 'session' is reserved if we ever need
   * a richer row on the Session tab (today the Session tab uses a bare
   * dropdown via `renderConfigDropdown`).
   */
  context: 'modules';
}

/**
 * Shared Configurations row: dropdown + Save / Save-as-new buttons + kebab
 * Manage toggle. When the inline name editor is open (create or rename), the
 * normal controls are replaced by a focused input + check/close pair.
 *
 * Save / Save-as-new live ONLY on the Modules tab per the locked design; the
 * Session tab embeds a bare dropdown via `renderConfigDropdown` instead.
 */
function renderConfigurationsRow(_opts: ConfigRowOptions): HTMLElement {
  const row = el('div', { class: 'configurations-row' });

  // Inline name editor takes the whole row when active. The state machine
  // dictates the placeholder + which message gets sent on submit.
  if (state.configNameEditMode !== false) {
    row.appendChild(renderConfigNameInput(state.configNameEditMode));
    return row;
  }

  // Dropdown — non-stretching, ~220px, occupies the left side.
  row.appendChild(renderConfigDropdown());

  // Save (commits current state into the active configuration). Disabled when
  // there is no active config OR the live state matches it already.
  const saveBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Save changes to active configuration',
    title: 'Save changes to active configuration',
  }) as HTMLButtonElement;
  saveBtn.innerHTML = SAVE_ICON_SVG;
  const canSave =
    state.activeConfigurationId !== null && state.isConfigurationModified;
  saveBtn.disabled = !canSave;
  saveBtn.addEventListener('click', () => {
    if (!canSave) return;
    vscode.postMessage({ type: 'saveConfigurationCurrent' });
  });
  row.appendChild(saveBtn);

  // Save as new — opens the inline name editor in 'create' mode.
  const saveAsBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Save current state as new configuration',
    title: 'Save current state as new configuration',
  }) as HTMLButtonElement;
  saveAsBtn.innerHTML = PLUS_ICON_SVG;
  saveAsBtn.addEventListener('click', () => {
    state.configNameEditMode = { mode: 'create' };
    state.configManageOpen = false;
    render();
  });
  row.appendChild(saveAsBtn);

  // Kebab — toggles the inline Manage panel that lists per-config actions.
  // Disabled when there are no saved configurations to manage.
  const kebabBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Manage configurations',
    title: 'Manage configurations',
  }) as HTMLButtonElement;
  kebabBtn.innerHTML = KEBAB_ICON_SVG;
  kebabBtn.disabled = state.configurations.length === 0;
  if (state.configManageOpen) kebabBtn.classList.add('active');
  kebabBtn.addEventListener('click', () => {
    if (state.configurations.length === 0) return;
    state.configManageOpen = !state.configManageOpen;
    render();
  });
  row.appendChild(kebabBtn);

  // Manage panel renders directly after the row (still inside this helper so
  // it stays visually associated with the controls that opened it).
  const wrapper = el('div', { class: 'configurations-wrapper' });
  wrapper.appendChild(row);
  if (state.configManageOpen && state.configurations.length > 0) {
    wrapper.appendChild(renderConfigManagePanel());
  }
  return wrapper;
}

/** Standalone dropdown — used on its own in the Session tab. */
function renderConfigDropdown(): HTMLElement {
  const select = el('select', {
    class: 'config-dropdown',
    'aria-label': 'Active configuration',
  }) as HTMLSelectElement;

  const noneOption = el('option') as HTMLOptionElement;
  noneOption.value = '';
  noneOption.textContent = 'No configuration';
  select.appendChild(noneOption);

  state.configurations.forEach((c) => {
    const opt = el('option') as HTMLOptionElement;
    opt.value = c.id;
    opt.textContent = c.isDefault ? `${c.name}  ★` : c.name;
    select.appendChild(opt);
  });

  select.value = state.activeConfigurationId ?? '';

  select.addEventListener('change', () => {
    const next = select.value === '' ? null : select.value;
    vscode.postMessage({ type: 'selectConfiguration', id: next });
  });

  return select;
}

function renderConfigNameInput(mode: { mode: 'create' } | { mode: 'rename'; id: string }): HTMLElement {
  const row = el('div', { class: 'config-name-input-row' });
  const input = el('input', { class: 'config-name-input', type: 'text' }) as HTMLInputElement;
  input.placeholder = mode.mode === 'create' ? 'New configuration name' : 'Rename configuration';
  if (mode.mode === 'rename') {
    const existing = state.configurations.find((c) => c.id === mode.id);
    if (existing) input.value = existing.name;
  }
  input.autofocus = true;
  // Focus on next tick — the element isn't in the DOM until render() finishes
  // attaching it, so an immediate input.focus() is a no-op.
  queueMicrotask(() => {
    input.focus();
    input.select();
  });

  const commit = (): void => {
    const value = input.value.trim();
    if (!value) {
      // Cancel rather than emit empty name.
      state.configNameEditMode = false;
      render();
      return;
    }
    if (mode.mode === 'create') {
      vscode.postMessage({ type: 'saveConfigurationAsNew', name: value });
    } else {
      vscode.postMessage({ type: 'renameConfiguration', id: mode.id, name: value });
    }
    state.configNameEditMode = false;
    // Don't re-render synchronously — the host will broadcast configurationsChanged.
  };

  const cancel = (): void => {
    state.configNameEditMode = false;
    render();
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
    }
  });
  row.appendChild(input);

  const confirmBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Confirm',
    title: 'Confirm',
  }) as HTMLButtonElement;
  confirmBtn.innerHTML = CHECK_ICON_SVG;
  confirmBtn.addEventListener('click', commit);
  row.appendChild(confirmBtn);

  const cancelBtn = el('button', {
    class: 'config-action-button',
    type: 'button',
    'aria-label': 'Cancel',
    title: 'Cancel',
  }) as HTMLButtonElement;
  cancelBtn.innerHTML = CLOSE_ICON_SVG;
  cancelBtn.addEventListener('click', cancel);
  row.appendChild(cancelBtn);

  return row;
}

function renderConfigManagePanel(): HTMLElement {
  const panel = el('div', { class: 'config-kebab-menu' });
  state.configurations.forEach((c) => {
    const item = el('div', { class: 'config-manage-item' });

    const name = el('span', { class: 'config-manage-name' });
    name.textContent = c.name;
    item.appendChild(name);

    if (c.isDefault) {
      const badge = el('span', { class: 'config-default-badge' });
      badge.textContent = 'default';
      item.appendChild(badge);
    }

    const actions = el('div', { class: 'config-manage-actions' });

    const renameBtn = el('button', {
      class: 'config-action-button',
      type: 'button',
      'aria-label': `Rename ${c.name}`,
      title: 'Rename',
    }) as HTMLButtonElement;
    renameBtn.innerHTML = PENCIL_ICON_SVG;
    renameBtn.addEventListener('click', () => {
      state.configNameEditMode = { mode: 'rename', id: c.id };
      state.configManageOpen = false;
      render();
    });
    actions.appendChild(renameBtn);

    const defaultBtn = el('button', {
      class: 'config-action-button',
      type: 'button',
      'aria-label': c.isDefault ? `${c.name} is the default` : `Set ${c.name} as default`,
      title: c.isDefault ? 'Default configuration' : 'Set as default',
    }) as HTMLButtonElement;
    defaultBtn.innerHTML = STAR_ICON_SVG;
    if (c.isDefault) defaultBtn.classList.add('active');
    defaultBtn.disabled = c.isDefault;
    defaultBtn.addEventListener('click', () => {
      if (c.isDefault) return;
      vscode.postMessage({ type: 'setDefaultConfiguration', id: c.id });
    });
    actions.appendChild(defaultBtn);

    const delBtn = el('button', {
      class: 'config-action-button',
      type: 'button',
      'aria-label': `Delete ${c.name}`,
      title: 'Delete',
    }) as HTMLButtonElement;
    delBtn.innerHTML = TRASH_ICON_SVG;
    delBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteConfiguration', id: c.id });
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    panel.appendChild(item);
  });
  return panel;
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
 * Layout per field:
 *   Label                                    ← stays above on its own line
 *   [ input grows .......... 28px ] [save]   ← input + explicit-save icon button
 *   Description (optional)                   ← below input
 *
 * Persistence model:
 *   - Booleans: auto-save on toggle (toggling implies commitment; there is no
 *     ambiguous "draft" state for a switch).
 *   - String / number / enum: explicit save — the user edits freely; the save
 *     button glows ".dirty" when the input differs from the persisted value;
 *     clicking the button commits the change and clears the dirty state. No
 *     more reactive blur/change persistence.
 *
 * Dirty tracking lives in this function's closure: `committed` holds the value
 * last persisted (initialized from settingsValues / field.default), and the
 * save button's classList is updated as the user types.
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
    // Booleans keep auto-save-on-toggle semantics. A toggle has no intermediate
    // "edited but not saved" state worth modelling, and a save button next to
    // it would be redundant chrome.
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
    if (field.description) {
      wrap.appendChild(textEl('div', field.description, 'setting-desc'));
    }
    return wrap;
  }

  // For non-boolean fields, build a flex row with the input on the left and an
  // explicit save icon button on the right. The closure below tracks the last
  // committed value so the button can show a "dirty" indicator while the
  // current input value differs.
  const row = el('div', { class: 'module-field-row' });

  // `committed` is the value last persisted; it is what we compare the live
  // input against to decide if there are unsaved changes.
  let committed: unknown = current;

  // Read the latest "input value" coerced to the field type.
  let readInputValue: () => unknown;
  // Apply a committed value back into the DOM (used after save to ensure the
  // displayed value matches what we persisted, especially for number coercion).
  let writeInputValue: (v: unknown) => void;

  if (field.type === 'enum') {
    const select = el('select', { class: 'setting-input' }) as HTMLSelectElement;
    (field.options ?? []).forEach((opt) => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt;
      o.textContent = opt;
      if (opt === current) o.selected = true;
      select.appendChild(o);
    });
    readInputValue = () => select.value;
    writeInputValue = (v) => {
      select.value = v === undefined || v === null ? '' : String(v);
    };
    row.appendChild(select);
    select.addEventListener('change', () => updateDirtyState());
  } else if (field.type === 'number') {
    const inp = el('input', { class: 'setting-input' }) as HTMLInputElement;
    inp.type = 'number';
    if (current !== undefined && current !== null) inp.value = String(current);
    readInputValue = () => (inp.value === '' ? undefined : Number(inp.value));
    writeInputValue = (v) => {
      inp.value = v === undefined || v === null ? '' : String(v);
    };
    row.appendChild(inp);
    inp.addEventListener('input', () => updateDirtyState());
  } else {
    // string, path, or unknown — render text input.
    const inp = el('input', { class: 'setting-input' }) as HTMLInputElement;
    inp.type = 'text';
    if (current !== undefined && current !== null) inp.value = String(current);
    readInputValue = () => inp.value;
    writeInputValue = (v) => {
      inp.value = v === undefined || v === null ? '' : String(v);
    };
    row.appendChild(inp);
    inp.addEventListener('input', () => updateDirtyState());
  }

  const saveBtn = el('button', {
    class: 'icon-button framed save-field-button',
    type: 'button',
    'aria-label': `Save ${field.label}`,
    title: 'Save',
  }) as HTMLButtonElement;
  saveBtn.innerHTML = SAVE_ICON_SVG;

  function isDirty(): boolean {
    const next = readInputValue();
    // Treat undefined / '' / null as equivalent "empty" so an empty optional
    // number input doesn't flicker dirty against an undefined default.
    const a = next === '' || next === null ? undefined : next;
    const b = committed === '' || committed === null ? undefined : committed;
    return a !== b;
  }

  function updateDirtyState(): void {
    if (isDirty()) {
      saveBtn.classList.add('dirty');
    } else {
      saveBtn.classList.remove('dirty');
    }
  }

  saveBtn.addEventListener('click', () => {
    if (!isDirty()) return;
    const next = readInputValue();
    state.settingsValues[key] = next;
    committed = next;
    // Reflect the canonical persisted value back into the input (e.g. number
    // coercion may have normalized '3.0' to 3).
    writeInputValue(next);
    persistSettings();
    updateDirtyState();
  });
  row.appendChild(saveBtn);
  wrap.appendChild(row);

  // Initial state — should be clean.
  updateDirtyState();

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

const AGENT_FULL_NAMES: Record<string, string> = {
  tpm: 'Technical Program Manager',
  swe: 'Software Engineer',
  qa: 'Quality Assurance',
};

function renderAgent(wrapper: HTMLElement, agentId: string): void {
  const h1 = el('h1');
  h1.textContent = agentId.toUpperCase();
  const fullName = AGENT_FULL_NAMES[agentId];
  if (fullName) {
    const elucidation = el('span', { class: 'agent-title-elucidation' });
    elucidation.textContent = fullName;
    h1.appendChild(elucidation);
  }
  wrapper.appendChild(h1);
  wrapper.appendChild(textEl('p', 'Composed agent prompt: core definition, preamble, and Session Manifest. Module content is read on demand.', 'subtitle'));

  // SWE and QA subpages render an agent-config block above the composed prompt
  // for configuring how many concurrent subagents TPM may spawn. TPM itself is
  // singular — no count field.
  if (agentId === 'swe') {
    wrapper.appendChild(renderSweConfigBlock());
  } else if (agentId === 'qa') {
    wrapper.appendChild(renderQaConfigBlock());
  }

  const prompt = state.composedPrompts[agentId];
  if (prompt === undefined) {
    wrapper.appendChild(textEl('div', 'Loading...', 'empty'));
    vscode.postMessage({ type: 'getComposedPrompt', agent: agentId });
    return;
  }
  const pre = el('pre', { class: 'prompt' });
  pre.textContent = prompt;
  wrapper.appendChild(pre);
}

/**
 * SWE subpage config block: two compact number inputs on one row laid out as
 * [label: input] [label: input]. The total SWE count is the sum of both.
 * Saves on blur via the existing `updateConfiguration` message.
 */
function renderSweConfigBlock(): HTMLElement {
  const block = el('div', { class: 'agent-config' });
  const header = el('div', { class: 'agent-config-header' });
  header.textContent = 'Configuration';
  block.appendChild(header);

  const row = el('div', { class: 'agent-config-row' });

  row.appendChild(
    renderAgentConfigField('Performance Cores', state.sweConfig.performanceCores, (next) => {
      state.sweConfig.performanceCores = next;
      vscode.postMessage({
        type: 'updateConfiguration',
        section: 'nomeda',
        key: 'swe.performanceCores',
        value: next,
      });
    }),
  );

  row.appendChild(
    renderAgentConfigField('Efficiency Cores', state.sweConfig.efficiencyCores, (next) => {
      state.sweConfig.efficiencyCores = next;
      vscode.postMessage({
        type: 'updateConfiguration',
        section: 'nomeda',
        key: 'swe.efficiencyCores',
        value: next,
      });
    }),
  );

  block.appendChild(row);
  return block;
}

/** QA subpage config block: single "QA Count" input above the composed prompt. */
function renderQaConfigBlock(): HTMLElement {
  const block = el('div', { class: 'agent-config' });
  const header = el('div', { class: 'agent-config-header' });
  header.textContent = 'Configuration';
  block.appendChild(header);

  const row = el('div', { class: 'agent-config-row' });
  row.appendChild(
    renderAgentConfigField('QA Count', state.qaConfig.count, (next) => {
      state.qaConfig.count = next;
      vscode.postMessage({
        type: 'updateConfiguration',
        section: 'nomeda',
        key: 'qa.count',
        value: next,
      });
    }),
  );
  block.appendChild(row);
  return block;
}

/**
 * Compact [label : number input] field used inside the agent-config row.
 * Persists on blur (consistent with the Initiation Command pattern). Coerces
 * empty input back to the previous value rather than emitting NaN.
 */
function renderAgentConfigField(
  label: string,
  initial: number,
  onCommit: (next: number) => void,
): HTMLElement {
  const field = el('div', { class: 'agent-config-field' });
  const lbl = el('label', { class: 'agent-config-label' });
  lbl.textContent = label;
  field.appendChild(lbl);

  const input = el('input', { class: 'agent-config-input' }) as HTMLInputElement;
  input.type = 'number';
  input.value = String(initial);
  input.addEventListener('blur', () => {
    const parsed = Number(input.value);
    if (input.value === '' || Number.isNaN(parsed)) {
      // Restore previous value rather than persist garbage.
      input.value = String(initial);
      return;
    }
    if (parsed === initial) return;
    onCommit(parsed);
  });
  field.appendChild(input);
  return field;
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
