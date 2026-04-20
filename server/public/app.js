/* ============================================================
   ClaudePaw — AI Operations Dashboard
   Vanilla ES6+ | Cyberpunk SPA | No frameworks
   Live API + WebSocket data layer
   ============================================================ */

// --------------- GLOBAL FETCH 401 INTERCEPTOR ---------------
// Wraps window.fetch so ANY 401 from /api/v1/* shows the auth gate,
// covering call sites that use raw fetch() outside of fetchFromAPI.
(function() {
  const _origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const response = await _origFetch(input, init);
    if (response.status === 401) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      // Only intercept API calls, not /api/v1/auth/login itself (avoid recursion)
      if (url.includes('/api/v1/') && !url.includes('/api/v1/auth/login') && !url.includes('/api/v1/auth/ws-ticket')) {
        // Clone is needed because body can only be read once
        const cloned = response.clone();
        showAuthGate();
        return cloned;
      }
    }
    return response;
  };
})();

// --------------- CURRENT USER ---------------

let CURRENT_USER = null;

async function fetchCurrentUser() {
  try {
    const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    CURRENT_USER = data.user;
    CURRENT_USER.memberships = data.memberships || [];
    CURRENT_USER.isAdmin = CURRENT_USER.global_role === 'admin';
    return CURRENT_USER;
  } catch (e) {
    console.warn('fetchCurrentUser failed:', e);
    return null;
  }
}

// --------------- AGENT DATA (dynamic per project) ---------------

let AGENTS = {};
const STATUS_CLASSES = ['online', 'active', 'idle', 'sleeping'];
let AGENT_NAME_TO_ID = {};

const TEMPLATE_ICON_MAP = {
  scout: 'search', producer: 'clapperboard', qa: 'check-circle',
  social: 'megaphone', sentinel: 'eye', analyst: 'bar-chart-3',
  brand: 'target', advocate: 'scale', auditor: 'shield-check',
  builder: 'hammer', researcher: 'book-open', 'content-creator': 'pen-tool',
  critic: 'message-square-warning', 'marketing-lead': 'trending-up',
  orchestrator: 'git-branch', 'social-manager': 'share-2',
};
function templateIcon(templateId) {
  return TEMPLATE_ICON_MAP[templateId] || 'bot';
}

function rebuildAgentIndex() {
  AGENT_NAME_TO_ID = {};
  Object.entries(AGENTS).forEach(([id, a]) => {
    AGENT_NAME_TO_ID[a.name.toLowerCase()] = id;
    AGENT_NAME_TO_ID[id] = id;
  });
}

let feedNewestFirst = true;
let _clockInterval = null;

// --------------- PROJECT STATE ---------------
let currentProject = { id: '', slug: '', display_name: 'All Projects', icon: '◉', settings: null };
let allProjects = [];

// --------------- PROJECT EVENT BUS ---------------
const ProjectBus = {
  _listeners: [],
  on(fn) { this._listeners.push(fn); },
  off(fn) { this._listeners = this._listeners.filter(f => f !== fn); },
  emit(project) { this._listeners.forEach(fn => fn(project)); }
};

// --------------- UTILITY FUNCTIONS ---------------

function pad(n) { return String(n).padStart(2, '0'); }

function formatDateHeader(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${pad(date.getDate())}, ${date.getFullYear()}`;
}

function formatTimeHeader(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ET`;
}

function formatFeedTime(date) {
  let h = date.getHours();
  const m = pad(date.getMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

// --------------- PROJECT MANAGEMENT ---------------

async function fetchProjects() {
  try {
    const data = await fetchFromAPI('/api/v1/projects');
    if (!Array.isArray(data)) return;
    allProjects = data;
    if (currentProject.id) {
      const activeCurrent = allProjects.find(p => p.id === currentProject.id && p.status !== 'archived');
      if (!activeCurrent) selectProject(null, { silent: true });
    }
    renderProjectSelector();

    // Restore saved project from localStorage.
    // Pass { silent: true } to skip the ProjectBus emit so we can control
    // the first data load ourselves and await it properly (no flash of wrong data).
    const savedProjectId = localStorage.getItem('cp_project');
    if (savedProjectId) {
      const saved = allProjects.find(p => p.id === savedProjectId && p.status !== 'archived');
      if (saved) selectProject(saved, { silent: true });
      else localStorage.removeItem('cp_project');
    }

    // First agent fetch -- runs AFTER project restore so agents match the active project.
    await fetchAgentStatuses();
    // Full data refresh for all project-scoped pages.
    await refreshWithProjectFilter();
    fetchProjectOverview();

    renderSettingsProjectBar();
    if (typeof renderProjectsPage === 'function') renderProjectsPage();
  } catch (e) {
    console.warn('Failed to fetch projects:', e);
  }
}

function makeProjectOption(iconName, nameText) {
  const iconEl = document.createElement('i');
  iconEl.className = 'project-option__icon';
  iconEl.setAttribute('data-lucide', iconName || 'folder');
  const nameEl = document.createElement('span');
  nameEl.className = 'project-option__name';
  nameEl.textContent = nameText;
  return [iconEl, nameEl];
}

function renderProjectSelector() {
  const dropdown = document.getElementById('project-dropdown');
  const selectorEl = document.getElementById('project-selector');
  if (!dropdown) return;

  const activeProjects = allProjects.filter(p => p.status !== 'archived');
  const isAdmin = CURRENT_USER && CURRENT_USER.isAdmin;

  // Members with exactly one project: hide the selector entirely
  if (!isAdmin && activeProjects.length === 1) {
    if (selectorEl) selectorEl.style.display = 'none';
    // Auto-select the sole project silently
    if (!currentProject.id) selectProject(activeProjects[0], { silent: true });
    return;
  }
  if (selectorEl) selectorEl.style.removeProperty('display');

  while (dropdown.firstChild) dropdown.removeChild(dropdown.firstChild);

  // "All Projects" only for admins
  if (isAdmin) {
    const allBtn = document.createElement('button');
    allBtn.className = 'project-selector__option' + (currentProject.id === '' ? ' active' : '');
    allBtn.dataset.projectId = '';
    allBtn.dataset.projectSlug = '';
    const [allIcon, allName] = makeProjectOption('globe', 'All Projects');
    allBtn.appendChild(allIcon);
    allBtn.appendChild(allName);
    allBtn.addEventListener('click', () => selectProject(null));
    dropdown.appendChild(allBtn);
  }

  // Individual projects
  for (const p of activeProjects) {
    const btn = document.createElement('button');
    btn.className = 'project-selector__option' + (currentProject.id === p.id ? ' active' : '');
    btn.dataset.projectId = p.id;
    btn.dataset.projectSlug = p.slug;

    const [icon, name] = makeProjectOption(p.icon || 'folder', p.display_name);
    btn.appendChild(icon);
    btn.appendChild(name);

    if (p.primary_color) {
      const dot = document.createElement('span');
      dot.className = 'project-option__dot';
      dot.style.background = p.primary_color;
      btn.appendChild(dot);
    }

    btn.addEventListener('click', () => selectProject(p));
    dropdown.appendChild(btn);
  }

  // Activate Lucide icons in the dropdown
  if (typeof lucide !== 'undefined') lucide.createIcons({ attrs: { class: 'project-option__icon' }, nameAttr: 'data-lucide' });
}

function selectProject(project, opts) {
  if (project) {
    currentProject = {
      id: project.id,
      slug: project.slug,
      display_name: project.display_name,
      icon: project.icon || 'folder',
      settings: {
        theme_id: project.theme_id,
        primary_color: project.primary_color,
        accent_color: project.accent_color,
        sidebar_color: project.sidebar_color,
      }
    };
  } else {
    currentProject = { id: '', slug: '', display_name: 'All Projects', icon: 'globe', settings: null };
  }

  // Update selector display
  const iconEl = document.getElementById('project-icon');
  const nameEl = document.getElementById('project-name');
  if (iconEl) {
    iconEl.innerHTML = '';
    iconEl.setAttribute('data-lucide', currentProject.icon);
    if (typeof lucide !== 'undefined') lucide.createIcons({ attrs: { class: 'project-selector__icon' }, nameAttr: 'data-lucide' });
  }
  if (nameEl) nameEl.textContent = currentProject.display_name;

  // Close dropdown
  toggleProjectDropdown(false);

  // Update active states in dropdown
  renderProjectSelector();

  // Apply project theme colors
  applyProjectTheme(currentProject.settings);

  // Update header subtitle
  const subtitle = document.querySelector('.header-subtitle');
  if (subtitle) subtitle.textContent = currentProject.display_name === 'All Projects' ? 'All Projects' : currentProject.display_name;

  // Update project color vars
  if (currentProject.id && currentProject.settings && currentProject.settings.primary_color) {
    const { r, g, b } = hexToRgb(currentProject.settings.primary_color);
    document.documentElement.style.setProperty('--project-primary-soft', `rgba(${r},${g},${b},0.10)`);
    document.documentElement.style.setProperty('--project-primary-dim', `rgba(${r},${g},${b},0.20)`);
  } else {
    document.documentElement.style.removeProperty('--project-primary-soft');
    document.documentElement.style.removeProperty('--project-primary-dim');
  }

  // Update sidebar project indicator
  const selector = document.getElementById('project-selector');
  if (selector) {
    if (currentProject.id) {
      selector.setAttribute('data-project-active', 'true');
      if (currentProject.settings && currentProject.settings.primary_color) {
        selector.style.setProperty('--project-primary', currentProject.settings.primary_color);
      }
    } else {
      selector.removeAttribute('data-project-active');
      selector.style.removeProperty('--project-primary');
    }
  }

  // Persist selection to localStorage
  if (currentProject.id) {
    localStorage.setItem('cp_project', currentProject.id);
  } else {
    localStorage.removeItem('cp_project');
  }

  // Hide/show project overview grid: only admins on "All Projects" view
  const overviewGrid = document.getElementById('project-health-grid');
  if (overviewGrid) overviewGrid.hidden = !!currentProject.id || !(CURRENT_USER && CURRENT_USER.isAdmin);

  // Notify all subscribers (skip on initial restore to avoid race conditions)
  if (!(opts && opts.silent)) ProjectBus.emit(currentProject);
}

// Theme cache: loaded once from /api/v1/themes
let _themesCache = null;
async function loadThemes() {
  if (_themesCache) return _themesCache;
  try {
    _themesCache = await fetchFromAPI('/api/v1/themes');
  } catch (e) {
    console.warn('Failed to load themes:', e);
    _themesCache = [];
  }
  return _themesCache;
}

function getThemeById(id) {
  if (!_themesCache) return null;
  return _themesCache.find(t => t.id === id) || null;
}

// Map theme JSON keys to CSS custom properties
const THEME_CSS_MAP = {
  bgBase:       '--bg-base',
  bgRaised:     '--bg-raised',
  bgSurface:    '--bg-surface',
  bgOverlay:    '--bg-overlay',
  bgGlass:      '--bg-glass',
  accent:       '--accent',
  accentDim:    '--accent-dim',
  accentGlow:   '--accent-glow',
  accentSoft:   '--accent-soft',
  magenta:      '--magenta',
  cyan:         '--cyan',
  green:        '--green',
  amber:        '--amber',
  red:          '--red',
  purple:       '--purple',
  textPrimary:  '--text-primary',
  textSecondary:'--text-secondary',
  textMuted:    '--text-muted',
  textOnAccent: '--text-on-accent',
  borderColor:  '--border-color',
  borderSubtle: '--border-subtle',
  magentaDim:   '--magenta-dim',
  cyanDim:      '--cyan-dim',
  greenDim:     '--green-dim',
  amberDim:     '--amber-dim',
  redDim:       '--red-dim',
  purpleDim:    '--purple-dim',
};

// Parse hex color to RGB components (supports #RGB and #RRGGBB)
function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.substring(0, 2), 16) || 0,
    g: parseInt(h.substring(2, 4), 16) || 0,
    b: parseInt(h.substring(4, 6), 16) || 0
  };
}

function applyThemeToRoot(theme) {
  const root = document.documentElement;
  if (!theme || !theme.colors) return;

  // Apply color variables
  for (const [key, cssVar] of Object.entries(THEME_CSS_MAP)) {
    if (theme.colors[key]) {
      root.style.setProperty(cssVar, theme.colors[key]);
    }
  }

  // Derive accent opacity variants from the accent hex
  const accent = theme.colors.accent;
  if (accent && accent.startsWith('#')) {
    const { r, g, b } = hexToRgb(accent);
    root.style.setProperty('--accent-faint', `rgba(${r},${g},${b},0.03)`);
    root.style.setProperty('--accent-subtle', `rgba(${r},${g},${b},0.10)`);
    root.style.setProperty('--accent-medium', `rgba(${r},${g},${b},0.28)`);
    root.style.setProperty('--accent-strong', `rgba(${r},${g},${b},0.60)`);
    root.style.setProperty('--accent-grid', `rgba(${r},${g},${b},0.010)`);
    // Also set dim/glow/soft if not in theme already
    if (!theme.colors.accentDim) root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.13)`);
    if (!theme.colors.accentGlow) root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.32)`);
    if (!theme.colors.accentSoft) root.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.07)`);
  }

  // Derive dim variants for semantic colors
  ['magenta', 'cyan', 'green', 'amber', 'red', 'purple'].forEach(name => {
    const hex = theme.colors[name];
    if (hex && hex.startsWith('#')) {
      const { r, g, b } = hexToRgb(hex);
      root.style.setProperty('--' + name + '-dim', `rgba(${r},${g},${b},0.13)`);
    }
  });

  // Apply font overrides
  if (theme.fonts) {
    if (theme.fonts.heading) root.style.setProperty('--font-heading', theme.fonts.heading);
    if (theme.fonts.body) root.style.setProperty('--font-body', theme.fonts.body);
    if (theme.fonts.mono) root.style.setProperty('--font-mono', theme.fonts.mono);
  }

  // Apply gradient overrides
  if (theme.gradients) {
    if (theme.gradients.card) root.style.setProperty('--card-gradient', theme.gradients.card);
    if (theme.gradients.cardHover) root.style.setProperty('--card-gradient-hover', theme.gradients.cardHover);
  }

  // Apply shadow overrides
  if (theme.shadows) {
    if (theme.shadows.card) root.style.setProperty('--shadow-card', theme.shadows.card);
    if (theme.shadows.hover) root.style.setProperty('--shadow-hover', theme.shadows.hover);
    if (theme.shadows.glow) root.style.setProperty('--shadow-glow', theme.shadows.glow);
  }

  // Apply sidebar and header backgrounds directly
  const sidebar = document.querySelector('.sidebar-nav');
  const header = document.querySelector('.header-bar');
  if (sidebar && theme.colors.sidebarBg) sidebar.style.background = theme.colors.sidebarBg;
  if (header && theme.colors.headerBg) header.style.background = theme.colors.headerBg;

  // Store active theme id for settings page
  root.dataset.activeTheme = theme.id || '';
}

function clearThemeOverrides() {
  const root = document.documentElement;
  for (const cssVar of Object.values(THEME_CSS_MAP)) {
    root.style.removeProperty(cssVar);
  }
  // Clear derived accent opacities (not in THEME_CSS_MAP, generated at runtime)
  ['--accent-faint','--accent-subtle','--accent-medium','--accent-strong','--accent-grid']
    .forEach(v => root.style.removeProperty(v));
  root.style.removeProperty('--font-heading');
  root.style.removeProperty('--font-body');
  root.style.removeProperty('--font-mono');
  root.style.removeProperty('--card-gradient');
  root.style.removeProperty('--card-gradient-hover');
  root.style.removeProperty('--shadow-card');
  root.style.removeProperty('--shadow-hover');
  root.style.removeProperty('--shadow-glow');

  const sidebar = document.querySelector('.sidebar-nav');
  const header = document.querySelector('.header-bar');
  if (sidebar) sidebar.style.removeProperty('background');
  if (header) header.style.removeProperty('background');

  delete root.dataset.activeTheme;
}

function applyProjectTheme(settings) {
  // Stash settings so we can reapply when switching back from light mode
  window._currentProjectSettings = settings;

  // Clear previous overrides first
  clearThemeOverrides();

  if (!settings) return;

  // In light mode, don't apply dark theme inline styles (CSS handles it)
  if (document.documentElement.getAttribute('data-theme') === 'light') return;

  // If a theme_id is set, apply the full theme
  if (settings.theme_id) {
    const theme = getThemeById(settings.theme_id);
    if (theme) {
      applyThemeToRoot(theme);

      // Then apply any per-project color overrides on top
      const root = document.documentElement;
      if (settings.primary_color) {
        root.style.setProperty('--accent', settings.primary_color);
        const { r, g, b } = hexToRgb(settings.primary_color);
        root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.13)`);
        root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.32)`);
        root.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.07)`);
        root.style.setProperty('--accent-faint', `rgba(${r},${g},${b},0.03)`);
        root.style.setProperty('--accent-subtle', `rgba(${r},${g},${b},0.10)`);
        root.style.setProperty('--accent-medium', `rgba(${r},${g},${b},0.28)`);
        root.style.setProperty('--accent-strong', `rgba(${r},${g},${b},0.60)`);
        root.style.setProperty('--border-color', `rgba(${r},${g},${b},0.14)`);
      }
      if (settings.accent_color) root.style.setProperty('--cyan', settings.accent_color);
      if (settings.sidebar_color) {
        document.querySelector('.sidebar-nav')?.style.setProperty('background', settings.sidebar_color);
      }
      return;
    }
  }

  // Fallback: derive a full color scheme from project colors without a named theme
  const root = document.documentElement;
  if (settings.primary_color) {
    const { r, g, b } = hexToRgb(settings.primary_color);
    root.style.setProperty('--accent', settings.primary_color);
    root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.13)`);
    root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.32)`);
    root.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.07)`);
    root.style.setProperty('--accent-faint', `rgba(${r},${g},${b},0.03)`);
    root.style.setProperty('--accent-subtle', `rgba(${r},${g},${b},0.10)`);
    root.style.setProperty('--accent-medium', `rgba(${r},${g},${b},0.28)`);
    root.style.setProperty('--accent-strong', `rgba(${r},${g},${b},0.60)`);
    root.style.setProperty('--border-color', `rgba(${r},${g},${b},0.14)`);
    root.style.setProperty('--card-gradient', `linear-gradient(135deg, rgba(${r},${g},${b},0.04) 0%, transparent 60%)`);
    root.style.setProperty('--card-gradient-hover', `linear-gradient(135deg, rgba(${r},${g},${b},0.07) 0%, transparent 60%)`);
    root.style.setProperty('--shadow-hover', `0 0 0 1px rgba(${r},${g},${b},0.3), 0 4px 24px rgba(0,0,0,0.4), 0 0 32px rgba(${r},${g},${b},0.06)`);
    root.style.setProperty('--shadow-glow', `0 0 8px rgba(${r},${g},${b},0.13), 0 0 24px rgba(${r},${g},${b},0.05)`);
  }
  if (settings.accent_color) root.style.setProperty('--cyan', settings.accent_color);
  if (settings.sidebar_color) {
    const sidebar = document.querySelector('.sidebar-nav');
    if (sidebar) sidebar.style.background = settings.sidebar_color;
  }
}

function toggleProjectDropdown(forceState) {
  const selector = document.getElementById('project-selector');
  const dropdown = document.getElementById('project-dropdown');
  if (!selector || !dropdown) return;

  const isOpen = forceState !== undefined ? forceState : dropdown.hidden;
  dropdown.hidden = !isOpen;
  selector.classList.toggle('open', isOpen);
}

function initProjectSelector() {
  const btn = document.getElementById('project-selector-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProjectDropdown();
    });
  }

  // Close on outside click
  document.addEventListener('click', (e) => {
    const selector = document.getElementById('project-selector');
    if (selector && !selector.contains(e.target)) {
      toggleProjectDropdown(false);
    }
  });

  loadThemes().then(() => fetchProjects());
}

function getProjectQueryParam() {
  if (!currentProject.id) return '';
  return 'project_id=' + encodeURIComponent(currentProject.id);
}

var _refreshInFlight = false;
var _refreshPending = false;

async function refreshWithProjectFilter() {
  if (_refreshInFlight) {
    _refreshPending = true;
    return;
  }
  _refreshInFlight = true;
  try {
  // Clear all existing polling intervals before registering new ones.
  // Without this, every project switch accumulates an additional fetchLiveFeed
  // interval (and any others registered via addPollingInterval), causing
  // unbounded concurrent pollers.
  clearAllPollingIntervals();
  // Clear stale metric values on project switch
  _allMetricValues = {};
  if (typeof liveCostData !== 'undefined') liveCostData = null;
  ytChannelData = null;
  // Re-fetch integrations (which triggers card re-render)
  fetchProjectIntegrations();
  refreshIntegrations();
  // Re-fetch all project-scoped data
  initActivityFeed();
  // Await agents so AGENTS is up-to-date before page-specific inits read it
  await fetchAgentStatuses();
  if (typeof fetchLiveFeed === 'function') fetchLiveFeed();
  fetchDashboardSummary();
  fetchSOPs();
  fetchPaws();
  fetchYouTubeData();
  fetchAnalyticsMetrics();
  fetchSocialMetrics();
  // Update pipeline preview on dashboard
  renderPipelinePreview();
  const pipelineTitle = document.querySelector('[data-component="pipeline-preview"] .section-title');
  if (pipelineTitle) {
    pipelineTitle.textContent = (currentProject.id && currentProject.display_name !== 'All Projects')
      ? currentProject.display_name + ' -- Pipeline'
      : 'Task Pipeline';
  }
  // Re-fetch page-specific data for currently visible page
  const activePage = document.querySelector('section.page:not([hidden])');
  if (activePage) {
    const pageId = activePage.id;
    if (pageId === 'page-costs') initCostsPage();
    if (pageId === 'page-health') initHealthPage();
    if (pageId === 'page-pipeline') initPipelinePage();
    if (pageId === 'page-research') { initResearchPage(); renderResearchUpcoming(); }
    if (pageId === 'page-board') initBoardPage();
    if (pageId === 'page-comms') initCommsPage();
    if (pageId === 'page-logging') initLoggingPage();
    if (pageId === 'page-credentials') refreshCredentialsPage();
    if (pageId === 'page-agents') fetchAgentStatuses();
    if (pageId === 'page-action-plan') initActionPlanPage();
    if (pageId === 'page-performance') { fetchYouTubeData(); fetchAnalyticsMetrics(); fetchSocialMetrics(); }
    if (pageId === 'page-webhooks') fetchWebhooks();
    if (pageId === 'page-plugins') fetchPlugins();
    if (pageId === 'page-graph') { fetchGraphData(); }
    if (pageId === 'page-chat') {
      chatState.messages = [];
      chatState.pending = [];
      chatState.loaded = false;
      chatState.sending = false;
      if (chatState.sendingTimer) { clearTimeout(chatState.sendingTimer); chatState.sendingTimer = null; }
      chatState.sendStartTime = null;
      if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
      if (typeof loadChatMessages === 'function') loadChatMessages();
      else if (typeof initChatPage === 'function') initChatPage();
    }
  }
  refreshIntegrationsPage();
  } finally {
    _refreshInFlight = false;
    if (_refreshPending) {
      _refreshPending = false;
      refreshWithProjectFilter();
    }
  }
}

function bind(key, value, title) {
  // Use querySelectorAll because the same metric key may appear on multiple
  // cards (e.g. two projects sharing a metric_prefix, or the same value
  // shown in both a sidebar stat and a perf chart). Older code only updated
  // the first match which left the second card stuck on "--".
  const els = document.querySelectorAll(`[data-bind="${key}"]`);
  els.forEach((el) => {
    el.textContent = value;
    if (title !== undefined) {
      if (title) {
        el.title = title;
        el.classList.add('metric-unavailable');
      } else {
        el.removeAttribute('title');
        el.classList.remove('metric-unavailable');
      }
    }
  });
}

function setElementHTML(el, html) {
  // Safe wrapper: only used with internally-generated content
  if (el) el.innerHTML = html;
}

// --------------- THEME-AWARE COLOR HELPERS ---------------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeAccent()  { return cssVar('--accent') || '#00ff9f'; }
function themeCyan()    { return cssVar('--cyan') || '#00d4ff'; }
function themeMagenta() { return cssVar('--magenta') || '#ff00aa'; }
function themeGreen()   { return cssVar('--green') || '#00ff88'; }
function themeAmber()   { return cssVar('--amber') || '#ffaa00'; }
function themeRed()     { return cssVar('--red') || '#ff3355'; }
function themePurple()  { return cssVar('--purple') || '#a78bfa'; }

// --------------- SPARKLINE / CHART RENDERER ---------------

function drawSparkline(canvas, data, color) {
  if (!color) color = themeAccent();
  if (!canvas || !data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width = canvas.offsetWidth * dpr;
  const h = canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;
  ctx.clearRect(0, 0, dw, dh);

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = dw / (data.length - 1);

  const points = data.map((v, i) => ({
    x: i * step,
    y: dh - ((v - min) / range) * (dh - 4) - 2,
  }));

  const grad = ctx.createLinearGradient(0, 0, 0, dh);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '05');

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const cx = (points[i - 1].x + points[i].x) / 2;
    ctx.bezierCurveTo(cx, points[i - 1].y, cx, points[i].y, points[i].x, points[i].y);
  }
  ctx.lineTo(dw, dh);
  ctx.lineTo(0, dh);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const cx = (points[i - 1].x + points[i].x) / 2;
    ctx.bezierCurveTo(cx, points[i - 1].y, cx, points[i].y, points[i].x, points[i].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawNoData(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
  var isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
  ctx.fillStyle = isDarkTheme ? '#ffffff30' : '#00000030';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('No data available', canvas.offsetWidth / 2, canvas.offsetHeight / 2 + 4);
}

// --------------- METRIC DATA STORE ---------------

const metricData = {
  youtube: [],
  linkedin: [],
  twitter: [],
  website: [],
  website: [],
};

// --------------- WEBSOCKET CONNECTION ---------------

let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;

function updateWsStatus(status) {
  const dot = document.getElementById('ws-status-dot');
  const footerDot = document.getElementById('ws-footer-dot');
  const footerText = document.getElementById('ws-footer-text');

  if (dot) dot.dataset.status = status;
  if (footerDot) {
    footerDot.className = 'connection-indicator__dot ' + status;
  }
  if (footerText) {
    const labels = { connected: 'Connected', disconnected: 'Disconnected', reconnecting: 'Reconnecting...' };
    footerText.textContent = labels[status] || status;
  }

  // Toggle body class so Live / Disconnected header badges show correctly
  if (status === 'connected') {
    document.body.classList.add('ws-connected');
  } else {
    document.body.classList.remove('ws-connected');
  }
}

let _wsTicketRetries = 0;
const _wsTicketMaxRetries = 3;

async function fetchWsTicket() {
  try {
    const res = await fetch('/api/v1/auth/ws-ticket', { credentials: 'same-origin' });
    if (res.status === 401) { showAuthGate(); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    return data.ticket || null;
  } catch (e) {
    console.warn('Failed to fetch WS ticket:', e);
    return null;
  }
}

async function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  updateWsStatus('reconnecting');

  // Fetch a short-lived ticket -- abort entirely if we can't get one.
  // The 401 path already triggers showAuthGate() inside fetchWsTicket().
  // For any other failure (network error, 404, malformed response) we use
  // the normal exponential backoff rather than opening a doomed socket.
  const ticket = await fetchWsTicket();
  if (!ticket) {
    updateWsStatus('disconnected');
    scheduleReconnect();
    return;
  }

  try {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${window.location.host}`);
  } catch (e) {
    console.warn('WebSocket connection failed:', e);
    updateWsStatus('disconnected');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    updateWsStatus('connected');
    wsReconnectDelay = 1000;
    _wsTicketRetries = 0;
    ws.send(JSON.stringify({ type: 'register', userTicket: ticket }));
    console.log('%c WS %c Connected', 'background:#00ff9f;color:#0a0a0f;font-weight:bold;padding:2px 6px;', 'color:#00ff9f;');
    // Re-check update status after reconnect (bot may have just finished upgrading)
    setTimeout(checkForUpdates, 2000);
    // If a chat send was in-flight when the WS dropped, reload history to catch
    // any response that arrived via the REST fallback while disconnected.
    if (chatState.sending) {
      setTimeout(() => { if (typeof loadChatMessages === 'function') loadChatMessages(); }, 500);
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // feed_item is sent bot->server only; server re-broadcasts as feed_update to clients
      if (msg.type === 'feed_update' && msg.item) addFeedItem(msg.item);
      if (msg.type === 'agent_status') { const _asd = msg.data || msg; updateAgentStatusFromWs(_asd); updateCommsAgentStatus(_asd); }
      if (msg.type === 'new_message') { const nmData = msg.data ?? msg.message; handleChatWsMessage(nmData); handleCommsWsMessage(nmData); }
      if (msg.type === 'channel_log' && msg.data) { handleLoggingWsMessage(msg.data); }
      if (msg.type === 'chat_response') handleChatWsMessage(msg.data);
      if (msg.type === 'security-update') {
        if (!currentProject.id || !msg.project_id || msg.project_id === currentProject.id) SecurityPage.load();
      }
      if (msg.type === 'tasks-update') {
        if (!currentProject.id || !msg.project_id || msg.project_id === currentProject.id) fetchSOPs();
      }
      if (msg.type === 'paws-update') {
        if (!currentProject.id || !msg.project_id || msg.project_id === currentProject.id) fetchPaws();
      }
      if (msg.type === 'action_item_update') {
        if (!currentProject.id || !msg.project_id || msg.project_id === currentProject.id) {
          document.dispatchEvent(new CustomEvent('action-item-ws-update', { detail: msg }));
        }
      }
      if (msg.type === 'action_item_chat_agent_result') {
        const itemId = msg.item_id;
        const state = apState.chat[itemId];
        if (state && msg.message) {
          if (state.agentRunningTimer) { clearTimeout(state.agentRunningTimer); state.agentRunningTimer = null; }
          state.messages = state.messages.filter(m => m && m.id !== '_running');
          state.messages.push(msg.message);
          state.agentRunning = false;
          const drawer = document.getElementById('ap-drawer');
          if (drawer && !drawer.hidden && drawer.dataset.itemId === itemId) {
            apRenderChatPanel(itemId, drawer);
            const input = drawer.querySelector('.ap-chat-panel__input');
            const sendBtn = drawer.querySelector('.ap-chat-panel__send');
            if (input) { input.disabled = false; input.focus(); }
            if (sendBtn) sendBtn.disabled = false;
          }
        }
      }
      if (msg.type === 'research_chat_agent_result') {
        var itemId = msg.item_id;
        var state = rsDrawer.chat[itemId];
        if (state) {
          if (state.agentRunningTimer) { clearTimeout(state.agentRunningTimer); state.agentRunningTimer = null; }
          state.agentRunning = false;
          if (msg.message) state.messages.push(msg.message);
          if (rsDrawer.openItemId === itemId) {
            rsDrawer.renderChat(itemId);
            var input = document.querySelector('#rs-drawer [data-bind="rs-chat-input"]');
            var sendBtn = document.querySelector('#rs-drawer [data-bind="rs-chat-send"]');
            if (input) { input.disabled = false; input.focus(); }
            if (sendBtn) sendBtn.disabled = false;
          }
        }
      }

      if (msg.type === 'research_investigation_complete') {
        var invId = msg.item_id;
        if (rsDrawer.items[invId]) {
          rsDrawer.items[invId].notes = msg.notes;
          if (rsDrawer.openItemId === invId) rsDrawer.renderDetails(rsDrawer.items[invId]);
        }
        // Only touch the investigate button if it belongs to the item that finished investigating.
        // Otherwise a concurrent item's cooldown UI would get wrongly cleared.
        if (rsDrawer.openItemId === invId) {
          var invBtn = document.querySelector('#rs-drawer [data-action="investigate"]');
          if (invBtn) { invBtn.disabled = false; invBtn.textContent = 'Deeper investigation'; }
        }
      }

      if (msg.type === 'research_draft_ready') {
        var dId = msg.item_id || (msg.action_item && msg.action_item.research_item_id);
        if (dId && rsDrawer.openItemId === dId) {
          rsDrawer.loadDrafts(dId);
        }
      }

      if (msg.type === 'research_deleted') {
        if (rsDrawer.openItemId === msg.item_id) {
          alert('This research item was deleted.');
          rsDrawer.close();
        }
      }
      if (msg.type === 'test-update') TestRunner.handleWsUpdate(msg.data);
    } catch (e) {
      console.warn('WS message parse error:', e);
    }
  };

  ws.onclose = (event) => {
    updateWsStatus('disconnected');
    // 4401: ticket expired or invalid -- re-fetch ticket and reconnect with bounded retries
    if (event.code === 4401 && _wsTicketRetries < _wsTicketMaxRetries) {
      _wsTicketRetries++;
      console.warn('WS: ticket rejected (4401), retry', _wsTicketRetries);
      setTimeout(connectWebSocket, Math.min(500 * _wsTicketRetries, 3000));
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    updateWsStatus('disconnected');
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  var _delay = wsReconnectDelay;
  wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
  var jitter = Math.random() * 0.5 * _delay;
  wsReconnectTimer = setTimeout(connectWebSocket, _delay + jitter);
}

function addFeedItem(data) {
  if (currentProject.id && data.project_id && data.project_id !== currentProject.id) return;
  const container = document.querySelector('.sidebar-feed__list[data-bind="live-feed"]');
  if (!container) return;

  // Normalize: API sends agent_id/action/detail/created_at; older path sends agent/text/timestamp
  const agentKey = data.agent_id || data.agent || '';
  const agentObj = AGENTS[agentKey];
  const iconName = agentObj ? agentObj.icon : '';
  const name = agentObj ? agentObj.name : (agentKey || 'System');
  const ts = data.created_at || (data.timestamp ? new Date(data.timestamp).getTime() : Date.now());
  const rawText = data.action
    ? (data.detail ? data.action + ': ' + data.detail : data.action)
    : (data.text || '');
  const feedText = rawText.replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, '').trim();

  const el = document.createElement('div');
  el.className = 'feed-item';
  el.dataset.agent = agentKey;

  const timeEl = document.createElement('time');
  timeEl.textContent = timeAgo(ts);
  el.appendChild(timeEl);

  const agentEl = document.createElement('span');
  agentEl.className = 'feed-agent';
  if (iconName) {
    const iconEl = document.createElement('i');
    iconEl.setAttribute('data-lucide', iconName);
    iconEl.style.cssText = 'width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;';
    agentEl.appendChild(iconEl);
  }
  agentEl.appendChild(document.createTextNode(name));
  el.appendChild(agentEl);

  // Project badge (only in all-projects view)
  if (!currentProject.id && data.project_id) {
    const proj = allProjects.find(p => p.id === data.project_id);
    if (proj) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'feed-project-badge';
      badgeEl.textContent = (proj.icon || '\uD83D\uDCC1') + ' ' + proj.display_name;
      if (proj.primary_color) badgeEl.style.borderColor = proj.primary_color;
      el.appendChild(badgeEl);
    }
  }

  const textEl = document.createElement('div');
  textEl.className = 'feed-text';
  textEl.textContent = feedText;
  el.appendChild(textEl);

  container.prepend(el);
  container.scrollTop = 0;
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [el] });
}

function updateAgentStatusFromWs(data) {
  const id = data && (data.id || data.agentId);
  if (!id) return;
  const agent = AGENTS[id];
  if (!agent) return;
  if (data.status) agent.status = data.status;
  if (data.task !== undefined) agent.task = data.task;
  if (data.lastActive) agent.lastActive = new Date(data.lastActive).getTime();
  updateAgentCard(id);

}

function handleChatWsMessage(data) {
  // Bug 1 fix: filter responses from other projects
  if (data.project_id && currentProject.id && data.project_id !== currentProject.id) return;

  // Append real-time chat messages from WebSocket.
  // If the page hasn't finished loading history yet, queue the message so it
  // isn't dropped (common for long-running agents whose response arrives while
  // loadChatMessages() is still in-flight).
  if (!chatState.loaded) {
    chatState.pending.push(data);
    return;
  }

  // Bug 2 fix: merge into temp message instead of appending a duplicate
  const tempIdx = chatState.messages.findIndex(
    m => m.event_id && m.event_id.startsWith('temp-') && m.result_text === null
  );
  if (tempIdx !== -1) {
    chatState.messages[tempIdx] = { ...chatState.messages[tempIdx], ...data };
  } else {
    if (data.event_id && chatState.messages.find(m => m.event_id === data.event_id)) return;
    chatState.messages.push(data);
    if (chatState.messages.length > 200) {
      chatState.messages = chatState.messages.slice(-200);
    }
  }

  chatState.sending = false;
  chatState.sendStartTime = null;
  if (chatState.sendingTimer) { clearTimeout(chatState.sendingTimer); chatState.sendingTimer = null; }
  if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
  renderChatMessages();
}

// --------------- YOUTUBE DATA ---------------
// All YouTube data is fetched via the server-side proxy at /api/v1/metrics/youtube.
// The API key is never exposed to the browser.

let ytChannelData = null;
let ytVideosData = [];

async function fetchYouTubeData() {
  // Fetch channel stats + sparkline data from server proxy (API key stays server-side)
  try {
    const pq = getProjectQueryParam();
    const proxyData = await fetchFromAPI('/api/v1/metrics/youtube' + (pq ? '?' + pq : ''));
    if (proxyData) {
      // Channel stats from YouTube API (proxied)
      if (proxyData.channel) {
        ytChannelData = proxyData.channel;
      }

      // Recent videos list (proxied)
      if (Array.isArray(proxyData.videos)) {
        ytVideosData = proxyData.videos;
      }

      // Sparkline + integration card data from stored metrics. Each row may
      // be either a legacy unprefixed key (subscribers/views/videos) or a
      // prefixed key (e.g. fop-youtube-subscribers). We feed BOTH the legacy
      // headline numbers AND every per-integration prefix into _allMetricValues
      // so the dashboard can render every YouTube integration card, not just
      // the hardcoded @your_channel one.
      const metricsData = proxyData.metrics || (Array.isArray(proxyData) ? proxyData : []);
      if (metricsData && Array.isArray(metricsData)) {
        const history = {};
        const latest = {};
        for (const m of metricsData) {
          if (!history[m.key]) history[m.key] = [];
          history[m.key].push(m.value);
          if (!(m.key in latest)) {
            latest[m.key] = m.value;
            const meta = parseMetricMetadata(m.metadata);
            if (meta && meta.unavailable) {
              _metricUnavailable[m.key] = meta.reason || 'unavailable';
            } else {
              delete _metricUnavailable[m.key];
            }
          }
        }
        // Headline sparkline (legacy key first, fall back to first youtube integration prefix)
        if (history['subscribers'] && history['subscribers'].length >= 2) {
          metricData.youtube = history['subscribers'].slice().reverse();
        } else if (history['views'] && history['views'].length >= 2) {
          metricData.youtube = history['views'].slice().reverse();
        }

        // Fallback channel stats: if YouTube API didn't return live data
        // (cooldown, missing key) populate the headline cards from whatever
        // stored metrics exist - prefixed first, then legacy.
        if (!ytChannelData) {
          const ytIntegs = (_projectIntegrations || []).filter(i => i.platform === 'youtube');
          const firstPrefix = ytIntegs[0] ? (ytIntegs[0].metric_prefix || 'youtube') : 'youtube';
          const subs = latest[firstPrefix + '-subscribers'] ?? latest['subscribers'];
          const views = latest[firstPrefix + '-views'] ?? latest['views'];
          const vids = latest[firstPrefix + '-videos'] ?? latest['videos'];
          if (subs !== undefined || views !== undefined || vids !== undefined) {
            ytChannelData = {
              statistics: {
                subscriberCount: String(subs ?? 0),
                viewCount: String(views ?? 0),
                videoCount: String(vids ?? 0),
              }
            };
          }
        }

        // Feed every prefixed key into the shared metric value cache so
        // populateIntegrationCards() picks them up for any YouTube card.
        Object.assign(_allMetricValues, latest);

        // Per-integration sparkline using the prefixed subscriber series
        for (const integ of (_projectIntegrations || [])) {
          if (integ.platform !== 'youtube') continue;
          const pfx = integ.metric_prefix || 'youtube';
          const series = history[pfx + '-subscribers'] || history[pfx + '-views'];
          if (series && series.length > 0) {
            metricData[pfx] = series.length >= 2
              ? series.slice().reverse()
              : [series[0], series[0]];
          }
        }
      }
    }
  } catch (err) {
    console.warn('YouTube proxy fetch failed:', err);
  }

  renderYouTubeData();
  // Re-bind integration cards now that prefixed values are in cache
  if (typeof populateIntegrationCards === 'function') populateIntegrationCards();
}

function renderYouTubeData() {
  if (ytChannelData) {
    const stats = ytChannelData.statistics;
    const subs = parseInt(stats.subscriberCount || '0');
    const views = parseInt(stats.viewCount || '0');
    const videoCount = parseInt(stats.videoCount || '0');
    const avgViews = videoCount > 0 ? Math.round(views / videoCount) : 0;

    bind('yt-subscribers', subs.toLocaleString());
    bind('yt-views', views.toLocaleString());
    bind('yt-videos', videoCount.toLocaleString());
    bind('yt-card-subs', subs.toLocaleString());
    bind('yt-card-views', views.toLocaleString());
    bind('yt-card-count', videoCount.toLocaleString());
    bind('yt-perf-subs', subs.toLocaleString());
    bind('yt-perf-views', views.toLocaleString());
    bind('yt-perf-count', videoCount.toLocaleString());
    bind('yt-perf-avg', avgViews.toLocaleString());

    // Feed live YouTube channel stats into ALL YouTube integration cards.
    // (For projects with multiple YouTube channels we'd need per-channel
    // proxy fetches; today the proxy is single-channel so all youtube
    // integrations share the same headline numbers as a sane default.)
    for (const integ of _projectIntegrations) {
      if (integ.platform !== 'youtube') continue;
      const prefix = integ.metric_prefix || 'youtube';
      // Only overwrite if we don't already have prefixed stored metrics
      if (_allMetricValues[prefix + '-subscribers'] === undefined) {
        _allMetricValues[prefix + '-subscribers'] = subs;
      }
      if (_allMetricValues[prefix + '-views'] === undefined) {
        _allMetricValues[prefix + '-views'] = views;
      }
      if (_allMetricValues[prefix + '-videos'] === undefined) {
        _allMetricValues[prefix + '-videos'] = videoCount;
      }
    }
    populateIntegrationCards();
  }

  // Draw sparkline from server metrics data
  if (metricData.youtube && metricData.youtube.length >= 2) {
    const canvas = document.querySelector('canvas[data-sparkline="youtube"]');
    if (canvas) drawSparkline(canvas, metricData.youtube, '#ff0000');
    const chartCanvas = document.querySelector('canvas[data-chart="yt-views-chart"]');
    if (chartCanvas) drawSparkline(chartCanvas, metricData.youtube, '#ff0000');
  } else {
    const canvas = document.querySelector('canvas[data-sparkline="youtube"]');
    if (canvas) drawNoData(canvas);
  }

  renderYouTubeVideoTable();
  initAllCharts();
}

function renderYouTubeVideoTable() {
  const tbody = document.querySelector('[data-bind="yt-video-tbody"]');
  if (!tbody) return;
  if (ytVideosData.length === 0) {
    tbody.textContent = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.setAttribute('colspan', '6');
    td.style.cssText = 'text-align:center;color:var(--text-muted);padding:1.5rem';
    td.textContent = 'No video data available';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  tbody.textContent = '';
  ytVideosData.forEach(v => {
    const s = v.statistics;
    const pub = new Date(v.snippet.publishedAt);
    const dateStr = pub.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const thumb = v.snippet.thumbnails.medium?.url || v.snippet.thumbnails.default?.url || '';
    const title = v.snippet.title;
    const videoUrl = 'https://www.youtube.com/watch?v=' + v.id;
    const viewCount = parseInt(s.viewCount || '0');
    const likes = parseInt(s.likeCount || '0');
    const comments = parseInt(s.commentCount || '0');

    const tr = document.createElement('tr');

    const tdThumb = document.createElement('td');
    const img = document.createElement('img');
    img.className = 'yt-thumb';
    img.src = thumb;
    img.alt = '';
    img.loading = 'lazy';
    tdThumb.appendChild(img);
    tr.appendChild(tdThumb);

    const tdTitle = document.createElement('td');
    tdTitle.className = 'yt-title';
    const a = document.createElement('a');
    a.href = videoUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = title;
    tdTitle.appendChild(a);
    tr.appendChild(tdTitle);

    const tdDate = document.createElement('td');
    tdDate.className = 'yt-date';
    tdDate.textContent = dateStr;
    tr.appendChild(tdDate);

    const tdViews = document.createElement('td');
    tdViews.className = 'yt-views';
    tdViews.textContent = viewCount.toLocaleString();
    tr.appendChild(tdViews);

    const tdLikes = document.createElement('td');
    tdLikes.textContent = likes.toLocaleString();
    tr.appendChild(tdLikes);

    const tdComments = document.createElement('td');
    tdComments.textContent = comments.toLocaleString();
    tr.appendChild(tdComments);

    tbody.appendChild(tr);
  });
}

// --------------- API DATA FETCHING ---------------

async function fetchFromAPI(endpoint, opts) {
  try {
    const resp = await fetch(endpoint, opts || undefined);
    if (resp.status === 401) { showAuthGate(); return null; }
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.warn(`API fetch failed: ${endpoint}`, e);
    return null;
  }
}

// Helper for mutating fetch calls (POST/PATCH/DELETE) that need 401 detection
// Returns { ok, status, data } instead of throwing
async function apiFetch(endpoint, opts) {
  try {
    const resp = await fetch(endpoint, opts || undefined);
    if (resp.status === 401) { showAuthGate(); return { ok: false, status: 401, data: null }; }
    let data = null;
    try { data = await resp.json(); } catch (_) {}
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    console.warn(`apiFetch failed: ${endpoint}`, e);
    return { ok: false, status: 0, data: null };
  }
}

let _agentsFetchInProgress = false;

async function fetchAgentStatuses() {
  if (_agentsFetchInProgress) return;
  _agentsFetchInProgress = true;
  try {
    const pq = getProjectQueryParam();
    let data = await fetchFromAPI('/api/v1/agents' + (pq ? '?' + pq : ''));
    if (!data) return;

    let agents = Array.isArray(data) ? data : (data.agents || []);

    // Lazy-seed: if no agents for this project, seed them (only for specific projects, not All Projects)
    const pid = currentProject.id;
    if (agents.length === 0 && pid) {
      await fetchFromAPI('/api/v1/projects/' + encodeURIComponent(pid) + '/seed-agents', { method: 'POST' });
      data = await fetchFromAPI('/api/v1/agents' + (pq ? '?' + pq : ''));
      agents = Array.isArray(data) ? data : (data.agents || []);
    }

    // Rebuild AGENTS object from API data
    const newAgents = {};
    let activeCount = 0;
    for (const info of agents) {
      const id = info.id;
      const tid = info.template_id || id;
      newAgents[id] = {
        name: info.name || tid,
        icon: templateIcon(tid),
        role: info.role || '',
        mode: info.mode || 'on-demand',
        heartbeat: info.heartbeat_interval || 'none',
        status: info.status || 'idle',
        lastActive: info.last_active || 0,
        task: info.current_task || '--',
        template_id: tid,
      };
      if (info.status === 'active' || info.status === 'online') activeCount++;
    }
    AGENTS = newAgents;
    rebuildAgentIndex();

    bind('active-agents', activeCount.toString());
    const total = Object.keys(AGENTS).length;
    const idleCount = total - activeCount;
    bind('active-agents-delta', idleCount > 0 ? idleCount + ' idle/sleeping' : 'all agents active');

    // Rebuild all agent UI
    buildDashboardAgentCards();
    buildDetailAgentCards();
    buildAgentSelect();
    // Rebuild comms agent UI if on comms page
    if (typeof renderCommsAgentRow === 'function') renderCommsAgentRow();
    rebuildCommsAgentFilter();
  } finally {
    _agentsFetchInProgress = false;
  }
}

async function fetchLiveFeed() {
  const pq = getProjectQueryParam();
  const data = await fetchFromAPI('/api/v1/feed?limit=50' + (pq ? '&' + pq : ''));
  if (!data) return;

  const container = document.querySelector('.sidebar-feed__list[data-bind="live-feed"]');
  if (!container) return;

  const items = data.items || data;
  if (!Array.isArray(items) || items.length === 0) {
    container.textContent = '';
    const emptyEl = document.createElement('div');
    emptyEl.className = 'feed-item';
    emptyEl.style.cssText = 'color:var(--text-muted);font-size:12px;padding:12px 0;text-align:center;';
    emptyEl.textContent = 'No activity yet';
    container.appendChild(emptyEl);
    return;
  }

  container.textContent = '';
  const sorted = feedNewestFirst ? items : items.slice().reverse();
  sorted.forEach(item => {
    const el = document.createElement('div');
    el.className = 'feed-item';
    // API returns agent_id/action/detail/created_at — normalize
    const agentKey = item.agent_id || item.agent || '';
    el.dataset.agent = agentKey;
    const agentObj = AGENTS[agentKey];
    const iconName = agentObj ? agentObj.icon : '';
    const name = agentObj ? agentObj.name : (agentKey || 'System');
    const ts = item.created_at || (item.timestamp ? new Date(item.timestamp).getTime() : Date.now());
    const feedText = item.action ? (item.detail ? item.action + ': ' + item.detail : item.action) : (item.text || '');
    const rawText = feedText.replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, '').trim();

    const timeEl = document.createElement('time');
    timeEl.textContent = timeAgo(ts);
    el.appendChild(timeEl);

    const agentSpan = document.createElement('span');
    agentSpan.className = 'feed-agent';
    if (iconName) {
      const iconEl = document.createElement('i');
      iconEl.setAttribute('data-lucide', iconName);
      iconEl.style.cssText = 'width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;';
      agentSpan.appendChild(iconEl);
    }
    agentSpan.appendChild(document.createTextNode(name));
    el.appendChild(agentSpan);

    const textDiv = document.createElement('div');
    textDiv.className = 'feed-text';
    textDiv.textContent = rawText;
    el.appendChild(textDiv);

    container.appendChild(el);
  });

  container.scrollTop = 0;
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: Array.from(container.querySelectorAll('[data-lucide]')) });
}

function setBriefingBanner(text, ts, agentLabel) {
  const briefingBody = document.querySelector('[data-bind="briefing-body"]');
  if (!briefingBody) return;
  const clean = (text || '').replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, '').trim();
  // Wrap in inner div for layout containment; reset scroll position each update
  while (briefingBody.firstChild) briefingBody.removeChild(briefingBody.firstChild);
  briefingBody.scrollTop = 0;
  const inner = document.createElement('div');
  inner.className = 'briefing-scroll-inner';
  inner.textContent = clean || 'Loading...';
  briefingBody.appendChild(inner);
  if (ts) {
    const d = new Date(ts);
    const timeEl = document.querySelector('.briefing-banner__time');
    if (timeEl) {
      const h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      timeEl.textContent = `${h % 12 || 12}:${m} ${ampm} ET`;
    }
  }
  const agentEl = document.querySelector('.briefing-banner__agent');
  if (agentEl && agentLabel) agentEl.textContent = agentLabel;
}

async function fetchDashboardSummary() {
  const pq = getProjectQueryParam();
  // Clear immediately so stale content from a previous project never lingers
  // while the new project's briefing is in-flight.
  setBriefingBanner('', null, null);
  const data = await fetchFromAPI('/api/v1/dashboard' + (pq ? '?' + pq : ''));
  if (!data) return;
  const active = data.stats?.active_agents ?? data.activeAgents ?? 0;
  bind('active-agents', active.toString());
  const total = data.stats?.total_agents ?? data.totalAgents;
  if (total !== undefined) {
    bind('active-agents-delta', 'of ' + total + ' total');
  } else {
    bind('active-agents-delta', '');
  }
  // Fetch briefing independently (not coupled to feed polling)
  // Server returns { summary, updated_at, sources[] } -- map into the
  // banner's (text, ts, agentLabel) contract. Do NOT rename back to
  // bData.text/generated_at/agent; that mismatch was the "Loading briefing..."
  // regression (regression fix 2026-04-17 from commit 7146deb).
  fetchFromAPI('/api/v1/briefing' + (pq ? '?' + pq : '')).then(function(bData) {
    if (bData && bData.summary) {
      var agentLabel = Array.isArray(bData.sources) && bData.sources.length > 0
        ? bData.sources[0]
        : null;
      setBriefingBanner(bData.summary, bData.updated_at, agentLabel);
    } else {
      // Project has no scheduled task results or board meetings yet -- show a
      // neutral placeholder instead of leaving stale content from another project.
      setBriefingBanner('No recent activity for this project.', null, null);
    }
  }).catch(function() { /* briefing is optional */ });
}

async function fetchProjectOverview() {
  if (currentProject.id) return;
  try {
    const data = await fetchFromAPI('/api/v1/dashboard/overview');
    renderProjectHealthGrid(data);
  } catch (e) {
    console.warn('Failed to fetch project overview:', e);
  }
}

function renderProjectHealthGrid(data) {
  if (!data || !data.totals) return;
  const grid = document.getElementById('project-health-grid');
  if (!grid) return;

  // Only show project overview on "All Projects" view AND on the dashboard page
  const onDashboard = document.getElementById('page-dashboard') && !document.getElementById('page-dashboard').hidden;
  if (currentProject.id || !onDashboard) {
    grid.hidden = true;
    return;
  }

  grid.hidden = false;
  const projects = data.projects || [];

  if (projects.length === 0) {
    setElementHTML(grid, '<div class="project-health-grid__title">No projects configured</div>');
    return;
  }

  // Summary row across all projects
  const totalAgents = projects.reduce((s, p) => s + (p.agent_count || 0), 0);
  const totalActivity = projects.reduce((s, p) => s + (p.recent_activity_24h || 0), 0);
  let html = '<div class="project-health-grid__title">Project Overview</div>'
    + '<div class="project-health-summary" style="display:flex;gap:1.5rem;padding:0 0 0.75rem;margin-bottom:0.5rem;border-bottom:1px solid var(--border);flex-wrap:wrap">'
    + '<span style="color:var(--text-muted);font-size:0.8rem"><strong style="color:var(--text-primary)">' + projects.length + '</strong> projects</span>'
    + '<span style="color:var(--text-muted);font-size:0.8rem"><strong style="color:var(--text-primary)">' + totalAgents + '</strong> agents</span>'
    + '<span style="color:var(--text-muted);font-size:0.8rem"><strong style="color:var(--text-primary)">' + data.totals.active_tasks + '</strong> active tasks</span>'
    + '<span style="color:var(--text-muted);font-size:0.8rem"><strong style="color:var(--text-primary)">' + totalActivity + '</strong> events (24h)</span>'
    + (data.totals.open_findings > 0 ? '<span style="color:var(--text-muted);font-size:0.8rem"><strong style="color:var(--warning,#f59e0b)">' + data.totals.open_findings + '</strong> open findings</span>' : '')
    + '</div>';

  for (const p of projects) {
    // render all projects including default (personal assistant)
    const borderColor = p.primary_color || 'var(--accent)';
    const activityBadge = (p.recent_activity_24h || 0) > 0
      ? '<span style="background:var(--accent);color:var(--bg-primary);font-size:0.65rem;padding:2px 6px;border-radius:9px;font-weight:600">' + p.recent_activity_24h + ' today</span>'
      : '<span style="color:var(--text-muted);font-size:0.7rem">quiet</span>';
    html += '<div class="project-health-card" data-project-id="' + p.id + '" style="border-left-color: ' + borderColor + '">'
      + '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">'
      + '<i class="project-health-card__icon" data-lucide="' + escapeHtml(p.icon || 'folder') + '"></i>'
      + '<span class="project-health-card__name">' + escapeHtml(p.display_name) + '</span>'
      + activityBadge
      + '</div>'
      + '<div class="project-health-card__stats">'
      + '<span class="project-health-card__stat"><strong>' + (p.agent_count || 0) + '</strong> agents</span>'
      + '<span class="project-health-card__stat"><strong>' + p.active_tasks + '</strong> tasks</span>'
      + (p.open_findings > 0 ? '<span class="project-health-card__stat" style="color:var(--warning,#f59e0b)"><strong>' + p.open_findings + '</strong> findings</span>' : '')
      + (p.research_items > 0 ? '<span class="project-health-card__stat"><strong>' + p.research_items + '</strong> research</span>' : '')
      + '</div>'
      + '<span class="project-health-card__time">' + timeAgo(p.last_feed_at) + '</span>'
      + '</div>';
  }

  setElementHTML(grid, html);
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: Array.from(grid.querySelectorAll('[data-lucide]')) });

  grid.querySelectorAll('.project-health-card').forEach(card => {
    card.addEventListener('click', () => {
      const pid = card.dataset.projectId;
      const proj = allProjects.find(p => p.id === pid);
      if (proj) selectProject(proj);
    });
  });
}

// Populate pipeline preview on dashboard from scheduled tasks
async function renderPipelinePreview() {
  const container = document.getElementById('pipeline-preview-container');
  if (!container) return;

  try {
    const pq = getProjectQueryParam();
    const tasks = await fetchFromAPI('/api/v1/tasks' + (pq ? '?' + pq : ''));
    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      container.textContent = '';
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:2rem;color:var(--text-muted)';
      empty.textContent = 'No scheduled tasks yet';
      container.appendChild(empty);
      return;
    }

    const now = Date.now();
    const active = tasks.filter(t => t.status === 'active');
    const paused = tasks.filter(t => t.status === 'paused');
    const overdue = active.filter(t => t.next_run && t.next_run < now);
    const upcoming = active.filter(t => t.next_run && t.next_run >= now).sort((a, b) => a.next_run - b.next_run);

    container.textContent = '';

    // Summary grid
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;';

    function makeKPI(value, label, color, borderColor) {
      const card = document.createElement('div');
      card.style.cssText = 'padding:16px;background:var(--surface-elevated);border-radius:8px;border:1px solid ' + (borderColor || 'var(--border-subtle)') + ';';
      const valEl = document.createElement('div');
      valEl.style.cssText = 'font-size:24px;font-weight:700;color:' + color + ';';
      valEl.textContent = value;
      const lblEl = document.createElement('div');
      lblEl.style.cssText = 'font-size:12px;color:var(--text-muted);';
      lblEl.textContent = label;
      card.appendChild(valEl);
      card.appendChild(lblEl);
      return card;
    }

    grid.appendChild(makeKPI(active.length, 'Active Tasks', 'var(--accent)'));
    if (overdue.length > 0) grid.appendChild(makeKPI(overdue.length, 'Overdue', 'var(--danger, #ff3355)', 'var(--danger, #ff3355)'));
    if (paused.length > 0) grid.appendChild(makeKPI(paused.length, 'Paused', 'var(--amber, #ffaa00)', 'var(--amber, #ffaa00)'));

    // Next up card
    if (upcoming.length > 0) {
      const next = upcoming[0];
      const diffMs = next.next_run - now;
      const diffH = Math.floor(diffMs / 3600000);
      const diffM = Math.floor((diffMs % 3600000) / 60000);
      const countdown = diffH > 0 ? diffH + 'h ' + diffM + 'm' : diffM + 'm';
      const card = document.createElement('div');
      card.style.cssText = 'padding:16px;background:var(--surface-elevated);border-radius:8px;border:1px solid var(--border-subtle);';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:4px;';
      lbl.textContent = 'Next Run';
      const name = document.createElement('div');
      name.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      name.textContent = next.id;
      const time = document.createElement('div');
      time.style.cssText = 'font-size:12px;color:var(--accent);margin-top:2px;';
      time.textContent = 'in ' + countdown;
      card.appendChild(lbl);
      card.appendChild(name);
      card.appendChild(time);
      grid.appendChild(card);
    }

    container.appendChild(grid);

    // Upcoming task list (next 5 after the first)
    if (upcoming.length > 1) {
      const list = document.createElement('div');
      list.style.cssText = 'margin-top:12px;';
      for (let i = 1; i < Math.min(upcoming.length, 6); i++) {
        const t = upcoming[i];
        const nd = new Date(t.next_run);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-size:12px;';
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'color:var(--text-primary);font-weight:500;';
        nameSpan.textContent = t.id;
        const timeSpan = document.createElement('span');
        timeSpan.style.cssText = 'color:var(--text-muted);';
        timeSpan.textContent = nd.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        row.appendChild(nameSpan);
        row.appendChild(timeSpan);
        list.appendChild(row);
      }
      container.appendChild(list);
    }
  } catch (e) {
    container.textContent = '';
    const err = document.createElement('div');
    err.style.cssText = 'text-align:center;padding:2rem;color:var(--text-muted)';
    err.textContent = 'Failed to load tasks';
    container.appendChild(err);
  }
}

async function fetchAnalyticsMetrics() {
  const pq = getProjectQueryParam();
  const data = await fetchFromAPI('/api/v1/metrics/analytics' + (pq ? '?' + pq : ''));
  if (!data || !Array.isArray(data)) return;

  // Group metrics by key (latest value = first in array since DB returns newest first)
  const latest = {};
  const history = {};
  for (const m of data) {
    if (!(m.key in latest)) {
      latest[m.key] = m.value;
      // Capture per-key metadata so cards can render "n/a" with tooltip
      const meta = parseMetricMetadata(m.metadata);
      if (meta && meta.unavailable) {
        _metricUnavailable[m.key] = meta.reason || 'unavailable';
      } else {
        delete _metricUnavailable[m.key];
      }
    }
    if (!history[m.key]) history[m.key] = [];
    history[m.key].push(m.value);
  }

  // Store in shared metric values for integration card binding
  Object.assign(_allMetricValues, latest);

  // Sparkline data from session history
  for (const integ of _projectIntegrations) {
    if (integ.platform !== 'website') continue;
    const prefix = integ.metric_prefix || integ.platform;
    const sessKey = prefix + '-sessions';
    if (history[sessKey]?.length >= 2) {
      metricData[prefix] = history[sessKey].slice().reverse();
    } else if (history[sessKey]?.length === 1) {
      metricData[prefix] = [history[sessKey][0], history[sessKey][0]];
    }
  }

  populateIntegrationCards();
  refreshPerfCharts();
  initAllCharts();
}

async function fetchSocialMetrics() {
  const pq = getProjectQueryParam();
  const data = await fetchFromAPI('/api/v1/metrics/social' + (pq ? '?' + pq : ''));
  if (!data || !Array.isArray(data)) return;

  const latest = {};
  const history = {};
  for (const m of data) {
    if (!(m.key in latest)) {
      latest[m.key] = m.value;
      const meta = parseMetricMetadata(m.metadata);
      if (meta && meta.unavailable) {
        _metricUnavailable[m.key] = meta.reason || 'unavailable';
      } else {
        delete _metricUnavailable[m.key];
      }
    }
    if (!history[m.key]) history[m.key] = [];
    history[m.key].push(m.value);
  }

  // Store in shared metric values for integration card binding
  Object.assign(_allMetricValues, latest);

  // Build sparkline data for social integrations
  for (const integ of _projectIntegrations) {
    const prefix = integ.metric_prefix || integ.platform;
    const suffixes = platformMetricKeySuffixes(integ.platform);
    // Use first metric suffix for sparkline (typically followers/subscribers)
    const sparkKey = prefix + '-' + suffixes[0];
    if (history[sparkKey]?.length > 0) {
      metricData[prefix] = history[sparkKey].length >= 2
        ? history[sparkKey].slice().reverse()
        : [history[sparkKey][0], history[sparkKey][0]];
    }
  }

  populateIntegrationCards();
  refreshPerfCharts();
  initAllCharts();
}

// ============================================================
// New Integrations Page (catalog + installed + install modal)
// ============================================================

let _intCatalog = []
let _intInstalled = []
let _intActiveCategory = 'all'
let _intSearch = ''

async function fetchIntCatalog() {
  try {
    const data = await fetchFromAPI('/api/v1/integrations/catalog')
    _intCatalog = (data && Array.isArray(data.integrations)) ? data.integrations : []
  } catch (e) {
    console.warn('Failed to fetch catalog:', e)
    _intCatalog = []
  }
}

async function fetchIntInstalled() {
  const projectId = currentProject.id
  if (!projectId) { _intInstalled = []; return }
  try {
    const data = await fetchFromAPI('/api/v1/integrations/installed?project_id=' + encodeURIComponent(projectId))
    _intInstalled = (data && Array.isArray(data.installed)) ? data.installed : []
  } catch (e) {
    console.warn('Failed to fetch installed integrations:', e)
    _intInstalled = []
  }
}

async function refreshIntegrationsPage() {
  await fetchIntCatalog()
  await fetchIntInstalled()
  renderIntConnected()
  renderIntBrowse()
}

function initIntegrationsTabs() {
  const buttons = document.querySelectorAll('.int-tab')
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-int-tab')
      buttons.forEach(b => b.classList.toggle('int-tab--active', b === btn))
      document.getElementById('int-tab-connected').hidden = tab !== 'connected'
      document.getElementById('int-tab-browse').hidden = tab !== 'browse'
      document.getElementById('int-tab-setup-help').hidden = tab !== 'setup-help'
    })
  })
}

function renderIntConnected() {
  const container = document.getElementById('int-connected-grid')
  if (!container) return
  while (container.firstChild) container.removeChild(container.firstChild)

  if (_intInstalled.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'int-empty'
    empty.textContent = 'No integrations connected yet. Browse the catalog to add one.'
    container.appendChild(empty)
    return
  }

  for (const row of _intInstalled) {
    const m = row.manifest
    const card = document.createElement('div')
    card.className = 'integration-card'

    const header = document.createElement('div')
    header.className = 'int-card-header'
    const icon = document.createElement('i')
    icon.setAttribute('data-lucide', m ? m.icon : 'plug')
    header.appendChild(icon)
    const name = document.createElement('span')
    name.textContent = m ? m.name : row.integration_id
    header.appendChild(name)
    const dot = document.createElement('span')
    dot.className = 'int-status-dot ' + row.status
    header.appendChild(dot)
    card.appendChild(header)

    if (row.account) {
      const acct = document.createElement('div')
      acct.style.cssText = 'font-size:12px;color:var(--text-muted)'
      acct.textContent = row.account
      card.appendChild(acct)
    }

    if (row.last_verified_at) {
      const when = document.createElement('div')
      when.style.cssText = 'font-size:11px;color:var(--text-muted)'
      const ago = Math.round((Date.now() - row.last_verified_at) / 1000)
      when.textContent = 'verified ' + (ago < 60 ? ago + 's ago' : Math.round(ago / 60) + 'm ago')
      card.appendChild(when)
    }

    if (row.last_error) {
      const err = document.createElement('details')
      err.style.cssText = 'font-size:11px;color:#ef4444'
      const summary = document.createElement('summary')
      summary.textContent = 'Show error'
      err.appendChild(summary)
      const pre = document.createElement('pre')
      pre.style.cssText = 'white-space:pre-wrap;font-size:11px'
      pre.textContent = row.last_error
      err.appendChild(pre)
      card.appendChild(err)
    }

    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px'

    const testBtn = document.createElement('button')
    testBtn.className = 'btn-secondary'
    testBtn.style.cssText = 'font-size:11px;padding:4px 8px'
    testBtn.textContent = 'Test'
    testBtn.addEventListener('click', () => intVerify(row.integration_id, testBtn))
    btnRow.appendChild(testBtn)

    if (m && m.kind === 'oauth' && m.oauth && m.oauth.provider) {
      const reBtn = document.createElement('button')
      reBtn.className = 'btn-secondary'
      reBtn.style.cssText = 'font-size:11px;padding:4px 8px'
      reBtn.textContent = 'Reconnect'
      reBtn.addEventListener('click', () => {
        const returnUrl = window.location.href
        window.location.href = '/api/v1/integrations/' + encodeURIComponent(m.oauth.provider) + '/auth?project_id=' + encodeURIComponent(currentProject.id) + '&return_url=' + encodeURIComponent(returnUrl)
      })
      btnRow.appendChild(reBtn)
    }

    const disBtn = document.createElement('button')
    disBtn.className = 'btn-secondary'
    disBtn.style.cssText = 'font-size:11px;padding:4px 8px'
    disBtn.textContent = 'Disconnect'
    disBtn.addEventListener('click', () => intUninstall(row.integration_id))
    btnRow.appendChild(disBtn)
    card.appendChild(btnRow)

    container.appendChild(card)
  }
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: Array.from(container.querySelectorAll('[data-lucide]')) })
}

function renderIntBrowse() {
  const list = document.getElementById('int-category-list')
  const grid = document.getElementById('int-browse-grid')
  if (!list || !grid) return

  const cats = ['all', ...Array.from(new Set(_intCatalog.map(m => m.category)))]
  while (list.firstChild) list.removeChild(list.firstChild)
  for (const c of cats) {
    const li = document.createElement('li')
    li.textContent = c === 'all' ? 'All' : c
    if (c === _intActiveCategory) li.classList.add('active')
    li.addEventListener('click', () => { _intActiveCategory = c; renderIntBrowse() })
    list.appendChild(li)
  }

  while (grid.firstChild) grid.removeChild(grid.firstChild)
  const filtered = _intCatalog.filter(m => {
    if (_intActiveCategory !== 'all' && m.category !== _intActiveCategory) return false
    if (_intSearch && !m.name.toLowerCase().includes(_intSearch.toLowerCase())) return false
    return true
  })
  for (const m of filtered) {
    const installed = _intInstalled.find(r => r.integration_id === m.id)
    const card = document.createElement('div')
    card.className = 'integration-card'

    const header = document.createElement('div')
    header.className = 'int-card-header'
    const icon = document.createElement('i')
    icon.setAttribute('data-lucide', m.icon)
    header.appendChild(icon)
    const name = document.createElement('span')
    name.textContent = m.name
    header.appendChild(name)
    const kind = document.createElement('span')
    kind.className = 'int-kind-badge'
    kind.textContent = m.kind === 'mcp_server' ? 'MCP' : (m.kind === 'api_key' ? 'API Key' : 'OAuth')
    header.appendChild(kind)
    card.appendChild(header)

    const desc = document.createElement('div')
    desc.style.cssText = 'font-size:12px;color:var(--text-muted)'
    desc.textContent = m.description
    card.appendChild(desc)

    const btn = document.createElement('button')
    btn.className = installed ? 'btn-secondary' : 'btn-primary'
    btn.style.cssText = 'font-size:12px;padding:5px 10px;margin-top:6px'
    btn.textContent = installed ? 'Installed' : 'Connect'
    btn.addEventListener('click', () => {
      if (installed) {
        const tabBtn = document.querySelector('.int-tab[data-int-tab="connected"]')
        if (tabBtn) tabBtn.click()
      } else {
        openInstallModal(m)
      }
    })
    card.appendChild(btn)

    grid.appendChild(card)
  }
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: Array.from(grid.querySelectorAll('[data-lucide]')) })

  const searchEl = document.getElementById('int-search')
  if (searchEl && !searchEl.dataset.wired) {
    searchEl.dataset.wired = '1'
    searchEl.addEventListener('input', (e) => { _intSearch = e.target.value; renderIntBrowse() })
  }
}

async function intVerify(id, btn) {
  const projectId = currentProject.id
  if (!projectId) return
  const origText = btn ? btn.textContent : ''
  if (btn) { btn.textContent = 'Testing...'; btn.disabled = true }
  try {
    const res = await fetchFromAPI('/api/v1/integrations/verify/' + encodeURIComponent(id) + '?project_id=' + encodeURIComponent(projectId), { method: 'POST' })
    if (btn) {
      const ok = res && res.status === 'connected'
      btn.textContent = ok ? 'Passed' : 'Failed'
      btn.style.color = ok ? '#22c55e' : '#ef4444'
    }
  } catch (e) {
    console.warn('verify failed', e)
    if (btn) { btn.textContent = 'Error'; btn.style.color = '#ef4444' }
  }
  await fetchIntInstalled()
  renderIntConnected()
}

async function intUninstall(id) {
  const projectId = currentProject.id
  if (!projectId) return
  if (!confirm('Disconnect this integration? Credentials will be archived for 30 days.')) return
  try {
    await fetchFromAPI('/api/v1/integrations/installed/' + encodeURIComponent(id) + '?project_id=' + encodeURIComponent(projectId), { method: 'DELETE' })
  } catch (e) { console.warn('uninstall failed', e) }
  await fetchIntInstalled()
  renderIntConnected()
  renderIntBrowse()
}

function openInstallModal(manifest) {
  const overlay = document.getElementById('int-modal')
  const body = document.getElementById('int-modal-body')
  const title = document.getElementById('int-modal-title')
  if (!overlay || !body || !title) return

  title.textContent = 'Install ' + manifest.name
  while (body.firstChild) body.removeChild(body.firstChild)

  if (manifest.setup.instructions) {
    const inst = document.createElement('p')
    inst.style.cssText = 'font-size:13px;color:var(--text-muted);margin:0 0 14px'
    inst.textContent = manifest.setup.instructions
    body.appendChild(inst)
  }

  if (manifest.kind === 'mcp_server' && manifest.mcp) {
    const mcpBox = document.createElement('div')
    mcpBox.style.cssText = 'background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:6px;padding:8px;margin-bottom:14px;font-family:monospace;font-size:11px;word-break:break-all'
    mcpBox.textContent = 'Runs: ' + manifest.mcp.command + ' ' + manifest.mcp.args.join(' ')
    body.appendChild(mcpBox)
  }

  if (manifest.kind === 'oauth') {
    const btn = document.createElement('button')
    btn.className = 'btn-primary'
    btn.textContent = 'Connect with ' + manifest.name
    btn.addEventListener('click', () => {
      const projectId = currentProject.id
      const returnUrl = window.location.origin + window.location.pathname + '#integrations'
      window.location.href = '/api/v1/integrations/' + encodeURIComponent(manifest.oauth.provider) + '/auth?project_id=' + encodeURIComponent(projectId) + '&return_url=' + encodeURIComponent(returnUrl)
    })
    body.appendChild(btn)
    overlay.style.display = 'block'
    return
  }

  const form = document.createElement('form')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const creds = {}
    for (const f of manifest.setup.credentials_required) {
      const input = form.querySelector('[name="' + f.key + '"]')
      creds[f.key] = input ? input.value : ''
    }
    while (body.firstChild) body.removeChild(body.firstChild)
    const verifying = document.createElement('div')
    verifying.style.cssText = 'text-align:center;padding:20px'
    verifying.textContent = 'Verifying...'
    body.appendChild(verifying)
    try {
      const res = await fetchFromAPI('/api/v1/integrations/install/' + encodeURIComponent(manifest.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, credentials: creds }),
      })
      while (body.firstChild) body.removeChild(body.firstChild)
      if (res.status === 'connected') {
        const ok = document.createElement('div')
        ok.style.cssText = 'color:#22c55e;text-align:center;padding:20px'
        ok.textContent = 'Connected' + (res.account ? ' as ' + res.account : '')
        body.appendChild(ok)
        setTimeout(() => { closeInstallModal(); refreshIntegrationsPage() }, 1200)
      } else {
        const err = document.createElement('div')
        err.style.cssText = 'color:#ef4444;padding:16px;white-space:pre-wrap;font-size:12px'
        err.textContent = 'Failed: ' + (res.error || 'unknown error')
        body.appendChild(err)
        const back = document.createElement('button')
        back.className = 'btn-secondary'
        back.style.cssText = 'margin-top:10px'
        back.textContent = 'Back'
        back.addEventListener('click', () => openInstallModal(manifest))
        body.appendChild(back)
      }
    } catch (e) {
      while (body.firstChild) body.removeChild(body.firstChild)
      const netErr = document.createElement('div')
      netErr.style.cssText = 'color:#ef4444;padding:16px'
      netErr.textContent = 'Network error: ' + (e.message || e)
      body.appendChild(netErr)
    }
  })

  for (const f of manifest.setup.credentials_required) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'margin-bottom:12px'
    const label = document.createElement('label')
    label.style.cssText = 'display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px'
    label.textContent = f.label
    if (f.help_url) {
      const help = document.createElement('a')
      help.href = f.help_url
      help.target = '_blank'
      help.rel = 'noopener'
      help.textContent = ' (get one)'
      help.style.cssText = 'font-size:11px;margin-left:6px'
      label.appendChild(help)
    }
    wrap.appendChild(label)
    const input = document.createElement('input')
    input.name = f.key
    input.type = f.input_type === 'password' ? 'password' : 'text'
    input.className = 'input-field'
    input.required = true
    input.style.cssText = 'width:100%'
    wrap.appendChild(input)
    form.appendChild(wrap)
  }
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'btn-primary'
  submit.textContent = 'Install'
  form.appendChild(submit)
  body.appendChild(form)

  overlay.style.display = 'block'
}

function closeInstallModal() {
  const overlay = document.getElementById('int-modal')
  if (overlay) overlay.style.display = 'none'
}

// --------------- DYNAMIC SOCIAL CARDS ---------------

let _projectIntegrations = [];

async function fetchProjectIntegrations() {
  if (currentProject.id) {
    // Single project -- fetch that project's integrations
    try {
      _projectIntegrations = await fetchFromAPI('/api/v1/projects/' + encodeURIComponent(currentProject.id) + '/integrations');
      if (!Array.isArray(_projectIntegrations)) _projectIntegrations = [];
    } catch (e) {
      console.warn('Failed to fetch integrations:', e);
      _projectIntegrations = [];
    }
  } else {
    // All Projects -- aggregate integrations from all projects (parallel)
    const results = await Promise.all(allProjects.map(p =>
      fetchFromAPI('/api/v1/projects/' + encodeURIComponent(p.id) + '/integrations')
        .then(items => {
          if (Array.isArray(items)) items.forEach(i => { i._projectName = p.display_name || p.name; i._projectIcon = p.icon; });
          return items || [];
        })
        .catch(() => [])
    ));
    _projectIntegrations = results.flat();
  }
  renderSocialCards();
  renderDashboardStats();
  renderPerfCards();
  // Pull health badges in parallel - non-blocking
  fetchMetricHealth();
}

function platformIcon(platform) {
  const map = {
    'youtube': 'youtube',
    'linkedin': 'linkedin',
    'x-twitter': 'twitter',
    'meta': 'facebook',
    'instagram': 'instagram',
    'website': 'globe',
    'shopify': 'shopping-bag',
    'tiktok': 'music',
    'github': 'github',
  };
  return map[platform] || 'link';
}

function platformMetricLabels(platform) {
  const map = {
    'youtube': ['Subscribers', 'Total Views', 'Videos'],
    'linkedin': ['Followers', 'Post Impressions', 'Engagement'],
    'x-twitter': ['Followers', 'Tweets', 'Following'],
    'meta': ['Page Likes', 'Reach', 'Engagement'],
    'instagram': ['Followers', 'Reach', 'Engagement'],
    'website': ['Sessions', 'Users', 'Bounce Rate'],
    'shopify': ['Orders', 'Revenue', 'Visitors'],
    'tiktok': ['Followers', 'Views', 'Likes'],
    'github': ['Stars', 'Forks', 'Issues'],
  };
  return map[platform] || ['Metric 1', 'Metric 2', 'Metric 3'];
}

// Maps platform type to DB metric key suffixes (order matches platformMetricLabels)
function platformMetricKeySuffixes(platform) {
  const map = {
    'youtube': ['subscribers', 'views', 'videos'],
    'x-twitter': ['followers', 'tweets', 'following'],
    'linkedin': ['followers', 'impressions', 'engagement'],
    'website': ['sessions', 'users', 'bounce'],
    'github': ['stars', 'forks', 'issues'],
    'meta': ['likes', 'reach', 'engagement'],
    'instagram': ['followers', 'reach', 'engagement'],
    'shopify': ['orders', 'revenue', 'visitors'],
    'tiktok': ['followers', 'views', 'likes'],
  };
  return map[platform] || ['m1', 'm2', 'm3'];
}

// Cached metric values for populating integration cards
let _allMetricValues = {};
// Per-key unavailability reasons (renders as "n/a" with hover tooltip)
let _metricUnavailable = {};
// Per-integration health rows (id -> {status, reason, missing_keys})
let _metricHealth = {};

function parseMetricMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// Populate all dynamic integration cards (social, stat row, perf) from fetched metrics
function populateIntegrationCards() {
  for (const integ of _projectIntegrations) {
    const prefix = integ.metric_prefix || integ.platform;
    const suffixes = platformMetricKeySuffixes(integ.platform);

    for (let i = 0; i < suffixes.length; i++) {
      // Build the DB key: for metrics stored as "twitter-followers", prefix=twitter, suffix=followers
      const dbKey = prefix + '-' + suffixes[i];
      let val = _allMetricValues[dbKey];
      const unavailableReason = _metricUnavailable[dbKey];

      // Format the value
      let display;
      let title = '';
      if (unavailableReason) {
        display = 'n/a';
        title = unavailableReason;
      } else if (val === undefined || val === null) {
        display = '--';
      } else if (suffixes[i] === 'bounce') {
        display = val + '%';
      } else if (suffixes[i] === 'status') {
        display = val === 1 ? 'Connected' : 'Expired';
      } else if (typeof val === 'number') {
        display = val.toLocaleString();
      } else {
        display = String(val);
      }

      // Bind to social cards: {prefix}-m1, {prefix}-m2, {prefix}-m3
      bind(prefix + '-m' + (i + 1), display, title);
      // Bind to dashboard stat row: stat-{prefix}-0, stat-{prefix}-1, stat-{prefix}-2
      bind('stat-' + prefix + '-' + i, display, title);
      // Bind to performance cards: perf-{prefix}-m1, perf-{prefix}-m2, perf-{prefix}-m3
      bind('perf-' + prefix + '-m' + (i + 1), display, title);
    }
  }
  // Update health badges on each social card
  applyHealthBadges();
}

function applyHealthBadges() {
  const container = document.getElementById('social-cards-container');
  if (!container) return;
  for (const integ of _projectIntegrations) {
    const card = container.querySelector('.social-card[data-integ-id="' + integ.id + '"]');
    if (!card) continue;
    const h = _metricHealth[integ.id];
    const dot = card.querySelector('.health-dot');
    if (!dot) continue;
    let cls = 'health-dot health-unknown';
    let title = 'No health data yet';
    if (h) {
      if (h.status === 'healthy') { cls = 'health-dot health-ok'; title = 'Healthy'; }
      else if (h.status === 'degraded') { cls = 'health-dot health-warn'; title = h.reason || 'Degraded - some metrics missing'; }
      else if (h.status === 'failing') { cls = 'health-dot health-fail'; title = h.reason || 'Failing - no metrics collected'; }
      else if (h.status === 'unsupported') { cls = 'health-dot health-warn'; title = h.reason || 'Platform not supported by collector'; }
    }
    dot.className = cls;
    dot.title = title;
  }
}

async function fetchMetricHealth() {
  try {
    const pq = getProjectQueryParam();
    const data = await fetchFromAPI('/api/v1/metric-health' + (pq ? '?' + pq : ''));
    if (!Array.isArray(data)) return;
    _metricHealth = {};
    for (const row of data) {
      _metricHealth[row.integration_id] = row;
    }
    applyHealthBadges();
  } catch (e) {
    console.warn('Failed to fetch metric health:', e);
  }
}

function renderSocialCards() {
  const container = document.getElementById('social-cards-container');
  if (!container) return;

  if (_projectIntegrations.length === 0) {
    container.innerHTML = '<div class="social-grid__empty" style="text-align:center;padding:2rem;color:var(--text-muted)">No integrations configured for this project</div>';
    return;
  }

  const titleEl = document.getElementById('social-section-title');
  if (titleEl) {
    const projName = currentProject.display_name === 'All Projects' ? '' : currentProject.display_name + ' -- ';
    titleEl.textContent = projName + 'Social & Integrations';
  }

  const isAllProjects = !currentProject.id;
  let html = '';
  let lastProjectName = '';

  for (const integ of _projectIntegrations) {
    // In All Projects mode, insert project group headers
    if (isAllProjects && integ._projectName && integ._projectName !== lastProjectName) {
      lastProjectName = integ._projectName;
      html += '<div class="social-group-header" style="grid-column:1/-1;display:flex;align-items:center;gap:0.5rem;padding:0.75rem 0 0.25rem;border-bottom:1px solid var(--border);margin-bottom:0.25rem">'
        + '<span style="font-size:0.85rem;font-weight:600;color:var(--text-primary)">' + escapeHtml(integ._projectName) + '</span>'
        + '</div>';
    }

    const labels = platformMetricLabels(integ.platform);
    const prefix = escapeHtml(integ.metric_prefix || integ.platform);
    const safePlatform = escapeHtml(integ.platform);
    html += '<div class="social-card" data-platform="' + safePlatform + '" data-integ-id="' + escapeHtml(String(integ.id)) + '">'
      + '<div class="social-card__header">'
      + '<span class="health-dot health-unknown" title="No health data yet"></span>'
      + '<span class="social-card__platform">' + escapeHtml(integ.display_name) + '</span>'
      + (integ.handle ? '<span class="social-card__handle">' + escapeHtml(integ.handle) + '</span>' : '')
      + '</div>'
      + '<canvas class="sparkline" data-sparkline="' + prefix + '" width="280" height="60" aria-label="' + escapeHtml(integ.display_name) + ' sparkline"></canvas>'
      + '<div class="social-card__metrics">'
      + '<div class="metric-row"><span>' + escapeHtml(labels[0]) + '</span><span data-bind="' + prefix + '-m1">--</span></div>'
      + '<div class="metric-row"><span>' + escapeHtml(labels[1]) + '</span><span data-bind="' + prefix + '-m2">--</span></div>'
      + '<div class="metric-row"><span>' + escapeHtml(labels[2]) + '</span><span data-bind="' + prefix + '-m3">--</span></div>'
      + '</div>'
      + '</div>';
  }

  container.innerHTML = html;

  // Ensure dynamic cards are visible (not caught by stagger animation)
  container.querySelectorAll('.social-card').forEach(card => {
    card.style.opacity = '1';
    card.style.transform = 'translateY(0)';
    card.dataset.skipStagger = '1';
  });

  // Redraw sparklines for visible cards
  setTimeout(() => {
    container.querySelectorAll('canvas.sparkline').forEach(canvas => {
      const key = canvas.dataset.sparkline;
      if (metricData[key] && metricData[key].length >= 2) {
        drawSparkline(canvas, metricData[key]);
      } else {
        drawNoData(canvas);
      }
    });
  }, 100);

  // If metrics already loaded, populate card values now
  if (Object.keys(_allMetricValues).length > 0) {
    populateIntegrationCards();
  }
}

function renderDashboardStats() {
  const row = document.getElementById('dashboard-stats-row');
  if (!row) return;

  // Keep the active-agents card, add dynamic stat cards before it
  const agentCard = row.querySelector('[data-metric="active-agents"]');

  // Remove old dynamic stat cards
  row.querySelectorAll('.stat-card.dynamic-stat').forEach(el => el.remove());

  // In All Projects mode, show aggregate stat cards; otherwise show first integration metrics
  // Note: innerHTML used here with hardcoded values only (no user input), safe from XSS
  if (!currentProject.id && allProjects.length > 1) {
    const totalProjects = allProjects.length;
    const statDefs = [
      { label: 'Projects', value: String(totalProjects) },
      { label: 'Channels', value: String(_projectIntegrations.length) },
    ];
    for (const sd of statDefs) {
      const card = document.createElement('div');
      card.className = 'stat-card dynamic-stat';
      const lbl = document.createElement('span');
      lbl.className = 'stat-card__label';
      lbl.textContent = sd.label;
      const val = document.createElement('span');
      val.className = 'stat-card__value';
      val.textContent = sd.value;
      card.appendChild(lbl);
      card.appendChild(val);
      row.insertBefore(card, agentCard);
    }
  } else if (_projectIntegrations.length > 0) {
    const primary = _projectIntegrations[0];
    const labels = platformMetricLabels(primary.platform);
    const prefix = primary.metric_prefix || primary.platform;

    for (let i = 0; i < Math.min(labels.length, 3); i++) {
      const card = document.createElement('div');
      card.className = 'stat-card dynamic-stat';
      const lbl = document.createElement('span');
      lbl.className = 'stat-card__label';
      lbl.textContent = labels[i];
      const val = document.createElement('span');
      val.className = 'stat-card__value';
      val.setAttribute('data-bind', 'stat-' + prefix + '-' + i);
      val.textContent = '--';
      card.appendChild(lbl);
      card.appendChild(val);
      row.insertBefore(card, agentCard);
    }
  }

  // If metrics already loaded, populate stat values now
  if (Object.keys(_allMetricValues).length > 0) {
    populateIntegrationCards();
  }
}

function renderPerfCards() {
  const container = document.getElementById('perf-cards-container');
  if (!container) return;

  if (_projectIntegrations.length === 0) {
    const msg = document.createElement('div');
    msg.style.cssText = 'text-align:center;padding:3rem 1rem;color:var(--text-muted)';
    msg.textContent = currentProject.id
      ? 'No integrations configured for this project'
      : 'Select a project to view performance analytics';
    container.textContent = '';
    container.appendChild(msg);
    return;
  }

  let html = '';
  for (const integ of _projectIntegrations) {
    const labels = platformMetricLabels(integ.platform);
    const prefix = escapeHtml(integ.metric_prefix || integ.platform);
    const safePlatform = escapeHtml(integ.platform);

    html += '<div class="perf-card" data-platform="' + safePlatform + '">'
      + '<h4>' + escapeHtml(integ.display_name) + (integ.handle ? ' &mdash; ' + escapeHtml(integ.handle) : '') + '</h4>'
      + '<div class="perf-card__chart">'
      + '<canvas data-chart="perf-' + prefix + '-chart" width="400" height="120" aria-label="' + escapeHtml(integ.display_name) + ' chart"></canvas>'
      + '</div>'
      + '<div class="perf-card__metrics">'
      + '<div class="metric-row"><span>' + escapeHtml(labels[0]) + '</span><span data-bind="perf-' + prefix + '-m1">--</span></div>'
      + '<div class="metric-row"><span>' + escapeHtml(labels[1]) + '</span><span data-bind="perf-' + prefix + '-m2">--</span></div>'
      + '<div class="metric-row"><span>' + escapeHtml(labels[2]) + '</span><span data-bind="perf-' + prefix + '-m3">--</span></div>'
      + '</div>'
      + '</div>';

    // YouTube gets a video table card
    if (integ.platform === 'youtube') {
      html += '<div class="perf-card perf-card--wide" data-platform="youtube-videos">'
        + '<h4>Video Performance</h4>'
        + '<div class="yt-video-table-wrap">'
        + '<table class="yt-video-table"><thead><tr>'
        + '<th>Thumbnail</th><th>Title</th><th>Published</th><th>Views</th><th>Likes</th><th>Comments</th>'
        + '</tr></thead>'
        + '<tbody data-bind="yt-video-tbody"><tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Loading...</td></tr></tbody>'
        + '</table></div></div>';
    }
  }

  container.innerHTML = html;

  // Ensure dynamic cards are visible (not caught by stagger animation)
  container.querySelectorAll('.perf-card').forEach(card => {
    card.style.opacity = '1';
    card.style.transform = 'translateY(0)';
    card.dataset.skipStagger = '1';
  });

  // Draw charts: use sparkline data if available, otherwise no-data placeholder
  setTimeout(() => refreshPerfCharts(container), 100);

  // If metrics already loaded, populate card values now
  if (Object.keys(_allMetricValues).length > 0) {
    populateIntegrationCards();
  }
}

function refreshPerfCharts(container) {
  if (!container) container = document.getElementById('perf-cards-container');
  if (!container) return;
  container.querySelectorAll('canvas[data-chart]').forEach(canvas => {
    // Extract prefix from data-chart attribute (e.g. "perf-twitter-chart" -> "twitter")
    const chartId = canvas.dataset.chart || '';
    const prefix = chartId.replace(/^perf-/, '').replace(/-chart$/, '');
    if (prefix && metricData[prefix] && metricData[prefix].length >= 2) {
      drawSparkline(canvas, metricData[prefix]);
    } else {
      drawNoData(canvas);
    }
  });
}

async function fetchHealthData() {
  const [srv, bot] = await Promise.all([
    fetchFromAPI('/api/v1/health'),
    fetchFromAPI('/api/v1/health/bot'),
  ]);
  return { srv, bot };
}

let liveCostData = null;
async function fetchLiveCostData(range) {
  var r = range || '7d';
  const pq = getProjectQueryParam();
  const data = await fetchFromAPI('/api/v1/costs?range=' + r + (pq ? '&' + pq : ''));
  if (data) liveCostData = data;
}

// --------------- CLOCK ---------------

function initClock() {
  if (_clockInterval) clearInterval(_clockInterval);
  const dateEl = document.querySelector('.header-date[data-bind="current-date"]');
  const timeEl = document.querySelector('.header-time[data-bind="current-time"]');
  if (!dateEl && !timeEl) return;
  const tick = () => {
    const now = new Date();
    if (dateEl) dateEl.textContent = formatDateHeader(now);
    if (timeEl) timeEl.textContent = formatTimeHeader(now);
  };
  _clockInterval = setInterval(tick, 1000);
  tick();
}

// --------------- PAGE NAVIGATION ---------------

// --------------- AGENT DETAIL VIEW ---------------

function showAgentDetail(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) return;

  navigateToPage('page-agents', false);
  history.replaceState(null, '', '#agent/' + agentId);

  // Update header title to agent name
  const titleEl = document.getElementById('header-page-title');
  if (titleEl) titleEl.textContent = agent.name;

  // Clear the sidebar page link highlight since we're in agent detail
  document.querySelectorAll('.sidebar-link[data-page]').forEach(s => s.classList.remove('active'));

  const page = document.getElementById('page-agents');
  if (!page) return;

  const grid = document.getElementById('agents-detail-grid');
  const comms = page.querySelector('[data-component="agent-comms"]');
  const taskAssign = page.querySelector('[data-component="task-assignment"]');
  const headingRow = page.querySelector('.page-heading-row');
  const wizard = document.getElementById('agent-wizard-overlay');
  if (grid) grid.hidden = true;
  if (comms) comms.hidden = true;
  if (taskAssign) taskAssign.hidden = true;
  if (headingRow) headingRow.hidden = true;
  if (wizard) wizard.hidden = true;

  let detail = document.getElementById('agent-detail-panel');
  if (!detail) {
    detail = document.createElement('div');
    detail.id = 'agent-detail-panel';
    page.prepend(detail);
  }
  detail.hidden = false;
  detail.textContent = '';

  const modeLabel = agent.mode === 'always-on' ? 'Always On' : agent.mode === 'active' ? 'Active' : 'On-demand';

  // Build header
  const headerDiv = document.createElement('div');
  headerDiv.className = 'agent-detail-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'btn btn--ghost agent-detail-back';
  backBtn.id = 'agent-detail-back';
  const backIcon = document.createElement('i');
  backIcon.setAttribute('data-lucide', 'arrow-left');
  backIcon.style.cssText = 'width:16px;height:16px;';
  backBtn.appendChild(backIcon);
  backBtn.appendChild(document.createTextNode(' All Agents'));
  backBtn.addEventListener('click', () => showAgentsGrid());

  const titleDiv = document.createElement('div');
  titleDiv.className = 'agent-detail-title';
  const titleIcon = document.createElement('i');
  titleIcon.setAttribute('data-lucide', agent.icon);
  titleIcon.className = 'agent-detail-title__icon';
  const titleInfo = document.createElement('div');
  const titleName = document.createElement('h2');
  titleName.className = 'agent-detail-title__name';
  titleName.textContent = agent.name;
  const titleRole = document.createElement('span');
  titleRole.className = 'agent-detail-title__role';
  titleRole.textContent = agent.role;
  titleInfo.appendChild(titleName);
  titleInfo.appendChild(titleRole);
  const statusDot = document.createElement('span');
  statusDot.className = 'status-dot ' + agent.status;
  statusDot.style.marginLeft = '12px';
  titleDiv.appendChild(titleIcon);
  titleDiv.appendChild(titleInfo);
  titleDiv.appendChild(statusDot);

  headerDiv.appendChild(backBtn);
  headerDiv.appendChild(titleDiv);

  // Build stats row
  const statsDiv = document.createElement('div');
  statsDiv.className = 'agent-detail-stats';
  const statEntries = [
    ['Mode', modeLabel],
    ['Heartbeat', agent.heartbeat === 'none' ? 'None' : agent.heartbeat],
    ['Status', agent.status],
    ['Last Active', agent.lastActive ? timeAgo(agent.lastActive) : '--']
  ];
  statEntries.forEach(([label, value]) => {
    const stat = document.createElement('div');
    stat.className = 'agent-detail-stat';
    const lbl = document.createElement('span');
    lbl.className = 'agent-detail-stat__label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.className = 'agent-detail-stat__value';
    val.textContent = value;
    stat.appendChild(lbl);
    stat.appendChild(val);
    statsDiv.appendChild(stat);
  });

  // Build sections container
  const sectionsDiv = document.createElement('div');
  sectionsDiv.className = 'agent-detail-sections';

  // Feed section
  const feedSection = document.createElement('div');
  feedSection.className = 'agent-detail-section';
  const feedTitle = document.createElement('h3');
  feedTitle.className = 'section-title';
  feedTitle.textContent = 'Activity Feed';
  const feedList = document.createElement('div');
  feedList.className = 'agent-detail-feed';
  feedList.id = 'agent-detail-feed';
  const feedLoading = document.createElement('div');
  feedLoading.style.cssText = 'color:var(--text-muted);padding:12px;';
  feedLoading.textContent = 'Loading activity...';
  feedList.appendChild(feedLoading);
  feedSection.appendChild(feedTitle);
  feedSection.appendChild(feedList);

  // Messages section
  const msgSection = document.createElement('div');
  msgSection.className = 'agent-detail-section';
  const msgTitle = document.createElement('h3');
  msgTitle.className = 'section-title';
  msgTitle.textContent = 'Messages';
  const msgList = document.createElement('div');
  msgList.className = 'agent-detail-messages';
  msgList.id = 'agent-detail-messages';
  const msgLoading = document.createElement('div');
  msgLoading.style.cssText = 'color:var(--text-muted);padding:12px;';
  msgLoading.textContent = 'Loading messages...';
  msgList.appendChild(msgLoading);
  msgSection.appendChild(msgTitle);
  msgSection.appendChild(msgList);

  sectionsDiv.appendChild(feedSection);
  sectionsDiv.appendChild(msgSection);


  // --- Config / Edit Tab ---
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;border-bottom:1px solid var(--border-subtle);margin-bottom:16px;';
  const tabs = ['Overview', 'Config'];
  const tabPanels = {};
  tabs.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.style.cssText = `padding:8px 20px;border-radius:0;border-bottom:2px solid ${i === 0 ? 'var(--accent)' : 'transparent'};color:${i === 0 ? 'var(--text-primary)' : 'var(--text-muted)'};font-size:13px;font-weight:600;cursor:pointer;`;
    btn.textContent = label;
    btn.dataset.tab = label.toLowerCase();
    btn.addEventListener('click', () => {
      tabBar.querySelectorAll('button').forEach(b => { b.style.borderBottomColor = 'transparent'; b.style.color = 'var(--text-muted)'; });
      btn.style.borderBottomColor = 'var(--accent)';
      btn.style.color = 'var(--text-primary)';
      Object.values(tabPanels).forEach(p => p.hidden = true);
      if (tabPanels[label.toLowerCase()]) tabPanels[label.toLowerCase()].hidden = false;
    });
    tabBar.appendChild(btn);
  });

  // Overview panel (existing feed + messages)
  const overviewPanel = document.createElement('div');
  overviewPanel.id = 'agent-tab-overview';
  tabPanels['overview'] = overviewPanel;

  // Config panel
  const configPanel = document.createElement('div');
  configPanel.id = 'agent-tab-config';
  configPanel.hidden = true;
  tabPanels['config'] = configPanel;

  const configLoading = document.createElement('div');
  configLoading.style.cssText = 'color:var(--text-muted);padding:12px;font-size:13px;';
  configLoading.textContent = 'Loading agent config...';
  configPanel.appendChild(configLoading);

  // Move feed + message sections into overview panel
  overviewPanel.appendChild(sectionsDiv);

  detail.appendChild(headerDiv);
  detail.appendChild(statsDiv);
  detail.appendChild(tabBar);
  detail.appendChild(overviewPanel);
  detail.appendChild(configPanel);

  if (typeof lucide !== 'undefined') lucide.createIcons();

  loadAgentDetailData(agentId);
  loadAgentConfig(agentId, configPanel);
}

async function loadAgentConfig(agentId, panel) {
  try {
    const res = await fetch('/api/v1/agents/config/' + agentId);
    if (!res.ok) {
      panel.textContent = '';
      const msg = document.createElement('div');
      msg.style.cssText = 'color:var(--text-muted);padding:12px;font-size:13px;';
      msg.textContent = 'No config file found for this agent.';
      panel.appendChild(msg);
      return;
    }
    const data = await res.json();
    const fm = data.frontmatter || {};
    const body = data.body || '';

    panel.textContent = '';
    const wrapper = document.createElement('div');
    wrapper.style.maxWidth = '680px';

    // Source info
    const sourceInfo = document.createElement('div');
    sourceInfo.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:16px;';
    sourceInfo.textContent = 'Source: ' + (data.source || 'unknown') + (data.filePath ? ' -- ' + data.filePath : '');
    wrapper.appendChild(sourceInfo);

    const inputStyle = 'width:100%;padding:8px 10px;background:var(--surface);border:1px solid var(--border-subtle);border-radius:6px;color:var(--text-primary);font-family:inherit;font-size:13px;';

    function addField(parent, label, id, value, opts) {
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:block;font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;margin-top:12px;';
      lbl.textContent = label;
      parent.appendChild(lbl);
      if (opts && opts.type === 'select') {
        const sel = document.createElement('select');
        sel.id = id;
        sel.style.cssText = inputStyle;
        opts.options.forEach(o => {
          const opt = document.createElement('option');
          const optionValue = typeof o === 'string' ? o : o.value;
          const optionLabel = typeof o === 'string' ? o : o.label;
          opt.value = optionValue;
          opt.textContent = optionLabel;
          if (optionValue === value) opt.selected = true;
          sel.appendChild(opt);
        });
        parent.appendChild(sel);
      } else if (opts && opts.type === 'textarea') {
        const ta = document.createElement('textarea');
        ta.id = id;
        ta.style.cssText = inputStyle + 'min-height:240px;resize:vertical;font-family:"JetBrains Mono",monospace;font-size:12px;';
        ta.value = value;
        parent.appendChild(ta);
      } else {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.id = id;
        inp.style.cssText = inputStyle;
        inp.value = value;
        if (opts && opts.disabled) inp.disabled = true;
        parent.appendChild(inp);
      }
    }

    // Grid for name/id/role/emoji/mode
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:0 16px;';
    addField(grid, 'Name', 'cfg-name', fm.name || '');
    addField(grid, 'ID', 'cfg-id', fm.id || agentId, { disabled: true });
    addField(grid, 'Role', 'cfg-role', fm.role || '');
    addField(grid, 'Emoji', 'cfg-emoji', fm.emoji || '');
    addField(grid, 'Mode', 'cfg-mode', fm.mode || 'on-demand', { type: 'select', options: ['on-demand', 'active', 'always-on'] });
    wrapper.appendChild(grid);

    const execGrid = document.createElement('div');
    execGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:0 16px;margin-top:8px;';
    addField(execGrid, 'Execution Mode', 'cfg-provider-mode', fm.provider_mode || 'inherit', {
      type: 'select',
      options: [
        { value: 'inherit', label: 'Inherit Project Default' },
        { value: 'claude_desktop', label: 'Force Claude Desktop' },
        { value: 'codex_local', label: 'Force Codex Local' },
        { value: 'anthropic_api', label: 'Force Anthropic API' },
        { value: 'openai_api', label: 'Force OpenAI API' },
        { value: 'openrouter_api', label: 'Force OpenRouter' },
        { value: 'ollama', label: 'Force Ollama' },
        { value: 'lm_studio', label: 'Force LM Studio' }
      ]
    });
    addField(execGrid, 'Fallback Provider', 'cfg-provider', fm.provider || '', {
      type: 'select',
      options: [
        { value: '', label: 'None' },
        { value: 'claude_desktop', label: 'Claude Desktop' },
        { value: 'codex_local', label: 'Codex Local' },
        { value: 'anthropic_api', label: 'Anthropic API' },
        { value: 'openai_api', label: 'OpenAI API' },
        { value: 'openrouter_api', label: 'OpenRouter' },
        { value: 'ollama', label: 'Ollama' },
        { value: 'lm_studio', label: 'LM Studio' }
      ]
    });
    addField(execGrid, 'Preferred Model', 'cfg-model', fm.model || '');
    addField(execGrid, 'Model Tier', 'cfg-model-tier', fm.model_tier || '', {
      type: 'select',
      options: [
        { value: '', label: 'Project Default' },
        { value: 'cheap', label: 'Cheap' },
        { value: 'balanced', label: 'Balanced' },
        { value: 'premium', label: 'Premium' }
      ]
    });
    addField(execGrid, 'Fallback Policy', 'cfg-fallback-policy', fm.fallback_policy || '', {
      type: 'select',
      options: [
        { value: '', label: 'Project Default' },
        { value: 'disabled', label: 'Disabled' },
        { value: 'enabled', label: 'Enabled' }
      ]
    });
    wrapper.appendChild(execGrid);

    const syncAgentExecutionModelUi = () => {
      const providerMode = document.getElementById('cfg-provider-mode');
      const modelInput = document.getElementById('cfg-model');
      if (!providerMode || !modelInput) return;

      const provider = providerMode.value;
      modelInput.disabled = provider === 'claude_desktop';
      if (provider === 'claude_desktop') {
        modelInput.placeholder = 'Not used for Claude Desktop';
        modelInput.value = '';
      } else if (provider === 'codex_local') {
        modelInput.placeholder = 'gpt-5.2-codex / gpt-5.4 / gpt-5-mini';
      } else if (provider === 'anthropic_api') {
        modelInput.placeholder = 'claude-3-5-haiku-latest / claude-sonnet-4-6';
      } else if (provider === 'openai_api') {
        modelInput.placeholder = 'gpt-5-mini / gpt-5.4 / o4-mini';
      } else {
        modelInput.placeholder = 'Project default';
      }
    };
    const providerModeSelect = document.getElementById('cfg-provider-mode');
    if (providerModeSelect) providerModeSelect.addEventListener('change', syncAgentExecutionModelUi);
    syncAgentExecutionModelUi();

    const execNote = document.createElement('div');
    execNote.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:10px;';
    execNote.textContent = 'Claude Desktop and Codex Local are the supported local execution paths. Claude Desktop ignores explicit model overrides. If automatic fallback is enabled, the agent-level Fallback Provider wins; otherwise non-Claude providers fall back to Claude Desktop.';
    wrapper.appendChild(execNote);

    // Keywords & capabilities
    const kw = Array.isArray(fm.keywords) ? fm.keywords.join(', ') : '';
    addField(wrapper, 'Keywords (comma-separated)', 'cfg-keywords', kw);
    const caps = Array.isArray(fm.capabilities) ? fm.capabilities.join(', ') : '';
    addField(wrapper, 'Capabilities (comma-separated)', 'cfg-caps', caps);

    // System prompt
    addField(wrapper, 'System Prompt', 'cfg-body', body, { type: 'textarea' });

    // Action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px;margin-top:20px;align-items:center;';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn--primary';
    saveBtn.id = 'cfg-save';
    saveBtn.textContent = 'Save Changes';

    const statusSpan = document.createElement('span');
    statusSpan.id = 'cfg-status';
    statusSpan.style.cssText = 'font-size:12px;color:var(--text-muted);';

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn--ghost';
    deleteBtn.style.color = 'var(--danger)';
    deleteBtn.textContent = 'Delete Agent';

    actions.appendChild(saveBtn);
    actions.appendChild(statusSpan);
    actions.appendChild(spacer);
    actions.appendChild(deleteBtn);
    wrapper.appendChild(actions);

    panel.appendChild(wrapper);

    // Save handler
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      statusSpan.textContent = '';

      const updatedFm = { ...fm };
      updatedFm.name = document.getElementById('cfg-name').value.trim();
      updatedFm.role = document.getElementById('cfg-role').value.trim();
      updatedFm.emoji = document.getElementById('cfg-emoji').value.trim();
      updatedFm.mode = document.getElementById('cfg-mode').value;
      updatedFm.provider_mode = document.getElementById('cfg-provider-mode').value;
      updatedFm.provider = document.getElementById('cfg-provider').value || '';
      updatedFm.model = document.getElementById('cfg-model').value.trim();
      updatedFm.model_tier = document.getElementById('cfg-model-tier').value || '';
      updatedFm.fallback_policy = document.getElementById('cfg-fallback-policy').value || '';
      updatedFm.keywords = document.getElementById('cfg-keywords').value.split(',').map(k => k.trim()).filter(Boolean);
      updatedFm.capabilities = document.getElementById('cfg-caps').value.split(',').map(c => c.trim()).filter(Boolean);
      const updatedBody = document.getElementById('cfg-body').value;

      try {
        const r = await fetch('/api/v1/agents/config/' + agentId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frontmatter: updatedFm, body: updatedBody })
        });
        if (!r.ok) { const err = await r.json(); throw new Error(err.error || 'Save failed'); }
        statusSpan.style.color = 'var(--success, #00c864)';
        statusSpan.textContent = 'Saved. Restart bot to apply.';
        if (typeof fetchAgentStatuses === 'function') fetchAgentStatuses();
      } catch (e) {
        statusSpan.style.color = 'var(--danger)';
        statusSpan.textContent = e.message;
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    });

    // Delete handler
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete agent "' + (fm.name || agentId) + '"? This removes the config file and DB entry.')) return;
      try {
        const r = await fetch('/api/v1/agents/' + agentId, { method: 'DELETE' });
        if (!r.ok) { const err = await r.json(); throw new Error(err.error || 'Delete failed'); }
        if (typeof fetchAgentStatuses === 'function') fetchAgentStatuses();
        if (typeof showAgentsGrid === 'function') showAgentsGrid();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    });

  } catch (e) {
    panel.textContent = '';
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:var(--danger);padding:12px;font-size:13px;';
    errDiv.textContent = 'Failed to load config: ' + e.message;
    panel.appendChild(errDiv);
  }
}

async function loadAgentDetailData(agentId) {
  const pq = getProjectQueryParam();
  const [feedData, messagesData] = await Promise.all([
    fetchFromAPI('/api/v1/feed?agent=' + agentId + '&limit=30' + (pq ? '&' + pq : '')).catch(() => []),
    fetchFromAPI('/api/v1/messages?agent=' + agentId + (pq ? '&' + pq : '')).catch(() => []),
  ]);

  const feedContainer = document.getElementById('agent-detail-feed');
  if (feedContainer) {
    feedContainer.textContent = '';
    if (!feedData || feedData.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);padding:12px;';
      empty.textContent = 'No recent activity';
      feedContainer.appendChild(empty);
    } else {
      feedData.forEach(item => {
        const row = document.createElement('div');
        row.className = 'agent-feed-item';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'agent-feed-item__time';
        timeSpan.textContent = item.created_at ? timeAgo(item.created_at) : '';
        const actionSpan = document.createElement('span');
        actionSpan.className = 'agent-feed-item__action';
        actionSpan.textContent = item.action + (item.detail ? ': ' + item.detail.substring(0, 120) : '');
        row.appendChild(timeSpan);
        row.appendChild(actionSpan);
        feedContainer.appendChild(row);
      });
    }
  }

  const msgContainer = document.getElementById('agent-detail-messages');
  if (msgContainer) {
    msgContainer.textContent = '';
    if (!messagesData || messagesData.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);padding:12px;';
      empty.textContent = 'No messages';
      msgContainer.appendChild(empty);
    } else {
      messagesData.slice(0, 20).forEach(msg => {
        const row = document.createElement('div');
        const dir = msg.from_agent === agentId ? 'sent' : 'received';
        row.className = 'agent-msg-item agent-msg-item--' + dir;
        const meta = document.createElement('span');
        meta.className = 'agent-msg-item__meta';
        const peer = dir === 'sent' ? (msg.to_agent || 'system') : (msg.from_agent || 'system');
        meta.textContent = (dir === 'sent' ? 'To ' : 'From ') + peer + ' - ' + (msg.created_at ? timeAgo(msg.created_at) : '');
        const content = document.createElement('span');
        content.className = 'agent-msg-item__content';
        content.textContent = (msg.content || '').substring(0, 200);
        row.appendChild(meta);
        row.appendChild(content);
        msgContainer.appendChild(row);
      });
    }
  }
}

function showAgentsGrid() {
  const page = document.getElementById('page-agents');
  if (!page) return;

  const detail = document.getElementById('agent-detail-panel');
  if (detail) detail.hidden = true;

  const grid = document.getElementById('agents-detail-grid');
  const comms = page.querySelector('[data-component="agent-comms"]');
  const taskAssign = page.querySelector('[data-component="task-assignment"]');
  const headingRow = page.querySelector('.page-heading-row');
  if (grid) grid.hidden = false;
  if (comms) comms.hidden = false;
  if (taskAssign) taskAssign.hidden = false;
  if (headingRow) headingRow.hidden = false;

  history.replaceState(null, '', '#agents');
}

function navigateToPage(pageId, pushState = true) {
  // Cancel comms animation frame when navigating away from comms page
  if (typeof commsState !== 'undefined' && commsState.animFrame) {
    cancelAnimationFrame(commsState.animFrame);
    commsState.animFrame = null;
  }

  // Hide all pages
  document.querySelectorAll('section.page').forEach(p => {
    p.classList.remove('active');
    p.hidden = true;
  });

  // Show target page
  const target = document.getElementById(pageId);
  if (target) {
    target.hidden = false;
    target.style.opacity = '0';
    target.style.transform = 'translateY(10px)';
    requestAnimationFrame(() => {
      target.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      target.style.opacity = '1';
      target.style.transform = 'translateY(0)';
      target.classList.add('active');
      animateCardsStaggered(target);
    });
  }

  // Update sidebar page link active states
  document.querySelectorAll('.sidebar-link[data-page]').forEach(s => {
    const isActive = s.dataset.page === pageId;
    s.classList.toggle('active', isActive);
    if (isActive) s.setAttribute('aria-current', 'page');
    else s.removeAttribute('aria-current');
  });

  // Update header nav active states
  document.querySelectorAll('.header-nav__link').forEach(l => l.classList.remove('active'));
  const headerLink = document.querySelector('.header-nav__link[data-page="' + pageId + '"]');
  if (headerLink) headerLink.classList.add('active');

  // Update URL hash
  if (pushState) {
    const hash = pageId.replace('page-', '');
    if (window.location.hash !== '#' + hash) {
      history.replaceState(null, '', '#' + hash);
    }
  }

  // Page-specific load triggers -- re-fetch project-scoped data on every navigation
  if (pageId === 'page-dashboard') { renderSocialCards(); renderDashboardStats(); apRenderHomeSection(); }
  if (pageId === 'page-agents') fetchAgentStatuses();
  if (pageId === 'page-security') { if (typeof SecurityPage !== 'undefined') SecurityPage.load(); }
  if (pageId === 'page-pipeline') initPipelinePage();
  if (pageId === 'page-board') initBoardPage();
  if (pageId === 'page-research') { if (typeof ResearchPage !== 'undefined') ResearchPage.load(); }
  if (pageId === 'page-comms') initCommsPage();
  if (pageId === 'page-chat') {
    chatState.messages = [];
    chatState.loaded = false;
    chatState.sending = false;
    chatState.sendStartTime = null;
    if (chatState.sendingTimer) { clearTimeout(chatState.sendingTimer); chatState.sendingTimer = null; }
    if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
    if (typeof loadChatMessages === 'function') loadChatMessages(); else initChatPage();
  }
  if (pageId === 'page-logging') initLoggingPage();
  if (pageId === 'page-sops') fetchSOPs();
  if (pageId === 'page-paws') fetchPaws();
  if (pageId === 'page-performance') { renderPerfCards(); fetchYouTubeData(); fetchAnalyticsMetrics(); fetchSocialMetrics(); }
  if (pageId === 'page-costs') initCostsPage();
  if (pageId === 'page-action-plan') initActionPlanPage();
  if (pageId === 'page-health') initHealthPage();
  if (pageId === 'page-webhooks') fetchWebhooks();
  if (pageId === 'page-plugins') fetchPlugins();
  if (pageId === 'page-graph') { if (typeof fetchGraphData === 'function') fetchGraphData(); }
  if (pageId === 'page-knowledge') initKnowledgePage();
  if (pageId === 'page-credentials') refreshCredentialsPage();
  if (pageId === 'page-projects') renderProjectsPage();
  if (pageId === 'page-users') {
    if (!CURRENT_USER || !CURRENT_USER.isAdmin) {
      navigateToPage('page-dashboard', false);
      return;
    }
    renderUsersPage();
  }
}

function initNavigation() {
  // Wire all sidebar page links
  document.querySelectorAll('.sidebar-link[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToPage(link.dataset.page);
    });
  });

  // Wire header nav links
  document.querySelectorAll('.header-nav__link[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToPage(link.dataset.page);
      if (typeof closeMobileNav === 'function') closeMobileNav();
    });
  });

  // Handle hash changes (back/forward)
  window.addEventListener('hashchange', () => {
    const hash = location.hash.replace('#', '');

    // Handle agent detail routes: #agent/scout, #agent/auditor, etc.
    if (hash.startsWith('agent/')) {
      const agentId = hash.split('/')[1];
      if (AGENTS[agentId]) {
        showAgentDetail(agentId);
        return;
      }
    }


    const pageMap = {
      'dashboard': 'page-dashboard',
      'agents': 'page-agents',
      'pipeline': 'page-pipeline',
      'performance': 'page-performance',
      'costs': 'page-costs',
      'health': 'page-health',
      'security': 'page-security',
      'chat': 'page-chat',
      'comms': 'page-comms',
      'board': 'page-board',
      'research': 'page-research',
      'sops': 'page-sops',
      'paws': 'page-paws',
      'plugins': 'page-plugins',
      'webhooks': 'page-webhooks',
      'graph': 'page-graph',
      'knowledge': 'page-knowledge',
      'settings': 'page-settings',
      'projects': 'page-projects',
      'logging': 'page-logging',
      'action-plan': 'page-action-plan',
    };
    const pageId = pageMap[hash] || ('page-' + hash);
    const target = document.getElementById(pageId);
    if (target) navigateToPage(pageId, false);
  });

  // Navigate from initial hash
  const initialHash = location.hash.replace('#', '') || 'dashboard';

  // Handle initial load of agent detail routes
  if (initialHash.startsWith('agent/')) {
    const agentId = initialHash.split('/')[1];
    if (AGENTS[agentId]) {
      showAgentDetail(agentId);
    } else {
      navigateToPage('page-dashboard', false);
    }
  } else {
    const initialPage = document.getElementById('page-' + initialHash) ? 'page-' + initialHash : 'page-dashboard';
    navigateToPage(initialPage, false);
  }
}

function animateCardsStaggered(container) {
  const cards = container.querySelectorAll('.agent-card, .agent-detail-card, .kanban-card, .perf-card, .social-card, .stat-card, .cost-kpi, .security-subscore, .security-scan-btn, .security-monitor-card, .security-finding, .sec-sev-card, .sec-project-item, .sop-card, .board-briefing-card, .board-metric-card, .board-history-item');
  cards.forEach(function(card, i) {
    // Skip cards already marked as animation-skip (dynamically inserted after render)
    if (card.dataset.skipStagger) return;
    card.style.opacity = '0';
    card.style.transform = 'translateY(15px)';
    if (i >= 30) {
      card.style.opacity = '1';
      card.style.transform = 'none';
      card.style.transition = 'none';
      return;
    }
    setTimeout(function() {
      card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      card.style.opacity = '1';
      card.style.transform = 'none';
    }, i * 60);
  });
}

// --------------- DYNAMIC AGENT CARD GENERATION ---------------

function buildDashboardAgentCards() {
  const grid = document.getElementById('dashboard-agent-grid');
  if (!grid) return;
  grid.textContent = '';
  for (const [id, agent] of Object.entries(AGENTS)) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.agent = id;
    card.dataset.status = agent.status;

    const header = document.createElement('div');
    header.className = 'agent-card__header';

    const iconEl = document.createElement('i');
    iconEl.className = 'agent-card__icon';
    iconEl.setAttribute('data-lucide', agent.icon);

    const identity = document.createElement('div');
    identity.className = 'agent-card__identity';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'agent-card__name';
    nameSpan.textContent = agent.name;
    const roleSpan = document.createElement('span');
    roleSpan.className = 'agent-card__role';
    roleSpan.textContent = agent.role;
    identity.appendChild(nameSpan);
    identity.appendChild(roleSpan);

    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot ' + agent.status;

    header.appendChild(iconEl);
    header.appendChild(identity);
    header.appendChild(statusDot);

    const body = document.createElement('div');
    body.className = 'agent-card__body';

    const metaDiv = document.createElement('div');
    metaDiv.className = 'agent-card__meta';
    const activeSpan = document.createElement('span');
    activeSpan.className = 'agent-card__last-active';
    activeSpan.dataset.bind = id + '-active';
    activeSpan.textContent = '--';
    metaDiv.appendChild(activeSpan);

    const taskP = document.createElement('p');
    taskP.className = 'agent-card__task';
    taskP.dataset.bind = id + '-task';
    taskP.textContent = 'Loading...';

    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar-mini';
    const progressFill = document.createElement('div');
    progressFill.className = 'progress-bar-mini__fill';
    progressFill.style.width = '0%';
    progressFill.dataset.bind = id + '-progress';
    progressBar.appendChild(progressFill);

    body.appendChild(metaDiv);
    body.appendChild(taskP);
    body.appendChild(progressBar);

    card.appendChild(header);
    card.appendChild(body);
    grid.appendChild(card);
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function buildDetailAgentCards() {
  const grid = document.getElementById('agents-detail-grid');
  if (!grid) return;
  grid.textContent = '';
  for (const [id, agent] of Object.entries(AGENTS)) {
    const modeLabel = agent.mode === 'always-on' ? 'Always On' : agent.mode === 'active' ? 'Active' : 'On-demand';
    const hbLabel = agent.heartbeat === 'none' ? 'None' : agent.heartbeat;

    const card = document.createElement('div');
    card.className = 'agent-detail-card';
    card.dataset.agent = id;

    // Header
    const header = document.createElement('div');
    header.className = 'agent-detail-card__header';
    const iconEl = document.createElement('i');
    iconEl.className = 'agent-detail-card__icon';
    iconEl.setAttribute('data-lucide', agent.icon);
    const infoDiv = document.createElement('div');
    const nameEl = document.createElement('h3');
    nameEl.className = 'agent-detail-card__name';
    nameEl.textContent = agent.name;
    const roleEl = document.createElement('span');
    roleEl.className = 'agent-detail-card__role';
    roleEl.textContent = agent.role;
    infoDiv.appendChild(nameEl);
    infoDiv.appendChild(roleEl);
    const dotEl = document.createElement('span');
    dotEl.className = 'status-dot ' + agent.status;
    header.appendChild(iconEl);
    header.appendChild(infoDiv);
    header.appendChild(dotEl);

    // Stats
    const statsDiv = document.createElement('div');
    statsDiv.className = 'agent-detail-card__stats';
    const statPairs = [
      ['Mode', modeLabel], ['Heartbeat', hbLabel],
      ['Sessions (24h)', '--', id + '-sessions'], ['Last Heartbeat', '--', id + '-heartbeat']
    ];
    statPairs.forEach(([label, value, bindKey]) => {
      const stat = document.createElement('div');
      stat.className = 'agent-stat';
      const lbl = document.createElement('span');
      lbl.className = 'agent-stat__label';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.className = 'agent-stat__value';
      val.textContent = value;
      if (bindKey) val.dataset.bind = bindKey;
      stat.appendChild(lbl);
      stat.appendChild(val);
      statsDiv.appendChild(stat);
    });

    // Tasks
    const tasksDiv = document.createElement('div');
    tasksDiv.className = 'agent-detail-card__tasks';
    const h4 = document.createElement('h4');
    h4.textContent = 'Task Queue';
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    ul.dataset.bind = id + '-tasks';
    const li = document.createElement('li');
    li.className = 'task-item';
    li.textContent = 'Loading tasks...';
    ul.appendChild(li);
    tasksDiv.appendChild(h4);
    tasksDiv.appendChild(ul);

    card.appendChild(header);
    card.appendChild(statsDiv);
    card.appendChild(tasksDiv);
    grid.appendChild(card);
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function buildAgentSelect() {
  const select = document.getElementById('task-agent-select');
  if (!select) return;
  select.textContent = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select Agent...';
  select.appendChild(defaultOpt);
  for (const [id, agent] of Object.entries(AGENTS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = agent.name + ' \u2014 ' + agent.role;
    select.appendChild(opt);
  }

  const costFilter = document.getElementById('cost-agent-filter');
  if (costFilter) {
    costFilter.textContent = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Agents';
    costFilter.appendChild(allOpt);
    for (const [id, agent] of Object.entries(AGENTS)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = agent.name;
      costFilter.appendChild(opt);
    }
  }
}

// --------------- AGENT STATUS SYSTEM ---------------

function updateAgentCard(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) return;

  const dashCard = document.querySelector(`.agent-card[data-agent="${agentId}"]`);
  if (dashCard) {
    dashCard.dataset.status = agent.status;
    const dot = dashCard.querySelector('.status-dot');
    if (dot) dot.className = 'status-dot ' + agent.status;
    const taskEl = dashCard.querySelector('.agent-card__task');
    if (taskEl) taskEl.textContent = agent.task;
    const activeEl = dashCard.querySelector('.agent-card__last-active');
    if (activeEl) activeEl.textContent = agent.lastActive ? timeAgo(agent.lastActive) : '--';
  }

  const detailCard = document.querySelector(`.agent-detail-card[data-agent="${agentId}"]`);
  if (detailCard) {
    const dot = detailCard.querySelector('.status-dot');
    if (dot) dot.className = 'status-dot ' + agent.status;
  }
}

function initAgentCards() {
  Object.keys(AGENTS).forEach(id => updateAgentCard(id));
}

// startAgentStatusPolling removed -- polling registered in DOMContentLoaded

// ── Agent Creator Wizard ──

const AgentWizard = {
  step: 1,
  maxSteps: 6,
  templates: [],
  data: { id: '', name: '', icon: '', role: '', mode: 'on-demand', keywords: [], capabilities: [], systemPrompt: '', templateSource: null },

  async open() {
    this.step = 1;
    this.data = { id: '', name: '', icon: '', role: '', mode: 'on-demand', keywords: [], capabilities: [], systemPrompt: '', templateSource: null };
    document.getElementById('agent-wizard').style.display = 'block';
    if (!this.templates.length) {
      try {
        const res = await fetch('/api/v1/templates');
        if (res.ok) this.templates = await res.json();
      } catch { /* proceed without templates */ }
    }
    this.renderStep();
  },

  close() {
    document.getElementById('agent-wizard').style.display = 'none';
  },

  applyTemplate(tmpl) {
    this.data.templateSource = tmpl.id;
    this.data.name = tmpl.name || '';
    this.data.id = (tmpl.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    this.data.role = tmpl.role || '';
    this.data.mode = tmpl.mode || 'on-demand';
    this.data.icon = TEMPLATE_ICON_MAP[tmpl.id] || 'bot';
    this.data.keywords = Array.isArray(tmpl.keywords) ? [...tmpl.keywords] : [];
    this.data.capabilities = Array.isArray(tmpl.capabilities) ? [...tmpl.capabilities] : [];
    this.data.systemPrompt = tmpl.body || '';
  },

  renderStep() {
    const content = document.getElementById('wizard-content');
    const backBtn = document.getElementById('wizard-back');
    const nextBtn = document.getElementById('wizard-next');

    backBtn.style.display = this.step > 1 ? '' : 'none';
    nextBtn.textContent = this.step === this.maxSteps ? 'Create Agent' : 'Next';

    document.querySelectorAll('#wizard-steps .wizard-step').forEach(el => {
      const s = parseInt(el.dataset.step);
      el.style.background = s <= this.step ? 'var(--accent)' : 'var(--border-subtle)';
    });

    const inputStyle = 'width:100%;padding:10px 12px;background:var(--surface);border:1px solid var(--border-subtle);border-radius:6px;color:var(--text-primary);font-family:inherit;font-size:13px;';
    const labelStyle = 'display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;';

    switch(this.step) {
      case 1: {
        const baseT = this.templates.filter(t => t.source === 'base');
        const roleT = this.templates.filter(t => t.source === 'template');
        const cs = 'padding:12px;background:var(--surface);border:1px solid var(--border-subtle);border-radius:8px;cursor:pointer;transition:border-color 0.15s;';
        const sel = this.data.templateSource;
        setElementHTML(content, `
          <div style="margin-bottom:12px;">
            <label style="${labelStyle}">Start from a template or build from scratch</label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:340px;overflow-y:auto;">
            <div class="wiz-tmpl-card" data-tmpl="blank" style="${cs}border-color:${!sel ? 'var(--accent)' : 'var(--border-subtle)'};">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <i data-lucide="plus" style="width:16px;height:16px;color:var(--text-muted);"></i>
                <span style="font-size:13px;font-weight:600;color:var(--text-primary);">Blank Agent</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);">Start from scratch</div>
            </div>
            ${baseT.map(t => `
              <div class="wiz-tmpl-card" data-tmpl="${escapeHtml(t.id)}" style="${cs}border-color:${sel === t.id ? 'var(--accent)' : 'var(--border-subtle)'};">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                  <i data-lucide="${TEMPLATE_ICON_MAP[t.id] || 'bot'}" style="width:16px;height:16px;color:var(--accent);"></i>
                  <span style="font-size:13px;font-weight:600;color:var(--text-primary);">${escapeHtml(t.name || t.id)}</span>
                  <span style="font-size:9px;padding:2px 6px;background:var(--accent);color:var(--bg-primary);border-radius:4px;font-weight:600;">BASE</span>
                </div>
                <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(t.role || '')}</div>
              </div>`).join('')}
            ${roleT.map(t => `
              <div class="wiz-tmpl-card" data-tmpl="${escapeHtml(t.id)}" style="${cs}border-color:${sel === t.id ? 'var(--accent)' : 'var(--border-subtle)'};">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                  <i data-lucide="${TEMPLATE_ICON_MAP[t.id] || 'bot'}" style="width:16px;height:16px;color:var(--text-secondary);"></i>
                  <span style="font-size:13px;font-weight:600;color:var(--text-primary);">${escapeHtml(t.name || t.id)}</span>
                </div>
                <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(t.role || '')}</div>
              </div>`).join('')}
          </div>`);
        content.querySelectorAll('.wiz-tmpl-card').forEach(card => {
          card.addEventListener('click', () => {
            content.querySelectorAll('.wiz-tmpl-card').forEach(c => c.style.borderColor = 'var(--border-subtle)');
            card.style.borderColor = 'var(--accent)';
            const tid = card.dataset.tmpl;
            if (tid === 'blank') {
              this.data = { id: '', name: '', icon: '', role: '', mode: 'on-demand', keywords: [], capabilities: [], systemPrompt: '', templateSource: null };
            } else {
              const tmpl = this.templates.find(t => t.id === tid);
              if (tmpl) this.applyTemplate(tmpl);
            }
          });
        });
        if (typeof lucide !== 'undefined') lucide.createIcons();
        break;
      }
      case 2:
        setElementHTML(content, `
          <div style="display:flex;flex-direction:column;gap:16px;">
            <div>
              <label style="${labelStyle}">Agent Name</label>
              <input type="text" id="wiz-name" style="${inputStyle}" placeholder="e.g. Analyst" value="${escapeHtml(this.data.name)}">
            </div>
            <div style="display:flex;gap:16px;">
              <div style="flex:1;">
                <label style="${labelStyle}">Lucide Icon</label>
                <input type="text" id="wiz-icon" style="${inputStyle}" placeholder="e.g. search, shield" value="${escapeHtml(this.data.icon)}">
              </div>
              <div style="flex:2;">
                <label style="${labelStyle}">ID (lowercase, no spaces)</label>
                <input type="text" id="wiz-id" style="${inputStyle}" placeholder="e.g. analyst" value="${escapeHtml(this.data.id)}" pattern="[a-z0-9-]+">
              </div>
            </div>
            <div>
              <label style="${labelStyle}">Role (one-line description)</label>
              <input type="text" id="wiz-role" style="${inputStyle}" placeholder="e.g. YouTube Analytics Specialist" value="${escapeHtml(this.data.role)}">
            </div>
          </div>`);
        {
          const ni = document.getElementById('wiz-name');
          const ii = document.getElementById('wiz-id');
          ni.addEventListener('input', () => {
            if (!this.data.id || this.data.id === this.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')) {
              ii.value = ni.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
            }
          });
        }
        break;
      case 3:
        setElementHTML(content, `
          <div>
            <label style="${labelStyle}">Operating Mode</label>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
              ${['on-demand', 'active', 'always-on'].map(m => `
                <label style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border:1px solid ${this.data.mode === m ? 'var(--accent)' : 'var(--border-subtle)'};border-radius:8px;cursor:pointer;">
                  <input type="radio" name="wiz-mode" value="${m}" ${this.data.mode === m ? 'checked' : ''} style="accent-color:var(--accent);">
                  <div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${m}</div>
                    <div style="font-size:11px;color:var(--text-muted);">${m === 'on-demand' ? 'Runs only when triggered' : m === 'active' ? 'Runs on a schedule' : 'Always running'}</div>
                  </div>
                </label>`).join('')}
            </div>
          </div>`);
        break;
      case 4: {
        const allCaps = ['web-search','youtube-api','sheets-cli','find-docs','newsletter-generation','social-cli','social-post','video-pipeline','voice-synthesis','analytics','brand-analysis','code-execution','infrastructure','security-scan','git-ops'];
        setElementHTML(content, `
          <div>
            <label style="${labelStyle}">Capabilities</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
              ${allCaps.map(c => `
                <label style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--surface);border:1px solid ${this.data.capabilities.includes(c) ? 'var(--accent)' : 'var(--border-subtle)'};border-radius:16px;cursor:pointer;font-size:12px;">
                  <input type="checkbox" class="wiz-cap" value="${c}" ${this.data.capabilities.includes(c) ? 'checked' : ''} style="display:none;">
                  <span style="color:${this.data.capabilities.includes(c) ? 'var(--accent)' : 'var(--text-secondary)'};">${c}</span>
                </label>`).join('')}
            </div>
          </div>
          <div style="margin-top:16px;">
            <label style="${labelStyle}">Trigger Keywords (comma-separated)</label>
            <input type="text" id="wiz-keywords" style="${inputStyle}" placeholder="e.g. analyze, metrics" value="${escapeHtml(this.data.keywords.join(', '))}">
          </div>`);
        content.querySelectorAll('.wiz-cap').forEach(cb => {
          cb.parentElement.addEventListener('click', (e) => {
            e.preventDefault();
            cb.checked = !cb.checked;
            cb.parentElement.style.borderColor = cb.checked ? 'var(--accent)' : 'var(--border-subtle)';
            cb.nextElementSibling.style.color = cb.checked ? 'var(--accent)' : 'var(--text-secondary)';
          });
        });
        break;
      }
      case 5:
        setElementHTML(content, `
          <div>
            <label style="${labelStyle}">System Prompt</label>
            <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Agent personality, instructions, and behavior.</p>
            <textarea id="wiz-prompt" style="${inputStyle}min-height:200px;resize:vertical;font-family:'JetBrains Mono',monospace;" placeholder="You are ${escapeHtml(this.data.name || '[Agent Name]')}...">${escapeHtml(this.data.systemPrompt)}</textarea>
          </div>`);
        break;
      case 6:
        setElementHTML(content, `
          <div style="font-size:13px;">
            <h4 style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:16px;">Review &amp; Create</h4>
            ${this.data.templateSource ? `<div style="font-size:11px;color:var(--accent);margin-bottom:12px;">Based on: ${escapeHtml(this.data.templateSource)}</div>` : ''}
            <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 16px;">
              <span style="color:var(--text-muted);">Name:</span><span style="color:var(--text-primary);font-weight:500;">${escapeHtml(this.data.name)}</span>
              <span style="color:var(--text-muted);">ID:</span><span style="color:var(--text-primary);font-family:'JetBrains Mono',monospace;">${escapeHtml(this.data.id)}</span>
              <span style="color:var(--text-muted);">Role:</span><span style="color:var(--text-primary);">${escapeHtml(this.data.role)}</span>
              <span style="color:var(--text-muted);">Mode:</span><span style="color:var(--text-primary);">${escapeHtml(this.data.mode)}</span>
              <span style="color:var(--text-muted);">Icon:</span><span style="color:var(--text-primary);">${escapeHtml(this.data.icon)}</span>
              <span style="color:var(--text-muted);">Capabilities:</span><span style="color:var(--text-primary);">${escapeHtml(this.data.capabilities.join(', ') || 'None')}</span>
              <span style="color:var(--text-muted);">Keywords:</span><span style="color:var(--text-primary);">${escapeHtml(this.data.keywords.join(', ') || 'None')}</span>
            </div>
            <div style="margin-top:16px;padding:12px;background:var(--surface);border-radius:6px;border:1px solid var(--border-subtle);max-height:150px;overflow-y:auto;">
              <pre style="font-size:11px;color:var(--text-secondary);white-space:pre-wrap;margin:0;">${escapeHtml(this.data.systemPrompt.slice(0, 500))}${this.data.systemPrompt.length > 500 ? '...' : ''}</pre>
            </div>
          </div>`);
        break;
    }
  },

  saveCurrentStep() {
    switch(this.step) {
      case 2:
        this.data.name = document.getElementById('wiz-name')?.value.trim() || '';
        this.data.icon = document.getElementById('wiz-icon')?.value.trim() || '';
        this.data.id = document.getElementById('wiz-id')?.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '';
        this.data.role = document.getElementById('wiz-role')?.value.trim() || '';
        break;
      case 3: {
        const checked = document.querySelector('input[name="wiz-mode"]:checked');
        if (checked) this.data.mode = checked.value;
        break;
      }
      case 4:
        this.data.capabilities = [...document.querySelectorAll('.wiz-cap:checked')].map(cb => cb.value);
        this.data.keywords = (document.getElementById('wiz-keywords')?.value || '').split(',').map(k => k.trim()).filter(Boolean);
        break;
      case 5:
        this.data.systemPrompt = document.getElementById('wiz-prompt')?.value || '';
        break;
    }
  },

  validate() {
    switch(this.step) {
      case 2: return this.data.id && this.data.name && this.data.icon && this.data.role;
      case 5: return this.data.systemPrompt.length > 10;
      default: return true;
    }
  },

  async next() {
    this.saveCurrentStep();
    if (!this.validate()) {
      const content = document.getElementById('wizard-content');
      let existing = content.querySelector('.wizard-error');
      if (!existing) {
        existing = document.createElement('div');
        existing.className = 'wizard-error';
        existing.style.cssText = 'color:var(--danger);font-size:12px;margin-top:8px;';
        content.appendChild(existing);
      }
      existing.textContent = this.step === 2 ? 'All fields are required' : 'System prompt must be at least 10 characters';
      return;
    }
    if (this.step === this.maxSteps) { await this.submit(); return; }
    this.step++;
    this.renderStep();
  },

  back() {
    this.saveCurrentStep();
    if (this.step > 1) { this.step--; this.renderStep(); }
  },

  async submit() {
    const nextBtn = document.getElementById('wizard-next');
    nextBtn.textContent = 'Creating...';
    nextBtn.disabled = true;
    try {
      const payload = {
        id: this.data.id, name: this.data.name, emoji: this.data.icon, role: this.data.role,
        mode: this.data.mode, keywords: this.data.keywords, capabilities: this.data.capabilities,
        systemPrompt: this.data.systemPrompt, project_id: currentProject.id || 'default'
      };
      const res = await fetch('/api/v1/agents/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to create agent'); }
      this.close();
      if (typeof fetchAgentStatuses === 'function') fetchAgentStatuses();
      const grid = document.getElementById('agents-detail-grid');
      if (grid) {
        const notice = document.createElement('div');
        notice.style.cssText = 'padding:12px 16px;background:var(--success-bg, rgba(0,200,100,0.1));border:1px solid var(--success, #00c864);border-radius:8px;color:var(--success, #00c864);font-size:13px;margin-bottom:16px;';
        notice.textContent = `Agent "${this.data.name}" created. Restart the bot to activate.`;
        grid.parentElement.insertBefore(notice, grid);
        setTimeout(() => notice.remove(), 8000);
      }
    } catch(e) {
      nextBtn.textContent = 'Create Agent';
      nextBtn.disabled = false;
      const content = document.getElementById('wizard-content');
      let err = content.querySelector('.wizard-error');
      if (!err) { err = document.createElement('div'); err.className = 'wizard-error'; err.style.cssText = 'color:var(--danger);font-size:12px;margin-top:8px;'; content.appendChild(err); }
      err.textContent = e.message;
    }
  }
};

// Wire up wizard buttons
document.getElementById('create-agent-btn')?.addEventListener('click', () => AgentWizard.open());
document.getElementById('wizard-close')?.addEventListener('click', () => AgentWizard.close());
document.getElementById('wizard-backdrop')?.addEventListener('click', () => AgentWizard.close());
document.getElementById('wizard-next')?.addEventListener('click', () => AgentWizard.next());
document.getElementById('wizard-back')?.addEventListener('click', () => AgentWizard.back());

// --------------- SPARKLINE INITIALIZATION ---------------

function initDashboardSparklines() {
  document.querySelectorAll('canvas.sparkline[data-sparkline]').forEach(canvas => {
    const key = canvas.dataset.sparkline;
    if (metricData[key] && metricData[key].length >= 2) {
      drawSparkline(canvas, metricData[key], colors[key] || themeAccent());
    } else {
      drawNoData(canvas);
    }
  });
}

function initAllCharts() {
  initDashboardSparklines();
  renderCostsCharts();
}

// --------------- ACTIVITY FEED ---------------

function initActivityFeed() {
  const sortBtn = document.getElementById('feed-sort-toggle');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      feedNewestFirst = !feedNewestFirst;
      sortBtn.innerHTML = feedNewestFirst ? '<i data-lucide="arrow-down" style="width:12px;height:12px;"></i> Newest' : '<i data-lucide="arrow-up" style="width:12px;height:12px;"></i> Oldest';
      if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [sortBtn] });
      fetchLiveFeed();
    });
  }
  fetchLiveFeed();
  addPollingInterval(fetchLiveFeed, 30000);
}

// --------------- COSTS PAGE ---------------

function formatCurrency(val) { return '$' + val.toFixed(2); }
function formatTokenCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

let _costsInitialized = false;

async function initCostsPage() {
  if (_costsInitialized) { await fetchLiveCostData(); renderCostsPage(); return; }
  _costsInitialized = true;

  document.querySelectorAll('button[data-cost-range]').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('button[data-cost-range]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await fetchLiveCostData(btn.dataset.costRange);
      renderCostsPage();
    });
  });

  const filterEl = document.querySelector('[data-bind="cost-agent-filter"]');
  if (filterEl) filterEl.addEventListener('change', () => renderCostTable());

  await fetchLiveCostData('7d');
  renderCostsPage();
}

function renderCostsPage() {
  if (!liveCostData) return;
  var lcd = liveCostData;

  var todayCost = lcd.todayCost || 0;
  var totalTokens = (lcd.totalInputTokens || 0) + (lcd.totalOutputTokens || 0) + (lcd.totalCacheReadTokens || 0) + (lcd.totalCacheCreationTokens || 0);
  var sessionCount = lcd.sessionCount || 0;
  var days = lcd.dailyTotals ? lcd.dailyTotals.length : 1;

  // KPIs
  bind('cost-total-value', formatCurrency(lcd.totalApiCost || 0));
  bind('cost-today-value', formatCurrency(todayCost));
  bind('cost-today-delta', 'Avg ' + formatCurrency((lcd.totalApiCost || 0) / Math.max(days, 1)) + '/day');
  bind('cost-tokens-value', formatTokenCount(totalTokens));
  bind('cost-tokens-delta', 'In: ' + formatTokenCount(lcd.totalInputTokens || 0) + ' / Out: ' + formatTokenCount(lcd.totalOutputTokens || 0) + ' / CRead: ' + formatTokenCount(lcd.totalCacheReadTokens || 0) + ' / CWrite: ' + formatTokenCount(lcd.totalCacheCreationTokens || 0));
  bind('cost-sessions-value', sessionCount.toLocaleString());
  bind('cost-sessions-delta', 'Avg ' + formatCurrency((lcd.totalApiCost || 0) / Math.max(sessionCount, 1)) + '/session');

  // Daily spend sparkline
  if (lcd.dailyTotals && lcd.dailyTotals.length >= 2) {
    var canvas = document.querySelector('[data-cost-chart="daily-spend"]');
    if (canvas) drawSparkline(canvas, lcd.dailyTotals.map(function(d) { return d.cost; }), themeAccent());
  }

  // Cost summary card -- API (variable) vs Subscriptions (fixed)
  var fixedContainer = document.querySelector('[data-bind="cost-fixed-items"]');
  if (fixedContainer) {
    fixedContainer.textContent = '';
    function addFixedRow(label, value, isTotal) {
      var row = document.createElement('div');
      row.className = 'costs-fixed-row' + (isTotal ? ' costs-fixed-row--total' : '');
      var lbl = document.createElement('span');
      lbl.className = 'costs-fixed-label';
      lbl.textContent = label;
      var val = document.createElement('span');
      val.className = 'costs-fixed-value';
      val.textContent = value;
      row.appendChild(lbl);
      row.appendChild(val);
      fixedContainer.appendChild(row);
    }
    addFixedRow('API Usage (this period)', formatCurrency(lcd.totalApiCost || 0));
    addFixedRow('Projected API', formatCurrency(lcd.projectedMonthlyApi || 0) + '/mo');
    if (lcd.lineItems) {
      lcd.lineItems.forEach(function(li) {
        var suffix = li.period === 'monthly' ? '/mo' : li.period === 'yearly' ? '/yr' : '';
        addFixedRow(li.label, formatCurrency(li.amount_usd) + suffix);
      });
    }
    addFixedRow('Projected Monthly Total', formatCurrency(lcd.projectedMonthlyTotal || 0) + '/mo', true);
  }

  // Agent bars
  var agentContainer = document.querySelector('[data-bind="cost-by-agent"]');
  if (agentContainer && lcd.byAgent) {
    agentContainer.textContent = '';
    var sorted = Object.entries(lcd.byAgent).sort(function(a, b) { return b[1].cost - a[1].cost; });
    if (sorted.length === 0) {
      var noAgentMsg = document.createElement('div');
      noAgentMsg.style.cssText = 'color:var(--text-muted);font-size:13px;padding:12px 0;';
      noAgentMsg.textContent = 'No agent cost data for this project';
      agentContainer.appendChild(noAgentMsg);
    }
    var maxCost = sorted.length > 0 ? sorted[0][1].cost : 1;
    var agentColors = { scout: themeAccent(), producer: themeCyan(), qa: themeMagenta(), social: themeAmber(), sentinel: themeRed(), analyst: themePurple(), brand:'#64748b', advocate:'#e879f9', direct:'#94a3b8' };
    sorted.forEach(function(entry) {
      var id = entry[0], data = entry[1];
      var pct = maxCost > 0 ? Math.round(data.cost / maxCost * 100) : 0;
      var color = agentColors[id] || themeAccent();
      var agentObj = AGENTS[id];
      var name = agentObj ? agentObj.name : id;
      var row = document.createElement('div');
      row.className = 'costs-bar-row';
      var label = document.createElement('span');
      label.className = 'costs-bar-label';
      label.textContent = name;
      var track = document.createElement('div');
      track.className = 'costs-bar-track';
      var fill = document.createElement('div');
      fill.className = 'costs-bar-fill';
      fill.style.width = pct + '%';
      fill.style.background = color;
      fill.title = data.sessions + ' sessions';
      track.appendChild(fill);
      var val = document.createElement('span');
      val.className = 'costs-bar-value';
      val.textContent = formatCurrency(data.cost);
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(val);
      agentContainer.appendChild(row);
    });
  }

  // Model bars
  var modelContainer = document.querySelector('[data-bind="cost-by-model"]');
  if (modelContainer && lcd.byModel) {
    modelContainer.textContent = '';
    var sortedModels = Object.entries(lcd.byModel).sort(function(a, b) { return b[1] - a[1]; });
    if (sortedModels.length === 0) {
      var noModelMsg = document.createElement('div');
      noModelMsg.style.cssText = 'color:var(--text-muted);font-size:13px;padding:12px 0;';
      noModelMsg.textContent = 'No model cost data for this project';
      modelContainer.appendChild(noModelMsg);
    }
    var maxModelCost = sortedModels.length > 0 ? sortedModels[0][1] : 1;
    sortedModels.forEach(function(entry) {
      var model = entry[0], cost = entry[1];
      var pct = maxModelCost > 0 ? Math.round(cost / maxModelCost * 100) : 0;
      var row = document.createElement('div');
      row.className = 'costs-bar-row';
      var label = document.createElement('span');
      label.className = 'costs-bar-label';
      label.textContent = model;
      var track = document.createElement('div');
      track.className = 'costs-bar-track';
      var fill = document.createElement('div');
      fill.className = 'costs-bar-fill';
      fill.style.width = pct + '%';
      fill.style.background = themeAccent();
      track.appendChild(fill);
      var val = document.createElement('span');
      val.className = 'costs-bar-value';
      val.textContent = formatCurrency(cost);
      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(val);
      modelContainer.appendChild(row);
    });
  }

  // Token split -- 4 segments
  var inputT = lcd.totalInputTokens || 0;
  var outputT = lcd.totalOutputTokens || 0;
  var cacheReadT = lcd.totalCacheReadTokens || 0;
  var cacheWriteT = lcd.totalCacheCreationTokens || 0;
  var allTokens = inputT + outputT + cacheReadT + cacheWriteT;

  var inputPct = allTokens > 0 ? Math.round(inputT / allTokens * 100) : 25;
  var outputPct = allTokens > 0 ? Math.round(outputT / allTokens * 100) : 25;
  var cacheReadPct = allTokens > 0 ? Math.round(cacheReadT / allTokens * 100) : 25;
  var cacheWritePct = Math.max(0, 100 - inputPct - outputPct - cacheReadPct);

  var tokenBar = document.querySelector('.costs-token-bar');
  if (tokenBar) {
    tokenBar.textContent = '';
    var segments = [
      { pct: inputPct, color: themeCyan() },
      { pct: outputPct, color: themeMagenta() },
      { pct: cacheReadPct, color: themeAccent() },
      { pct: cacheWritePct, color: themeAmber() }
    ];
    segments.forEach(function(s) {
      var seg = document.createElement('div');
      seg.className = 'costs-token-segment';
      seg.style.width = s.pct + '%';
      seg.style.background = s.color;
      tokenBar.appendChild(seg);
    });
  }
  var tokenLabels = document.querySelector('.costs-token-labels');
  if (tokenLabels) {
    tokenLabels.textContent = '';
    var tlabels = [
      { text: 'Input ' + inputPct + '%', color: themeCyan() },
      { text: 'Output ' + outputPct + '%', color: themeMagenta() },
      { text: 'Cache Read ' + cacheReadPct + '%', color: themeAccent() },
      { text: 'Cache Write ' + cacheWritePct + '%', color: themeAmber() }
    ];
    tlabels.forEach(function(l) {
      var sp = document.createElement('span');
      sp.textContent = l.text;
      sp.style.color = l.color;
      tokenLabels.appendChild(sp);
    });
  }

  // Populate agent filter dropdown
  var costFilter = document.getElementById('cost-agent-filter');
  if (costFilter && lcd.byAgent) {
    var currentVal = costFilter.value;
    costFilter.textContent = '';
    var allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Agents';
    costFilter.appendChild(allOpt);
    Object.keys(lcd.byAgent).forEach(function(id) {
      var opt = document.createElement('option');
      opt.value = id;
      var agentObj = AGENTS[id];
      opt.textContent = agentObj ? agentObj.name : id;
      costFilter.appendChild(opt);
    });
    costFilter.value = currentVal || 'all';
  }

  var heatmap = lcd.heatmap || Array.from({length: 7}, function() { return Array(24).fill(0); });
  renderHeatmap(heatmap);
  renderCostTable();

  // Monthly projection summary
  var alertContainer = document.querySelector('[data-bind="cost-alerts"]');
  if (alertContainer) {
    alertContainer.textContent = '';
    var projected = lcd.projectedMonthlyTotal || 0;
    if (projected > 0) {
      var alertDiv = document.createElement('div');
      alertDiv.className = 'cost-alert cost-alert--ok';
      alertDiv.textContent = 'Projected: ' + formatCurrency(projected) + '/mo (API: ' + formatCurrency(lcd.projectedMonthlyApi || 0) + ' + Fixed: ' + formatCurrency(lcd.monthlyFixed || 0) + ')';
      alertContainer.appendChild(alertDiv);
    }
  }
}

function renderHeatmap(heatmapData) {
  const grid = document.querySelector('[data-bind="heatmap-grid"]');
  if (!grid) return;
  let maxVal = 0;
  heatmapData.forEach(row => row.forEach(v => { if (v > maxVal) maxVal = v; }));
  if (maxVal === 0) maxVal = 1;
  grid.textContent = '';
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const val = heatmapData[day][hour];
      const ratio = val / maxVal;
      const level = ratio === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.dataset.level = level;
      cell.title = '$' + val.toFixed(2);
      grid.appendChild(cell);
    }
  }
}

function renderCostTable() {
  var tbody = document.querySelector('[data-bind="cost-table-body"]');
  if (!tbody) return;
  var filterEl = document.querySelector('[data-bind="cost-agent-filter"]');
  var agentFilter = filterEl ? filterEl.value : 'all';

  tbody.textContent = '';

  if (liveCostData && liveCostData.sessions && liveCostData.sessions.length > 0) {
    var sessions = liveCostData.sessions;
    if (agentFilter !== 'all') sessions = sessions.filter(function(s) { return (s.agent_id || 'direct') === agentFilter; });
    var shown = sessions.slice(0, 50);

    shown.forEach(function(s) {
      var d = new Date(s.received_at);
      var timeStr = pad(d.getMonth()+1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      var agentId = s.agent_id || 'direct';
      var agentObj = AGENTS[agentId];
      var agentName = agentObj ? agentObj.name : agentId;
      var executionLabel = s.executed_provider || s.requested_provider || '--';
      var modelLabel = s.model || '--';
      var fallback = !!s.provider_fallback_applied;

      var tr = document.createElement('tr');

      [timeStr, agentName].forEach(function(text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

      var execTd = document.createElement('td');
      var stack = document.createElement('div');
      stack.className = 'cost-exec-stack';
      var providerChip = document.createElement('span');
      providerChip.className = 'cost-provider-chip' + (fallback ? ' cost-provider-chip--fallback' : '');
      providerChip.textContent = executionLabel.replace(/_/g, ' ');
      stack.appendChild(providerChip);
      var modelMeta = document.createElement('div');
      modelMeta.className = 'cost-exec-model';
      modelMeta.textContent = modelLabel;
      stack.appendChild(modelMeta);
      execTd.appendChild(stack);
      tr.appendChild(execTd);

      [
        formatTokenCount(s.input_tokens || 0),
        formatTokenCount(s.output_tokens || 0),
        formatTokenCount(s.cache_read_tokens || 0),
        formatTokenCount(s.cache_creation_tokens || 0),
        formatCurrency(s.total_cost_usd || 0),
        (s.prompt_summary || '').slice(0, 60)
      ].forEach(function(text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  } else {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 9;
    td.style.textAlign = 'center';
    td.style.opacity = '0.5';
    td.textContent = 'No usage data for this period';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function renderCostsCharts() {
  const canvas = document.querySelector('[data-cost-chart="daily-spend"]');
  if (canvas && canvas.offsetWidth > 0 && liveCostData) renderCostsPage();
}

// --------------- SYSTEM HEALTH PAGE ---------------

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function formatBytes(bytes, decimals) {
  if (!bytes || bytes <= 0) return '0';
  const k = 1024;
  const dm = decimals ?? 1;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function setBar(bindKey, percent) {
  const el = document.querySelector('[data-bind="' + bindKey + '"]');
  if (!el) return;
  el.style.width = Math.min(percent, 100) + '%';
  el.removeAttribute('data-level');
  if (percent > 80) el.setAttribute('data-level', 'danger');
  else if (percent > 60) el.setAttribute('data-level', 'warning');
}

function renderHealthPage(data) {
  if (!data) return;
  const { srv, bot } = data;

  // -- Service dependency grid --
  const depGrid = document.querySelector('[data-bind="health-dep-grid"]');
  if (depGrid) {
    depGrid.textContent = '';
    const svcStatuses = buildServiceStatuses(srv, bot);
    svcStatuses.forEach(svc => {
      const card = document.createElement('div');
      card.className = 'health-service-card';
      const dot = document.createElement('div');
      dot.className = 'health-service-dot';
      dot.dataset.status = svc.status;
      const name = document.createElement('span');
      name.className = 'health-service-name';
      name.textContent = svc.name;
      const statusEl = document.createElement('span');
      statusEl.className = 'health-service-status';
      statusEl.dataset.status = svc.status;
      statusEl.textContent = svc.status;
      card.appendChild(dot);
      card.appendChild(name);
      card.appendChild(statusEl);
      depGrid.appendChild(card);
    });
  }

  // -- Bot (Mac) section --
  if (bot && bot.snapshots && bot.snapshots.length > 0) {
    const latest = bot.snapshots[bot.snapshots.length - 1];
    bind('health-bot-ts', 'Updated: ' + new Date(latest.recorded_at).toLocaleTimeString());

    const cpuVal = latest.cpu_percent ?? 0;
    bind('bot-cpu', cpuVal.toFixed(1) + '%');
    setBar('bot-cpu-bar', cpuVal);

    const memUsed = latest.memory_used_bytes ?? 0;
    const memTotal = latest.memory_total_bytes ?? 1;
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    bind('bot-mem', memPct.toFixed(1) + '%');
    bind('bot-mem-detail', (memUsed / 1073741824).toFixed(1) + ' / ' + (memTotal / 1073741824).toFixed(1) + ' GB');
    setBar('bot-mem-bar', memPct);

    bind('bot-rss', formatBytes(latest.node_rss_bytes));
    bind('bot-uptime', formatUptime(latest.uptime_seconds));

    // Charts from snapshot history (already 30-reading window from API)
    const cpuHistory = bot.snapshots.map(s => s.cpu_percent ?? 0);
    const memHistory = bot.snapshots.map(s => {
      const u = s.memory_used_bytes ?? 0;
      const t = s.memory_total_bytes ?? 1;
      return t > 0 ? (u / t) * 100 : 0;
    });
    drawHealthChart('bot-cpu-chart', cpuHistory, 'CPU %', themeAccent());
    drawHealthChart('bot-mem-chart', memHistory, 'RAM %', themeGreen());
  } else {
    bind('health-bot-ts', 'No data');
  }

  // -- Server (Hostinger) section --
  if (srv) {
    bind('health-srv-ts', 'Updated: ' + new Date(srv.timestamp).toLocaleTimeString());
    bind('srv-status', srv.status === 'ok' ? 'Online' : srv.status ?? 'Unknown');
    bind('srv-uptime', formatUptime(srv.uptime));

    const heapUsed = srv.memory?.heap_used ?? 0;
    const heapTotal = srv.memory?.heap_total ?? 1;
    const heapPct = heapTotal > 0 ? (heapUsed / heapTotal) * 100 : 0;
    bind('srv-heap', heapPct.toFixed(0) + '%');
    bind('srv-heap-detail', (heapUsed / 1048576).toFixed(0) + ' / ' + (heapTotal / 1048576).toFixed(0) + ' MB');
    setBar('srv-heap-bar', heapPct);

    bind('srv-db-size', formatBytes(srv.db_size_bytes));
  } else {
    bind('health-srv-ts', 'Unreachable');
    bind('srv-status', 'Offline');
  }
}

function buildServiceStatuses(srv, bot) {
  const results = [];
  const botOk = bot && bot.snapshots && bot.snapshots.length > 0;
  const latest = botOk ? bot.snapshots[bot.snapshots.length - 1] : null;
  const botAge = latest ? Date.now() - latest.recorded_at : Infinity;
  const botAlive = latest && latest.bot_alive === 1 && botAge < 120000;

  results.push({ name: 'Bot Process', status: botAlive ? 'up' : 'down' });
  results.push({ name: 'Dashboard API', status: srv && srv.status === 'ok' ? 'up' : 'down' });
  results.push({ name: 'Telegram', status: botAlive ? 'up' : 'down' });

  // Service deps from bot services array if available
  const botSvcs = bot?.services ?? [];
  const findSvc = (name) => botSvcs.find(s => s.name === name);

  const stt = findSvc('STT');
  const tts = findSvc('TTS');
  const guard = findSvc('Guard Sidecar');
  const tailscale = findSvc('Tailscale');

  results.push({ name: 'STT (WhisperX)', status: stt ? stt.status : (botAlive ? 'degraded' : 'down') });
  results.push({ name: 'TTS (Chatterbox)', status: tts ? tts.status : (botAlive ? 'degraded' : 'down') });
  results.push({ name: 'Guard Sidecar', status: guard ? guard.status : (botAlive ? 'degraded' : 'down') });
  results.push({ name: 'Tailscale', status: tailscale ? tailscale.status : (botAlive ? 'degraded' : 'down') });

  return results;
}

function drawHealthChart(canvasId, data, label, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || data.length < 2) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width, h = rect.height;
  const p = { top: 24, right: 12, bottom: 12, left: 40 };
  const plotW = w - p.left - p.right, plotH = h - p.top - p.bottom;
  ctx.clearRect(0, 0, w, h);

  ctx.font = '600 10px "Orbitron", sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(label, p.left, 14);
  ctx.textAlign = 'right';
  ctx.fillText(data[data.length - 1].toFixed(1) + '%', w - p.right, 14);

  ctx.strokeStyle = 'rgba(136,136,168,0.1)';
  ctx.lineWidth = 1;
  for (let pct of [25, 50, 75, 100]) {
    const y = p.top + plotH - (pct / 100) * plotH;
    ctx.beginPath(); ctx.moveTo(p.left, y); ctx.lineTo(w - p.right, y); ctx.stroke();
    ctx.font = '500 8px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(136,136,168,0.4)';
    ctx.textAlign = 'right';
    ctx.fillText(pct + '', p.left - 4, y + 3);
  }

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  data.forEach((val, i) => {
    const x = p.left + (i / (data.length - 1)) * plotW;
    const y = p.top + plotH - (val / 100) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.lineTo(p.left + plotW, p.top + plotH);
  ctx.lineTo(p.left, p.top + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, p.top, 0, p.top + plotH);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '05');
  ctx.fillStyle = grad;
  ctx.fill();

  const cx = p.left + plotW;
  const cy = p.top + plotH - (data[data.length - 1] / 100) * plotH;
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fillStyle = color + '30'; ctx.fill();
}

let _healthPolling = false;
async function initHealthPage() {
  const data = await fetchHealthData();
  if (data) renderHealthPage(data);
  if (!_healthPolling) { _healthPolling = true; addPollingInterval(async () => { const d = await fetchHealthData(); if (d) renderHealthPage(d); }, 30000); }
}

// --------------- CHAT PAGE ---------------

const chatState = {
  messages: [],
  pending: [],   // WS responses that arrived before loadChatMessages completed
  loaded: false,
  loading: false,
  sending: false,
  sendingTimer: null,  // safety-net timeout to reset sending if no WS response
  sendStartTime: null,    // when sending began (for elapsed timer)
  elapsedInterval: null,  // setInterval handle for elapsed time display
  hasMore: false,
  stickyBottom: true,
};

async function fetchChatMessages(before) {
  const params = new URLSearchParams({ limit: '50' });
  if (before) params.set('before', String(before));
  const pq = getProjectQueryParam();
  if (pq) params.set('project_id', currentProject.id);
  return await fetchFromAPI('/api/v1/chat?' + params.toString());
}

function formatChatTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}

function chatDateLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[d.getMonth()] + ' ' + d.getDate() + (sameYear ? '' : ', ' + d.getFullYear());
}

function isSameDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function renderMarkdown(text) {
  if (!text) return '';
  // Minimal markdown: code blocks, inline code, bold, links
  let html = escapeHtml(text);
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Links -- only allow http/https to prevent javascript:/data:/vbscript: XSS
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    if (!/^https?:\/\//i.test(url)) return text;
    const dangerous = /^(javascript|data|vbscript):/i;
    if (dangerous.test(url)) return text;
    return `<a href="${url.replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function buildMetadataToggle(msg) {
  if (!msg.duration_ms && !msg.model && !msg.total_cost_usd && !msg.executed_provider && !msg.requested_provider) return null;

  const modelShort = (msg.model || '').replace('claude-', '').replace(/-\d{8}$/, '') || '?';
  const dur = msg.duration_ms > 0 ? (msg.duration_ms / 1000).toFixed(1) + 's' : '';
  const cost = msg.total_cost_usd > 0 ? '$' + msg.total_cost_usd.toFixed(3) : '';
  const tools = (msg.tool_calls || []).length;
  const providerLabel = msg.executed_provider ? msg.executed_provider.replace(/_/g, ' ') : '';
  const parts = [dur, modelShort, providerLabel, cost, tools > 0 ? tools + ' tools' : ''].filter(Boolean);
  if (parts.length === 0) return null;

  const wrap = document.createElement('div');
  const btn = document.createElement('button');
  btn.className = 'chat-meta-toggle';
  btn.textContent = '\u25B8 ' + parts.join(' \u00B7 ');
  let expanded = false;

  btn.addEventListener('click', () => {
    expanded = !expanded;
    btn.textContent = (expanded ? '\u25BE ' : '\u25B8 ') + parts.join(' \u00B7 ');
    const detail = wrap.querySelector('.chat-meta-detail');
    if (expanded && !detail) {
      const d = document.createElement('div');
      d.className = 'chat-meta-detail';

      const tokens = document.createElement('div');
      tokens.textContent = 'in: ' + (msg.input_tokens || 0).toLocaleString() + '  out: ' + (msg.output_tokens || 0).toLocaleString() + '  cache: ' + (msg.cache_read_tokens || 0).toLocaleString();
      d.appendChild(tokens);

      if (msg.requested_provider || msg.executed_provider) {
        const prov = document.createElement('div');
        const requested = msg.requested_provider || '--';
        const executed = msg.executed_provider || '--';
        prov.textContent = 'provider: ' + requested + ' -> ' + executed + (msg.provider_fallback_applied ? ' (fallback)' : '');
        d.appendChild(prov);
      }

      if (tools > 0) {
        const toolsDiv = document.createElement('div');
        toolsDiv.className = 'chat-meta-detail__tools';
        for (const tc of msg.tool_calls) {
          const chip = document.createElement('span');
          chip.className = 'chat-meta-detail__tool';
          chip.textContent = tc.tool_name + (tc.elapsed_seconds ? ' ' + tc.elapsed_seconds.toFixed(1) + 's' : '');
          toolsDiv.appendChild(chip);
        }
        d.appendChild(toolsDiv);
      }
      wrap.appendChild(d);
    } else if (!expanded && detail) {
      detail.remove();
    }
  });

  wrap.appendChild(btn);
  return wrap;
}

function renderChatMessages() {
  const listEl = document.getElementById('chat-list');
  const emptyEl = document.getElementById('chat-empty');
  const typingEl = document.getElementById('chat-typing');
  const messagesEl = document.getElementById('chat-messages');
  if (!listEl) return;

  const msgs = chatState.messages;

  if (msgs.length === 0) {
    listEl.textContent = '';
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  // Check if at bottom before re-render
  const wasAtBottom = chatState.stickyBottom;

  listEl.textContent = '';

  // Sort oldest first
  const sorted = [...msgs].sort((a, b) => (a.received_at || 0) - (b.received_at || 0));

  let lastTs = null;
  for (const msg of sorted) {
    const ts = msg.received_at || 0;

    // Date separator
    if (!lastTs || !isSameDay(lastTs, ts)) {
      const sep = document.createElement('div');
      sep.className = 'chat-date-sep';
      const l1 = document.createElement('div');
      l1.className = 'chat-date-sep__line';
      const label = document.createElement('span');
      label.className = 'chat-date-sep__label';
      label.textContent = chatDateLabel(ts);
      const l2 = document.createElement('div');
      l2.className = 'chat-date-sep__line';
      sep.appendChild(l1);
      sep.appendChild(label);
      sep.appendChild(l2);
      listEl.appendChild(sep);
    }
    lastTs = ts;

    // User message bubble (prompt)
    if (msg.prompt_text || msg.prompt_summary) {
      const userMsg = document.createElement('div');
      userMsg.className = 'chat-msg chat-msg--user';

      const bubble = document.createElement('div');
      bubble.className = 'chat-msg__bubble';
      bubble.textContent = msg.prompt_text || msg.prompt_summary;
      userMsg.appendChild(bubble);

      const meta = document.createElement('div');
      meta.className = 'chat-msg__meta';
      meta.textContent = formatChatTime(ts);
      if (msg.source && msg.source !== 'telegram') {
        const src = document.createElement('span');
        src.className = 'chat-msg__source';
        src.textContent = ' via ' + msg.source;
        meta.appendChild(src);
      }
      userMsg.appendChild(meta);

      listEl.appendChild(userMsg);
    }

    // Agent response bubble
    if (msg.result_text || msg.result_summary) {
      const agentMsg = document.createElement('div');
      agentMsg.className = 'chat-msg chat-msg--agent' + (msg.is_error ? ' chat-msg--error' : '');

      // Agent label
      const agentLabel = document.createElement('div');
      agentLabel.className = 'chat-msg__agent-label';
      agentLabel.textContent = '\uD83D\uDC3E Paw';
      agentMsg.appendChild(agentLabel);

      const bubble = document.createElement('div');
      bubble.className = 'chat-msg__bubble';
      setElementHTML(bubble, renderMarkdown(msg.result_text || msg.result_summary));
      agentMsg.appendChild(bubble);

      // Metadata toggle
      const metaToggle = buildMetadataToggle(msg);
      if (metaToggle) agentMsg.appendChild(metaToggle);

      const meta = document.createElement('div');
      meta.className = 'chat-msg__meta';
      meta.textContent = formatChatTime(ts + (msg.duration_ms || 0));
      agentMsg.appendChild(meta);

      listEl.appendChild(agentMsg);
    }
  }

  // Typing indicator with elapsed time
  if (typingEl) {
    typingEl.hidden = !chatState.sending;
    if (chatState.sending && chatState.sendStartTime) {
      const elapsed = Math.floor((Date.now() - chatState.sendStartTime) / 1000);
      const elapsedEl = typingEl.querySelector('.chat-typing__elapsed');
      if (elapsedEl) {
        elapsedEl.textContent = elapsed > 0 ? `Processing... ${elapsed}s` : 'Processing...';
      }
    }
  }

  // Auto-scroll
  if (wasAtBottom && messagesEl) {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
}

async function loadChatMessages(before) {
  if (chatState.loading) return;
  chatState.loading = true;

  const loaderEl = document.getElementById('chat-loader');
  if (loaderEl && !before) loaderEl.hidden = false;

  const result = await fetchChatMessages(before);
  chatState.loading = false;
  if (loaderEl) loaderEl.hidden = true;

  if (!result) return;

  chatState.hasMore = result.has_more || false;

  // Merge messages (avoid duplicates)
  const existing = new Set(chatState.messages.map(m => m.event_id));
  for (const msg of (result.data || [])) {
    if (!existing.has(msg.event_id)) {
      chatState.messages.push(msg);
    }
  }

  chatState.loaded = true;

  // Drain any WS messages that arrived while we were loading history
  const pending = chatState.pending.splice(0);
  for (const p of pending) {
    // Filter by project
    if (p.project_id && currentProject.id && p.project_id !== currentProject.id) continue;
    // In-place merge into temp message if it exists
    const tempIdx = chatState.messages.findIndex(
      m => m.event_id && m.event_id.startsWith('temp-') && m.result_text === null
    );
    if (tempIdx !== -1) {
      chatState.messages[tempIdx] = { ...chatState.messages[tempIdx], ...p };
    } else {
      if (p.event_id && chatState.messages.find(m => m.event_id === p.event_id)) continue;
      chatState.messages.push(p);
    }
    chatState.sending = false;
    chatState.sendStartTime = null;
    if (chatState.sendingTimer) { clearTimeout(chatState.sendingTimer); chatState.sendingTimer = null; }
    if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
  }

  // Reconnect recovery: if a chat was still pending after draining the queue,
  // the response may have arrived via REST fallback while the browser WS was down.
  // Find any server-side response received after we started sending and merge it.
  if (chatState.sending && chatState.sendStartTime) {
    const tempIdx = chatState.messages.findIndex(
      m => m.event_id && m.event_id.startsWith('temp-') && m.result_text === null
    );
    if (tempIdx !== -1) {
      const sendTime = chatState.sendStartTime;
      const responseIdx = chatState.messages.findIndex(
        m => !m.event_id.startsWith('temp-') && m.received_at >= sendTime
      );
      if (responseIdx !== -1) {
        chatState.messages[tempIdx] = { ...chatState.messages[tempIdx], ...chatState.messages[responseIdx] };
        chatState.messages.splice(responseIdx, 1);
        chatState.sending = false;
        chatState.sendStartTime = null;
        if (chatState.sendingTimer) { clearTimeout(chatState.sendingTimer); chatState.sendingTimer = null; }
        if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
      }
    }
  }

  renderChatMessages();
}

async function sendChatMessage(text) {
  if (!text.trim() || chatState.sending) return;

  chatState.sending = true;
  chatState.sendStartTime = Date.now();

  // Optimistic user message
  const tempId = 'temp-' + Date.now();
  chatState.messages.push({
    event_id: tempId,
    received_at: Date.now(),
    prompt_text: text,
    result_text: null,
    source: 'dashboard',
    model: null,
    duration_ms: 0,
    total_cost_usd: 0,
    is_error: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    agent_id: null,
    tool_calls: [],
  });
  if (chatState.messages.length > 200) {
    chatState.messages = chatState.messages.slice(-200);
  }
  renderChatMessages();

  // Start elapsed time counter (updates typing indicator every second)
  if (chatState.elapsedInterval) clearInterval(chatState.elapsedInterval);
  const _elapsedHandle = setInterval(() => {
    if (!chatState.sending) {
      clearInterval(_elapsedHandle);
      if (chatState.elapsedInterval === _elapsedHandle) chatState.elapsedInterval = null;
      return;
    }
    // Targeted update: only update the elapsed text, not the full message list
    if (chatState.sendStartTime) {
      const elapsed = Math.floor((Date.now() - chatState.sendStartTime) / 1000);
      const elapsedEl = document.querySelector('.chat-typing__elapsed');
      if (elapsedEl) {
        elapsedEl.textContent = elapsed > 0 ? `Processing... ${elapsed}s` : 'Processing...';
      }
    }
  }, 1000);
  chatState.elapsedInterval = _elapsedHandle;

  try {
    const resp = await fetch('/api/v1/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, project_id: currentProject.id || 'default' }),
    });
    if (!resp.ok) {
      // Bug 3 fix: show error inline on the temp message bubble
      const tempMsg = chatState.messages.find(m => m.event_id === tempId);
      if (tempMsg) {
        tempMsg.result_text = `Failed to send — server returned ${resp.status}. Try again.`;
        tempMsg.is_error = 1;
      }
      chatState.sending = false;
      chatState.sendStartTime = null;
      if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
      renderChatMessages();
      return;
    }
    // Response arrives via WebSocket -- sending stays true until then.
    // Safety net: if no response after 3 minutes, reset sending state so the
    // user can try again (long-running agents like newsletter can take a while).
    if (chatState.sendingTimer) clearTimeout(chatState.sendingTimer);
    chatState.sendingTimer = setTimeout(() => {
      if (chatState.sending) {
        const tempMsg = chatState.messages.find(m => m.event_id === tempId);
        if (tempMsg) {
          tempMsg.result_text = 'Agent timed out after 3 minutes. Try again.';
          tempMsg.is_error = 1;
        }
        chatState.sending = false;
        chatState.sendStartTime = null;
        chatState.sendingTimer = null;
        if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
        renderChatMessages();
      }
    }, 3 * 60 * 1000);
  } catch (e) {
    console.warn('Chat send error:', e);
    const tempMsg = chatState.messages.find(m => m.event_id === tempId);
    if (tempMsg) {
      tempMsg.result_text = 'Failed to send — network error. Try again.';
      tempMsg.is_error = 1;
    }
    chatState.sending = false;
    chatState.sendStartTime = null;
    if (chatState.elapsedInterval) { clearInterval(chatState.elapsedInterval); chatState.elapsedInterval = null; }
    renderChatMessages();
  }
}

var _chatPageInitialized = false;
function initChatPage() {
  if (_chatPageInitialized) { loadChatMessages(); return; }
  _chatPageInitialized = true;
  const messagesEl = document.getElementById('chat-messages');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const pillEl = document.getElementById('chat-new-pill');

  // Scroll tracking
  if (messagesEl) {
    messagesEl.addEventListener('scroll', () => {
      const threshold = 60;
      chatState.stickyBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;

      if (chatState.stickyBottom && pillEl) pillEl.hidden = true;

      // Load older on scroll to top
      if (messagesEl.scrollTop < 50 && chatState.hasMore && !chatState.loading) {
        const oldest = chatState.messages.reduce((min, m) => Math.min(min, m.received_at || Infinity), Infinity);
        if (oldest < Infinity) loadChatMessages(oldest);
      }
    });
  }

  // New messages pill
  if (pillEl) {
    pillEl.addEventListener('click', () => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      pillEl.hidden = true;
    });
  }

  // Input handling
  if (inputEl && sendBtn) {
    inputEl.addEventListener('input', () => {
      sendBtn.disabled = !inputEl.value.trim();
      // Auto-grow
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (inputEl.value.trim()) {
          sendChatMessage(inputEl.value);
          inputEl.value = '';
          inputEl.style.height = 'auto';
          sendBtn.disabled = true;
        }
      }
    });

    sendBtn.addEventListener('click', () => {
      if (inputEl.value.trim()) {
        sendChatMessage(inputEl.value);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        sendBtn.disabled = true;
      }
    });
  }

  // Initial load
  loadChatMessages();
}

// --------------- SECURITY COMMAND CENTER ---------------

const SecurityPage = {
  data: { findings: [], scans: [], score: null, autofixes: [] },
  filters: { severity: '', scanner: '', status: 'open', text: '' },
  sortCol: 'severity',
  sortAsc: true,
  trendDays: 30,
  pollTimer: null,
  SEV_ORDER: { critical: 0, high: 1, medium: 2, low: 3, info: 4 },
  SEV_COLORS: {
    critical: '#ff1744',
    high: '#ff9100',
    medium: '#ffea00',
    low: '#00e5ff',
    info: '#b0bec5',
  },

  /* ---- DATA LOADING ---- */
  async load() {
    const pq = getProjectQueryParam();
    const sep = (url) => url.includes('?') ? '&' : '?';
    const [findingsRes, scansRes, scoreRes, fixesRes] = await Promise.all([
      fetchFromAPI('/api/v1/security/findings?limit=200' + (pq ? '&' + pq : '')),
      fetchFromAPI('/api/v1/security/scans?limit=30' + (pq ? '&' + pq : '')),
      fetchFromAPI('/api/v1/security/score' + (pq ? '?' + pq : '')),
      fetchFromAPI('/api/v1/security/autofixes?limit=30' + (pq ? '&' + pq : '')),
    ]);

    this.data.findings = (findingsRes && findingsRes.findings) ? findingsRes.findings : [];
    this.data.scans = Array.isArray(scansRes) ? scansRes : (scansRes && scansRes.scans) ? scansRes.scans : [];
    this.data.score = (scoreRes && scoreRes.current) ? scoreRes.current : null;
    this.data.history = (scoreRes && scoreRes.history) ? scoreRes.history : [];
    this.data.autofixes = (fixesRes && fixesRes.fixes) ? fixesRes.fixes : [];

    // Detect "not configured" -- no data at all for this project
    this.data.notConfigured = !this.data.score && this.data.findings.length === 0 && this.data.scans.length === 0;

    this.render();
  },

  /* ---- MASTER RENDER ---- */
  render() {
    if (this.data.notConfigured) {
      this.renderNotConfigured();
      this.renderSeverityCards();
      this.renderFindings();
      this.renderScans();
      this.renderAutoFixes();
      this.renderProjectBreakdown();
      this.renderScanTimes();
      return;
    }
    this.renderGauge();
    this.renderSeverityCards();
    this.renderTrendChart();
    this.renderFindings();
    this.renderScans();
    this.renderAutoFixes();
    this.renderProjectBreakdown();
    this.renderScanTimes();
  },

  /* ---- NOT CONFIGURED STATE ---- */
  renderNotConfigured() {
    // Gauge canvas: dashed ring with shield indicator
    const gaugeCanvas = document.getElementById('sec-gauge-canvas');
    if (gaugeCanvas) {
      const ctx = gaugeCanvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = gaugeCanvas.getBoundingClientRect();
      const cssW = Math.round(rect.width || 220);
      const cssH = Math.round(rect.height || cssW || 220);
      gaugeCanvas.style.width = cssW + 'px';
      gaugeCanvas.style.height = cssH + 'px';
      gaugeCanvas.width = cssW * dpr;
      gaugeCanvas.height = cssH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = cssW / 2, cy = cssH / 2;
      const radius = Math.min(cssW, cssH) * 0.41;
      ctx.clearRect(0, 0, cssW, cssH);
      // Dashed arc
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0.75 * Math.PI, 2.25 * Math.PI);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Shield icon (text)
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '36px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('--', cx, cy - 6);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '11px sans-serif';
      ctx.fillText('NO DATA', cx, cy + 22);
    }
    // Trend canvas: centered message
    const trendCanvas = document.getElementById('sec-trend-canvas');
    if (trendCanvas) {
      const ctx = trendCanvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = trendCanvas.getBoundingClientRect();
      const cssW = rect.width || 900;
      const cssH = rect.height || 260;
      trendCanvas.width = cssW * dpr;
      trendCanvas.height = cssH * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Security monitoring is not configured for this project', cssW / 2, cssH / 2 - 10);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.font = '12px sans-serif';
      ctx.fillText('Configure a security scanner or switch to a project with active monitoring', cssW / 2, cssH / 2 + 14);
    }
  },

  /* ---- SCORE GAUGE ---- */
  renderGauge() {
    const canvas = document.getElementById('sec-gauge-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.round(rect.width || 220);
    const cssH = Math.round(rect.height || cssW || 220);

    // Keep the visible box in CSS pixels and only scale the backing store for DPR.
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.41;
    const lineWidth = 14;
    const score = this.data.score ? this.data.score.score : 0;
    const color = score > 80 ? themeAccent() : score >= 60 ? themeAmber() : themeRed();

    ctx.clearRect(0, 0, w, h);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0.75 * Math.PI, 2.25 * Math.PI);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Score arc
    const arcRange = 1.5 * Math.PI; // from 0.75pi to 2.25pi
    const endAngle = 0.75 * Math.PI + (score / 100) * arcRange;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0.75 * Math.PI, endAngle);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Score text
    ctx.fillStyle = color;
    ctx.font = 'bold 48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(score), cx, cy - 8);

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px sans-serif';
    ctx.fillText('/ 100', cx, cy + 28);
  },

  /* ---- SEVERITY CARDS ---- */
  renderSeverityCards() {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    // Use score data if available (more accurate), otherwise count open findings
    if (this.data.score) {
      counts.critical = this.data.score.critical_count || 0;
      counts.high = this.data.score.high_count || 0;
      counts.medium = this.data.score.medium_count || 0;
      counts.low = this.data.score.low_count || 0;
    } else {
      for (const f of this.data.findings) {
        if (f.status === 'open') {
          const sev = (f.severity || '').toLowerCase();
          if (counts[sev] !== undefined) counts[sev]++;
        }
      }
    }
    bind('sec-sev-critical', String(counts.critical));
    bind('sec-sev-high', String(counts.high));
    bind('sec-sev-medium', String(counts.medium));
    bind('sec-sev-low', String(counts.low));
  },

  /* ---- TREND CHART ---- */
  renderTrendChart() {
    const canvas = document.getElementById('sec-trend-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 900;
    const cssH = rect.height || 260;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
    const w = cssW;
    const h = cssH;
    const history = (this.data.history || []).slice(0, this.trendDays);
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough history data', w / 2, h / 2);
      return;
    }

    const pad = { top: 20, right: 20, bottom: 30, left: 40 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const n = history.length;
    const dx = cw / (n - 1);

    // Find max stacked value for scale
    let maxVal = 0;
    for (const pt of history) {
      const total = (pt.critical_count || 0) + (pt.high_count || 0) + (pt.medium_count || 0) + (pt.low_count || 0);
      if (total > maxVal) maxVal = total;
    }
    if (maxVal === 0) maxVal = 1;

    const yScale = ch / maxVal;
    const layers = ['low', 'medium', 'high', 'critical'];
    const layerColors = {
      critical: 'rgba(255,23,68,0.6)',
      high: 'rgba(255,145,0,0.5)',
      medium: 'rgba(255,234,0,0.35)',
      low: 'rgba(0,229,255,0.25)',
    };

    // Stacked area from bottom
    let prevY = new Array(n).fill(0);
    for (const layer of layers) {
      const curY = [];
      for (let i = 0; i < n; i++) {
        curY.push(prevY[i] + (history[i][layer + '_count'] || 0));
      }

      ctx.beginPath();
      // Top edge (forward)
      for (let i = 0; i < n; i++) {
        const x = pad.left + i * dx;
        const y = pad.top + ch - curY[i] * yScale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      // Bottom edge (backward)
      for (let i = n - 1; i >= 0; i--) {
        const x = pad.left + i * dx;
        const y = pad.top + ch - prevY[i] * yScale;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = layerColors[layer] || 'rgba(255,255,255,0.1)';
      ctx.fill();

      prevY = curY;
    }

    // Score line overlay
    ctx.beginPath();
    const scoreMax = 100;
    for (let i = 0; i < n; i++) {
      const x = pad.left + i * dx;
      const y = pad.top + ch - ((history[i].score || 0) / scoreMax) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = themeAccent();
    ctx.lineWidth = 2;
    ctx.shadowColor = themeAccent();
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // X-axis date labels (every ~5 days)
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) {
      const x = pad.left + i * dx;
      const label = history[i].date ? history[i].date.slice(5) : '';
      ctx.fillText(label, x, h - 8);
    }

    // Y-axis
    ctx.textAlign = 'right';
    ctx.fillText('0', pad.left - 6, pad.top + ch);
    ctx.fillText(String(maxVal), pad.left - 6, pad.top + 10);
  },

  /* ---- FINDINGS TABLE ---- */
  renderFindings() {
    const tbody = document.getElementById('sec-findings-tbody');
    const emptyEl = document.getElementById('sec-findings-empty');
    if (!tbody) return;

    // Apply filters
    let items = this.data.findings.slice();
    const f = this.filters;
    if (f.severity) items = items.filter(i => (i.severity || '').toLowerCase() === f.severity);
    if (f.scanner) items = items.filter(i => (i.scanner_id || '') === f.scanner);
    if (f.status) items = items.filter(i => (i.status || '') === f.status);
    if (f.text) {
      const q = f.text.toLowerCase();
      items = items.filter(i => (i.title || '').toLowerCase().includes(q) || (i.target || '').toLowerCase().includes(q));
    }

    // Sort
    const sevOrd = this.SEV_ORDER;
    const col = this.sortCol;
    const asc = this.sortAsc ? 1 : -1;
    items.sort((a, b) => {
      if (col === 'severity') return asc * ((sevOrd[a.severity] || 9) - (sevOrd[b.severity] || 9));
      if (col === 'lastSeen') return asc * ((a.last_seen || 0) - (b.last_seen || 0));
      const av = (a[col] || '').toString().toLowerCase();
      const bv = (b[col] || '').toString().toLowerCase();
      return asc * av.localeCompare(bv);
    });

    // Populate scanner filter options from data
    const scannerSelect = document.getElementById('sec-filter-scanner');
    if (scannerSelect && scannerSelect.options.length <= 1) {
      const scanners = [...new Set(this.data.findings.map(f => f.scanner_id).filter(Boolean))];
      scanners.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        scannerSelect.appendChild(opt);
      });
    }

    tbody.textContent = '';
    if (emptyEl) emptyEl.style.display = items.length === 0 ? '' : 'none';

    const sevColors = this.SEV_COLORS;
    for (const item of items) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-status', item.status || 'open');
      const sev = (item.severity || 'info').toLowerCase();
      const sevColor = sevColors[sev] || sevColors.info;

      // Severity badge
      const tdSev = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'sec-sev-badge';
      badge.style.cssText = 'color:' + sevColor + ';border:1px solid ' + sevColor + ';padding:2px 8px;border-radius:4px;font-size:11px;text-transform:uppercase;';
      badge.textContent = sev;
      tdSev.appendChild(badge);

      // Title
      const tdTitle = document.createElement('td');
      tdTitle.textContent = item.title || '--';

      // Scanner
      const tdScanner = document.createElement('td');
      tdScanner.textContent = item.scanner_id || '--';

      // Target (last path segment)
      const tdTarget = document.createElement('td');
      const targetStr = item.target || '';
      tdTarget.textContent = targetStr.split('/').pop() || targetStr;
      tdTarget.title = targetStr;

      // Status badge
      const tdStatus = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = 'sec-status-badge';
      const statusColors = { open: themeRed(), acknowledged: themeAmber(), 'false-positive': '#b0bec5', fixed: themeAccent() };
      const sc = statusColors[item.status] || '#b0bec5';
      statusBadge.style.cssText = 'color:' + sc + ';font-size:11px;';
      statusBadge.textContent = item.status || 'open';
      tdStatus.appendChild(statusBadge);

      // Last seen
      const tdSeen = document.createElement('td');
      const seenMs = typeof item.last_seen === 'number' && item.last_seen < 1e12 ? item.last_seen * 1000 : new Date(item.last_seen).getTime();
      tdSeen.textContent = item.last_seen ? timeAgo(seenMs) : '--';

      // Actions
      const tdActions = document.createElement('td');
      if (item.status === 'open') {
        const mkBtn = (label, newStatus) => {
          const b = document.createElement('button');
          b.className = 'sec-action-btn';
          b.style.cssText = 'padding:2px 6px;margin-right:4px;font-size:10px;cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:3px;color:rgba(255,255,255,0.7);';
          b.textContent = label;
          b.type = 'button';
          b.addEventListener('click', () => SecurityPage.updateFinding(item.id, newStatus, b));
          return b;
        };
        tdActions.appendChild(mkBtn('Ack', 'acknowledged'));
        tdActions.appendChild(mkBtn('FP', 'false-positive'));
        tdActions.appendChild(mkBtn('Resolve', 'fixed'));
      } else if (item.status === 'acknowledged') {
        const resolveBtn = document.createElement('button');
        resolveBtn.className = 'sec-action-btn';
        resolveBtn.style.cssText = 'padding:2px 6px;font-size:10px;cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:3px;color:rgba(255,255,255,0.7);';
        resolveBtn.textContent = 'Resolve';
        resolveBtn.type = 'button';
        resolveBtn.addEventListener('click', () => SecurityPage.updateFinding(item.id, 'fixed', resolveBtn));
        tdActions.appendChild(resolveBtn);
      }

      tr.appendChild(tdSev);
      tr.appendChild(tdTitle);
      tr.appendChild(tdScanner);
      tr.appendChild(tdTarget);
      tr.appendChild(tdStatus);
      tr.appendChild(tdSeen);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    }
  },

  /* ---- SCAN HISTORY TABLE ---- */
  renderScans() {
    const tbody = document.getElementById('sec-scans-tbody');
    if (!tbody) return;
    tbody.textContent = '';

    for (const s of this.data.scans) {
      const tr = document.createElement('tr');
      const add = (text) => { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); };
      add(s.scanner_id || '--');
      add(s.trigger || s.trigger_type || '--');
      add(s.findings_count != null ? String(s.findings_count) : '--');
      add(s.duration_ms ? (s.duration_ms / 1000).toFixed(1) + 's' : '--');
      const scanMs = typeof s.started_at === 'number' && s.started_at < 1e12 ? s.started_at * 1000 : new Date(s.started_at).getTime();
      add(s.started_at ? timeAgo(scanMs) : '--');
      tbody.appendChild(tr);
    }
  },

  /* ---- AUTO-FIX LOG TABLE ---- */
  renderAutoFixes() {
    const tbody = document.getElementById('sec-autofixes-tbody');
    if (!tbody) return;
    tbody.textContent = '';

    for (const f of this.data.autofixes) {
      const tr = document.createElement('tr');
      const add = (text) => { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); };
      add(f.finding_title || f.finding_id || '--');
      const resultColor = f.result === 'success' ? themeAccent() : f.result === 'failed' ? themeRed() : '#b0bec5';
      const tdResult = document.createElement('td');
      tdResult.style.color = resultColor;
      tdResult.textContent = f.result || '--';
      tr.appendChild(tdResult);
      add(f.description || '--');
      add(f.applied_at ? timeAgo(new Date(f.applied_at).getTime()) : '--');
      tbody.appendChild(tr);
    }
  },

  /* ---- PROJECT BREAKDOWN ---- */
  renderProjectBreakdown() {
    const container = document.getElementById('sec-projects-accordion');
    if (!container) return;
    container.textContent = '';

    // Group findings by target
    const groups = {};
    for (const f of this.data.findings) {
      const target = f.target || 'unknown';
      if (!groups[target]) groups[target] = [];
      groups[target].push(f);
    }

    const targets = Object.keys(groups).sort();
    if (targets.length === 0) {
      container.textContent = 'No findings to break down.';
      return;
    }

    for (const target of targets) {
      const items = groups[target];
      const counts = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const f of items) {
        const sev = (f.severity || '').toLowerCase();
        if (counts[sev] !== undefined) counts[sev]++;
      }

      const section = document.createElement('div');
      section.className = 'sec-project-item';

      // Header with mini severity bar
      const header = document.createElement('div');
      header.className = 'sec-project-header';
      header.style.cssText = 'cursor:pointer;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(255,255,255,0.08);border-radius:6px;margin-bottom:4px;';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = target.split('/').pop() || target;
      nameSpan.title = target;
      nameSpan.style.fontWeight = '600';

      const miniBar = document.createElement('div');
      miniBar.style.cssText = 'display:flex;gap:8px;font-size:11px;';
      const sevColors = this.SEV_COLORS;
      for (const sev of ['critical', 'high', 'medium', 'low']) {
        if (counts[sev] > 0) {
          const chip = document.createElement('span');
          chip.style.color = sevColors[sev];
          chip.textContent = counts[sev] + ' ' + sev.charAt(0).toUpperCase();
          miniBar.appendChild(chip);
        }
      }

      header.appendChild(nameSpan);
      header.appendChild(miniBar);

      // Collapsible body
      const body = document.createElement('div');
      body.style.cssText = 'display:none;padding:6px 12px;font-size:12px;';
      for (const f of items) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:3px 0;color:rgba(255,255,255,0.6);';
        row.textContent = (f.severity || '').toUpperCase() + ' - ' + (f.title || 'Untitled') + ' [' + (f.status || 'open') + ']';
        body.appendChild(row);
      }

      header.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? 'block' : 'none';
      });

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    }
  },

  /* ---- SCAN TIMES ---- */
  renderScanTimes() {
    if (this.data.scans.length > 0) {
      const latest = this.data.scans[0];
      if (latest.started_at) {
        const lastMs = typeof latest.started_at === 'number' && latest.started_at < 1e12 ? latest.started_at * 1000 : new Date(latest.started_at).getTime();
        bind('sec-last-scan', timeAgo(lastMs));
      }
    }
    bind('sec-next-scan', 'Daily at 7:19am');
  },

  /* ---- FINDING STATUS UPDATE ---- */
  async updateFinding(id, newStatus, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '...'; }
    try {
      const resp = await fetch('/api/v1/security/findings/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (resp.ok) {
        // Update local data and re-render
        const f = this.data.findings.find(f => f.id === id);
        if (f) f.status = newStatus;
        this.render();
      } else {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Error'; }
      }
    } catch (e) {
      console.warn('Failed to update finding', id, e);
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Error'; }
    }
  },

  /* ---- TRIGGER SCAN ---- */
  async triggerScan(scope, btnEl) {
    const statusEl = btnEl ? btnEl.querySelector('.security-scan-btn__status') : null;
    if (statusEl) statusEl.textContent = 'Running...';
    if (btnEl) btnEl.disabled = true;

    try {
      const resp = await fetch('/api/v1/security/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, project_id: currentProject.id || 'default' }),
      });
      if (resp.ok) {
        if (statusEl) statusEl.textContent = 'Triggered';
        // Reload data after a short delay to let scan complete
        setTimeout(() => SecurityPage.load(), 3000);
      } else {
        if (statusEl) statusEl.textContent = 'Error';
      }
    } catch (e) {
      console.warn('Scan trigger failed', e);
      if (statusEl) statusEl.textContent = 'Error';
    }

    // Reset button after 10s
    setTimeout(() => {
      if (btnEl) btnEl.disabled = false;
      if (statusEl) statusEl.textContent = 'Idle';
    }, 10000);
  },
};

function getMockSecurityData() {
  return {
    score: { date: new Date().toISOString().slice(0, 10), score: 82, critical_count: 0, high_count: 1, medium_count: 3, low_count: 5 },
    history: [],
    findings: [
      { id: 'mock-1', severity: 'high', title: 'API token expiring within 7 days', scanner_id: 'token-scanner', target: 'claudepaw-server', status: 'open', last_seen: new Date().toISOString() },
      { id: 'mock-2', severity: 'medium', title: 'npm moderate vulnerability (jsonwebtoken)', scanner_id: 'npm-audit', target: 'tesla-bridge', status: 'open', last_seen: new Date().toISOString() },
      { id: 'mock-3', severity: 'medium', title: 'npm moderate vulnerability (axios)', scanner_id: 'npm-audit', target: 'claudepaw-server', status: 'open', last_seen: new Date().toISOString() },
      { id: 'mock-4', severity: 'medium', title: 'npm moderate vulnerability (express)', scanner_id: 'npm-audit', target: 'claudepaw-server', status: 'open', last_seen: new Date().toISOString() },
      { id: 'mock-5', severity: 'low', title: 'SSH password auth enabled', scanner_id: 'infra-scan', target: 'macbook-pro', status: 'open', last_seen: new Date().toISOString() },
    ],
    scans: [],
    autofixes: [],
  };
}

function initSecurityPage() {
  // Filter event listeners
  const filterIds = ['sec-filter-severity', 'sec-filter-scanner', 'sec-filter-status'];
  filterIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        const key = id.replace('sec-filter-', '');
        SecurityPage.filters[key] = el.value;
        SecurityPage.renderFindings();
      });
    }
  });
  const textFilter = document.getElementById('sec-filter-text');
  if (textFilter) {
    textFilter.addEventListener('input', () => {
      SecurityPage.filters.text = textFilter.value;
      SecurityPage.renderFindings();
    });
  }

  // Trend period filter buttons
  document.querySelectorAll('.sec-trend-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sec-trend-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const days = parseInt(btn.dataset.days, 10);
      SecurityPage.trendDays = days;
      const title = document.getElementById('sec-trend-title');
      if (title) title.textContent = `${days}-Day Security Trend`;
      SecurityPage.renderTrendChart();
    });
  });

  // Column sorting
  document.querySelectorAll('#sec-findings-table th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (SecurityPage.sortCol === col) {
        SecurityPage.sortAsc = !SecurityPage.sortAsc;
      } else {
        SecurityPage.sortCol = col;
        SecurityPage.sortAsc = true;
      }
      SecurityPage.renderFindings();
    });
  });

  // Scan buttons
  const dailyBtn = document.getElementById('sec-btn-daily');
  if (dailyBtn) {
    dailyBtn.addEventListener('click', () => SecurityPage.triggerScan('daily', dailyBtn));
  }
  const weeklyBtn = document.getElementById('sec-btn-weekly');
  if (weeklyBtn) {
    weeklyBtn.addEventListener('click', () => SecurityPage.triggerScan('weekly', weeklyBtn));
  }

  // Acknowledge All button
  const ackAllBtn = document.getElementById('btn-resolve-all');
  if (ackAllBtn) {
    ackAllBtn.addEventListener('click', async () => {
      const open = (SecurityPage.data.findings || []).filter(f => f.status === 'open');
      if (open.length === 0) return;
      if (!confirm('Acknowledge all ' + open.length + ' open findings?')) return;
      ackAllBtn.disabled = true;
      ackAllBtn.textContent = 'Working...';
      for (const f of open) {
        await SecurityPage.updateFinding(f.id, 'acknowledged');
      }
      ackAllBtn.disabled = false;
      ackAllBtn.textContent = 'Acknowledge All';
      SecurityPage.load();
    });
  }

  // Initial load
  SecurityPage.load();

  // Poll every 60s -- uses visibility-aware addPollingInterval
  SecurityPage.pollTimer = addPollingInterval(() => {
    const secPage = document.getElementById('page-security');
    if (secPage && secPage.classList.contains('active')) {
      SecurityPage.load();
    }
  }, 60000);
}

// --------------- TEST RUNNER ---------------

const TestRunner = {
  running: false,
  lastResults: null,

  setStatus(text, type) {
    const el = document.getElementById('test-status');
    if (!el) return;
    const cls = type === 'pass' ? 'test-status--pass' : type === 'fail' ? 'test-status--fail' : type === 'running' ? 'test-status--running' : '';
    el.className = 'test-status' + (cls ? ' ' + cls : '');
    el.querySelector('.test-status__text').textContent = text;
  },

  appendLog(line) {
    const log = document.getElementById('test-progress-log');
    if (!log) return;
    log.style.display = 'block';
    const div = document.createElement('div');
    div.className = 'test-log-line';
    div.textContent = line;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  },

  clearLog() {
    const log = document.getElementById('test-progress-log');
    if (log) { log.textContent = ''; log.style.display = 'none'; }
  },

  async runTests() {
    if (this.running) return;
    this.running = true;

    const btn = document.getElementById('btn-run-tests');
    if (btn) { btn.disabled = true; var ico = btn.querySelector('#test-run-icon'); ico.innerHTML = '<i data-lucide="loader" style="width:14px;height:14px;"></i>'; if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [ico] }); }

    this.clearLog();
    this.setStatus('Starting test run...', 'running');

    // Hide previous results
    const cards = document.getElementById('test-summary-cards');
    if (cards) cards.style.display = 'none';
    const filesWrap = document.getElementById('test-files-wrap');
    if (filesWrap) filesWrap.style.display = 'none';
    const errorsDiv = document.getElementById('test-errors');
    if (errorsDiv) errorsDiv.style.display = 'none';

    try {
      const res = await fetch('/api/v1/tests/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        this.setStatus(data.error || 'Failed to start tests', 'fail');
        this.running = false;
        if (btn) { btn.disabled = false; var _ico = btn.querySelector('#test-run-icon'); _ico.innerHTML = '<i data-lucide="play" style="width:14px;height:14px;"></i>'; if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [_ico] }); }
      }
      // Results arrive via WebSocket
    } catch (err) {
      this.setStatus('Network error: ' + err.message, 'fail');
      this.running = false;
      if (btn) { btn.disabled = false; var _ico = btn.querySelector('#test-run-icon'); _ico.innerHTML = '<i data-lucide="play" style="width:14px;height:14px;"></i>'; if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [_ico] }); }
    }
  },

  handleWsUpdate(data) {
    if (data.status === 'running') {
      this.setStatus(data.message || 'Running...', 'running');
    } else if (data.status === 'progress') {
      this.appendLog(data.line);
    } else if (data.status === 'passed' || data.status === 'failed' || data.status === 'error') {
      this.running = false;
      const btn = document.getElementById('btn-run-tests');
      if (btn) { btn.disabled = false; var _ico = btn.querySelector('#test-run-icon'); _ico.innerHTML = '<i data-lucide="play" style="width:14px;height:14px;"></i>'; if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [_ico] }); }

      if (data.status === 'error') {
        this.setStatus('Error: ' + (data.message || 'Unknown error'), 'fail');
        return;
      }

      this.lastResults = data.results;
      this.renderResults(data);
    }
  },

  _td(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  },

  _fmtDur(ms) {
    return ms > 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  },

  renderResults(data) {
    const results = data.results;
    if (!results) return;

    // If raw output (JSON parse failed), show it as log
    if (results.raw) {
      this.setStatus('Tests ' + data.status + ' (exit ' + data.exitCode + ')', data.status === 'passed' ? 'pass' : 'fail');
      if (results.stdout) this.appendLog(results.stdout);
      if (results.stderr) this.appendLog(results.stderr);
      return;
    }

    // Parse vitest JSON output
    const testResults = results.testResults || [];
    let totalPassed = 0, totalFailed = 0, totalSkipped = 0;
    const duration = results.duration || results.time || 0;

    testResults.forEach(function(file) {
      const ar = file.assertionResults || [];
      ar.forEach(function(t) {
        if (t.status === 'passed') totalPassed++;
        else if (t.status === 'failed') totalFailed++;
        else totalSkipped++;
      });
    });

    // Also try vitest's numPassedTests format
    if (totalPassed === 0 && totalFailed === 0 && results.numPassedTests !== undefined) {
      totalPassed = results.numPassedTests || 0;
      totalFailed = results.numFailedTests || 0;
      totalSkipped = results.numPendingTests || 0;
    }

    // Summary cards
    bind('test-passed', totalPassed);
    bind('test-failed', totalFailed);
    bind('test-skipped', totalSkipped);
    bind('test-duration', this._fmtDur(duration));

    const cards = document.getElementById('test-summary-cards');
    if (cards) cards.style.display = 'flex';

    this.setStatus(
      totalFailed > 0
        ? totalFailed + ' test' + (totalFailed !== 1 ? 's' : '') + ' failed'
        : 'All ' + totalPassed + ' tests passed',
      totalFailed > 0 ? 'fail' : 'pass'
    );

    // File breakdown
    const tbody = document.getElementById('test-files-tbody');
    if (tbody && testResults.length > 0) {
      tbody.textContent = '';
      const self = this;
      testResults.forEach(function(file) {
        const ar = file.assertionResults || [];
        const fp = (file.name || file.testFilePath || '').replace(/^.*?src\//, 'src/');
        const passed = ar.filter(function(t) { return t.status === 'passed'; }).length;
        const failed = ar.filter(function(t) { return t.status === 'failed'; }).length;
        const fileDur = file.duration || (file.perfStats && file.perfStats.duration) || 0;
        const status = failed > 0 ? 'FAIL' : 'PASS';

        const tr = document.createElement('tr');
        const nameTd = self._td(fp);
        nameTd.className = 'test-file-name';
        tr.appendChild(nameTd);
        tr.appendChild(self._td(ar.length));
        tr.appendChild(self._td(passed));

        const failTd = document.createElement('td');
        if (failed > 0) {
          const span = document.createElement('span');
          span.className = 'test-fail-count';
          span.textContent = failed;
          failTd.appendChild(span);
        } else {
          failTd.textContent = '0';
        }
        tr.appendChild(failTd);

        tr.appendChild(self._td(self._fmtDur(fileDur)));

        const statusTd = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'test-badge test-badge--' + status.toLowerCase();
        badge.textContent = status;
        statusTd.appendChild(badge);
        tr.appendChild(statusTd);

        tbody.appendChild(tr);
      });
      document.getElementById('test-files-wrap').style.display = 'block';
    }

    // Error details
    const errorsList = document.getElementById('test-errors-list');
    const errorsDiv = document.getElementById('test-errors');
    if (errorsList && errorsDiv) {
      errorsList.textContent = '';
      let hasErrors = false;
      testResults.forEach(function(file) {
        const ar = file.assertionResults || [];
        ar.filter(function(t) { return t.status === 'failed'; }).forEach(function(t) {
          hasErrors = true;
          const div = document.createElement('div');
          div.className = 'test-error-item';
          const title = document.createElement('div');
          title.className = 'test-error-item__title';
          title.textContent = (t.ancestorTitles || []).join(' > ') + ' > ' + (t.title || 'unknown');
          div.appendChild(title);
          if (t.failureMessages && t.failureMessages.length > 0) {
            const pre = document.createElement('pre');
            pre.className = 'test-error-item__message';
            pre.textContent = t.failureMessages.join('\n').slice(0, 2000);
            div.appendChild(pre);
          }
          errorsList.appendChild(div);
        });
      });
      if (hasErrors) errorsDiv.style.display = 'block';
    }
  },
};

function initTestRunner() {
  const btn = document.getElementById('btn-run-tests');
  if (btn) {
    btn.addEventListener('click', function() { TestRunner.runTests(); });
  }
}

// --------------- THEME TOGGLE ---------------

function setThemeIcon(btn, icon) {
  while (btn.firstChild) btn.removeChild(btn.firstChild);
  const i = document.createElement('i');
  i.setAttribute('data-lucide', icon);
  i.style.width = '18px';
  i.style.height = '18px';
  btn.appendChild(i);
  lucide.createIcons({ nodes: [btn] });
}

// ── Update Check ─────────────────────────────────────────────────────

var _updateCommits = [];

async function checkForUpdates() {
  try {
    var res = await fetch('/api/v1/system/update-status');
    if (!res.ok) return;
    var data = await res.json();
    var badge = document.getElementById('update-badge');
    var badgeText = document.getElementById('update-badge-text');
    if (!badge || !badgeText) return;
    if (data.behind > 0) {
      badgeText.textContent = data.behind + ' commit' + (data.behind === 1 ? '' : 's') + ' behind';
      badge.style.display = 'flex';
      _updateCommits = data.commits || [];
    } else {
      badge.style.display = 'none';
      _updateCommits = [];
    }
  } catch (e) {
    // Silently fail -- no badge shown on network error
  }
}

function openUpgradeModal() {
  var modal = document.getElementById('upgrade-modal');
  var subtitle = document.getElementById('upgrade-modal-subtitle');
  var commitList = document.getElementById('upgrade-commits');
  var btn = document.getElementById('upgrade-now-btn');
  if (!modal || !subtitle || !commitList || !btn) return;
  subtitle.textContent = _updateCommits.length + ' new commit' + (_updateCommits.length === 1 ? '' : 's') + ' on main';
  // Build commit list with safe DOM methods (no innerHTML with untrusted content)
  while (commitList.firstChild) commitList.removeChild(commitList.firstChild);
  _updateCommits.forEach(function(c) {
    var row = document.createElement('div');
    var dot = document.createElement('span');
    dot.textContent = '● ';
    dot.style.color = '#fbbf24';
    var sha = document.createElement('span');
    sha.textContent = c.sha + ' ';
    sha.style.color = 'var(--text-muted)';
    var msg = document.createElement('span');
    msg.textContent = c.message;
    row.appendChild(dot);
    row.appendChild(sha);
    row.appendChild(msg);
    commitList.appendChild(row);
  });
  btn.textContent = 'Upgrade Now';
  btn.disabled = false;
  modal.style.display = 'flex';
}

function closeUpgradeModal() {
  var modal = document.getElementById('upgrade-modal');
  if (modal) modal.style.display = 'none';
}

async function triggerUpgrade() {
  var btn = document.getElementById('upgrade-now-btn');
  if (!btn) return;
  btn.textContent = 'Upgrading...';
  btn.disabled = true;
  try {
    var res = await fetch('/api/v1/system/upgrade', { method: 'POST' });
    if (!res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      btn.textContent = (errData && errData.error) ? errData.error : 'Error -- try again';
      btn.disabled = false;
      return;
    }
    // On success: bot is restarting. WS reconnect triggers checkForUpdates() which clears the badge.
  } catch (e) {
    btn.textContent = 'Error -- try again';
    btn.disabled = false;
  }
}

function initThemeToggle() {
  const btn = document.getElementById('toggle-theme');
  if (!btn) return;
  const saved = localStorage.getItem('paw-theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    clearThemeOverrides(); // strip inline styles so CSS light rules win
    setThemeIcon(btn, 'sun');
  }
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'light') {
      // Switch to dark: restore project theme inline styles
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('paw-theme', 'dark');
      reapplyCurrentProjectTheme();
      setThemeIcon(btn, 'moon');
    } else {
      // Switch to light: clear inline styles so CSS [data-theme="light"] wins
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('paw-theme', 'light');
      clearThemeOverrides();
      setThemeIcon(btn, 'sun');
    }
    setTimeout(initAllCharts, 100);
  });
}

// Re-apply the current project's theme (used when switching back to dark mode)
function reapplyCurrentProjectTheme() {
  const settings = window._currentProjectSettings;
  if (settings) applyProjectTheme(settings);
}

// --------------- FEED SIDEBAR TOGGLE ---------------

function initFeedToggle() {
  const btn = document.getElementById('toggle-feed');
  if (!btn) return;
  const saved = localStorage.getItem('paw-feed-hidden');
  if (saved === 'true') document.body.classList.add('feed-hidden');
  btn.addEventListener('click', () => {
    document.body.classList.toggle('feed-hidden');
    localStorage.setItem('paw-feed-hidden', document.body.classList.contains('feed-hidden'));
    setTimeout(initAllCharts, 350);
  });
}

// --------------- SIDEBAR EXPAND/COLLAPSE ---------------

function initSidebarToggle() {
  const btn = document.getElementById('toggle-sidebar');
  if (!btn) return;
  const saved = localStorage.getItem('paw-sidebar-expanded');
  if (saved !== 'false') {
    // Default to open
    document.body.classList.add('sidebar-expanded');
    btn.textContent = '\u25C0';
  }
  btn.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-expanded');
    const isExpanded = document.body.classList.contains('sidebar-expanded');
    localStorage.setItem('paw-sidebar-expanded', isExpanded);
    btn.textContent = isExpanded ? '\u25C0' : '\u25B6';
    setTimeout(initAllCharts, 350);
  });
}

// --------------- HAMBURGER MOBILE NAV ---------------

function closeMobileNav() {
  const sidebar = document.querySelector('.sidebar-nav');
  const overlay = document.getElementById('mobile-nav-overlay');
  const hamburger = document.getElementById('btn-hamburger');
  if (sidebar) sidebar.classList.remove('mobile-open');
  if (overlay) {
    overlay.classList.remove('visible');
    // Remove pointer-events after fade
    setTimeout(() => { if (overlay) overlay.style.pointerEvents = 'none'; }, 300);
  }
  if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
}

function openMobileNav() {
  const sidebar = document.querySelector('.sidebar-nav');
  const overlay = document.getElementById('mobile-nav-overlay');
  const hamburger = document.getElementById('btn-hamburger');
  if (sidebar) sidebar.classList.add('mobile-open');
  if (overlay) {
    overlay.style.pointerEvents = 'auto';
    overlay.classList.add('visible');
  }
  if (hamburger) hamburger.setAttribute('aria-expanded', 'true');
}

function isMobile() {
  return window.innerWidth <= 768;
}

function initHamburger() {
  const hamburger = document.getElementById('btn-hamburger');
  const overlay = document.getElementById('mobile-nav-overlay');

  if (hamburger) {
    hamburger.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar-nav');
      if (sidebar && sidebar.classList.contains('mobile-open')) {
        closeMobileNav();
      } else {
        openMobileNav();
      }
    });
  }

  if (overlay) {
    overlay.addEventListener('click', closeMobileNav);
  }

  // Close nav when a sidebar link is tapped on mobile
  document.querySelectorAll('.sidebar-link').forEach(item => {
    item.addEventListener('click', () => {
      if (isMobile()) closeMobileNav();
    });
  });

  // Close nav on resize to desktop
  window.addEventListener('resize', () => {
    if (!isMobile()) closeMobileNav();
  });
}

// --------------- TASK ASSIGNMENT ---------------

function initTaskAssignment() {
  const submitBtn = document.querySelector('button[data-action="submit-task"]');
  if (!submitBtn) return;
  submitBtn.addEventListener('click', () => {
    const form = document.querySelector('.task-assignment-form[data-action="assign-task"]');
    if (!form) return;
    const agentSelect = form.querySelector('[data-field="agent"]');
    const taskInput = form.querySelector('[data-field="task-title"]');
    const prioritySelect = form.querySelector('[data-field="priority"]');
    const agentId = agentSelect?.value;
    const taskText = taskInput?.value?.trim();
    const priority = prioritySelect?.value || 'normal';
    if (!agentId || !taskText) return;

    if (AGENTS[agentId]) {
      AGENTS[agentId].task = taskText;
      AGENTS[agentId].status = 'active';
      AGENTS[agentId].lastActive = Date.now();
      updateAgentCard(agentId);
    }

    addCustomFeedItem(agentId, 'Assigned: "' + taskText + '" (' + priority + ')');
    if (taskInput) taskInput.value = '';
    if (agentSelect) agentSelect.value = '';
    submitBtn.textContent = 'Assigned!';
    submitBtn.disabled = true;
    setTimeout(() => { submitBtn.textContent = 'Assign'; submitBtn.disabled = false; }, 2000);
  });
}

function addCustomFeedItem(agentId, text) {
  const container = document.querySelector('.sidebar-feed__list[data-bind="live-feed"]');
  if (!container) return;
  const agent = AGENTS[agentId];
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.dataset.agent = agentId;

  const timeEl = document.createElement('time');
  timeEl.textContent = formatFeedTime(new Date());
  const agentSpan = document.createElement('span');
  agentSpan.className = 'feed-agent';
  if (agent && agent.icon) {
    const iconEl = document.createElement('i');
    iconEl.setAttribute('data-lucide', agent.icon);
    iconEl.style.cssText = 'width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;';
    agentSpan.appendChild(iconEl);
  }
  agentSpan.appendChild(document.createTextNode(agent ? agent.name : ''));
  const textSpan = document.createElement('span');
  textSpan.className = 'feed-text';
  textSpan.textContent = text;

  el.appendChild(timeEl);
  el.appendChild(agentSpan);
  el.appendChild(textSpan);
  container.prepend(el);
  container.scrollTop = 0;
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [el] });
}

// --------------- RESIZE HANDLER ---------------

let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(initAllCharts, 250);
}

// --------------- MASTER INIT ---------------

// --------------- VISIBILITY-AWARE POLLING ---------------

const _pollingIntervals = [];
let _pollingPaused = false;

/** Register a polling interval. Use instead of bare setInterval for pollable timers. */
function addPollingInterval(fn, ms) {
  const id = setInterval(fn, ms);
  _pollingIntervals.push({ fn, ms, id });
  return id;
}

function clearAllPollingIntervals() {
  _pollingIntervals.forEach(function(entry) { clearInterval(entry.id); });
  _pollingIntervals.length = 0;
  if (typeof SecurityPage !== 'undefined' && SecurityPage.pollTimer) {
    clearInterval(SecurityPage.pollTimer);
    SecurityPage.pollTimer = null;
  }
  if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
  _healthPolling = false;
  _commsPolling = false;
}

function pauseAllPolling() {
  if (_pollingPaused) return;
  _pollingPaused = true;
  for (const entry of _pollingIntervals) {
    clearInterval(entry.id);
    entry.id = null;
  }
}

function resumeAllPolling() {
  if (!_pollingPaused) return;
  _pollingPaused = false;
  for (const entry of _pollingIntervals) {
    entry.id = setInterval(entry.fn, entry.ms);
    // Run immediately on resume to get fresh data
    entry.fn();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseAllPolling();
  else resumeAllPolling();
});

// --------------- CRON JOBS ---------------

const SOP_ICON_MAP = {
  scout: 'search', producer: 'clapperboard', qa: 'check-circle',
  social: 'megaphone', sentinel: 'eye', analyst: 'bar-chart-3',
  brand: 'target', advocate: 'scale', auditor: 'shield-check',
  default: 'settings'
};

function sopIcon(taskId) {
  const id = (taskId || '').toLowerCase();
  for (const [key, icon] of Object.entries(SOP_ICON_MAP)) {
    if (key !== 'default' && id.includes(key)) return icon;
  }
  if (id.includes('security') || id.includes('audit')) return 'shield-check';
  if (id.includes('youtube') || id.includes('video')) return 'clapperboard';
  if (id.includes('social') || id.includes('linkedin')) return 'megaphone';
  if (id.includes('report') || id.includes('analyt')) return 'bar-chart-3';
  if (id.includes('monitor') || id.includes('watch')) return 'eye';
  return SOP_ICON_MAP.default;
}

function formatCron(cron) {
  if (!cron) return '--';
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (hour.startsWith('*/')) return 'Every ' + hour.slice(2) + 'h';
  if (min.startsWith('*/')) return 'Every ' + min.slice(2) + 'm';
  if (dow === '*' && dom === '*') return 'Daily ' + hour + ':' + min.padStart(2, '0');
  if (dow !== '*') {
    const dayList = dow.split(',').map(function(d) { return dowNames[parseInt(d)] || d; }).join(', ');
    return dayList + ' ' + hour + ':' + min.padStart(2, '0');
  }
  return cron;
}

function formatTaskTitle(id) {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function buildSopCardEl(task) {
  var iconName = sopIcon(task.id);
  var title = formatTaskTitle(task.id);
  var schedule = formatCron(task.schedule || task.cron);
  var status = task.status || 'active';
  var statusLabel = status.toUpperCase();
  var nextRun = task.next_run ? timeAgo(task.next_run) : '--';
  var lastRun = task.last_run ? timeAgo(task.last_run) : '--';

  var card = document.createElement('div');
  card.className = 'sop-card';
  card.dataset.taskId = task.id;

  var header = document.createElement('div');
  header.className = 'sop-card__header';
  var iconEl = document.createElement('i');
  iconEl.className = 'sop-card__icon';
  iconEl.setAttribute('data-lucide', iconName);
  var titleEl = document.createElement('h3');
  titleEl.className = 'sop-card__title';
  titleEl.textContent = title;
  header.appendChild(iconEl);
  header.appendChild(titleEl);

  var body = document.createElement('div');
  body.className = 'sop-card__body';
  var promptPreview = (task.prompt || '').length > 80 ? task.prompt.substring(0, 80) + '...' : (task.prompt || '--');
  var metaItems = [['Schedule', schedule], ['Next Run', nextRun], ['Last Run', lastRun], ['Chat ID', String(task.chat_id || '--')]];
  metaItems.push(['Prompt', promptPreview]);
  metaItems.forEach(function(pair) {
    var row = document.createElement('div');
    row.className = 'sop-meta';
    var l = document.createElement('span');
    l.textContent = pair[0];
    var v = document.createElement('span');
    v.textContent = pair[1];
    row.appendChild(l);
    row.appendChild(v);
    body.appendChild(row);
  });

  var footer = document.createElement('div');
  footer.className = 'sop-card__footer';
  var statusBadge = document.createElement('span');
  statusBadge.className = 'sop-status ' + status;
  statusBadge.textContent = statusLabel;
  var btnGroup = document.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:6px;';
  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn btn--sm btn--ghost';
  toggleBtn.type = 'button';
  toggleBtn.dataset.action = 'toggle-sop';
  toggleBtn.dataset.taskId = task.id;
  toggleBtn.dataset.currentStatus = status;
  toggleBtn.textContent = status === 'active' ? 'Pause' : 'Resume';
  var runBtn = document.createElement('button');
  runBtn.className = 'btn btn--sm btn--primary';
  runBtn.type = 'button';
  runBtn.dataset.action = 'run-sop';
  runBtn.dataset.taskId = task.id;
  runBtn.textContent = 'Run Now';

  var editBtn = document.createElement('button');
  editBtn.className = 'btn btn--sm btn--ghost';
  editBtn.type = 'button';
  editBtn.dataset.action = 'edit-sop';
  editBtn.dataset.taskId = task.id;
  editBtn.textContent = 'Edit';

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn--sm btn--ghost btn--danger';
  deleteBtn.type = 'button';
  deleteBtn.dataset.action = 'delete-sop';
  deleteBtn.dataset.taskId = task.id;
  deleteBtn.textContent = 'Delete';

  btnGroup.appendChild(toggleBtn);
  btnGroup.appendChild(runBtn);
  btnGroup.appendChild(editBtn);
  btnGroup.appendChild(deleteBtn);
  footer.appendChild(statusBadge);
  footer.appendChild(btnGroup);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  return card;
}

function renderSopCards(tasks) {
  var grid = document.querySelector('.sop-grid[data-component="sops"]');
  if (!grid) return;
  grid.textContent = '';

  if (!tasks || tasks.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'sop-card';
    empty.style.cssText = 'opacity:0.4;text-align:center;padding:40px;';
    var msg = document.createElement('span');
    msg.style.color = 'var(--text-muted)';
    msg.textContent = 'No scheduled tasks found';
    empty.appendChild(msg);
    grid.appendChild(empty);
    return;
  }

  var countEl = document.querySelector('[data-bind="sop-task-count"]');
  if (countEl) countEl.textContent = tasks.length + ' task' + (tasks.length === 1 ? '' : 's');

  tasks.forEach(function(task) { grid.appendChild(buildSopCardEl(task)); });
  animateCardsStaggered(grid);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ========== PAWS PAGE ==========


async function fetchPaws() {
  try {
    var pq = getProjectQueryParam();
    var res = await fetch('/api/v1/paws' + (pq ? '?' + pq : ''));
    if (!res.ok) return;
    var data = await res.json();
    renderPawCards(data.paws || []);
  } catch (err) {
    console.error('Paws fetch error:', err);
  }
}

function renderPawCards(paws) {
  var grid = document.querySelector('.sop-grid[data-component="paws"]');
  if (!grid) return;
  grid.textContent = '';

  var countEl = document.querySelector('[data-bind="paw-count"]');
  if (countEl) countEl.textContent = paws.length + ' paw' + (paws.length !== 1 ? 's' : '');

  if (!paws.length) {
    var empty = document.createElement('div');
    empty.className = 'sop-card';
    empty.style.cssText = 'opacity:0.4;text-align:center;padding:40px;';
    var msg = document.createElement('span');
    msg.textContent = 'No Paws configured yet.';
    empty.appendChild(msg);
    grid.appendChild(empty);
    return;
  }

  var showProject = !currentProject.id;
  paws.forEach(function(paw) {
    var card = document.createElement('div');
    card.className = 'sop-card';
    card.dataset.pawId = paw.id;

    var header = document.createElement('div');
    header.className = 'sop-card__header';
    var iconEl = document.createElement('i');
    iconEl.className = 'sop-card__icon';
    iconEl.setAttribute('data-lucide', 'paw-print');
    var titleEl = document.createElement('h3');
    titleEl.className = 'sop-card__title';
    titleEl.textContent = paw.name;
    titleEl.style.cursor = 'pointer';
    titleEl.onclick = function() { openPawDetailModal(paw.id); };
    header.appendChild(iconEl);
    header.appendChild(titleEl);

    var body = document.createElement('div');
    body.className = 'sop-card__body';
    var metaItems = [
      ['Schedule', formatCron(paw.cron)],
      ['Next Run', paw.next_run ? timeAgo(paw.next_run) : '--'],
      ['Agent', paw.agent_id || '--'],
      ['Threshold', String(paw.config && paw.config.approval_threshold != null ? paw.config.approval_threshold : '--')],
    ];
    if (showProject && paw.project_id) {
      metaItems.push(['Project', paw.project_id]);
    }
    metaItems.forEach(function(pair) {
      var row = document.createElement('div');
      row.className = 'sop-meta';
      var l = document.createElement('span');
      l.textContent = pair[0];
      var v = document.createElement('span');
      v.textContent = pair[1];
      row.appendChild(l);
      row.appendChild(v);
      body.appendChild(row);
    });

    // Approval banner -- shows when paw is waiting for human decision
    if (paw.status === 'waiting_approval') {
      var approvalBanner = document.createElement('div');
      approvalBanner.className = 'paw-approval-banner';
      approvalBanner.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--accent);border-radius:6px;padding:12px;margin-top:8px;';

      // Fetch latest cycle findings for context
      (function(banner, pawId) {
        fetch('/api/v1/paws/' + encodeURIComponent(pawId))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var cycle = data.latest_cycle;
            if (cycle && cycle.findings && cycle.findings.length) {
              var findingsText = document.createElement('div');
              findingsText.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px;';
              var lines = cycle.findings
                .filter(function(f) { return f.severity >= (data.paw.config.approval_threshold || 3); })
                .map(function(f) { return f.title + ' (severity ' + f.severity + '/5)'; });
              findingsText.textContent = lines.length ? lines.join(', ') : 'Findings pending review';
              banner.insertBefore(findingsText, banner.firstChild);
            }
          })
          .catch(function() { /* ignore -- buttons still work */ });
      })(approvalBanner, paw.id);

      var approvalLabel = document.createElement('div');
      approvalLabel.style.cssText = 'font-size:0.75rem;font-weight:600;color:var(--accent);margin-bottom:8px;';
      approvalLabel.textContent = 'Waiting for your call';
      approvalBanner.appendChild(approvalLabel);

      var approvalBtns = document.createElement('div');
      approvalBtns.style.cssText = 'display:flex;gap:8px;';

      var approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn--sm btn--primary';
      approveBtn.textContent = 'Approve';
      approveBtn.onclick = function() { approvePaw(paw.id, true, approveBtn); };

      var skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn--sm btn--ghost';
      skipBtn.textContent = 'Skip';
      skipBtn.onclick = function() { approvePaw(paw.id, false, skipBtn); };

      approvalBtns.appendChild(approveBtn);
      approvalBtns.appendChild(skipBtn);
      approvalBanner.appendChild(approvalBtns);
      card.appendChild(approvalBanner);
    }

    var footer = document.createElement('div');
    footer.className = 'sop-card__footer';

    var statusBadge = document.createElement('span');
    statusBadge.className = 'sop-status ' + (paw.status || 'active');
    statusBadge.textContent = (paw.status || 'active').toUpperCase();

    var btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:6px;';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn--sm btn--ghost';
    toggleBtn.textContent = paw.status === 'paused' ? 'Resume' : 'Pause';
    toggleBtn.onclick = function() { togglePaw(paw.id, paw.status === 'waiting_approval' ? 'active' : paw.status, toggleBtn); };

    var runBtn = document.createElement('button');
    runBtn.className = 'btn btn--sm btn--primary';
    runBtn.textContent = 'Run Now';
    runBtn.onclick = function() { runPawNow(paw.id, runBtn); };

    var editBtn = document.createElement('button');
    editBtn.className = 'btn btn--sm btn--ghost';
    editBtn.textContent = 'Edit';
    editBtn.onclick = function() { openPawEditModal(paw); };

    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn--sm btn--ghost btn--danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = function() { confirmDeletePaw(paw.id, paw.name); };

    btnGroup.appendChild(toggleBtn);
    btnGroup.appendChild(runBtn);
    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(deleteBtn);

    footer.appendChild(statusBadge);
    footer.appendChild(btnGroup);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);
    grid.appendChild(card);
  });

  animateCardsStaggered(grid);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function approvePaw(id, approved, btn) {
  // Disable ALL approval buttons for this paw (prevents double-tap)
  var banner = btn.closest('.paw-approval-banner');
  if (banner) {
    var allBtns = banner.querySelectorAll('button');
    for (var i = 0; i < allBtns.length; i++) allBtns[i].disabled = true;
  }
  // Also disable any modal approval buttons
  var modalBtns = document.querySelectorAll('.modal-overlay button');
  for (var j = 0; j < modalBtns.length; j++) {
    if (modalBtns[j].textContent === 'Approve' || modalBtns[j].textContent === 'Skip') modalBtns[j].disabled = true;
  }
  btn.textContent = approved ? 'Approving...' : 'Skipping...';
  try {
    var res = await fetch('/api/v1/paws/' + encodeURIComponent(id) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: approved }),
    });
    if (res.ok) {
      // Replace entire banner with status message
      if (banner) {
        banner.textContent = '';
        var statusMsg = document.createElement('div');
        statusMsg.style.cssText = 'font-size:0.8rem;color:var(--accent);padding:4px 0;';
        statusMsg.textContent = approved ? 'Approved -- running ACT phase. This may take a minute.' : 'Skipped -- generating report.';
        banner.appendChild(statusMsg);
      }
      // Poll for completion instead of fixed delay
      var polls = 0;
      var pollInterval = setInterval(function() {
        polls++;
        if (polls > 30) { clearInterval(pollInterval); fetchPaws(); return; } // give up after 60s
        fetch('/api/v1/paws/' + encodeURIComponent(id))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.paw && data.paw.status !== 'waiting_approval') {
              clearInterval(pollInterval);
              fetchPaws();
            }
          })
          .catch(function() {});
      }, 2000);
    } else {
      var data = await res.json().catch(function() { return {}; });
      btn.textContent = data.error || 'Failed';
      btn.disabled = false;
    }
  } catch (err) {
    console.error('Approve paw error:', err);
    btn.textContent = 'Error';
    btn.disabled = false;
  }
}

async function togglePaw(id, currentStatus, btn) {
  var action = currentStatus === 'active' ? 'pause' : 'resume';
  btn.disabled = true;
  try {
    var res = await fetch('/api/v1/paws/' + id + '/' + action, { method: 'POST' });
    if (res.ok) fetchPaws();
  } catch (err) {
    console.error('Toggle paw error:', err);
  } finally {
    btn.disabled = false;
  }
}

async function runPawNow(id, btn) {
  btn.disabled = true;
  var origText = btn.textContent;
  btn.textContent = '';
  var spinner = document.createElement('span');
  spinner.className = 'sop-spinner';
  btn.appendChild(spinner);
  btn.appendChild(document.createTextNode(' Running\u2026'));
  btn.classList.add('running');
  try {
    const res = await fetch('/api/v1/paws/' + encodeURIComponent(id) + '/run-now', { method: 'POST' });
    if (!res.ok) {
      btn.textContent = 'Run failed';
      btn.disabled = false;
      if (btn.classList) btn.classList.remove('running');
      return;
    }
    btn.textContent = '\u2713 Triggered';
    btn.classList.remove('running');
    btn.classList.add('completed');
    setTimeout(function() {
      btn.textContent = origText;
      btn.disabled = false;
      btn.classList.remove('completed');
      fetchPaws();
    }, 4000);
  } catch (err) {
    btn.textContent = origText;
    btn.disabled = false;
    btn.classList.remove('running');
  }
}

function confirmDeletePaw(id, name) {
  var existing = document.getElementById('delete-confirm-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'delete-confirm-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card';
  box.style.cssText = 'width:min(400px,90vw);padding:20px;';

  var msg = document.createElement('p');
  msg.textContent = 'Delete "' + name + '"? This removes the paw and all its cycle history. This cannot be undone.';

  var actions = document.createElement('div');
  actions.className = 'modal-form__actions';

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn--sm btn--ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function() { overlay.remove(); };

  var confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn--sm btn--danger';
  confirmBtn.textContent = 'Delete';
  confirmBtn.onclick = async function() {
    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/v1/paws/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) {
        confirmBtn.disabled = false;
        return;
      }
      overlay.remove();
      fetchPaws();
    } catch (err) {
      console.error('Delete paw error:', err);
      confirmBtn.disabled = false;
    }
  };

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  box.appendChild(msg);
  box.appendChild(actions);
  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function openPawCreateModal() {
  var existing = document.getElementById('paw-crud-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'paw-crud-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card';
  box.style.cssText = 'width:min(560px,95vw);max-height:85vh;overflow-y:auto;padding:24px;';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
  var title = document.createElement('h3');
  title.style.margin = '0';
  title.textContent = 'New Paw';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--sm btn--ghost';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = function() { overlay.remove(); };
  hdr.appendChild(title);
  hdr.appendChild(closeBtn);

  var form = document.createElement('div');
  form.className = 'modal-form';

  function field(label, id, type, placeholder, value) {
    var el = document.createElement('div');
    el.className = 'modal-form__field';
    var lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.setAttribute('for', 'paw-' + id);
    var input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else if (type === 'select') {
      input = document.createElement('select');
    } else {
      input = document.createElement('input');
      input.type = type || 'text';
    }
    input.id = 'paw-' + id;
    if (placeholder) input.placeholder = placeholder;
    if (value !== undefined) input.value = value;
    el.appendChild(lbl);
    el.appendChild(input);
    return el;
  }

  var nameField = field('Name', 'name', 'text', 'e.g. Security Scanner');
  var idField = field('ID', 'id', 'text', 'auto-generated from name');
  var cronField = field('Schedule (cron)', 'cron', 'text', '0 */4 * * *');
  var cronPreview = document.createElement('div');
  cronPreview.className = 'modal-form__cron-preview';
  cronField.appendChild(cronPreview);

  nameField.querySelector('input').addEventListener('input', function() {
    document.getElementById('paw-id').value = this.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  });
  cronField.querySelector('input').addEventListener('input', function() {
    cronPreview.textContent = formatCron(this.value);
  });

  var agentField = field('Agent', 'agent', 'select');
  var agentSelect = agentField.querySelector('select');
  var defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select agent...';
  agentSelect.appendChild(defaultOpt);
  if (typeof AGENTS === 'object' && AGENTS) {
    var projectId = currentProject.id || 'default';
    var projectAgents = Object.entries(AGENTS).filter(function(entry) {
      var agentId = entry[0];
      if (projectId === 'default' || projectId === '') return !agentId.includes('--');
      return agentId.startsWith(projectId + '--');
    });
    projectAgents.forEach(function(entry) {
      var agentId = entry[0], agentDef = entry[1];
      var opt = document.createElement('option');
      opt.value = agentId;
      opt.textContent = agentDef.label || agentId;
      agentSelect.appendChild(opt);
    });
  }

  var chatField = field('Chat ID', 'chat-id', 'text', 'Telegram chat ID');
  var thresholdField = field('Approval Threshold', 'threshold', 'number', '7', '7');
  var timeoutField = field('Approval Timeout (sec)', 'timeout', 'number', '3600', '3600');

  var phaseToggle = document.createElement('button');
  phaseToggle.className = 'modal-form__section-toggle';
  phaseToggle.type = 'button';
  phaseToggle.textContent = '> Phase Instructions (optional)';
  var phaseBody = document.createElement('div');
  phaseBody.className = 'modal-form__section-body';
  phaseToggle.onclick = function() {
    phaseBody.classList.toggle('open');
    phaseToggle.textContent = (phaseBody.classList.contains('open') ? 'v' : '>') + ' Phase Instructions (optional)';
  };
  ['observe', 'analyze', 'decide', 'act', 'report'].forEach(function(phase) {
    phaseBody.appendChild(field(phase.charAt(0).toUpperCase() + phase.slice(1), 'phase-' + phase, 'textarea', 'Instructions for ' + phase + ' phase'));
  });

  var actions = document.createElement('div');
  actions.className = 'modal-form__actions';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn--sm btn--ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function() { overlay.remove(); };
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn--sm btn--primary';
  saveBtn.textContent = 'Create Paw';
  saveBtn.onclick = async function() {
    var id = document.getElementById('paw-id').value.trim();
    var name = document.getElementById('paw-name').value.trim();
    var agent = document.getElementById('paw-agent').value;
    var cron = document.getElementById('paw-cron').value.trim();
    var chatId = document.getElementById('paw-chat-id').value.trim();
    var threshold = parseInt(document.getElementById('paw-threshold').value) || 7;
    var timeout = parseInt(document.getElementById('paw-timeout').value) || 3600;

    if (!id || !name || !agent || !cron) {
      alert('Name, ID, Agent, and Schedule are required.');
      return;
    }

    var phaseInstructions = {};
    ['observe', 'analyze', 'decide', 'act', 'report'].forEach(function(p) {
      var val = document.getElementById('paw-phase-' + p).value.trim();
      if (val) phaseInstructions[p] = val;
    });

    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating...';
    try {
      var res = await fetch('/api/v1/paws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id, name: name, agent_id: agent, cron: cron,
          project_id: currentProject.id || 'default',
          config: {
            chat_id: chatId, approval_threshold: threshold,
            approval_timeout_sec: timeout,
            phase_instructions: Object.keys(phaseInstructions).length ? phaseInstructions : undefined,
          },
        }),
      });
      var data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to create paw');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Create Paw';
        return;
      }
      overlay.remove();
      fetchPaws();
    } catch (err) {
      console.error('Create paw error:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Paw';
    }
  };
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  form.appendChild(nameField);
  form.appendChild(idField);
  form.appendChild(agentField);
  form.appendChild(cronField);
  form.appendChild(chatField);
  form.appendChild(thresholdField);
  form.appendChild(timeoutField);
  form.appendChild(phaseToggle);
  form.appendChild(phaseBody);
  form.appendChild(actions);

  box.appendChild(hdr);
  box.appendChild(form);
  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openPawEditModal(paw) {
  var existing = document.getElementById('paw-crud-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'paw-crud-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card';
  box.style.cssText = 'width:min(560px,95vw);max-height:85vh;overflow-y:auto;padding:24px;';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
  var title = document.createElement('h3');
  title.style.margin = '0';
  title.textContent = 'Edit: ' + paw.name;
  var closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--sm btn--ghost';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = function() { overlay.remove(); };
  hdr.appendChild(title);
  hdr.appendChild(closeBtn);

  var form = document.createElement('div');
  form.className = 'modal-form';
  var cfg = paw.config || {};
  var pi = cfg.phase_instructions || {};

  function field(label, id, type, value) {
    var el = document.createElement('div');
    el.className = 'modal-form__field';
    var lbl = document.createElement('label');
    lbl.textContent = label;
    var input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else if (type === 'select') {
      input = document.createElement('select');
    } else {
      input = document.createElement('input');
      input.type = type || 'text';
    }
    input.id = 'edit-paw-' + id;
    if (value !== undefined && value !== null) input.value = value;
    el.appendChild(lbl);
    el.appendChild(input);
    return el;
  }

  var nameField = field('Name', 'name', 'text', paw.name);
  var cronField = field('Schedule (cron)', 'cron', 'text', paw.cron);
  var cronPreview = document.createElement('div');
  cronPreview.className = 'modal-form__cron-preview';
  cronPreview.textContent = formatCron(paw.cron);
  cronField.appendChild(cronPreview);
  cronField.querySelector('input').addEventListener('input', function() {
    cronPreview.textContent = formatCron(this.value);
  });

  var agentField = field('Agent', 'agent', 'select');
  var agentSelect = agentField.querySelector('select');
  if (typeof AGENTS === 'object' && AGENTS) {
    var projectId = currentProject.id || 'default';
    var projectAgents = Object.entries(AGENTS).filter(function(entry) {
      var agentId = entry[0];
      if (projectId === 'default' || projectId === '') return !agentId.includes('--');
      return agentId.startsWith(projectId + '--');
    });
    projectAgents.forEach(function(entry) {
      var agentId = entry[0], agentDef = entry[1];
      var opt = document.createElement('option');
      opt.value = agentId;
      opt.textContent = agentDef.label || agentId;
      if (agentId === paw.agent_id) opt.selected = true;
      agentSelect.appendChild(opt);
    });
  }

  var chatField = field('Chat ID', 'chat-id', 'text', cfg.chat_id || '');
  var thresholdField = field('Approval Threshold', 'threshold', 'number', cfg.approval_threshold != null ? cfg.approval_threshold : 7);
  var timeoutField = field('Approval Timeout (sec)', 'timeout', 'number', cfg.approval_timeout_sec != null ? cfg.approval_timeout_sec : 3600);

  var hasPhases = Object.keys(pi).length > 0;
  var phaseToggle = document.createElement('button');
  phaseToggle.className = 'modal-form__section-toggle';
  phaseToggle.type = 'button';
  phaseToggle.textContent = (hasPhases ? 'v' : '>') + ' Phase Instructions';
  var phaseBody = document.createElement('div');
  phaseBody.className = 'modal-form__section-body' + (hasPhases ? ' open' : '');
  phaseToggle.onclick = function() {
    phaseBody.classList.toggle('open');
    phaseToggle.textContent = (phaseBody.classList.contains('open') ? 'v' : '>') + ' Phase Instructions';
  };
  ['observe', 'analyze', 'decide', 'act', 'report'].forEach(function(phase) {
    phaseBody.appendChild(field(phase.charAt(0).toUpperCase() + phase.slice(1), 'phase-' + phase, 'textarea', pi[phase] || ''));
  });

  var actions = document.createElement('div');
  actions.className = 'modal-form__actions';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn--sm btn--ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function() { overlay.remove(); };
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn--sm btn--primary';
  saveBtn.textContent = 'Save Changes';
  saveBtn.onclick = async function() {
    var phaseInstructions = {};
    ['observe', 'analyze', 'decide', 'act', 'report'].forEach(function(p) {
      var val = document.getElementById('edit-paw-phase-' + p).value.trim();
      if (val) phaseInstructions[p] = val;
    });
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      var res = await fetch('/api/v1/paws/' + encodeURIComponent(paw.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('edit-paw-name').value.trim(),
          agent_id: document.getElementById('edit-paw-agent').value,
          cron: document.getElementById('edit-paw-cron').value.trim(),
          config: {
            chat_id: document.getElementById('edit-paw-chat-id').value.trim(),
            approval_threshold: parseInt(document.getElementById('edit-paw-threshold').value) || 7,
            approval_timeout_sec: parseInt(document.getElementById('edit-paw-timeout').value) || 3600,
            phase_instructions: Object.keys(phaseInstructions).length ? phaseInstructions : undefined,
          },
        }),
      });
      if (!res.ok) {
        var data = await res.json();
        alert(data.error || 'Failed to update paw');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
        return;
      }
      overlay.remove();
      fetchPaws();
    } catch (err) {
      console.error('Update paw error:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  };
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  form.appendChild(nameField);
  form.appendChild(agentField);
  form.appendChild(cronField);
  form.appendChild(chatField);
  form.appendChild(thresholdField);
  form.appendChild(timeoutField);
  form.appendChild(phaseToggle);
  form.appendChild(phaseBody);
  form.appendChild(actions);

  box.appendChild(hdr);
  box.appendChild(form);
  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openSopCreateModal() {
  var existing = document.getElementById('sop-crud-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'sop-crud-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card';
  box.style.cssText = 'width:min(560px,95vw);max-height:85vh;overflow-y:auto;padding:24px;';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
  var title = document.createElement('h3');
  title.style.margin = '0';
  title.textContent = 'New Cron Job';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--sm btn--ghost';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = function() { overlay.remove(); };
  hdr.appendChild(title);
  hdr.appendChild(closeBtn);

  var form = document.createElement('div');
  form.className = 'modal-form';

  function field(label, id, type, placeholder, value) {
    var el = document.createElement('div');
    el.className = 'modal-form__field';
    var lbl = document.createElement('label');
    lbl.textContent = label;
    var input;
    if (type === 'textarea') { input = document.createElement('textarea'); input.rows = 4; }
    else { input = document.createElement('input'); input.type = type || 'text'; }
    input.id = 'sop-' + id;
    if (placeholder) input.placeholder = placeholder;
    if (value !== undefined) input.value = value;
    el.appendChild(lbl); el.appendChild(input);
    return el;
  }

  var idField = field('ID (kebab-case)', 'id', 'text', 'e.g. daily-security-scan');
  var promptField = field('Prompt', 'prompt', 'textarea', 'The instruction to run on each execution...');
  var cronField = field('Schedule (cron)', 'cron', 'text', '0 9 * * *');
  var cronPreview = document.createElement('div');
  cronPreview.className = 'modal-form__cron-preview';
  cronField.appendChild(cronPreview);
  cronField.querySelector('input').addEventListener('input', function() {
    cronPreview.textContent = formatCron(this.value);
  });
  var chatField = field('Chat ID', 'chat-id', 'text', 'Telegram chat ID');

  var actions = document.createElement('div');
  actions.className = 'modal-form__actions';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn--sm btn--ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function() { overlay.remove(); };
  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn--sm btn--primary';
  saveBtn.textContent = 'Create Cron Job';
  saveBtn.onclick = async function() {
    var id = document.getElementById('sop-id').value.trim();
    var prompt = document.getElementById('sop-prompt').value.trim();
    var cron = document.getElementById('sop-cron').value.trim();
    var chatId = document.getElementById('sop-chat-id').value.trim();
    if (!id || !prompt || !cron || !chatId) { alert('All fields are required.'); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating...';
    try {
      var res = await fetch('/api/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, prompt: prompt, schedule: cron, chat_id: chatId, project_id: currentProject.id || 'default' }),
      });
      var data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to create cron job'); saveBtn.disabled = false; saveBtn.textContent = 'Create Cron Job'; return; }
      overlay.remove();
      fetchSOPs();
    } catch (err) {
      console.error('Create SOP error:', err);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Cron Job';
    }
  };
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  form.appendChild(idField);
  form.appendChild(promptField);
  form.appendChild(cronField);
  form.appendChild(chatField);
  form.appendChild(actions);

  box.appendChild(hdr);
  box.appendChild(form);
  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function openSopEditModal(taskId) {
  try {
    var res = await fetch('/api/v1/tasks/' + encodeURIComponent(taskId));
    if (!res.ok) return;
    var task = await res.json();

    var existing = document.getElementById('sop-crud-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'sop-crud-modal';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.className = 'modal-box card';
    box.style.cssText = 'width:min(560px,95vw);max-height:85vh;overflow-y:auto;padding:24px;';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    var title = document.createElement('h3');
    title.style.margin = '0';
    title.textContent = 'Edit: ' + formatTaskTitle(task.id);
    var closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--sm btn--ghost';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = function() { overlay.remove(); };
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);

    var form = document.createElement('div');
    form.className = 'modal-form';

    var idField = document.createElement('div');
    idField.className = 'modal-form__field';
    var idLabel = document.createElement('label'); idLabel.textContent = 'ID';
    var idVal = document.createElement('input'); idVal.type = 'text'; idVal.value = task.id; idVal.disabled = true; idVal.style.opacity = '0.5';
    idField.appendChild(idLabel); idField.appendChild(idVal);

    var promptField = document.createElement('div');
    promptField.className = 'modal-form__field';
    var promptLabel = document.createElement('label'); promptLabel.textContent = 'Prompt';
    var promptInput = document.createElement('textarea'); promptInput.id = 'edit-sop-prompt'; promptInput.rows = 6; promptInput.value = task.prompt || '';
    promptField.appendChild(promptLabel); promptField.appendChild(promptInput);

    var cronField = document.createElement('div');
    cronField.className = 'modal-form__field';
    var cronLabel = document.createElement('label'); cronLabel.textContent = 'Schedule (cron)';
    var cronInput = document.createElement('input'); cronInput.type = 'text'; cronInput.id = 'edit-sop-cron'; cronInput.value = task.schedule || '';
    var cronPreview = document.createElement('div'); cronPreview.className = 'modal-form__cron-preview'; cronPreview.textContent = formatCron(task.schedule);
    cronInput.addEventListener('input', function() { cronPreview.textContent = formatCron(this.value); });
    cronField.appendChild(cronLabel); cronField.appendChild(cronInput); cronField.appendChild(cronPreview);

    var chatField = document.createElement('div');
    chatField.className = 'modal-form__field';
    var chatLabel = document.createElement('label'); chatLabel.textContent = 'Chat ID';
    var chatInput = document.createElement('input'); chatInput.type = 'text'; chatInput.id = 'edit-sop-chat-id'; chatInput.value = task.chat_id || '';
    chatField.appendChild(chatLabel); chatField.appendChild(chatInput);

    var resultSection = document.createElement('div');
    resultSection.className = 'modal-detail__section';
    var resultTitle = document.createElement('h4'); resultTitle.textContent = 'Last Result';
    resultSection.appendChild(resultTitle);
    var resultBox = document.createElement('div');
    resultBox.className = 'modal-detail__result';
    resultBox.textContent = task.last_result || 'No results yet.';
    resultSection.appendChild(resultBox);

    var actions = document.createElement('div');
    actions.className = 'modal-form__actions';
    var cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn--sm btn--ghost'; cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function() { overlay.remove(); };
    var saveBtn = document.createElement('button'); saveBtn.className = 'btn btn--sm btn--primary'; saveBtn.textContent = 'Save Changes';
    saveBtn.onclick = async function() {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
      try {
        var r = await fetch('/api/v1/tasks/' + encodeURIComponent(task.id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: document.getElementById('edit-sop-prompt').value.trim(), schedule: document.getElementById('edit-sop-cron').value.trim(), chat_id: document.getElementById('edit-sop-chat-id').value.trim() }),
        });
        if (!r.ok) { var d = await r.json(); alert(d.error || 'Failed to update'); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; return; }
        overlay.remove(); fetchSOPs();
      } catch (err) { console.error('Update SOP error:', err); saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
    };
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);

    form.appendChild(idField); form.appendChild(promptField); form.appendChild(cronField); form.appendChild(chatField); form.appendChild(resultSection); form.appendChild(actions);

    box.appendChild(hdr); box.appendChild(form);
    overlay.appendChild(box);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  } catch (err) { console.error('Edit SOP modal error:', err); }
}

function confirmDeleteSop(taskId) {
  var existing = document.getElementById('delete-confirm-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'delete-confirm-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card';
  box.style.cssText = 'width:min(400px,90vw);padding:20px;';

  var msg = document.createElement('p');
  msg.textContent = 'Delete "' + formatTaskTitle(taskId) + '"? This cannot be undone.';

  var actions = document.createElement('div');
  actions.className = 'modal-form__actions';
  var cancelBtn = document.createElement('button'); cancelBtn.className = 'btn btn--sm btn--ghost'; cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function() { overlay.remove(); };
  var confirmBtn = document.createElement('button'); confirmBtn.className = 'btn btn--sm btn--danger'; confirmBtn.textContent = 'Delete';
  confirmBtn.onclick = async function() {
    confirmBtn.disabled = true;
    try {
      await fetch('/api/v1/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' });
      overlay.remove(); fetchSOPs();
    } catch (err) { console.error('Delete SOP error:', err); confirmBtn.disabled = false; }
  };
  actions.appendChild(cancelBtn); actions.appendChild(confirmBtn);
  box.appendChild(msg); box.appendChild(actions);
  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function openPawDetailModal(pawId) {
  try {
    var res = await fetch('/api/v1/paws/' + encodeURIComponent(pawId));
    if (!res.ok) return;
    var data = await res.json();
    var paw = data.paw;
    var latestCycle = data.latest_cycle;

    var existing = document.getElementById('paw-detail-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'paw-detail-modal';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.className = 'modal-box card';
    box.style.cssText = 'width:min(680px,95vw);max-height:85vh;overflow-y:auto;padding:24px;';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    var title = document.createElement('h3');
    title.style.margin = '0';
    title.textContent = paw.name;
    var closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--sm btn--ghost';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = function() { overlay.remove(); };
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);
    box.appendChild(hdr);

    // Config section
    var cfgSection = document.createElement('div');
    cfgSection.className = 'modal-detail__section';
    var cfgTitle = document.createElement('h4');
    cfgTitle.textContent = 'Configuration';
    cfgSection.appendChild(cfgTitle);
    var cfg = paw.config || {};
    var cfgMeta = [
      ['ID', paw.id], ['Agent', paw.agent_id],
      ['Schedule', formatCron(paw.cron) + ' (' + paw.cron + ')'],
      ['Status', paw.status],
      ['Chat ID', cfg.chat_id || '--'],
      ['Approval Threshold', String(cfg.approval_threshold != null ? cfg.approval_threshold : '--')],
      ['Approval Timeout', (cfg.approval_timeout_sec || 3600) + 's'],
      ['Next Run', paw.next_run ? new Date(paw.next_run).toLocaleString() : '--'],
    ];
    cfgMeta.forEach(function(pair) {
      var row = document.createElement('div');
      row.className = 'sop-meta';
      row.style.marginBottom = '4px';
      var l = document.createElement('span'); l.textContent = pair[0];
      var v = document.createElement('span'); v.textContent = pair[1];
      row.appendChild(l); row.appendChild(v);
      cfgSection.appendChild(row);
    });

    var pi = cfg.phase_instructions || {};
    if (Object.keys(pi).length) {
      var piTitle = document.createElement('h4');
      piTitle.textContent = 'Phase Instructions';
      piTitle.style.marginTop = '12px';
      cfgSection.appendChild(piTitle);
      Object.keys(pi).forEach(function(phase) {
        var row = document.createElement('div');
        row.style.marginBottom = '6px';
        var label = document.createElement('strong');
        label.style.fontSize = '0.76rem';
        label.textContent = phase.charAt(0).toUpperCase() + phase.slice(1) + ': ';
        var val = document.createElement('span');
        val.style.cssText = 'font-size:0.76rem;color:var(--text-secondary);';
        val.textContent = pi[phase];
        row.appendChild(label); row.appendChild(val);
        cfgSection.appendChild(row);
      });
    }
    box.appendChild(cfgSection);

    // Approval action section -- only when waiting
    if (paw.status === 'waiting_approval') {
      var approvalSection = document.createElement('div');
      approvalSection.className = 'modal-detail__section';
      approvalSection.style.cssText = 'border:1px solid var(--accent);border-radius:6px;padding:16px;margin-bottom:12px;';

      var approvalTitle = document.createElement('h4');
      approvalTitle.style.cssText = 'color:var(--accent);margin:0 0 8px 0;';
      approvalTitle.textContent = 'Action Required';
      approvalSection.appendChild(approvalTitle);

      // Show findings that triggered approval
      if (latestCycle && latestCycle.findings && latestCycle.findings.length) {
        var findingsDiv = document.createElement('div');
        findingsDiv.style.cssText = 'margin-bottom:12px;';
        var findingsLabel = document.createElement('div');
        findingsLabel.style.cssText = 'font-size:0.8rem;font-weight:600;margin-bottom:4px;';
        findingsLabel.textContent = 'What it found:';
        findingsDiv.appendChild(findingsLabel);

        var threshold = (paw.config && paw.config.approval_threshold) || 3;
        latestCycle.findings.forEach(function(f) {
          if (f.severity < threshold) return;
          var fRow = document.createElement('div');
          fRow.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);padding:2px 0;';
          fRow.textContent = '- ' + f.title + ' (severity ' + f.severity + '/5)';
          if (f.detail) {
            var detailEl = document.createElement('div');
            detailEl.style.cssText = 'font-size:0.75rem;color:var(--text-tertiary);padding-left:12px;';
            detailEl.textContent = f.detail.length > 300 ? f.detail.slice(0, 300) + '...' : f.detail;
            fRow.appendChild(detailEl);
          }
          findingsDiv.appendChild(fRow);
        });
        approvalSection.appendChild(findingsDiv);
      }

      // Show proposed actions from decisions
      if (latestCycle && latestCycle.state && latestCycle.state.decisions) {
        var actDecisions = latestCycle.state.decisions.filter(function(d) { return d.action === 'act'; });
        if (actDecisions.length) {
          var actionsDiv = document.createElement('div');
          actionsDiv.style.cssText = 'margin-bottom:12px;';
          var actionsLabel = document.createElement('div');
          actionsLabel.style.cssText = 'font-size:0.8rem;font-weight:600;margin-bottom:4px;';
          actionsLabel.textContent = 'What it wants to do:';
          actionsDiv.appendChild(actionsLabel);
          actDecisions.forEach(function(d) {
            var aRow = document.createElement('div');
            aRow.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);padding:2px 0;';
            aRow.textContent = '- ' + d.reason;
            actionsDiv.appendChild(aRow);
          });
          approvalSection.appendChild(actionsDiv);
        }
      }

      var modalApprovalBtns = document.createElement('div');
      modalApprovalBtns.style.cssText = 'display:flex;gap:8px;';

      var modalApproveBtn = document.createElement('button');
      modalApproveBtn.className = 'btn btn--sm btn--primary';
      modalApproveBtn.textContent = 'Approve';
      modalApproveBtn.onclick = function() {
        approvePaw(paw.id, true, modalApproveBtn);
        setTimeout(function() { overlay.remove(); }, 1500);
      };

      var modalSkipBtn = document.createElement('button');
      modalSkipBtn.className = 'btn btn--sm btn--ghost';
      modalSkipBtn.textContent = 'Skip';
      modalSkipBtn.onclick = function() {
        approvePaw(paw.id, false, modalSkipBtn);
        setTimeout(function() { overlay.remove(); }, 1500);
      };

      modalApprovalBtns.appendChild(modalApproveBtn);
      modalApprovalBtns.appendChild(modalSkipBtn);
      approvalSection.appendChild(modalApprovalBtns);
      box.appendChild(approvalSection);
    }

    // Latest cycle section
    var cycleSection = document.createElement('div');
    cycleSection.className = 'modal-detail__section';
    var cycleTitle = document.createElement('h4');
    cycleTitle.textContent = 'Latest Cycle';
    cycleSection.appendChild(cycleTitle);

    if (latestCycle) {
      var cycleMeta = [
        ['Started', new Date(latestCycle.started_at).toLocaleString()],
        ['Phase', latestCycle.phase],
        ['Findings', String(latestCycle.findings ? latestCycle.findings.length : 0)],
      ];
      if (latestCycle.completed_at) cycleMeta.push(['Completed', new Date(latestCycle.completed_at).toLocaleString()]);
      cycleMeta.forEach(function(pair) {
        var row = document.createElement('div');
        row.className = 'sop-meta'; row.style.marginBottom = '4px';
        var l = document.createElement('span'); l.textContent = pair[0];
        var v = document.createElement('span'); v.textContent = pair[1];
        row.appendChild(l); row.appendChild(v);
        cycleSection.appendChild(row);
      });

      if (latestCycle.report) {
        var rptEl = document.createElement('div');
        rptEl.className = 'modal-detail__result';
        rptEl.textContent = latestCycle.report;
        cycleSection.appendChild(rptEl);
      }
      if (latestCycle.error) {
        var errEl = document.createElement('div');
        errEl.className = 'modal-detail__result';
        errEl.style.borderColor = 'var(--red)';
        errEl.textContent = 'Error: ' + latestCycle.error;
        cycleSection.appendChild(errEl);
      }

      if (latestCycle.findings && latestCycle.findings.length) {
        var fTitle = document.createElement('h4');
        fTitle.textContent = 'Findings'; fTitle.style.marginTop = '10px';
        cycleSection.appendChild(fTitle);
        latestCycle.findings.forEach(function(f) {
          var item = document.createElement('div');
          item.className = 'finding-item';
          var fhdr = document.createElement('div');
          fhdr.className = 'finding-item__header';
          var ftitle = document.createElement('span');
          ftitle.className = 'finding-item__title';
          ftitle.textContent = f.title;
          var fsev = document.createElement('span');
          fsev.className = 'finding-item__severity' + (f.severity >= 7 ? ' high' : '');
          fsev.textContent = 'Sev ' + f.severity;
          fhdr.appendChild(ftitle); fhdr.appendChild(fsev);
          item.appendChild(fhdr);
          if (f.detail) {
            var fd = document.createElement('div');
            fd.className = 'finding-item__detail';
            fd.textContent = f.detail;
            item.appendChild(fd);
          }
          cycleSection.appendChild(item);
        });
      }
    } else {
      var noData = document.createElement('p');
      noData.style.opacity = '0.5';
      noData.textContent = 'No cycles recorded yet.';
      cycleSection.appendChild(noData);
    }
    box.appendChild(cycleSection);

    var allCyclesBtn = document.createElement('button');
    allCyclesBtn.className = 'btn btn--sm btn--ghost';
    allCyclesBtn.textContent = 'View All Cycles';
    allCyclesBtn.style.marginBottom = '10px';
    allCyclesBtn.onclick = function() { overlay.remove(); loadPawCycles(paw.id, paw.name); };
    box.appendChild(allCyclesBtn);

    overlay.appendChild(box);
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  } catch (err) {
    console.error('Paw detail error:', err);
  }
}

document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action="create-paw"]');
  if (btn) { openPawCreateModal(); return; }
});

async function loadPawCycles(pawId, pawName) {
  try {
    var res = await fetch('/api/v1/paws/' + encodeURIComponent(pawId) + '/cycles?limit=10');
    if (!res.ok) return;
    var data = await res.json();
    showPawCyclesModal(pawName, data.cycles || []);
  } catch (err) {
    console.error('Load paw cycles error:', err);
  }
}

function showPawCyclesModal(name, cycles) {
  var existing = document.getElementById('paw-cycles-modal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'paw-cycles-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.className = 'modal-box card';
  box.style.cssText = 'width:min(680px,95vw);max-height:80vh;overflow-y:auto;padding:20px;';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';

  var hTitle = document.createElement('h3');
  hTitle.style.margin = '0';
  hTitle.textContent = name + ' - Cycles';
  hdr.appendChild(hTitle);

  var closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-sm btn-secondary';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = function() { overlay.remove(); };
  hdr.appendChild(closeBtn);

  box.appendChild(hdr);

  if (!cycles.length) {
    var empty = document.createElement('p');
    empty.style.opacity = '0.6';
    empty.textContent = 'No cycles recorded yet.';
    box.appendChild(empty);
  } else {
    cycles.forEach(function(c, idx) {
      var cc = document.createElement('div');
      cc.className = 'card cycle-card';
      cc.style.marginBottom = '10px';

      var ch = document.createElement('div');
      ch.className = 'card-header';

      var cycleTitle = document.createElement('span');
      cycleTitle.className = 'card-title';
      cycleTitle.textContent = 'Cycle #' + (cycles.length - idx);

      var cycleTime = document.createElement('span');
      cycleTime.className = 'cycle-time';
      cycleTime.textContent = new Date(c.started_at).toLocaleString();

      ch.appendChild(cycleTitle);
      ch.appendChild(cycleTime);

      var phase = document.createElement('div');
      phase.style.cssText = 'padding:8px 16px;font-size:0.85rem;opacity:0.7;';
      phase.textContent = 'Phase: ' + c.phase + (c.completed_at ? ' | Completed' : c.error ? ' | Failed' : ' | In Progress');

      cc.appendChild(ch);
      cc.appendChild(phase);

      if (c.report) {
        var rpt = document.createElement('div');
        rpt.className = 'cycle-report';
        rpt.style.padding = '0 16px 12px';
        rpt.textContent = c.report;
        cc.appendChild(rpt);
      }
      if (c.error) {
        var errEl = document.createElement('div');
        errEl.className = 'cycle-error';
        errEl.style.padding = '0 16px 12px';
        errEl.textContent = 'Error: ' + c.error;
        cc.appendChild(errEl);
      }
      if (c.findings && c.findings.length) {
        var findingsEl = document.createElement('div');
        findingsEl.style.cssText = 'padding:0 16px 8px;font-size:0.78rem;';
        findingsEl.textContent = c.findings.length + ' finding' + (c.findings.length !== 1 ? 's' : '') +
          ' (' + c.findings.filter(function(f) { return f.severity >= 7; }).length + ' high severity)';
        cc.appendChild(findingsEl);
      }

      box.appendChild(cc);
    });
  }

  overlay.appendChild(box);
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function fetchSOPs() {
  try {
    var pq = getProjectQueryParam();
    var res = await fetch('/api/v1/tasks' + (pq ? '?' + pq : ''));
    if (!res.ok) return;
    var tasks = await res.json();
    renderSopCards(tasks);
  } catch (err) {
    console.error('Cron Jobs fetch error:', err);
  }
}

// ========== RESEARCH PAGE ==========

var rsDrawer = {
  openItemId: null,
  items: {},
  chat: {},
  drafts: {},
  pendingSave: {},

  open: async function(itemId) {
    this.openItemId = itemId;
    var drawer = document.getElementById('rs-drawer');
    if (!drawer) return;
    drawer.hidden = false;

    try {
      var res = await fetch('/api/v1/research/' + encodeURIComponent(itemId));
      if (!res.ok) { this.close(); return; }
      var item = await res.json();
      this.items[itemId] = item;
      this.renderAll(item);
      await this.loadChat(itemId, item);
      await this.loadDrafts(itemId);
    } catch (err) {
      console.error('rsDrawer open failed:', err);
    }
  },

  close: function() {
    var drawer = document.getElementById('rs-drawer');
    if (drawer) drawer.hidden = true;

    // Dismiss any open draft picker popover (it's a body-level child, survives drawer hide)
    var picker = document.getElementById('rs-draft-picker');
    if (picker) picker.remove();

    // Cancel the pending chat-timeout timer so it doesn't fire into a stale/other item
    var chatState = this.openItemId ? this.chat[this.openItemId] : null;
    if (chatState && chatState.agentRunningTimer) {
      clearTimeout(chatState.agentRunningTimer);
      chatState.agentRunningTimer = null;
      chatState.agentRunning = false;
    }

    this.flushPendingSave(this.openItemId);
    this.openItemId = null;
  },

  renderAll: function(item) {
    this.renderHeader(item);
    this.renderActionBar(item);
    this.renderDetails(item);
  },

  flushPendingSave: function(itemId) {
    if (!itemId || !this.pendingSave[itemId]) return;
    var payload = this.pendingSave[itemId];
    this.pendingSave[itemId] = null;
    fetch('/api/v1/research/' + encodeURIComponent(itemId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function(err){ console.error('rsDrawer save failed', err); });
  },

  patchField: async function(itemId, partial) {
    try {
      var res = await fetch('/api/v1/research/' + encodeURIComponent(itemId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (!res.ok) throw new Error('PATCH failed');
      var updated = await res.json();
      this.items[itemId] = updated;
      this.renderAll(updated);
      if (typeof ResearchPage !== 'undefined' && ResearchPage.load) ResearchPage.load();
    } catch (err) {
      console.error('rsDrawer patchField:', err);
    }
  },

  showDraftPicker: function(item, anchor) {
    var existing = document.getElementById('rs-draft-picker');
    if (existing) { existing.remove(); return; }

    var picker = document.createElement('div');
    picker.id = 'rs-draft-picker';
    picker.style.cssText = 'position:fixed;background:var(--surface-elevated);border:1px solid var(--border-subtle);border-radius:6px;padding:6px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
    var formats = [
      { key: 'blog', label: 'Blog post' },
      { key: 'youtube', label: 'YouTube script' },
      { key: 'linkedin', label: 'LinkedIn post' },
      { key: 'tweet', label: 'Tweet thread' },
      { key: 'newsletter', label: 'Newsletter section' },
    ];
    formats.forEach(function(f) {
      var btn = document.createElement('button');
      btn.className = 'rs-drawer__action-btn';
      btn.style.cssText = 'display:block;width:100%;margin-bottom:4px;text-align:left;';
      btn.textContent = f.label;
      btn.onclick = function() { picker.remove(); rsDrawer.createDraft(item.id, f.key); };
      picker.appendChild(btn);
    });

    var rect = anchor.getBoundingClientRect();
    picker.style.left = rect.left + 'px';
    picker.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(picker);

    var dismiss = function(ev) {
      if (!picker.contains(ev.target) && ev.target !== anchor) {
        picker.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    setTimeout(function(){ document.addEventListener('click', dismiss); }, 0);
  },

  createDraft: async function(itemId, format) {
    try {
      var res = await fetch('/api/v1/research/' + encodeURIComponent(itemId) + '/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: format }),
      });
      if (!res.ok) throw new Error('Draft request failed');
      await this.loadDrafts(itemId);
    } catch (err) {
      console.error('rsDrawer createDraft:', err);
    }
  },

  triggerInvestigate: async function(itemId, btn) {
    btn.disabled = true;
    btn.textContent = 'Investigating...';
    try {
      var res = await fetch('/api/v1/research/' + encodeURIComponent(itemId) + '/investigate', { method: 'POST' });
      if (res.status === 429) {
        var data = await res.json();
        alert(data.message || 'Investigation cooldown.');
        btn.disabled = false;
        btn.textContent = 'Deeper investigation';
      }
    } catch (err) {
      console.error('rsDrawer triggerInvestigate:', err);
      btn.disabled = false;
      btn.textContent = 'Deeper investigation';
    }
  },

  renderHeader: function(item) {
    var drawer = document.getElementById('rs-drawer');
    if (!drawer) return;
    drawer.classList.toggle('rs-drawer--archived', item.status === 'archived');

    var title = drawer.querySelector('[data-bind="rs-title"]');
    if (title) title.textContent = item.topic;

    var meta = drawer.querySelector('[data-bind="rs-meta"]');
    if (meta) {
      var d = new Date(item.created_at);
      var parts = [];
      if (item.source) parts.push(item.source);
      if (item.category) parts.push(item.category);
      parts.push('Found ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      parts.push('Score ' + item.score);
      meta.textContent = parts.join(' \u00B7 ');
    }

    var statusSel = drawer.querySelector('[data-bind="rs-status"]');
    if (statusSel) {
      statusSel.value = item.status;
      statusSel.onchange = function() {
        rsDrawer.patchField(item.id, { status: statusSel.value });
      };
    }
  },
  renderActionBar: function(item) {
    var bar = document.querySelector('#rs-drawer [data-bind="rs-actionbar"]');
    if (!bar) return;
    bar.replaceChildren();

    var stages = ['idea', 'draft', 'scheduled', 'live'];
    stages.forEach(function(stage) {
      var btn = document.createElement('button');
      btn.className = 'rs-drawer__action-btn';
      if (item.pipeline === stage) btn.classList.add('rs-drawer__action-btn--active');
      btn.textContent = stage.charAt(0).toUpperCase() + stage.slice(1);
      btn.onclick = function() {
        var next = item.pipeline === stage ? null : stage;
        rsDrawer.patchField(item.id, { pipeline: next });
      };
      bar.appendChild(btn);
    });

    var draftBtn = document.createElement('button');
    draftBtn.className = 'rs-drawer__action-btn';
    draftBtn.textContent = 'Draft content \u25BE';
    draftBtn.onclick = function() { rsDrawer.showDraftPicker(item, draftBtn); };
    bar.appendChild(draftBtn);

    var invBtn = document.createElement('button');
    invBtn.className = 'rs-drawer__action-btn';
    invBtn.dataset.action = 'investigate';
    invBtn.textContent = 'Deeper investigation';
    var now = Date.now();
    var COOLDOWN = 60 * 60 * 1000;
    if (item.last_investigated_at && now - item.last_investigated_at < COOLDOWN) {
      var mins = Math.ceil((COOLDOWN - (now - item.last_investigated_at)) / 60000);
      invBtn.disabled = true;
      invBtn.title = 'Cooldown: ' + mins + 'm remaining';
    }
    invBtn.onclick = function() { rsDrawer.triggerInvestigate(item.id, invBtn); };
    bar.appendChild(invBtn);

    if (item.status !== 'archived') {
      var archBtn = document.createElement('button');
      archBtn.className = 'rs-drawer__action-btn';
      archBtn.textContent = 'Archive';
      archBtn.onclick = function() {
        var reason = window.prompt('Archive reason (optional):', '');
        var notes = item.notes || '';
        if (reason) notes += '\n\n[Archived: ' + reason + ']';
        rsDrawer.patchField(item.id, { status: 'archived', notes: notes });
      };
      bar.appendChild(archBtn);
    }
  },
  renderDetails: function(item) {
    var details = document.querySelector('#rs-drawer [data-bind="rs-details"]');
    if (!details) return;
    details.replaceChildren();

    // Must match research_items.category CHECK constraint in server DB
    var categories = ['cyber', 'ai', 'tools', 'general', 'real-estate', 'business'];
    var self = this;

    // Notes (debounced autosave)
    var notesWrap = document.createElement('div');
    notesWrap.className = 'rs-drawer__field';
    var notesLabel = document.createElement('label');
    notesLabel.textContent = 'Notes';
    var notesSaved = document.createElement('span');
    notesSaved.className = 'rs-drawer__saved-indicator';
    notesSaved.textContent = 'Saved';
    notesLabel.appendChild(notesSaved);
    notesWrap.appendChild(notesLabel);
    var notesArea = document.createElement('textarea');
    notesArea.value = item.notes || '';
    var notesTimer = null;
    notesArea.addEventListener('input', function() {
      clearTimeout(notesTimer);
      self.pendingSave[item.id] = Object.assign(self.pendingSave[item.id] || {}, { notes: notesArea.value });
      notesTimer = setTimeout(function() {
        self.patchField(item.id, { notes: notesArea.value });
        self.pendingSave[item.id] = null;
        notesSaved.classList.add('rs-drawer__saved-indicator--visible');
        setTimeout(function(){ notesSaved.classList.remove('rs-drawer__saved-indicator--visible'); }, 2000);
      }, 500);
    });
    notesArea.addEventListener('blur', function() {
      if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
      if (self.pendingSave[item.id]) {
        self.patchField(item.id, self.pendingSave[item.id]);
        self.pendingSave[item.id] = null;
      }
    });
    notesWrap.appendChild(notesArea);
    details.appendChild(notesWrap);

    // Competitor
    var compWrap = document.createElement('div');
    compWrap.className = 'rs-drawer__field';
    var compLabel = document.createElement('label');
    compLabel.textContent = 'Competitor';
    compWrap.appendChild(compLabel);
    var compInput = document.createElement('input');
    compInput.type = 'text';
    compInput.value = item.competitor || '';
    compInput.addEventListener('blur', function() {
      if (compInput.value !== (item.competitor || '')) {
        self.patchField(item.id, { competitor: compInput.value });
      }
    });
    compWrap.appendChild(compInput);
    details.appendChild(compWrap);

    // Category
    var catWrap = document.createElement('div');
    catWrap.className = 'rs-drawer__field';
    var catLabel = document.createElement('label');
    catLabel.textContent = 'Category';
    catWrap.appendChild(catLabel);
    var catSel = document.createElement('select');
    var cats = categories.slice();
    if (cats.indexOf(item.category) === -1 && item.category) cats.push(item.category);
    cats.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      if (c === item.category) opt.selected = true;
      catSel.appendChild(opt);
    });
    catSel.addEventListener('change', function() { self.patchField(item.id, { category: catSel.value }); });
    catWrap.appendChild(catSel);
    details.appendChild(catWrap);

    // Score
    var scoreWrap = document.createElement('div');
    scoreWrap.className = 'rs-drawer__field';
    var scoreLabel = document.createElement('label');
    scoreLabel.textContent = 'Score (Scout set ' + item.score + ')';
    scoreWrap.appendChild(scoreLabel);
    var scoreInput = document.createElement('input');
    scoreInput.type = 'number';
    scoreInput.min = '0';
    scoreInput.max = '100';
    scoreInput.value = item.score;
    scoreInput.addEventListener('blur', function() {
      var n = parseInt(scoreInput.value, 10);
      if (!isNaN(n) && n >= 0 && n <= 100 && n !== item.score) {
        self.patchField(item.id, { score: n });
      }
    });
    scoreWrap.appendChild(scoreInput);
    details.appendChild(scoreWrap);

    // Source URL
    if (item.source_url) {
      var srcWrap = document.createElement('div');
      srcWrap.className = 'rs-drawer__field';
      var srcLabel = document.createElement('label');
      srcLabel.textContent = 'Source';
      srcWrap.appendChild(srcLabel);
      var a = document.createElement('a');
      a.href = item.source_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = item.source_url;
      a.style.fontSize = '12px';
      srcWrap.appendChild(a);
      details.appendChild(srcWrap);
    }
  },
  loadChat: async function(itemId, item) {
    try {
      var res = await fetch('/api/v1/research/' + encodeURIComponent(itemId) + '/chat');
      if (!res.ok) throw new Error('chat history fetch failed');
      var data = await res.json();
      this.chat[itemId] = this.chat[itemId] || { messages: [], agentRunning: false, agentRunningTimer: null };
      this.chat[itemId].messages = data.messages || [];

      if (this.chat[itemId].messages.length === 0 && item) {
        var dayMs = 24 * 60 * 60 * 1000;
        var age = Date.now() - item.created_at;
        var when = age < dayMs ? 'today' : age < 7 * dayMs ? Math.floor(age / dayMs) + ' days ago' : 'earlier';
        this.chat[itemId].messages = [{
          id: 'template-0',
          item_id: itemId,
          role: 'agent',
          body: 'Found this on ' + (item.source || 'the web') + ' ' + when + '. Scored it ' + item.score + '/100. Want me to dig deeper, draft something, or just park it?',
          agent_job: null,
          created_at: Date.now(),
        }];
      }

      this.renderChat(itemId);
      this.wireChatSend(itemId);
    } catch (err) {
      console.error('rsDrawer loadChat:', err);
    }
  },

  renderChat: function(itemId) {
    var container = document.querySelector('#rs-drawer [data-bind="rs-chat-messages"]');
    if (!container) return;
    container.replaceChildren();
    var state = this.chat[itemId] || { messages: [] };
    state.messages.forEach(function(m) {
      var div = document.createElement('div');
      div.className = 'rs-drawer__chat-msg rs-drawer__chat-msg--' + m.role;
      var role = document.createElement('div');
      role.className = 'rs-drawer__chat-msg-role';
      role.textContent = m.role === 'agent' ? 'Scout' : m.role === 'user' ? 'You' : 'Assistant';
      div.appendChild(role);
      var body = document.createElement('div');
      body.textContent = m.body;
      body.style.whiteSpace = 'pre-wrap';
      div.appendChild(body);
      container.appendChild(div);
    });
    if (state.agentRunning) {
      var thinking = document.createElement('div');
      thinking.className = 'rs-drawer__chat-msg';
      thinking.textContent = 'Scout is thinking...';
      container.appendChild(thinking);
    }
    container.scrollTop = container.scrollHeight;
  },

  wireChatSend: function(itemId) {
    var input = document.querySelector('#rs-drawer [data-bind="rs-chat-input"]');
    var sendBtn = document.querySelector('#rs-drawer [data-bind="rs-chat-send"]');
    if (!input || !sendBtn) return;
    var self = this;

    sendBtn.disabled = false;
    input.disabled = false;
    input.value = '';

    sendBtn.onclick = function() { self.sendChat(itemId); };
    input.onkeydown = function(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        self.sendChat(itemId);
      }
    };
  },

  sendChat: async function(itemId) {
    var input = document.querySelector('#rs-drawer [data-bind="rs-chat-input"]');
    var sendBtn = document.querySelector('#rs-drawer [data-bind="rs-chat-send"]');
    if (!input || !sendBtn) return;
    var message = input.value.trim();
    if (!message) return;

    var state = this.chat[itemId] = this.chat[itemId] || { messages: [], agentRunning: false, agentRunningTimer: null };
    state.messages.push({
      id: 'local-' + Date.now(),
      item_id: itemId,
      role: 'user',
      body: message,
      agent_job: null,
      created_at: Date.now(),
    });
    state.agentRunning = true;
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;
    this.renderChat(itemId);

    if (state.agentRunningTimer) clearTimeout(state.agentRunningTimer);
    state.agentRunningTimer = setTimeout(function() {
      state.agentRunning = false;
      state.messages.push({
        id: 'timeout-' + Date.now(),
        item_id: itemId,
        role: 'assistant',
        body: 'Scout did not respond within 60s. Try sending again.',
        agent_job: null,
        created_at: Date.now(),
      });
      if (rsDrawer.openItemId === itemId) rsDrawer.renderChat(itemId);
      input.disabled = false; sendBtn.disabled = false;
    }, 60000);

    try {
      await fetch('/api/v1/research/' + encodeURIComponent(itemId) + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message }),
      });
    } catch (err) {
      console.error('rsDrawer sendChat:', err);
      state.agentRunning = false;
      clearTimeout(state.agentRunningTimer);
      input.disabled = false; sendBtn.disabled = false;
    }
  },
  loadDrafts: async function(itemId) {
    try {
      var res = await fetch('/api/v1/research/' + encodeURIComponent(itemId) + '/drafts');
      if (!res.ok) return;
      var data = await res.json();
      this.drafts[itemId] = data.drafts || [];
      this.renderDrafts(itemId);
    } catch (err) {
      console.error('rsDrawer loadDrafts:', err);
    }
  },

  renderDrafts: function(itemId) {
    var section = document.querySelector('#rs-drawer [data-bind="rs-drafts"]');
    var list = document.querySelector('#rs-drawer [data-bind="rs-drafts-list"]');
    if (!section || !list) return;
    var drafts = this.drafts[itemId] || [];

    if (drafts.length === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    list.replaceChildren();
    drafts.forEach(function(d) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#action-plan/' + encodeURIComponent(d.id);
      a.textContent = d.title;
      li.appendChild(a);
      var statusSpan = document.createElement('span');
      statusSpan.style.cssText = 'color:var(--text-muted);margin-left:8px;font-size:11px;';
      statusSpan.textContent = d.status;
      li.appendChild(statusSpan);
      list.appendChild(li);
    });
  },
};

var ResearchPage = {
  data: { items: [], stats: null },
  filters: { category: '', status: '', pipeline: '' },
  sort: { field: 'score', dir: 'desc' },

  getSortedItems() {
    var items = this.data.items.slice();
    var { field, dir } = this.sort;
    items.sort(function(a, b) {
      var av = a[field] ?? '';
      var bv = b[field] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') {
        return dir === 'asc' ? av - bv : bv - av;
      }
      av = String(av).toLowerCase();
      bv = String(bv).toLowerCase();
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return items;
  },

  applySort(field) {
    if (this.sort.field === field) {
      this.sort.dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sort.field = field;
      this.sort.dir = field === 'score' || field === 'created_at' ? 'desc' : 'asc';
    }
    this.updateSortIndicators();
    this.render();
  },

  updateSortIndicators() {
    var ths = document.querySelectorAll('.research-th-sortable');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var ind = th.querySelector('.sort-indicator');
      if (!ind) continue;
      if (th.dataset.sortField === this.sort.field) {
        ind.textContent = this.sort.dir === 'asc' ? '↑' : '↓';
        th.classList.add('research-th--active');
      } else {
        ind.textContent = '';
        th.classList.remove('research-th--active');
      }
    }
  },

  async load() {
    try {
      var params = new URLSearchParams();
      if (this.filters.category) params.set('category', this.filters.category);
      if (this.filters.status) params.set('status', this.filters.status);
      if (this.filters.pipeline) params.set('pipeline', this.filters.pipeline);
      var pid = currentProject.id;
      if (pid) params.set('project_id', pid);
      var qs = params.toString();
      var url = '/api/v1/research' + (qs ? '?' + qs : '');
      var statsQs = pid ? '?project_id=' + encodeURIComponent(pid) : '';
      var [itemsRes, statsRes] = await Promise.all([
        fetch(url),
        fetch('/api/v1/research/stats' + statsQs)
      ]);
      var itemsData = await itemsRes.json();
      this.data.items = itemsData.items || [];
      this.data.stats = await statsRes.json();
      this.render();
      this.renderStats();
      this.renderPipeline();
      this.renderCompetitors();
    } catch (err) {
      console.error('Research load error:', err);
    }
  },

  renderStats() {
    var s = this.data.stats;
    if (!s) return;
    var el = function(b) { return document.querySelector('[data-bind="' + b + '"]'); };
    var totalEl = el('research-stat-total');
    var oppEl = el('research-stat-opportunities');
    var pipeEl = el('research-stat-pipeline');
    var pubEl = el('research-stat-published');
    var countEl = el('research-item-count');

    if (totalEl) totalEl.textContent = s.total;
    if (oppEl) oppEl.textContent = s.by_status.opportunity || 0;
    if (pipeEl) {
      var pipeTotal = 0;
      for (var k in s.by_pipeline) pipeTotal += s.by_pipeline[k];
      pipeEl.textContent = pipeTotal;
    }
    if (pubEl) pubEl.textContent = s.by_status.published || 0;
    if (countEl) countEl.textContent = s.total + ' items';
  },

  render() {
    var tbody = document.querySelector('[data-bind="research-table-body"]');
    if (!tbody) return;
    tbody.textContent = '';

    var items = this.getSortedItems();
    if (items.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 8;
      emptyTd.className = 'research-table-empty';
      emptyTd.textContent = 'No research items found';
      emptyRow.appendChild(emptyTd);
      tbody.appendChild(emptyRow);
      return;
    }

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var tr = document.createElement('tr');
      tr.dataset.status = item.status;
      tr.dataset.id = item.id;
      tr.style.cursor = 'pointer';

      // Topic
      var tdTopic = document.createElement('td');
      tdTopic.className = 'research-topic-cell';
      if (item.source_url) {
        var a = document.createElement('a');
        a.href = item.source_url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = item.topic;
        a.className = 'research-topic-link';
        tdTopic.appendChild(a);
      } else {
        tdTopic.textContent = item.topic;
      }
      tr.appendChild(tdTopic);

      // Source
      var tdSource = document.createElement('td');
      tdSource.textContent = item.source;
      tr.appendChild(tdSource);

      // Category
      var tdCat = document.createElement('td');
      var catSpan = document.createElement('span');
      catSpan.className = 'research-tag research-tag--' + item.category;
      catSpan.textContent = item.category.toUpperCase();
      tdCat.appendChild(catSpan);
      tr.appendChild(tdCat);

      // Score
      var tdScore = document.createElement('td');
      var scoreSpan = document.createElement('span');
      scoreSpan.className = 'research-score';
      if (item.score >= 80) scoreSpan.classList.add('research-score--high');
      else if (item.score >= 50) scoreSpan.classList.add('research-score--mid');
      else scoreSpan.classList.add('research-score--low');
      scoreSpan.textContent = item.score;
      tdScore.appendChild(scoreSpan);
      tr.appendChild(tdScore);

      // Status
      var tdStatus = document.createElement('td');
      var statusSpan = document.createElement('span');
      statusSpan.className = 'research-tag research-tag--' + item.status;
      statusSpan.textContent = item.status.charAt(0).toUpperCase() + item.status.slice(1);
      tdStatus.appendChild(statusSpan);
      tr.appendChild(tdStatus);

      // Pipeline
      var tdPipe = document.createElement('td');
      if (item.pipeline) {
        var pipeSpan = document.createElement('span');
        pipeSpan.className = 'research-tag research-tag--pipe-' + item.pipeline;
        pipeSpan.textContent = item.pipeline.charAt(0).toUpperCase() + item.pipeline.slice(1);
        tdPipe.appendChild(pipeSpan);
      } else {
        tdPipe.textContent = '--';
        tdPipe.style.color = 'var(--text-muted)';
      }
      tr.appendChild(tdPipe);

      // Found date
      var tdDate = document.createElement('td');
      tdDate.className = 'research-date-cell';
      var d = new Date(item.created_at);
      tdDate.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      tr.appendChild(tdDate);

      // Actions
      var tdActions = document.createElement('td');
      tdActions.className = 'research-actions-cell';
      var statusSelect = document.createElement('select');
      statusSelect.className = 'research-status-select';
      statusSelect.dataset.itemId = item.id;
      var statuses = ['new', 'reviewing', 'opportunity', 'published', 'archived'];
      for (var si = 0; si < statuses.length; si++) {
        var opt = document.createElement('option');
        opt.value = statuses[si];
        opt.textContent = statuses[si].charAt(0).toUpperCase() + statuses[si].slice(1);
        if (statuses[si] === item.status) opt.selected = true;
        statusSelect.appendChild(opt);
      }
      tdActions.appendChild(statusSelect);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
    this.updateSortIndicators();

    var tbodyEl = document.querySelector('[data-bind="research-table-body"]');
    if (tbodyEl && tbodyEl.dataset.rsWired !== '1') {
      tbodyEl.dataset.rsWired = '1';
      tbodyEl.addEventListener('click', function(ev) {
        if (ev.target.closest('.research-topic-link')) return;
        if (ev.target.closest('.research-status-select')) return;
        var tr = ev.target.closest('tr');
        if (!tr || !tr.dataset.id) return;
        rsDrawer.open(tr.dataset.id);
      });
    }
  },

  renderPipeline() {
    var stages = ['idea', 'draft', 'scheduled', 'live'];
    for (var si = 0; si < stages.length; si++) {
      var stage = stages[si];
      var container = document.querySelector('[data-bind="pipeline-' + stage + '-items"]');
      var countEl = document.querySelector('[data-bind="pipeline-' + stage + '-count"]');
      if (!container) continue;
      container.textContent = '';

      var stageItems = this.data.items.filter(function(it) { return it.pipeline === stage; });
      if (countEl) countEl.textContent = stageItems.length;

      for (var i = 0; i < stageItems.length; i++) {
        var item = stageItems[i];
        var card = document.createElement('div');
        card.className = 'research-pipeline-card';
        card.dataset.id = item.id;

        var title = document.createElement('div');
        title.className = 'research-pipeline-card__title';
        title.textContent = item.topic;
        card.appendChild(title);

        var meta = document.createElement('div');
        meta.className = 'research-pipeline-card__meta';
        var catTag = document.createElement('span');
        catTag.className = 'research-tag research-tag--' + item.category + ' research-tag--sm';
        catTag.textContent = item.category.toUpperCase();
        meta.appendChild(catTag);
        var scoreTag = document.createElement('span');
        scoreTag.className = 'research-pipeline-card__score';
        scoreTag.textContent = item.score;
        meta.appendChild(scoreTag);
        card.appendChild(meta);

        container.appendChild(card);
      }

      if (stageItems.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'research-pipeline-empty';
        empty.textContent = 'No items';
        container.appendChild(empty);
      }
    }
  },

  renderCompetitors() {
    var tbody = document.querySelector('[data-bind="research-competitor-body"]');
    if (!tbody) return;
    tbody.textContent = '';

    var compItems = this.data.items.filter(function(it) { return it.competitor && it.competitor.trim() !== ''; });
    if (compItems.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 6;
      emptyTd.className = 'research-table-empty';
      emptyTd.textContent = 'No competitor data yet';
      emptyRow.appendChild(emptyTd);
      tbody.appendChild(emptyRow);
      return;
    }

    for (var i = 0; i < compItems.length; i++) {
      var item = compItems[i];
      var tr = document.createElement('tr');

      var tdTopic = document.createElement('td');
      tdTopic.textContent = item.topic;
      tr.appendChild(tdTopic);

      var tdComp = document.createElement('td');
      tdComp.className = 'research-competitor-name';
      tdComp.textContent = item.competitor;
      tr.appendChild(tdComp);

      var tdCat = document.createElement('td');
      var catSpan = document.createElement('span');
      catSpan.className = 'research-tag research-tag--' + item.category;
      catSpan.textContent = item.category.toUpperCase();
      tdCat.appendChild(catSpan);
      tr.appendChild(tdCat);

      var tdScore = document.createElement('td');
      tdScore.textContent = item.score;
      tr.appendChild(tdScore);

      var tdNotes = document.createElement('td');
      tdNotes.className = 'research-notes-cell';
      tdNotes.textContent = item.notes || '--';
      tr.appendChild(tdNotes);

      var tdStatus = document.createElement('td');
      var statusSpan = document.createElement('span');
      statusSpan.className = 'research-tag research-tag--' + item.status;
      statusSpan.textContent = item.status.charAt(0).toUpperCase() + item.status.slice(1);
      tdStatus.appendChild(statusSpan);
      tr.appendChild(tdStatus);

      tbody.appendChild(tr);
    }
  },

  async updateStatus(itemId, newStatus) {
    try {
      await fetch('/api/v1/research/' + itemId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      this.load();
    } catch (err) {
      console.error('Research status update error:', err);
    }
  }
};

// ── Research Upcoming Tasks Bar ──

async function renderResearchUpcoming() {
  var container = document.querySelector('[data-bind="research-upcoming"]');
  if (!container) return;

  try {
    var pq = getProjectQueryParam();
    var res = await fetch('/api/v1/tasks' + (pq ? '?' + pq : ''));
    var tasks = await res.json();
    var researchTasks = tasks.filter(function(t) {
      return (t.id.indexOf('research') !== -1 || t.id.indexOf('scout') !== -1 ||
              t.id.indexOf('newsletter') !== -1 || t.prompt.toLowerCase().indexOf('research') !== -1 ||
              t.prompt.toLowerCase().indexOf('scout') !== -1) && t.status === 'active';
    });

    if (researchTasks.length === 0) { container.textContent = ''; return; }

    var nextTask = researchTasks.sort(function(a, b) { return a.next_run - b.next_run; })[0];
    var nextDate = new Date(nextTask.next_run);
    var now = Date.now();
    var diffMs = nextTask.next_run - now;
    var diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    var diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    var countdown = diffMs <= 0 ? 'Due now' : diffHours > 0 ? 'in ' + diffHours + 'h ' + diffMins + 'm' : 'in ' + diffMins + 'm';

    setElementHTML(container,
      '<div style="display:flex;align-items:center;gap:16px;padding:12px 16px;background:var(--surface-elevated);border-radius:8px;border:1px solid var(--border-subtle);">' +
        '<span style="font-size:18px;">&#128269;</span>' +
        '<div style="flex:1;">' +
          '<span style="font-size:13px;font-weight:600;color:var(--text-primary);">Next Research Sweep</span>' +
          '<span style="font-size:12px;color:var(--text-muted);margin-left:8px;">' + escapeHtml(nextTask.id) + '</span>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-size:13px;font-weight:600;color:var(--accent);">' + escapeHtml(countdown) + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);">' + escapeHtml(nextDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) + '</div>' +
        '</div>' +
        '<div style="text-align:right;border-left:1px solid var(--border-subtle);padding-left:16px;">' +
          '<div style="font-size:16px;font-weight:700;color:var(--text-primary);">' + researchTasks.length + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);">active tasks</div>' +
        '</div>' +
      '</div>');
  } catch (e) {
    container.textContent = '';
  }
}

document.addEventListener('click', function(ev) {
  var closeEl = ev.target.closest('#rs-drawer [data-action="close"]');
  if (closeEl) { rsDrawer.close(); ev.preventDefault(); }
});

document.addEventListener('keydown', function(ev) {
  if (ev.key === 'Escape' && rsDrawer.openItemId) {
    rsDrawer.close();
  }
});

// ── Universal Pipeline Page ──

var PipelinePage = {
  data: { tasks: [], activeTab: 'all' },

  load: async function() {
    try {
      var pq = getProjectQueryParam();
      var url = '/api/v1/tasks' + (pq ? '?' + pq : '');
      var res = await fetch(url);
      this.data.tasks = await res.json();
    } catch(e) {
      console.error('Pipeline load failed:', e);
    }
    this.render();
  },

  render: function() {
    var tasks = this.data.tasks;
    var kanbanBoard = document.querySelector('[data-component="pipeline-kanban"]');
    var upcomingSection = document.querySelector('[data-component="pipeline-upcoming"]');
    var emptyState = document.getElementById('pipeline-empty-state');

    if (!Array.isArray(tasks) || tasks.length === 0) {
      if (kanbanBoard) kanbanBoard.hidden = true;
      if (upcomingSection) upcomingSection.hidden = true;
      if (!emptyState) {
        emptyState = document.createElement('div');
        emptyState.id = 'pipeline-empty-state';
        emptyState.style.cssText = 'padding:48px;text-align:center;color:var(--text-muted);';
        var emptyMsg = document.createElement('p');
        emptyMsg.style.cssText = 'font-size:14px;margin:0;';
        emptyMsg.textContent = 'No pipeline items yet';
        emptyState.appendChild(emptyMsg);
        var pipelineSection = document.getElementById('page-pipeline');
        if (pipelineSection) pipelineSection.appendChild(emptyState);
      } else {
        emptyState.hidden = false;
      }
      return;
    }

    if (emptyState) emptyState.hidden = true;
    if (kanbanBoard) kanbanBoard.hidden = false;
    if (upcomingSection) upcomingSection.hidden = false;
    this.renderUpcoming();
    this.renderKanban();
  },

  setTab: function(tab) {
    this.data.activeTab = tab;
    document.querySelectorAll('[data-component="pipeline-tabs"] button').forEach(function(b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    this.render();
  },

  getFilteredTasks: function() {
    var tab = this.data.activeTab;
    var tasks = this.data.tasks;
    if (tab === 'cron') return tasks;
    if (tab === 'research') return tasks.filter(function(t) { return t.id.indexOf('research') !== -1 || t.id.indexOf('scout') !== -1 || t.id.indexOf('newsletter') !== -1; });
    if (tab === 'video') return tasks.filter(function(t) { return t.id.indexOf('video') !== -1 || t.id.indexOf('producer') !== -1; });
    return tasks;
  },

  renderUpcoming: function() {
    var container = document.querySelector('[data-bind="pipeline-upcoming"]');
    var countEl = document.querySelector('[data-bind="pipeline-upcoming-count"]');
    if (!container) return;

    var tasks = this.getFilteredTasks();
    var now = Date.now();
    var upcoming = tasks
      .filter(function(t) { return t.status === 'active' && t.next_run > now; })
      .sort(function(a, b) { return a.next_run - b.next_run; })
      .slice(0, 8);

    if (countEl) countEl.textContent = upcoming.length ? '(' + upcoming.length + ')' : '';

    if (upcoming.length === 0) {
      setElementHTML(container, '<p style="color:var(--text-muted);font-size:13px;padding:8px 0;">No upcoming tasks</p>');
      return;
    }

    setElementHTML(container, upcoming.map(function(t) {
      var diffMs = t.next_run - now;
      var diffH = Math.floor(diffMs / 3600000);
      var diffM = Math.floor((diffMs % 3600000) / 60000);
      var countdown = diffMs <= 0 ? 'Now' : diffH > 24 ? Math.floor(diffH / 24) + 'd' : diffH > 0 ? diffH + 'h ' + diffM + 'm' : diffM + 'm';
      var nextDate = new Date(t.next_run);
      return '<div style="display:inline-flex;align-items:center;gap:12px;padding:10px 14px;background:var(--surface-elevated);border-radius:6px;border:1px solid var(--border-subtle);margin:4px;">' +
        '<span style="font-size:12px;font-weight:600;color:var(--accent);min-width:50px;">' + escapeHtml(countdown) + '</span>' +
        '<span style="font-size:12px;color:var(--text-primary);font-weight:500;">' + escapeHtml(t.id) + '</span>' +
        '<span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(nextDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) + '</span>' +
      '</div>';
    }).join(''));
  },

  renderKanban: function() {
    var tasks = this.getFilteredTasks();
    var now = Date.now();
    var oneHourAgo = now - 3600000;

    var queued = tasks.filter(function(t) { return t.status === 'active' && t.last_result !== 'running...' && t.next_run > now; });
    var running = tasks.filter(function(t) { return t.last_result === 'running...'; });
    var completed = tasks.filter(function(t) { return t.last_result && t.last_result !== 'running...' && t.last_run && t.last_run > oneHourAgo && !t.last_result.startsWith('ERROR'); });
    var failed = tasks.filter(function(t) { return t.last_result && t.last_result.startsWith('ERROR') && t.last_run && t.last_run > oneHourAgo; });

    var columns = { queued: queued, running: running, completed: completed, failed: failed };

    Object.keys(columns).forEach(function(col) {
      var items = columns[col];
      var body = document.querySelector('[data-drop-zone="' + col + '"]');
      var count = document.querySelector('[data-bind="' + col + '-count"]');
      if (count) count.textContent = String(items.length);
      if (!body) return;

      if (items.length === 0) {
        setElementHTML(body, '<div style="color:var(--text-muted);font-size:12px;padding:20px;text-align:center;">No items</div>');
        return;
      }

      setElementHTML(body, items.map(function(t) {
        var time = t.last_run ? new Date(t.last_run).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
        var preview = t.last_result ? t.last_result.slice(0, 80) : '';
        return '<div style="padding:10px 12px;background:var(--surface);border:1px solid var(--border-subtle);border-radius:6px;margin-bottom:6px;">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">' + escapeHtml(t.id) + '</div>' +
          (time ? '<div style="font-size:11px;color:var(--text-muted);">' + escapeHtml(time) + '</div>' : '') +
          (preview && col !== 'queued' ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">' + escapeHtml(preview) + '</div>' : '') +
        '</div>';
      }).join(''));
    });
  }
};

let _pipelinePageInitialized = false;
function initPipelinePage() {
  if (!_pipelinePageInitialized) {
    _pipelinePageInitialized = true;
    document.querySelectorAll('[data-component="pipeline-tabs"] button').forEach(function(btn) {
      btn.addEventListener('click', function() { PipelinePage.setTab(btn.dataset.tab); });
    });
  }
  PipelinePage.load();
}

let _researchPageInitialized = false;
function initResearchPage() {
  if (!_researchPageInitialized) {
    _researchPageInitialized = true;
    var refreshBtn = document.getElementById('research-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() { ResearchPage.load(); });
    }

    var catFilter = document.getElementById('research-filter-category');
    var statusFilter = document.getElementById('research-filter-status');
    var pipeFilter = document.getElementById('research-filter-pipeline');

    function onFilterChange() {
      ResearchPage.filters.category = catFilter ? catFilter.value : '';
      ResearchPage.filters.status = statusFilter ? statusFilter.value : '';
      ResearchPage.filters.pipeline = pipeFilter ? pipeFilter.value : '';
      ResearchPage.load();
    }

    if (catFilter) catFilter.addEventListener('change', onFilterChange);
    if (statusFilter) statusFilter.addEventListener('change', onFilterChange);
    if (pipeFilter) pipeFilter.addEventListener('change', onFilterChange);

    // Delegated click for sort headers
    document.addEventListener('click', function(e) {
      var th = e.target.closest('.research-th-sortable');
      if (th && th.dataset.sortField) {
        ResearchPage.applySort(th.dataset.sortField);
      }
    });

    // Delegated click for status select changes in table
    document.addEventListener('change', function(e) {
      var sel = e.target.closest('.research-status-select');
      if (sel) {
        ResearchPage.updateStatus(sel.dataset.itemId, sel.value);
      }
    });
  }
  ResearchPage.load();
}

// ========== PLUGINS PAGE ==========

async function fetchPlugins() {
  try {
    var pq = getProjectQueryParam();
    var res = await fetch('/api/v1/plugins' + (pq ? '?' + pq : ''));
    if (!res.ok) return;
    var plugins = await res.json();
    renderPluginCards(plugins);
  } catch (err) {
    console.error('Plugins fetch error:', err);
  }
}

function renderPluginCards(plugins) {
  var grid = document.querySelector('[data-component="plugins"]');
  if (!grid) return;
  grid.textContent = '';

  var countEl = document.querySelector('[data-bind="plugin-count"]');
  if (countEl) countEl.textContent = plugins.length + ' plugin' + (plugins.length !== 1 ? 's' : '');

  if (plugins.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'sop-card';
    empty.style.cssText = 'opacity:0.5;text-align:center;padding:40px;';
    var emptyText = document.createElement('span');
    emptyText.style.color = 'var(--text-muted)';
    emptyText.textContent = 'No plugins installed. Add a plugin directory under plugins/ with a manifest.json + prompt.md';
    empty.appendChild(emptyText);
    grid.appendChild(empty);
    return;
  }

  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var card = document.createElement('div');
    card.className = 'sop-card';
    card.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:10px;';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:15px;color:var(--text-primary);';
    title.textContent = p.name;

    var badge = document.createElement('span');
    badge.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600;' +
      (p.enabled
        ? 'background:rgba(0,255,136,0.1);color:#0f8'
        : 'background:rgba(255,80,80,0.1);color:#f55');
    badge.textContent = p.enabled ? 'ENABLED' : 'DISABLED';

    header.appendChild(title);
    header.appendChild(badge);

    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:13px;color:var(--text-muted);line-height:1.4;';
    desc.textContent = p.description;

    var meta = document.createElement('div');
    meta.style.cssText = 'font-size:12px;color:var(--text-muted);display:flex;gap:16px;flex-wrap:wrap;';
    var verSpan = document.createElement('span');
    verSpan.textContent = 'v' + p.version;
    meta.appendChild(verSpan);
    var authorSpan = document.createElement('span');
    authorSpan.textContent = 'by ' + p.author;
    meta.appendChild(authorSpan);
    if (p.agent_id) {
      var agentSpan = document.createElement('span');
      agentSpan.textContent = 'agent: ' + p.agent_id;
      meta.appendChild(agentSpan);
    }
    if (p.keywords && p.keywords.length) {
      var kwSpan = document.createElement('span');
      kwSpan.textContent = p.keywords.join(', ');
      meta.appendChild(kwSpan);
    }

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:4px;';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn--ghost';
    toggleBtn.style.cssText = 'font-size:12px;padding:4px 12px;';
    toggleBtn.textContent = p.enabled ? 'Disable' : 'Enable';
    toggleBtn.dataset.pluginId = p.id;
    toggleBtn.dataset.action = 'toggle-plugin';
    toggleBtn.dataset.currentState = p.enabled ? '1' : '0';
    actions.appendChild(toggleBtn);

    card.appendChild(header);
    card.appendChild(desc);
    card.appendChild(meta);
    card.appendChild(actions);
    grid.appendChild(card);
  }
}

var _pluginsPageInitialized = false;
function initPluginsPage() {
  if (_pluginsPageInitialized) { fetchPlugins(); return; }
  _pluginsPageInitialized = true;
  document.addEventListener('click', async function(e) {
    var btn = e.target.closest('button[data-action="toggle-plugin"]');
    if (!btn) return;
    var pluginId = btn.dataset.pluginId;
    var newEnabled = btn.dataset.currentState !== '1';
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      var res = await fetch('/api/v1/plugins/' + encodeURIComponent(pluginId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled })
      });
      if (res.ok) {
        await fetchPlugins();
      } else {
        btn.textContent = 'Error';
        setTimeout(function() { fetchPlugins(); }, 1500);
      }
    } catch (err) {
      console.error('Plugin toggle error:', err);
      btn.textContent = 'Error';
      setTimeout(function() { fetchPlugins(); }, 1500);
    }
  });
}

function initSOPsPage() {
  if (_sopPageInitialized) return;
  _sopPageInitialized = true;
  document.addEventListener('click', async function(e) {
    var runBtn = e.target.closest('button[data-action="run-sop"]');
    if (runBtn) {
      var taskId = runBtn.dataset.taskId;
      var card = runBtn.closest('.sop-card');
      var statusEl = card ? card.querySelector('.sop-status') : null;

      runBtn.disabled = true;
      runBtn.textContent = '';
      var spinner = document.createElement('span');
      spinner.className = 'sop-spinner';
      runBtn.appendChild(spinner);
      runBtn.appendChild(document.createTextNode(' Running\u2026'));
      runBtn.classList.add('running');
      if (statusEl) { statusEl.textContent = 'RUNNING'; statusEl.className = 'sop-status running'; }

      try {
        const res = await fetch('/api/v1/tasks/' + encodeURIComponent(taskId) + '/run', { method: 'POST' });
        if (!res.ok) {
          runBtn.textContent = 'Run failed';
          runBtn.disabled = false;
          return;
        }
        runBtn.textContent = '\u2713 Triggered';
        runBtn.classList.remove('running');
        runBtn.classList.add('completed');

        setTimeout(function() {
          runBtn.textContent = 'Run Now';
          runBtn.disabled = false;
          runBtn.classList.remove('completed');
          fetchSOPs();
        }, 4000);
      } catch (err) {
        runBtn.textContent = 'Run Now';
        runBtn.disabled = false;
        runBtn.classList.remove('running');
        if (statusEl) { statusEl.textContent = 'ERROR'; statusEl.className = 'sop-status error'; }
      }
      return;
    }

    var toggleBtn = e.target.closest('button[data-action="toggle-sop"]');
    if (toggleBtn) {
      var tid = toggleBtn.dataset.taskId;
      var current = toggleBtn.dataset.currentStatus;
      var newStatus = current === 'active' ? 'paused' : 'active';

      toggleBtn.disabled = true;
      try {
        const res = await fetch('/api/v1/tasks/' + encodeURIComponent(tid), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
          fetchSOPs();
        } else {
          console.error('Toggle failed:', res.status);
        }
      } catch (err) {
        console.error('Toggle error:', err);
      }
      toggleBtn.disabled = false;
      return;
    }

    var editSopBtn = e.target.closest('button[data-action="edit-sop"]');
    if (editSopBtn) { openSopEditModal(editSopBtn.dataset.taskId); return; }

    var deleteSopBtn = e.target.closest('button[data-action="delete-sop"]');
    if (deleteSopBtn) { confirmDeleteSop(deleteSopBtn.dataset.taskId); return; }

    var createSopBtn = e.target.closest('[data-action="create-sop"]');
    if (createSopBtn) { openSopCreateModal(); return; }
  });
}

// --------------- BOARD PAGE ---------------

const esc = escapeHtml;
var boardData = null;

async function fetchBoardData() {
  try {
    const pq = getProjectQueryParam();
    const data = await fetchFromAPI('/api/v1/board' + (pq ? '?' + pq : ''));
    boardData = data;
    renderNextMeeting(data);
    renderBoardBriefing(data);
    renderBoardDecisions(data);
    renderBoardMetrics(data);
    renderBoardHistory(data);
  } catch (err) {
    console.error('Board fetch error:', err);
  }
}

function renderNextMeeting(data) {
  var container = document.querySelector('[data-bind="board-next-meeting"]');
  if (!container) return;

  var nextMs = data && data.stats && data.stats.next_meeting;
  if (!nextMs) {
    container.textContent = '';
    var empty = document.createElement('div');
    empty.className = 'board-empty-state';
    var p = document.createElement('p');
    p.style.color = 'var(--text-muted)';
    p.textContent = 'No upcoming meeting scheduled';
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  var nextDate = new Date(nextMs);
  var now = Date.now();
  var diffMs = nextMs - now;
  var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  var diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  var countdown = '';
  if (diffMs <= 0) countdown = 'Meeting is due now';
  else if (diffDays > 0) countdown = 'in ' + diffDays + 'd ' + diffHours + 'h';
  else countdown = 'in ' + diffHours + 'h';

  var openDecisions = (data.decisions && data.decisions.open && data.decisions.open.length) || 0;

  container.textContent = '';
  var card = document.createElement('div');
  card.className = 'board-next-card';
  card.style.cssText = 'display:flex;gap:24px;align-items:center;padding:16px;background:var(--surface-elevated);border-radius:8px;border:1px solid var(--border-subtle);';

  var iconDiv = document.createElement('div');
  iconDiv.style.fontSize = '32px';
  iconDiv.innerHTML = '&#9878;';
  card.appendChild(iconDiv);

  var infoDiv = document.createElement('div');
  infoDiv.style.flex = '1';
  var dateDiv = document.createElement('div');
  dateDiv.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-primary);';
  dateDiv.textContent = nextDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + ' at ' + nextDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  infoDiv.appendChild(dateDiv);
  var countdownDiv = document.createElement('div');
  countdownDiv.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:4px;';
  countdownDiv.textContent = countdown;
  infoDiv.appendChild(countdownDiv);
  card.appendChild(infoDiv);

  var statsDiv = document.createElement('div');
  statsDiv.style.textAlign = 'right';
  var countDiv = document.createElement('div');
  countDiv.style.cssText = 'font-size:20px;font-weight:700;color:var(--accent);';
  countDiv.textContent = String(openDecisions);
  statsDiv.appendChild(countDiv);
  var labelDiv = document.createElement('div');
  labelDiv.style.cssText = 'font-size:11px;color:var(--text-muted);';
  labelDiv.textContent = 'open items';
  statsDiv.appendChild(labelDiv);
  card.appendChild(statsDiv);

  container.appendChild(card);
}

function renderBoardBriefing(data) {
  var el = document.querySelector('[data-bind="board-briefing"]');
  if (!el) return;

  if (!data || !data.latest) {
    var projectLabel = currentProject.id ? 'No board meetings for ' + currentProject.display_name + ' yet.' : 'No board meetings held yet.';
    el.innerHTML =
      '<div class="board-empty-state">' +
        '<div class="board-empty-icon">&#9878;</div>' +
        '<p>' + escapeHtml(projectLabel) + '</p>' +
        '<p class="board-empty-hint">Schedule a weekly board meeting task, or run one manually.</p>' +
      '</div>';
    return;
  }

  var m = data.latest;
  var statusClass = 'board-status--' + esc(m.status);
  var highlights = [];
  try { highlights = JSON.parse(m.agent_highlights || '[]'); } catch(e) {}

  var highlightsHtml = '';
  if (highlights.length > 0) {
    highlightsHtml = '<div class="board-highlights"><h4>Agent Highlights</h4><ul>' +
      highlights.map(function(h) { return '<li>' + esc(h) + '</li>'; }).join('') +
      '</ul></div>';
  }

  el.innerHTML =
    '<div class="board-briefing-header">' +
      '<span class="board-date">' + esc(m.date) + '</span>' +
      '<span class="board-status ' + statusClass + '">' + esc(m.status) + '</span>' +
    '</div>' +
    '<div class="board-briefing-body">' + formatBriefing(m.briefing) + '</div>' +
    highlightsHtml;
}

function formatBriefing(text) {
  if (!text) return '';
  return text.split('\n').filter(function(l) { return l.trim(); }).map(function(p) {
    return '<p>' + esc(p) + '</p>';
  }).join('');
}

function renderBoardDecisions(data) {
  var el = document.querySelector('[data-bind="board-decisions"]');
  var countEl = document.querySelector('[data-bind="board-open-count"]');
  if (!el) return;

  var open = (data.decisions && data.decisions.open) || [];
  var resolved = (data.decisions && data.decisions.resolved) || [];

  if (countEl) {
    countEl.textContent = open.length > 0 ? open.length : '';
    countEl.style.display = open.length > 0 ? '' : 'none';
  }

  if (open.length === 0 && resolved.length === 0) {
    el.innerHTML = '<p class="board-no-items">No decisions tracked yet.</p>';
    return;
  }

  var openHtml = '<div class="board-decisions-col">' +
    '<h4>Open Items</h4>';
  if (open.length === 0) {
    openHtml += '<p class="board-no-items">All clear</p>';
  } else {
    openHtml += open.map(function(d) {
      return '<div class="board-decision-item board-decision--open" data-id="' + esc(d.id) + '">' +
        '<span class="board-decision-text">' + esc(d.description) + '</span>' +
        '<div class="board-decision-actions">' +
          '<button class="board-decision-btn" data-action="resolve" data-decision-id="' + esc(d.id) + '" title="Resolve">&#10003;</button>' +
          '<button class="board-decision-btn board-decision-btn--defer" data-action="deferred" data-decision-id="' + esc(d.id) + '" title="Defer">&#8674;</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  openHtml += '</div>';

  var resolvedHtml = '<div class="board-decisions-col">' +
    '<h4>Recently Resolved</h4>';
  if (resolved.length === 0) {
    resolvedHtml += '<p class="board-no-items">None yet</p>';
  } else {
    resolvedHtml += resolved.map(function(d) {
      return '<div class="board-decision-item board-decision--resolved">' +
        '<span class="board-decision-text">' + esc(d.description) + '</span>' +
        '<span class="board-decision-resolved-date">' + formatRelativeTime(d.resolved_at) + '</span>' +
      '</div>';
    }).join('');
  }
  resolvedHtml += '</div>';

  el.innerHTML = openHtml + resolvedHtml;
}

function renderBoardMetrics(data) {
  var el = document.querySelector('[data-bind="board-metrics"]');
  if (!el) return;

  if (!data.latest || !data.latest.metrics_snapshot) {
    el.innerHTML = '<div class="board-metric-card board-metric-card--empty">' +
      '<span class="board-metric-label">Metrics populate after first board meeting</span></div>';
    return;
  }

  var snap;
  try { snap = typeof data.latest.metrics_snapshot === 'string' ? JSON.parse(data.latest.metrics_snapshot) : data.latest.metrics_snapshot; } catch(e) { snap = {}; }

  var platforms = [
    { key: 'youtube', label: 'YouTube', icon: '&#9654;' },
    { key: 'website', label: 'Website', icon: '&#9679;' },
    { key: 'linkedin', label: 'LinkedIn', icon: '&#9679;' },
    { key: 'twitter', label: 'Twitter / X', icon: '&#9679;' }
  ];

  el.innerHTML = platforms.map(function(p) {
    var d = snap[p.key] || {};
    var rows = Object.keys(d).filter(function(k) { return k !== 'delta'; }).map(function(k) {
      var val = d[k];
      var label = k.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
      return '<div class="board-metric-row">' +
        '<span class="board-metric-key">' + esc(label) + '</span>' +
        '<span class="board-metric-val">' + formatMetricValue(val) + '</span>' +
      '</div>';
    }).join('');

    var deltaHtml = '';
    if (d.delta !== undefined && d.delta !== null) {
      var cls = d.delta >= 0 ? 'board-metric-delta--up' : 'board-metric-delta--down';
      var arrow = d.delta >= 0 ? '&#9650;' : '&#9660;';
      deltaHtml = '<div class="board-metric-delta ' + cls + '">' + arrow + ' ' + Math.abs(d.delta).toFixed(1) + '%</div>';
    }

    return '<div class="board-metric-card">' +
      '<div class="board-metric-header">' +
        '<span class="board-metric-icon">' + p.icon + '</span>' +
        '<span class="board-metric-label">' + esc(p.label) + '</span>' +
        deltaHtml +
      '</div>' +
      '<div class="board-metric-body">' + (rows || '<span class="board-no-items">No data</span>') + '</div>' +
    '</div>';
  }).join('');
}

function formatMetricValue(val) {
  if (typeof val !== 'number') return esc(String(val));
  if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
  return String(val);
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  var diff = Date.now() - ts;
  var days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function renderBoardHistory(data) {
  var el = document.querySelector('[data-bind="board-history"]');
  if (!el) return;

  var history = data.history || [];
  if (history.length === 0) {
    el.innerHTML = '<p class="board-no-items">No meetings recorded yet.</p>';
    return;
  }

  el.innerHTML = history.map(function(m) {
    var statusClass = 'board-status--' + esc(m.status);
    return '<div class="board-history-item" data-meeting-id="' + esc(m.id) + '">' +
      '<div class="board-history-header">' +
        '<span class="board-date">' + esc(m.date) + '</span>' +
        '<span class="board-status ' + statusClass + '">' + esc(m.status) + '</span>' +
        '<span class="board-history-decisions">' + m.decision_count + ' decision' + (m.decision_count !== 1 ? 's' : '') + '</span>' +
        '<button class="board-history-toggle" aria-label="Expand meeting details">&#9660;</button>' +
      '</div>' +
      '<div class="board-history-body" hidden>' +
        formatBriefing(m.briefing) +
      '</div>' +
    '</div>';
  }).join('');
}

let _sopPageInitialized = false;
let _boardPageInitialized = false;
function initBoardPage() {
  if (!_boardPageInitialized) {
  _boardPageInitialized = true;
  // Decision action buttons (resolve/defer)
  document.addEventListener('click', async function(e) {
    var btn = e.target.closest('[data-decision-id]');
    if (btn) {
      var id = btn.dataset.decisionId;
      var action = btn.dataset.action;
      btn.disabled = true;
      try {
        await fetch('/api/v1/board/decisions/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: action })
        });
        fetchBoardData();
      } catch (err) {
        console.error('Decision update error:', err);
      }
      btn.disabled = false;
      return;
    }

    // History expand/collapse
    var toggle = e.target.closest('.board-history-toggle');
    if (toggle) {
      var item = toggle.closest('.board-history-item');
      var body = item && item.querySelector('.board-history-body');
      if (body) {
        var isHidden = body.hasAttribute('hidden');
        if (isHidden) {
          body.removeAttribute('hidden');
          toggle.innerHTML = '&#9650;';
        } else {
          body.setAttribute('hidden', '');
          toggle.innerHTML = '&#9660;';
        }
      }
    }
  });
  } // end _boardPageInitialized guard

  fetchBoardData();
}

// --------------- LOGGING PAGE (Channel Communications) ---------------

let loggingOffset = 0;
const LOGGING_PAGE_SIZE = 50;

var PROJECT_BOT_MAP = {
  'default': '@YourBotName',
  'claudepaw': '@YourBotName',
};

function initLoggingPage() {
  loggingOffset = 0;

  const channelFilter = document.getElementById('logging-channel-filter');
  const botFilter = document.getElementById('logging-bot-filter');
  const dirFilter = document.getElementById('logging-direction-filter');
  const timeFilter = document.getElementById('logging-time-filter');
  const searchInput = document.getElementById('logging-search');
  const moreBtn = document.getElementById('logging-more-btn');

  // Pre-select bot based on active project
  if (botFilter && currentProject.slug && PROJECT_BOT_MAP[currentProject.slug]) {
    botFilter.value = PROJECT_BOT_MAP[currentProject.slug];
  } else if (botFilter) {
    botFilter.value = '';
  }

  if (channelFilter) channelFilter.onchange = function() { loggingOffset = 0; fetchLoggingEntries(true); };
  if (botFilter) botFilter.onchange = function() { loggingOffset = 0; fetchLoggingEntries(true); };
  if (dirFilter) dirFilter.onchange = function() { loggingOffset = 0; fetchLoggingEntries(true); };
  if (timeFilter) timeFilter.onchange = function() { loggingOffset = 0; fetchLoggingEntries(true); };
  if (searchInput) {
    var debounce;
    searchInput.oninput = function() {
      clearTimeout(debounce);
      debounce = setTimeout(function() { loggingOffset = 0; fetchLoggingEntries(true); }, 300);
    };
  }
  if (moreBtn) moreBtn.onclick = function() { fetchLoggingEntries(false); };

  fetchLoggingEntries(true);
}

async function fetchLoggingEntries(replace) {
  if (replace) loggingOffset = 0;
  var params = new URLSearchParams();

  var channel = document.getElementById('logging-channel-filter');
  var bot = document.getElementById('logging-bot-filter');
  var direction = document.getElementById('logging-direction-filter');
  var since = document.getElementById('logging-time-filter');
  var search = document.getElementById('logging-search');

  if (channel && channel.value) params.set('channel', channel.value);
  if (bot && bot.value) params.set('bot_name', bot.value);
  if (direction && direction.value) params.set('direction', direction.value);
  params.set('since', (since && since.value) || '24h');
  if (search && search.value) params.set('search', search.value);
  params.set('limit', String(LOGGING_PAGE_SIZE));
  params.set('offset', String(loggingOffset));

  try {
    var url = '/api/v1/logging?' + params.toString();
    var data = await fetchFromAPI(url);
    if (!data) {
      console.warn('Logging API returned null for:', url);
      renderLoggingTable([], replace);
      return;
    }
    var entries = data.entries || [];
    renderLoggingTable(entries, replace);
    loggingOffset += entries.length;
    var moreBtn = document.getElementById('logging-more-btn');
    if (moreBtn) moreBtn.hidden = entries.length < LOGGING_PAGE_SIZE;
  } catch (e) {
    console.warn('Failed to fetch logging entries:', e);
    renderLoggingTable([], replace);
  }
}

function renderLoggingTable(entries, replace) {
  var tbody = document.getElementById('logging-tbody');
  if (!tbody) return;
  if (replace) tbody.textContent = '';

  if (entries.length === 0 && replace) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 8;
    td.style.cssText = 'text-align:center;padding:2rem;color:var(--text-muted)';
    td.textContent = 'No log entries found';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var tr = document.createElement('tr');

    // Time
    var tdTime = document.createElement('td');
    tdTime.style.cssText = 'white-space:nowrap;font-size:0.75rem;color:var(--text-muted)';
    var d = new Date(entry.created_at);
    tdTime.textContent = d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' ' + d.toLocaleDateString([], {month:'short',day:'numeric'});
    tr.appendChild(tdTime);

    // Direction
    var tdDir = document.createElement('td');
    tdDir.style.width = '24px';
    var dirSpan = document.createElement('span');
    dirSpan.className = 'logging-direction ' + (entry.direction || 'in');
    dirSpan.textContent = entry.direction === 'out' ? '\u2191' : '\u2193';
    dirSpan.title = entry.direction === 'out' ? 'Outbound' : 'Inbound';
    tdDir.appendChild(dirSpan);
    tr.appendChild(tdDir);

    // Channel
    var tdChan = document.createElement('td');
    var chanBadge = document.createElement('span');
    chanBadge.className = 'logging-channel-badge';
    chanBadge.textContent = entry.channel_name || entry.channel || '-';
    tdChan.appendChild(chanBadge);
    tr.appendChild(tdChan);

    // Bot
    var tdBot = document.createElement('td');
    tdBot.style.cssText = 'font-size:0.78rem';
    tdBot.textContent = entry.bot_name || '-';
    tr.appendChild(tdBot);

    // Project
    var tdProj = document.createElement('td');
    tdProj.style.cssText = 'font-size:0.78rem';
    tdProj.textContent = entry.project_id || '-';
    tr.appendChild(tdProj);

    // Sender
    var tdSender = document.createElement('td');
    tdSender.style.cssText = 'font-size:0.78rem';
    tdSender.textContent = entry.sender_name || entry.chat_id || '-';
    tr.appendChild(tdSender);

    // Content
    var tdContent = document.createElement('td');
    var preview = document.createElement('span');
    preview.className = 'logging-content-preview';
    var fullText = entry.content || '';
    preview.textContent = fullText.slice(0, 120);
    if (fullText.length > 120) {
      preview.title = 'Click to expand';
      preview.style.cursor = 'pointer';
      (function(el, full) {
        el.addEventListener('click', function() {
          el.classList.toggle('expanded');
          el.textContent = el.classList.contains('expanded') ? full : full.slice(0, 120);
        });
      })(preview, fullText);
    }
    tdContent.appendChild(preview);
    tr.appendChild(tdContent);

    // Agent
    var tdAgent = document.createElement('td');
    if (entry.agent_id) {
      var agentBadge = document.createElement('span');
      agentBadge.className = 'logging-agent-badge';
      agentBadge.textContent = entry.agent_id;
      tdAgent.appendChild(agentBadge);
    }
    tr.appendChild(tdAgent);

    if (replace) {
      tbody.appendChild(tr);
    } else {
      tbody.appendChild(tr);
    }
  }
}

function handleLoggingWsMessage(data) {
  var page = document.getElementById('page-logging');
  if (!page || page.hidden || !data) return;

  // Check if entry matches active filters before prepending
  var channelFilter = document.getElementById('logging-channel-filter');
  var botFilter = document.getElementById('logging-bot-filter');
  var dirFilter = document.getElementById('logging-direction-filter');

  var entryChannel = data.channel || data.channelId || '';
  var entryBot = data.botName || data.bot_name || '';
  var entryDir = data.direction || '';

  if (channelFilter && channelFilter.value && !entryChannel.startsWith(channelFilter.value)) return;
  if (botFilter && botFilter.value && entryBot !== botFilter.value) return;
  if (dirFilter && dirFilter.value && entryDir !== dirFilter.value) return;

  var tbody = document.getElementById('logging-tbody');
  if (!tbody) return;
  // Remove "No log entries" placeholder if present
  var placeholder = tbody.querySelector('td[colspan]');
  if (placeholder) placeholder.parentElement.remove();
  renderLoggingTableRow(data, tbody, true);
}

function renderLoggingTableRow(entry, tbody, prepend) {
  var tr = document.createElement('tr');
  tr.style.cssText = 'animation: fadeIn 0.3s ease';

  var tdTime = document.createElement('td');
  tdTime.style.cssText = 'white-space:nowrap;font-size:0.75rem;color:var(--text-muted)';
  var d = new Date(entry.created_at || Date.now());
  tdTime.textContent = d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' ' + d.toLocaleDateString([], {month:'short',day:'numeric'});
  tr.appendChild(tdTime);

  var tdDir = document.createElement('td');
  tdDir.style.width = '24px';
  var dirSpan = document.createElement('span');
  dirSpan.className = 'logging-direction ' + (entry.direction || 'in');
  dirSpan.textContent = entry.direction === 'out' ? '\u2191' : '\u2193';
  tdDir.appendChild(dirSpan);
  tr.appendChild(tdDir);

  var tdChan = document.createElement('td');
  var chanBadge = document.createElement('span');
  chanBadge.className = 'logging-channel-badge';
  chanBadge.textContent = entry.channelName || entry.channel_name || entry.channel || '-';
  tdChan.appendChild(chanBadge);
  tr.appendChild(tdChan);

  var tdBot = document.createElement('td');
  tdBot.style.cssText = 'font-size:0.78rem';
  tdBot.textContent = entry.botName || entry.bot_name || '-';
  tr.appendChild(tdBot);

  var tdProj = document.createElement('td');
  tdProj.style.cssText = 'font-size:0.78rem';
  tdProj.textContent = entry.projectId || entry.project_id || '-';
  tr.appendChild(tdProj);

  var tdSender = document.createElement('td');
  tdSender.style.cssText = 'font-size:0.78rem';
  tdSender.textContent = entry.senderName || entry.sender_name || entry.chatId || entry.chat_id || '-';
  tr.appendChild(tdSender);

  var tdContent = document.createElement('td');
  var preview = document.createElement('span');
  preview.className = 'logging-content-preview';
  preview.textContent = (entry.content || '').slice(0, 120);
  tdContent.appendChild(preview);
  tr.appendChild(tdContent);

  var tdAgent = document.createElement('td');
  if (entry.agentId || entry.agent_id) {
    var agentBadge = document.createElement('span');
    agentBadge.className = 'logging-agent-badge';
    agentBadge.textContent = entry.agentId || entry.agent_id;
    tdAgent.appendChild(agentBadge);
  }
  tr.appendChild(tdAgent);

  if (prepend && tbody.firstChild) {
    tbody.insertBefore(tr, tbody.firstChild);
  } else {
    tbody.appendChild(tr);
  }
}

// --------------- COMMS PAGE (Agent Network Visualization) ---------------

const commsState = {
  messages: [],
  connections: [],
  particles: [],
  filters: { type: 'all', agent: '', since: '24h' },
  animFrame: null,
  replyTo: null,
  loaded: false,
};

function rebuildCommsAgentFilter() {
  const agentFilter = document.getElementById('comms-agent-filter');
  if (!agentFilter) return;
  const prev = agentFilter.value;
  while (agentFilter.options.length > 1) agentFilter.remove(1);
  Object.entries(AGENTS).forEach(([id, a]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = a.name;
    agentFilter.appendChild(opt);
  });
  // Restore previous selection if agent still exists
  if (prev && AGENTS[prev]) agentFilter.value = prev;
  else { agentFilter.value = ''; commsState.filters.agent = ''; }
}

let _commsPolling = false;
let _commsPageInitialized = false;
function initCommsPage() {
  if (_commsPageInitialized) return;
  _commsPageInitialized = true;
  const typeGroup = document.getElementById('comms-type-filters');
  if (typeGroup) {
    typeGroup.addEventListener('click', (e) => {
      const pill = e.target.closest('.comms-filter-pill');
      if (!pill) return;
      typeGroup.querySelectorAll('.comms-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      commsState.filters.type = pill.dataset.type;
      fetchCommsLog();
    });
  }

  const timeGroup = document.getElementById('comms-time-filters');
  if (timeGroup) {
    timeGroup.addEventListener('click', (e) => {
      const pill = e.target.closest('.comms-filter-pill');
      if (!pill) return;
      timeGroup.querySelectorAll('.comms-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      commsState.filters.since = pill.dataset.since;
      fetchCommsLog();
      fetchCommsConnections();
    });
  }

  rebuildCommsAgentFilter();
  const agentFilter = document.getElementById('comms-agent-filter');
  if (agentFilter) {
    agentFilter.onchange = () => {
      commsState.filters.agent = agentFilter.value;
      fetchCommsLog();
    };
  }

  const replyInput = document.getElementById('comms-reply-input');
  const replySend = document.getElementById('comms-reply-send');
  const replyClose = document.getElementById('comms-reply-close');

  if (replyInput) {
    replyInput.addEventListener('input', () => {
      if (replySend) replySend.disabled = !replyInput.value.trim();
    });
    replyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCommsReply(); }
    });
  }
  if (replySend) replySend.addEventListener('click', sendCommsReply);
  if (replyClose) replyClose.addEventListener('click', closeCommsReply);

  renderCommsAgentRow();
  fetchCommsLog();
  fetchCommsConnections();
  if (!_commsPolling) { _commsPolling = true; addPollingInterval(fetchCommsConnections, 30000); }
  commsState.loaded = true;
}

async function fetchCommsLog() {
  const { type, agent, since } = commsState.filters;
  const params = new URLSearchParams();
  if (type && type !== 'all') params.set('type', type);
  if (agent) params.set('agent', agent);
  if (since) params.set('since', since);
  params.set('limit', '100');

  const pq = getProjectQueryParam();
  if (pq) params.set('project_id', currentProject.id);
  const data = await fetchFromAPI('/api/v1/comms?' + params.toString());
  if (!data) return;
  commsState.messages = data.messages || [];
  renderCommsLog();
}

async function fetchCommsConnections() {
  const cpq = getProjectQueryParam();
  const data = await fetchFromAPI('/api/v1/comms/connections?since=1h' + (cpq ? '&' + cpq : ''));
  if (!data) return;
  commsState.connections = data.connections || [];
  spawnCommsParticles();
  renderCommsNetwork();
}

function renderCommsLog() {
  const logEl = document.getElementById('comms-log');
  if (!logEl) return;

  if (!commsState.messages.length) {
    logEl.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'comms-log-empty';
    empty.textContent = 'No communications in this time range.';
    logEl.appendChild(empty);
    return;
  }

  logEl.textContent = '';
  for (const m of commsState.messages) {
    const fromAgent = AGENTS[m.from] || { icon: '', name: m.from };
    const toAgent = AGENTS[m.to] || { icon: '', name: m.to };
    const preview = (m.content || '').length > 120 ? m.content.slice(0, 120) + '...' : m.content;

    const entry = document.createElement('div');
    entry.className = 'comms-log-entry';
    entry.dataset.type = m.type;
    entry.dataset.agentId = m.to;
    entry.dataset.agentName = toAgent.name;
    entry.dataset.agentIcon = toAgent.icon || '';

    const route = document.createElement('div');
    route.className = 'comms-log-route';
    route.textContent = fromAgent.name + ' \u2192 ' + toAgent.name;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'comms-log-message';
    msgDiv.textContent = preview;

    const meta = document.createElement('div');
    meta.className = 'comms-log-meta';

    const time = document.createElement('span');
    time.className = 'comms-log-time';
    time.textContent = timeAgo(m.created_at);

    const typeBadge = document.createElement('span');
    typeBadge.className = 'comms-log-type';
    typeBadge.dataset.type = m.type;
    typeBadge.textContent = m.type.toUpperCase();

    meta.appendChild(time);
    meta.appendChild(typeBadge);
    entry.appendChild(route);
    entry.appendChild(msgDiv);
    entry.appendChild(meta);

    entry.addEventListener('click', () => {
      logEl.querySelectorAll('.comms-log-entry').forEach(e => e.classList.remove('selected'));
      entry.classList.add('selected');
      openCommsReply(entry.dataset.agentId, entry.dataset.agentName, entry.dataset.agentIcon);
    });

    logEl.appendChild(entry);
  }
}

function openCommsReply(agentId, agentName, agentIcon) {
  commsState.replyTo = { agentId, agentName, agentIcon };
  const panel = document.getElementById('comms-reply-panel');
  const label = document.getElementById('comms-reply-to');
  const input = document.getElementById('comms-reply-input');
  if (panel) panel.hidden = false;
  if (label) label.textContent = 'Replying to ' + agentName;
  if (input) { input.value = ''; input.focus(); }
}

function closeCommsReply() {
  commsState.replyTo = null;
  const panel = document.getElementById('comms-reply-panel');
  if (panel) panel.hidden = true;
  document.querySelectorAll('.comms-log-entry.selected').forEach(e => e.classList.remove('selected'));
}

async function sendCommsReply() {
  if (!commsState.replyTo) return;
  const input = document.getElementById('comms-reply-input');
  const content = input ? input.value.trim() : '';
  if (!content) return;

  const sendBtn = document.getElementById('comms-reply-send');
  if (sendBtn) sendBtn.disabled = true;

  try {
    const resp = await fetch('/api/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'dashboard',
        to: commsState.replyTo.agentId,
        content,
        type: 'info',
        project_id: currentProject.id || 'default',
      }),
    });
    if (resp.ok) {
      closeCommsReply();
      fetchCommsLog();
    }
  } catch (e) {
    console.warn('Failed to send comms reply:', e);
  }
  if (sendBtn) sendBtn.disabled = false;
}

function renderCommsAgentRow() {
  const row = document.getElementById('comms-agents-row');
  if (!row) return;
  row.textContent = '';
  Object.entries(AGENTS).forEach(([id, a]) => {
    const pill = document.createElement('div');
    pill.className = 'comms-agent-pill';
    pill.dataset.agent = id;

    const iconEl = document.createElement('i');
    iconEl.className = 'comms-agent-pill__icon';
    iconEl.setAttribute('data-lucide', a.icon);

    const name = document.createElement('span');
    name.className = 'comms-agent-pill__name';
    name.textContent = a.name;

    const status = document.createElement('span');
    status.className = 'comms-agent-pill__status';
    status.dataset.status = a.status;

    pill.appendChild(iconEl);
    pill.appendChild(name);
    pill.appendChild(status);
    row.appendChild(pill);
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateCommsAgentStatus(data) {
  if (!data) return;
  const agentId = data.agentId || data.id;
  if (!agentId) return;
  const pill = document.querySelector('.comms-agent-pill[data-agent="' + agentId + '"] .comms-agent-pill__status');
  if (pill) pill.dataset.status = data.status || 'idle';
}

function handleCommsWsMessage(data) {
  if (!commsState.loaded) return;
  fetchCommsLog();
  fetchCommsConnections();
}

// --- Comms Network Canvas ---

function spawnCommsParticles() {
  commsState.particles = [];
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  for (const conn of commsState.connections) {
    // Only animate connections with activity in the last 5 minutes
    if (conn.last_active < fiveMinAgo) continue;
    const count = Math.min(Math.max(1, conn.count), 4);
    for (let i = 0; i < count; i++) {
      commsState.particles.push({
        from: conn.from,
        to: conn.to,
        progress: Math.random(),
        speed: 0.003 + Math.random() * 0.004,
      });
    }
  }
}

function getCommsAgentPositions(canvas) {
  const agentIds = Object.keys(AGENTS);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.35;
  const positions = {};

  agentIds.forEach((id, i) => {
    const angle = (i / agentIds.length) * 2 * Math.PI - Math.PI / 2;
    positions[id] = {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });
  return positions;
}

function renderCommsNetwork() {
  const canvas = document.getElementById('comms-network-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const accentColor = themeAccent();
  const activeColor = themeGreen();
  const textColor = cssVar('--text-primary') || (isLight ? '#333340' : '#e4e4ef');
  const mutedColor = cssVar('--text-secondary') || (isLight ? '#666680' : '#aaaabe');
  const bgNodeColor = cssVar('--bg-glass') || (isLight ? 'rgba(255,255,255,0.9)' : 'rgba(13,13,24,0.85)');
  const nodeBorder = cssVar('--border-color') || (isLight ? 'rgba(90,140,30,0.3)' : 'rgba(0,255,159,0.14)');

  const positions = getCommsAgentPositions(canvas);
  const agentIds = Object.keys(AGENTS);

  const activeAgentIds = new Set();
  for (const conn of commsState.connections) {
    activeAgentIds.add(conn.from);
    activeAgentIds.add(conn.to);
  }

  function getBezierCP(from, to) {
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const offset = len * 0.15;
    return { x: mx + (-dy / len) * offset, y: my + (dx / len) * offset };
  }

  function animate() {
    ctx.clearRect(0, 0, w, h);

    // Faint scan lines
    ctx.strokeStyle = cssVar('--accent-faint') || 'rgba(0,255,159,0.03)';
    ctx.setLineDash([2, 6]);
    for (let y = 0; y < h; y += 4) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Active connections
    for (const conn of commsState.connections) {
      const from = positions[conn.from];
      const to = positions[conn.to];
      if (!from || !to) continue;
      const cp = getBezierCP(from, to);
      const lineWidth = Math.min(1 + conn.count * 0.5, 4);
      const alpha = Math.min(0.3 + conn.count * 0.15, 0.9);

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cp.x, cp.y, to.x, to.y);
      ctx.strokeStyle = 'rgba(0, 255, 136, ' + alpha + ')';
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }

    // Particles
    for (const p of commsState.particles) {
      p.progress += p.speed;
      if (p.progress > 1) p.progress -= 1;

      const from = positions[p.from];
      const to = positions[p.to];
      if (!from || !to) continue;
      const cp = getBezierCP(from, to);

      const t = p.progress;
      const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cp.x + t * t * to.x;
      const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cp.y + t * t * to.y;

      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 255, 136, 0.18)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = activeColor;
      ctx.fill();
    }

    // Agent nodes
    for (const id of agentIds) {
      const pos = positions[id];
      const agent = AGENTS[id];
      if (!pos) continue;
      const isActive = activeAgentIds.has(id);
      const nodeRadius = 22;

      if (isActive) {
        const pulse = 0.3 + 0.3 * Math.sin(Date.now() / 500);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, nodeRadius + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 136, ' + (pulse * 0.15) + ')';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = bgNodeColor;
      ctx.fill();
      ctx.strokeStyle = isActive ? accentColor : nodeBorder;
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.stroke();

      ctx.font = "bold 13px 'Orbitron', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isActive ? accentColor : textColor;
      ctx.fillText((agent.name || '?').charAt(0).toUpperCase(), pos.x, pos.y);

      ctx.font = "600 10px 'Orbitron', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = mutedColor;
      ctx.fillText(agent.name.toUpperCase(), pos.x, pos.y + nodeRadius + 5);
    }

    if (commsState.connections.length > 0) {
      commsState.animFrame = requestAnimationFrame(animate);
    }
  }

  if (commsState.animFrame) {
    cancelAnimationFrame(commsState.animFrame);
    commsState.animFrame = null;
  }

  // Draw once even without connections (shows static nodes), then stop loop if no activity
  animate();
  if (commsState.connections.length === 0 && commsState.animFrame) {
    cancelAnimationFrame(commsState.animFrame);
    commsState.animFrame = null;
  }
}

// --------------- WEBHOOKS PAGE ---------------
// NOTE: innerHTML usage here is safe -- all data comes from our own API/DB, not user input.
// The webhook URLs and event types are validated server-side before storage.

var API = '/api/v1';
var webhooksCache = [];
var deliveriesCache = [];

function initWebhooksPage() {
  var addBtn = document.getElementById('btn-add-webhook');
  var form = document.getElementById('webhook-form');
  var saveBtn = document.getElementById('btn-save-webhook');
  var cancelBtn = document.getElementById('btn-cancel-webhook');

  if (addBtn) addBtn.addEventListener('click', function() {
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });

  if (cancelBtn) cancelBtn.addEventListener('click', function() {
    form.style.display = 'none';
    document.getElementById('wh-target-url').value = '';
    document.getElementById('wh-secret').value = '';
  });

  if (saveBtn) saveBtn.addEventListener('click', function() {
    var eventType = document.getElementById('wh-event-type').value;
    var targetUrl = document.getElementById('wh-target-url').value.trim();
    var secret = document.getElementById('wh-secret').value.trim();

    if (!targetUrl) { alert('Target URL is required'); return; }
    try { new URL(targetUrl); } catch(e) { alert('Invalid URL'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    fetch(API + '/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, target_url: targetUrl, secret: secret }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { alert(data.error); return; }
      form.style.display = 'none';
      document.getElementById('wh-target-url').value = '';
      document.getElementById('wh-secret').value = '';
      fetchWebhooks();
    })
    .catch(function(err) { alert('Failed: ' + err.message); })
    .finally(function() { saveBtn.disabled = false; saveBtn.textContent = 'Save'; });
  });
}

function fetchWebhooks() {
  var pq = getProjectQueryParam();
  fetch(API + '/webhooks' + (pq ? '?' + pq : ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      webhooksCache = data;
      renderWebhooksList();
    })
    .catch(function() {});

  fetch(API + '/webhooks/deliveries?limit=50' + (pq ? '&' + pq : ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      deliveriesCache = data;
      renderWebhookDeliveries();
    })
    .catch(function() {});
}

function renderWebhooksList() {
  var container = document.getElementById('webhooks-list');
  if (!container) return;

  var countEl = document.querySelector('[data-bind="webhook-count"]');
  if (countEl) countEl.textContent = webhooksCache.length + ' webhook' + (webhooksCache.length !== 1 ? 's' : '');

  if (webhooksCache.length === 0) {
    container.textContent = '';
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.4;text-align:center;padding:20px;color:var(--text-muted);';
    empty.textContent = 'No webhooks registered. Click "+ Add Webhook" to create one.';
    container.appendChild(empty);
    return;
  }

  var eventColors = {
    agent_completed: themeAccent(),
    security_finding: themeRed(),
    task_completed: themeCyan(),
    guard_blocked: themeAmber(),
  };

  var tbl = document.createElement('table');
  tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.85rem;';

  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  headRow.style.cssText = 'border-bottom:1px solid var(--border);color:var(--text-muted);font-size:0.75rem;';
  ['Event', 'URL', 'Active', 'Actions'].forEach(function(label, i) {
    var th = document.createElement('th');
    th.textContent = label;
    th.style.padding = '8px';
    th.style.textAlign = i >= 2 ? 'center' : 'left';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  webhooksCache.forEach(function(wh) {
    var color = eventColors[wh.event_type] || '#b0bec5';
    var tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';

    // Event cell
    var td1 = document.createElement('td');
    td1.style.padding = '8px';
    var dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + color;
    td1.appendChild(dot);
    td1.appendChild(document.createTextNode(wh.event_type));
    tr.appendChild(td1);

    // URL cell
    var td2 = document.createElement('td');
    td2.style.cssText = 'padding:8px;color:var(--text-muted);font-family:monospace;font-size:0.8rem;';
    td2.title = wh.target_url;
    td2.textContent = wh.target_url.length > 50 ? wh.target_url.slice(0, 50) + '...' : wh.target_url;
    tr.appendChild(td2);

    // Active cell
    var td3 = document.createElement('td');
    td3.style.cssText = 'padding:8px;text-align:center;';
    td3.textContent = wh.active ? '\u2705' : '\u26D4';
    tr.appendChild(td3);

    // Actions cell
    var td4 = document.createElement('td');
    td4.style.cssText = 'padding:8px;text-align:center;white-space:nowrap;';

    var testBtn = document.createElement('button');
    testBtn.textContent = '\u25B6 Test';
    testBtn.title = 'Send test payload';
    testBtn.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:0.75rem;margin-right:4px;';
    testBtn.addEventListener('click', function() { testWebhook(wh.id); });
    td4.appendChild(testBtn);

    var toggleBtn = document.createElement('button');
    toggleBtn.textContent = wh.active ? 'Pause' : 'Enable';
    toggleBtn.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:0.75rem;margin-right:4px;';
    toggleBtn.addEventListener('click', function() { toggleWebhookAction(wh.id, !wh.active); });
    td4.appendChild(toggleBtn);

    var delBtn = document.createElement('button');
    delBtn.textContent = '\u2716';
    delBtn.style.cssText = 'background:transparent;border:1px solid #ff1744;color:#ff1744;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:0.75rem;';
    delBtn.addEventListener('click', function() { deleteWebhookAction(wh.id); });
    td4.appendChild(delBtn);

    tr.appendChild(td4);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  container.textContent = '';
  container.appendChild(tbl);
}

function renderWebhookDeliveries() {
  var container = document.getElementById('webhook-deliveries');
  if (!container) return;

  if (deliveriesCache.length === 0) {
    container.textContent = '';
    var empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.4;text-align:center;padding:20px;color:var(--text-muted);';
    empty.textContent = 'No deliveries yet.';
    container.appendChild(empty);
    return;
  }

  var tbl = document.createElement('table');
  tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.8rem;';

  var thead = document.createElement('thead');
  var headRow = document.createElement('tr');
  headRow.style.cssText = 'border-bottom:1px solid var(--border);color:var(--text-muted);font-size:0.75rem;';
  [
    { label: 'Time', align: 'left' },
    { label: 'Event', align: 'left' },
    { label: 'Status', align: 'center' },
    { label: 'Latency', align: 'right' },
    { label: 'Error', align: 'left' },
  ].forEach(function(col) {
    var th = document.createElement('th');
    th.textContent = col.label;
    th.style.cssText = 'padding:6px;text-align:' + col.align + ';';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tbl.appendChild(thead);

  var tbody = document.createElement('tbody');
  deliveriesCache.slice(0, 30).forEach(function(d) {
    var tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';

    var td1 = document.createElement('td');
    td1.style.cssText = 'padding:6px;color:var(--text-muted);white-space:nowrap;';
    td1.textContent = new Date(d.created_at).toLocaleString();
    tr.appendChild(td1);

    var td2 = document.createElement('td');
    td2.style.padding = '6px';
    td2.textContent = d.event_type;
    tr.appendChild(td2);

    var td3 = document.createElement('td');
    td3.style.cssText = 'padding:6px;text-align:center;';
    var statusSpan = document.createElement('span');
    var statusColor = !d.status_code ? themeRed() : d.status_code < 300 ? themeAccent() : d.status_code < 500 ? themeAmber() : themeRed();
    statusSpan.style.cssText = 'color:' + statusColor + ';font-weight:600;';
    statusSpan.textContent = d.status_code ? String(d.status_code) : 'ERR';
    td3.appendChild(statusSpan);
    tr.appendChild(td3);

    var td4 = document.createElement('td');
    td4.style.cssText = 'padding:6px;text-align:right;color:var(--text-muted);';
    td4.textContent = d.response_time_ms ? d.response_time_ms + 'ms' : '--';
    tr.appendChild(td4);

    var td5 = document.createElement('td');
    td5.style.cssText = 'padding:6px;color:#ff1744;font-size:0.75rem;';
    td5.title = d.error || '';
    td5.textContent = d.error ? d.error.slice(0, 40) : '';
    tr.appendChild(td5);

    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  container.textContent = '';
  container.appendChild(tbl);
}

function testWebhook(id) {
  fetch(API + '/webhooks/' + id + '/test', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var msg = data.ok ? 'Test delivered! Status: ' + data.status_code : 'Test failed: ' + (data.error || 'Unknown error');
      alert(msg);
      setTimeout(fetchWebhooks, 1000);
    })
    .catch(function(err) { alert('Test failed: ' + err.message); });
}

function toggleWebhookAction(id, active) {
  fetch(API + '/webhooks/' + id + '/toggle', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: active }),
  })
  .then(function(r) { if (!r.ok) throw new Error(r.statusText); return fetchWebhooks(); })
  .catch(function(err) { console.error('Webhook action failed:', err); });
}

function deleteWebhookAction(id) {
  if (!confirm('Delete this webhook?')) return;
  fetch(API + '/webhooks/' + id, { method: 'DELETE' })
    .then(function(r) { if (!r.ok) throw new Error(r.statusText); return fetchWebhooks(); })
    .catch(function(err) { console.error('Webhook action failed:', err); });
}

// --------------- PROJECTS PAGE ---------------

const projectsPageState = {
  editingId: null,
};

function projectStatusLabel(status) {
  if (status === 'paused') return 'Paused';
  if (status === 'archived') return 'Archived';
  return 'Active';
}

function formatProjectDate(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function projectLastTouched(project) {
  return project.updated_at || project.created_at || Date.now();
}

function sortProjectsForPage(projects) {
  const rank = { active: 0, paused: 1, archived: 2 };
  return projects.slice().sort((a, b) => {
    const statusDelta = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (statusDelta !== 0) return statusDelta;
    return (projectLastTouched(b) || 0) - (projectLastTouched(a) || 0);
  });
}

function renderProjectsSummary(projects) {
  const summary = document.getElementById('projects-summary');
  if (!summary) return;
  const active = projects.filter(p => p.status === 'active').length;
  const paused = projects.filter(p => p.status === 'paused').length;
  const archived = projects.filter(p => p.status === 'archived').length;
  setElementHTML(
    summary,
    '<span><strong>' + projects.length + '</strong> total</span>' +
    '<span><strong>' + active + '</strong> active</span>' +
    '<span><strong>' + paused + '</strong> paused</span>' +
    '<span><strong>' + archived + '</strong> archived</span>'
  );
}

function projectStatusBadge(status) {
  return '<span class="project-status-badge project-status-badge--' + escapeHtml(status || 'active') + '">' +
    escapeHtml(projectStatusLabel(status)) +
    '</span>';
}

function projectActionButton(action, label, extraClass) {
  return '<button type="button" class="project-action-btn' + (extraClass ? ' ' + extraClass : '') + '" data-project-action="' + action + '">' +
    escapeHtml(label) +
    '</button>';
}

function projectIconMarkup(iconName) {
  return '<div class="project-card__icon"><i class="project-card__icon-glyph" data-lucide="' + escapeHtml(iconName || 'folder') + '"></i></div>';
}

function projectColorSchemeMarkup(project) {
  const theme = project.theme_id ? getThemeById(project.theme_id) : null;
  const swatches = [];
  const addSwatch = (color) => {
    if (!color || !/^#|rgb|hsl|var\(/.test(String(color))) return;
    if (!swatches.includes(color)) swatches.push(color);
  };

  addSwatch(project.primary_color);
  addSwatch(project.accent_color);
  addSwatch(project.sidebar_color);

  if (theme && theme.colors) {
    addSwatch(theme.colors.accent);
    addSwatch(theme.colors.sidebarBg || theme.colors.bgRaised);
    addSwatch(theme.colors.magenta || theme.colors.textPrimary);
  }

  const visibleSwatches = swatches.slice(0, 4);
  const schemeName = theme?.name || (project.theme_id ? project.theme_id.replace(/[-_]/g, ' ') : 'Custom');

  return '' +
    '<div class="project-card__scheme">' +
      '<span class="project-card__scheme-label">Color Scheme</span>' +
      '<div class="project-card__scheme-row">' +
        '<span class="project-card__scheme-name">' + escapeHtml(schemeName) + '</span>' +
        '<div class="project-card__scheme-swatches">' +
          visibleSwatches.map(color => (
            '<span class="project-card__scheme-swatch" style="background:' + escapeHtml(color) + '"></span>'
          )).join('') +
        '</div>' +
      '</div>' +
    '</div>';
}

function projectCardMarkup(project) {
  const accent = project.primary_color || 'var(--accent)';
  const accentSoft = project.primary_color
    ? 'rgba(' + hexToRgb(project.primary_color).r + ',' + hexToRgb(project.primary_color).g + ',' + hexToRgb(project.primary_color).b + ',0.12)'
    : 'var(--accent-subtle)';

  const actions = [
    projectActionButton('edit', 'Edit'),
    project.status === 'active' ? projectActionButton('pause', 'Pause') : '',
    project.status === 'paused' ? projectActionButton('resume', 'Resume') : '',
    project.status === 'archived' ? projectActionButton('restore', 'Restore') : projectActionButton('archive', 'Archive'),
    projectActionButton('delete', 'Delete', 'project-action-btn--danger'),
  ].filter(Boolean).join('');

  const autoArchiveText = project.auto_archive_days
    ? String(project.auto_archive_days) + ' days'
    : 'Off';

  const archiveMeta = project.archived_at
    ? '<span>Archived ' + escapeHtml(timeAgo(project.archived_at)) + '</span>'
    : '';

  return '' +
    '<article class="project-card project-card--' + escapeHtml(project.status || 'active') + '" data-project-id="' + escapeHtml(project.id) + '"' +
      ' style="--project-card-accent:' + escapeHtml(accent) + ';--project-card-accent-soft:' + escapeHtml(accentSoft) + ';">' +
      '<div class="project-card__top">' +
        '<div class="project-card__identity">' +
          projectIconMarkup(project.icon || 'folder') +
          '<div class="project-card__identity-copy">' +
            '<div class="project-card__title">' +
              '<h4>' + escapeHtml(project.display_name || project.name || project.id) + '</h4>' +
              projectStatusBadge(project.status || 'active') +
            '</div>' +
            '<div class="project-card__meta">' +
              '<span>' + escapeHtml(project.id) + '</span>' +
              '<span>slug: ' + escapeHtml(project.slug || '') + '</span>' +
              '<span>name: ' + escapeHtml(project.name || '') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        projectColorSchemeMarkup(project) +
      '</div>' +
      '<div class="project-card__body">' +
        '<div class="project-card__stats">' +
          '<div class="project-card__stat"><span class="project-card__stat-label">Auto-Archive</span><span class="project-card__stat-value">' + escapeHtml(autoArchiveText) + '</span></div>' +
          '<div class="project-card__stat"><span class="project-card__stat-label">Created</span><span class="project-card__stat-value">' + escapeHtml(formatProjectDate(project.created_at)) + '</span></div>' +
          '<div class="project-card__stat"><span class="project-card__stat-label">Updated</span><span class="project-card__stat-value">' + escapeHtml(timeAgo(projectLastTouched(project))) + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="project-card__footer">' +
        '<div class="project-card__timestamps">' +
          '<span>Last touched ' + escapeHtml(timeAgo(projectLastTouched(project))) + '</span>' +
          (project.paused_at ? '<span>Paused ' + escapeHtml(timeAgo(project.paused_at)) + '</span>' : '') +
          archiveMeta +
        '</div>' +
        '<div class="project-card__actions">' + actions + '</div>' +
      '</div>' +
    '</article>';
}

function resetProjectsForm() {
  projectsPageState.editingId = null;
  const form = document.getElementById('projects-form');
  if (form) form.reset();
  const idInput = document.getElementById('project-id-input');
  if (idInput) idInput.disabled = false;
  const title = document.getElementById('projects-form-title');
  const subtitle = document.getElementById('projects-form-subtitle');
  const submit = document.getElementById('projects-submit-btn');
  const resetBtn = document.getElementById('projects-form-reset');
  if (title) title.textContent = 'Create Project';
  if (subtitle) subtitle.textContent = 'Set up a new workspace and optional auto-archive window.';
  if (submit) submit.textContent = 'Create Project';
  if (resetBtn) resetBtn.hidden = true;
}

function populateProjectsForm(project) {
  projectsPageState.editingId = project.id;
  const form = document.getElementById('projects-form');
  if (!form) return;
  form.elements.id.value = project.id || '';
  form.elements.slug.value = project.slug || '';
  form.elements.name.value = project.name || '';
  form.elements.display_name.value = project.display_name || '';
  form.elements.icon.value = project.icon || '';
  form.elements.status.value = project.status || 'active';
  form.elements.auto_archive_days.value = project.auto_archive_days || '';
  const idInput = document.getElementById('project-id-input');
  if (idInput) idInput.disabled = true;
  const title = document.getElementById('projects-form-title');
  const subtitle = document.getElementById('projects-form-subtitle');
  const submit = document.getElementById('projects-submit-btn');
  const resetBtn = document.getElementById('projects-form-reset');
  if (title) title.textContent = 'Edit Project';
  if (subtitle) subtitle.textContent = 'Update project details, lifecycle state, and inactivity rules.';
  if (submit) submit.textContent = 'Save Changes';
  if (resetBtn) resetBtn.hidden = false;
}

async function submitProjectsForm(event) {
  event.preventDefault();
  const form = event.target;
  const id = String(form.elements.id.value || '').trim();
  const payload = {
    id,
    slug: String(form.elements.slug.value || '').trim(),
    name: String(form.elements.name.value || '').trim(),
    display_name: String(form.elements.display_name.value || '').trim(),
    icon: String(form.elements.icon.value || '').trim() || null,
    status: String(form.elements.status.value || 'active'),
    auto_archive_days: form.elements.auto_archive_days.value ? Number(form.elements.auto_archive_days.value) : null,
  };

  if (!payload.id || !payload.slug || !payload.name || !payload.display_name) {
    alert('Project ID, slug, name, and display name are required.');
    return;
  }

  const editing = projectsPageState.editingId;
  const endpoint = editing ? '/api/v1/projects/' + encodeURIComponent(editing) : '/api/v1/projects';
  const method = editing ? 'PUT' : 'POST';

  const res = await fetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Project save failed' }));
    alert(err.error || 'Project save failed');
    return;
  }

  resetProjectsForm();
  await fetchProjects();
}

async function updateProjectLifecycle(projectId, updates) {
  const res = await fetch('/api/v1/projects/' + encodeURIComponent(projectId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Project update failed' }));
    alert(err.error || 'Project update failed');
    return false;
  }
  await fetchProjects();
  return true;
}

async function deleteProjectFromPage(projectId) {
  const res = await fetch('/api/v1/projects/' + encodeURIComponent(projectId), { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Project delete failed' }));
    alert(err.error || 'Project delete failed');
    return false;
  }
  if (projectsPageState.editingId === projectId) resetProjectsForm();
  await fetchProjects();
  return true;
}

async function handleProjectCardAction(projectId, action) {
  const project = allProjects.find(p => p.id === projectId);
  if (!project) return;

  if (action === 'edit') {
    populateProjectsForm(project);
    document.getElementById('page-projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (action === 'delete') {
    if (!confirm('Delete project "' + (project.display_name || project.id) + '"? This removes related dashboard data and cannot be undone.')) return;
    await deleteProjectFromPage(projectId);
    return;
  }

  const nextStatusMap = {
    pause: 'paused',
    resume: 'active',
    restore: 'active',
    archive: 'archived',
  };
  const nextStatus = nextStatusMap[action];
  if (!nextStatus) return;
  await updateProjectLifecycle(projectId, { status: nextStatus });
}

function wireProjectsPage() {
  const form = document.getElementById('projects-form');
  if (form && !form.dataset.bound) {
    form.addEventListener('submit', submitProjectsForm);
    form.dataset.bound = 'true';
  }

  const resetBtn = document.getElementById('projects-form-reset');
  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.addEventListener('click', resetProjectsForm);
    resetBtn.dataset.bound = 'true';
  }

  const list = document.getElementById('projects-list');
  if (list && !list.dataset.bound) {
    list.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-project-action]');
      const card = event.target.closest('[data-project-id]');
      if (!btn || !card) return;
      handleProjectCardAction(card.dataset.projectId, btn.dataset.projectAction);
    });
    list.dataset.bound = 'true';
  }
}

function renderProjectsPage() {
  const list = document.getElementById('projects-list');
  if (!list) return;

  wireProjectsPage();
  renderProjectsSummary(allProjects);

  const projects = sortProjectsForPage(allProjects);
  if (projects.length === 0) {
    setElementHTML(list, '<div class="projects-empty">No projects yet. Create the first one from the form on the left.</div>');
    return;
  }

  setElementHTML(list, projects.map(projectCardMarkup).join(''));
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function initProjectsPage() {
  resetProjectsForm();
  renderProjectsPage();
}

// --------------- SETTINGS PAGE ---------------

let settingsProject = null;
const EXECUTION_DEFAULTS = {
  provider: 'claude_desktop',
  provider_secondary: '',
  provider_fallback: '',
  model: '',
  model_primary: '',
  model_secondary: '',
  model_fallback: '',
  fallback_policy: 'disabled',
  model_tier: 'balanced'
};

function normalizeFallbackPolicy(value) {
  if (!value) return 'disabled';
  if (value === 'enabled' || value === 'auto_on_error' || value === 'auto_on_quota') return 'enabled';
  if (value === 'manual_only' || value === 'disabled') return 'disabled';
  return 'disabled';
}

async function loadCostGate(projectId) {
  const statusEl = document.getElementById('cap-status');
  const monthlyEl = document.getElementById('cap-monthly');
  const dailyEl = document.getElementById('cap-daily');
  if (!statusEl || !monthlyEl || !dailyEl || !projectId) return;

  const data = await fetchFromAPI('/api/v1/cost-gate/' + encodeURIComponent(projectId));
  if (!data) {
    statusEl.textContent = 'No caps set - unlimited.';
    return;
  }

  if (data.monthly_cost_cap_usd != null) monthlyEl.value = data.monthly_cost_cap_usd;
  else monthlyEl.value = '';
  if (data.daily_cost_cap_usd != null) dailyEl.value = data.daily_cost_cap_usd;
  else dailyEl.value = '';

  const mtd = (data.mtd_spend_usd != null) ? '$' + Number(data.mtd_spend_usd).toFixed(2) : '$0.00';
  const today = (data.today_spend_usd != null) ? '$' + Number(data.today_spend_usd).toFixed(2) : '$0.00';
  if (data.monthly_cost_cap_usd != null) {
    const pct = Math.round((data.mtd_spend_usd || 0) / data.monthly_cost_cap_usd * 100);
    statusEl.textContent = 'Current: ' + mtd + ' MTD - ' + today + ' today - ' + pct + '% of cap';
  } else {
    statusEl.textContent = 'No caps set - unlimited.';
  }
}

// --------------- KILL SWITCH PANEL ---------------

async function renderKillSwitch() {
  const panel = document.getElementById('kill-switch-panel');
  if (!panel) return;

  // Admin check
  const me = await fetchFromAPI('/api/v1/auth/me');
  if (!me || me.user?.global_role !== 'admin') {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    const section = document.getElementById('settings-kill-switch-section');
    if (section) section.style.display = 'none';
    return;
  }
  const section = document.getElementById('settings-kill-switch-section');
  if (section) section.style.display = '';

  const ks = await fetchFromAPI('/api/v1/system-state/kill-switch');
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  const wrapper = document.createElement('div');
  wrapper.className = 'killswitch' + (ks && ks.active ? ' tripped' : '');

  const heading = document.createElement('h3');
  heading.style.cssText = 'margin:0 0 6px;font-size:15px;';
  heading.textContent = 'Kill Switch';
  wrapper.appendChild(heading);

  const status = document.createElement('p');
  status.className = 'kill-status';
  if (ks && ks.active) {
    const setAt = ks.set_at ? new Date(ks.set_at).toLocaleString() : 'unknown time';
    status.textContent = '\u26D4 Tripped at ' + setAt + ' Reason: ' + (ks.reason || '');
  } else {
    status.textContent = 'No kill switch active.';
  }
  wrapper.appendChild(status);

  const btn = document.createElement('button');
  btn.className = 'btn-danger';
  if (ks && ks.active) {
    btn.id = 'kill-clear';
    btn.textContent = 'Clear kill switch';
  } else {
    btn.id = 'kill-trip';
    btn.textContent = 'Pause all agents (kill switch)';
  }
  wrapper.appendChild(btn);


  panel.appendChild(wrapper);
}

let _killSwitchDelegated = false;
function _initKillSwitchDelegation() {
  if (_killSwitchDelegated) return;
  _killSwitchDelegated = true;

  const settingsPage = document.getElementById('page-settings');
  if (!settingsPage) return;

  settingsPage.addEventListener('click', async (e) => {
    if (e.target.id === 'kill-trip') {
      const modal = document.getElementById('kill-modal');
      const reasonInput = document.getElementById('kill-reason');
      if (!modal || !reasonInput) return;
      reasonInput.value = '';
      modal.classList.remove('hidden');
      reasonInput.focus();
    }

    if (e.target.id === 'kill-confirm') {
      const modal = document.getElementById('kill-modal');
      const reasonInput = document.getElementById('kill-reason');
      const reason = reasonInput ? reasonInput.value.trim() : '';
      if (!reason) { if (reasonInput) reasonInput.focus(); return; }
      if (modal) modal.classList.add('hidden');
      await apiFetch('/api/v1/system-state/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
        credentials: 'include',
      });
      renderKillSwitch();
    }

    if (e.target.id === 'kill-cancel') {
      const modal = document.getElementById('kill-modal');
      if (modal) modal.classList.add('hidden');
    }

    if (e.target.id === 'kill-clear') {
      if (!confirm('Clear the kill switch? Agents will resume.')) return;
      await apiFetch('/api/v1/system-state/kill-switch', {
        method: 'DELETE',
        credentials: 'include',
      });
      renderKillSwitch();
    }
  });
}

let _settingsPageInitialized = false;
function initSettingsPage() {
  if (!_settingsPageInitialized) {
    _settingsPageInitialized = true;
    const resetBtn = document.getElementById('settings-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetProjectSettings);

    const capSave = document.getElementById('cap-save');
    if (capSave) {
      capSave.addEventListener('click', async () => {
        const projectId = settingsProject && settingsProject.id;
        if (!projectId) return;
        const monthlyVal = document.getElementById('cap-monthly')?.value.trim();
        const dailyVal = document.getElementById('cap-daily')?.value.trim();
        const body = {
          monthly_cost_cap_usd: monthlyVal !== '' ? parseFloat(monthlyVal) : null,
          daily_cost_cap_usd:   dailyVal   !== '' ? parseFloat(dailyVal)   : null,
        };
        const result = await fetchFromAPI('/api/v1/cost-gate/' + encodeURIComponent(projectId) + '/caps', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        });
        const statusEl = document.getElementById('cap-status');
        if (result !== null) {
          if (statusEl) statusEl.textContent = 'Caps saved.';
          loadCostGate(projectId);
        } else {
          if (statusEl) statusEl.textContent = 'Save failed.';
        }
      });
    }
    [
      'settings-execution-provider',
      'settings-execution-provider-secondary',
      'settings-execution-provider-fallback',
      'settings-execution-model-primary',
      'settings-execution-model-secondary',
      'settings-execution-model-fallback',
      'settings-fallback-policy',
      'settings-model-tier',
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(evt, () => {
        syncSettingsExecutionModelUi();
        queueProjectSettingsSave();
      });
    });

    _initKillSwitchDelegation();
  }
  populateExecutionSettingsLabels();
  renderSettingsProjectBar();
  refreshIntegrations();
  renderKillSwitch();
}

function getSettingsExecutionState(project) {
  const modelPrimary = project?.execution_model_primary || project?.execution_model || EXECUTION_DEFAULTS.model_primary;
  return {
    provider: project?.execution_provider || EXECUTION_DEFAULTS.provider,
    provider_secondary: project?.execution_provider_secondary || EXECUTION_DEFAULTS.provider_secondary,
    provider_fallback: project?.execution_provider_fallback || EXECUTION_DEFAULTS.provider_fallback,
    model: project?.execution_model || EXECUTION_DEFAULTS.model,
    model_primary: modelPrimary,
    model_secondary: project?.execution_model_secondary || EXECUTION_DEFAULTS.model_secondary,
    model_fallback: project?.execution_model_fallback || EXECUTION_DEFAULTS.model_fallback,
    fallback_policy: normalizeFallbackPolicy(project?.fallback_policy) || EXECUTION_DEFAULTS.fallback_policy,
    model_tier: project?.model_tier || EXECUTION_DEFAULTS.model_tier,
  };
}

let settingsSaveTimer = null;
let settingsSaveSeq = 0;

function setSettingsStatus(state, message) {
  const el = document.getElementById('settings-status');
  if (!el) return;
  el.dataset.state = state || '';
  el.textContent = message || 'Saved';
}

function queueProjectSettingsSave() {
  if (!settingsProject) return;
  setSettingsStatus('saving', 'Saving...');
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveProjectSettings();
  }, 250);
}

function renderSettingsProjectBar() {
  const bar = document.getElementById('settings-project-bar');
  if (!bar) return;
  while (bar.firstChild) bar.removeChild(bar.firstChild);

  const projects = allProjects.filter(p => p.id && p.status !== 'archived');
  if (projects.length === 0) {
    const msg = document.createElement('p');
    msg.style.cssText = 'color:var(--text-muted);font-size:13px;';
    msg.textContent = 'No projects found. Create a project first.';
    bar.appendChild(msg);
    return;
  }

  const select = document.createElement('select');
  select.className = 'settings-project-select';
  projects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = (p.icon || '') + ' ' + (p.display_name || p.name);
    select.appendChild(opt);
  });

  if (currentProject.id) select.value = currentProject.id;

  select.addEventListener('change', () => {
    const proj = projects.find(p => p.id === select.value);
    if (proj) {
      settingsProject = proj;
      renderThemeGrid();
      renderColorOverrides();
      renderExecutionDefaults();
      loadCostGate(proj.id);
    }
  });

  bar.appendChild(select);

  const initial = projects.find(p => p.id === (currentProject.id || projects[0]?.id));
  if (initial) {
    settingsProject = initial;
    select.value = initial.id;
    renderThemeGrid();
    renderColorOverrides();
    renderExecutionDefaults();
    loadCostGate(initial.id);
  }
}

function renderThemeGrid() {
  const grid = document.getElementById('theme-grid');
  if (!grid || !_themesCache) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  const currentThemeId = settingsProject?.theme_id || '';
  const initialTheme = _themesCache.find(t => t.id === currentThemeId) || _themesCache[0];

  // Collapsible header showing the current theme + swatches + expand toggle
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'theme-picker-header';
  header.setAttribute('aria-expanded', 'false');

  const headerLeft = document.createElement('div');
  headerLeft.className = 'theme-picker-header__left';

  const label = document.createElement('span');
  label.className = 'theme-picker-header__label';
  label.textContent = 'Current theme';

  const nameEl = document.createElement('span');
  nameEl.className = 'theme-picker-header__name';

  headerLeft.appendChild(label);
  headerLeft.appendChild(nameEl);

  const preview = document.createElement('div');
  preview.className = 'theme-select-preview';

  const chevron = document.createElement('span');
  chevron.className = 'theme-picker-header__chevron';
  chevron.textContent = 'v';

  header.appendChild(headerLeft);
  header.appendChild(preview);
  header.appendChild(chevron);

  // Card grid, hidden until header is clicked
  const cards = document.createElement('div');
  cards.className = 'theme-cards';
  cards.hidden = true;

  const renderHeaderPreview = (theme) => {
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    if (!theme || !theme.colors) return;
    [
      theme.colors.accent,
      theme.colors.bgBase,
      theme.colors.bgRaised,
      theme.colors.sidebarBg || theme.colors.bgBase,
      theme.colors.textPrimary,
      theme.colors.magenta,
    ].forEach(c => {
      if (!c) return;
      const s = document.createElement('span');
      s.className = 'theme-swatch';
      s.style.background = c;
      preview.appendChild(s);
    });
    nameEl.textContent = theme.name;
  };

  renderHeaderPreview(initialTheme);

  const buildCard = (theme) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card' + (theme.id === (settingsProject?.theme_id || '') ? ' active' : '');
    card.dataset.themeId = theme.id;

    const prev = document.createElement('div');
    prev.className = 'theme-card__preview';
    prev.style.background = theme.colors.bgBase;

    const swatches = document.createElement('div');
    swatches.className = 'theme-card__swatches';
    [theme.colors.accent, theme.colors.bgRaised, theme.colors.textPrimary, theme.colors.magenta].forEach(c => {
      const s = document.createElement('span');
      s.className = 'theme-swatch';
      s.style.background = c;
      swatches.appendChild(s);
    });
    prev.appendChild(swatches);

    const sidebarBar = document.createElement('div');
    sidebarBar.className = 'theme-card__sidebar-bar';
    sidebarBar.style.background = theme.colors.sidebarBg || theme.colors.bgBase;
    prev.appendChild(sidebarBar);

    const accentLine = document.createElement('div');
    accentLine.className = 'theme-card__accent-line';
    accentLine.style.background = theme.colors.accent;
    prev.appendChild(accentLine);

    const info = document.createElement('div');
    info.className = 'theme-card__info';
    const nm = document.createElement('span');
    nm.className = 'theme-card__name';
    nm.textContent = theme.name;
    const desc = document.createElement('span');
    desc.className = 'theme-card__desc';
    desc.textContent = theme.description || '';
    info.appendChild(nm);
    info.appendChild(desc);

    card.appendChild(prev);
    card.appendChild(info);
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      selectTheme(theme);
      renderHeaderPreview(theme);
      // Collapse after selection
      cards.hidden = true;
      header.setAttribute('aria-expanded', 'false');
      header.classList.remove('expanded');
    });
    return card;
  };

  _themesCache.forEach(theme => cards.appendChild(buildCard(theme)));

  header.addEventListener('click', () => {
    const expanded = !cards.hidden;
    cards.hidden = expanded;
    header.setAttribute('aria-expanded', String(!expanded));
    header.classList.toggle('expanded', !expanded);
  });

  grid.appendChild(header);
  grid.appendChild(cards);
}

function selectTheme(theme) {
  if (!settingsProject) return;
  settingsProject.theme_id = theme.id;

  applyThemeToRoot(theme);

  document.querySelectorAll('.theme-card').forEach(c => {
    c.classList.toggle('active', c.dataset.themeId === theme.id);
  });

  fetch(API + '/projects/' + settingsProject.id + '/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_id: theme.id })
  }).then(r => r.json()).then(() => {
    const idx = allProjects.findIndex(p => p.id === settingsProject.id);
    if (idx >= 0) allProjects[idx].theme_id = theme.id;
    if (currentProject.id === settingsProject.id) {
      currentProject.settings = currentProject.settings || {};
      currentProject.settings.theme_id = theme.id;
    }
  }).catch(err => console.warn('Failed to save theme:', err));
}

function renderColorOverrides() {
  const grid = document.getElementById('color-overrides-grid');
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  const overrides = [
    { key: 'accent_color', label: 'Accent Color', current: settingsProject?.accent_color },
    { key: 'sidebar_color', label: 'Sidebar Background', current: settingsProject?.sidebar_color },
    { key: 'primary_color', label: 'Primary Text', current: settingsProject?.primary_color },
  ];

  overrides.forEach(o => {
    const row = document.createElement('div');
    row.className = 'color-override-row';

    const label = document.createElement('label');
    label.className = 'color-override-label';
    label.textContent = o.label;

    const inputWrap = document.createElement('div');
    inputWrap.className = 'color-override-input-wrap';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-override-picker';
    colorInput.value = o.current || themeAccent();
    colorInput.dataset.key = o.key;

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'color-override-text';
    textInput.value = o.current || '';
    textInput.placeholder = 'Default';
    textInput.dataset.key = o.key;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'color-override-clear';
    clearBtn.textContent = 'x';
    clearBtn.title = 'Clear override';
    clearBtn.addEventListener('click', () => {
      textInput.value = '';
      colorInput.value = themeAccent();
      queueProjectSettingsSave();
    });

    colorInput.addEventListener('input', () => {
      textInput.value = colorInput.value;
      queueProjectSettingsSave();
    });
    textInput.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(textInput.value)) colorInput.value = textInput.value;
      queueProjectSettingsSave();
    });

    inputWrap.appendChild(colorInput);
    inputWrap.appendChild(textInput);
    inputWrap.appendChild(clearBtn);
    row.appendChild(label);
    row.appendChild(inputWrap);
    grid.appendChild(row);
  });
}

function populateExecutionSettingsLabels() {
  const providers = [
    document.getElementById('settings-execution-provider'),
    document.getElementById('settings-execution-provider-secondary'),
    document.getElementById('settings-execution-provider-fallback'),
  ];
  const fallback = document.getElementById('settings-fallback-policy');
  const tier = document.getElementById('settings-model-tier');
  providers.forEach((provider, index) => {
    if (!provider || provider.dataset.labeled) return;
    provider.innerHTML = [
      ...(index > 0 ? ['<option value="">None</option>'] : []),
      '<option value="claude_desktop">Claude Desktop</option>',
      '<option value="codex_local">Codex Local</option>',
      '<option value="anthropic_api">Anthropic API</option>',
      '<option value="openai_api">OpenAI API</option>',
      '<option value="openrouter_api">OpenRouter</option>',
      '<option value="ollama">Ollama</option>',
      '<option value="lm_studio">LM Studio</option>'
    ].join('');
    provider.dataset.labeled = 'true';
  });
  if (fallback && !fallback.dataset.labeled) {
    fallback.innerHTML = [
      '<option value="disabled">Disabled</option>',
      '<option value="enabled">Enabled</option>'
    ].join('');
    fallback.dataset.labeled = 'true';
  }
  if (tier && !tier.dataset.labeled) {
    tier.innerHTML = [
      '<option value="cheap">Cheap</option>',
      '<option value="balanced">Balanced</option>',
      '<option value="premium">Premium</option>'
    ].join('');
    tier.dataset.labeled = 'true';
  }
}

function syncSettingsExecutionModelUi() {
  const pairs = [
    ['settings-execution-provider', 'settings-execution-model-primary'],
    ['settings-execution-provider-secondary', 'settings-execution-model-secondary'],
    ['settings-execution-provider-fallback', 'settings-execution-model-fallback'],
  ];

  pairs.forEach(([providerId, modelId]) => {
    const provider = document.getElementById(providerId);
    const model = document.getElementById(modelId);
    if (!provider || !model) return;

    const providerValue = provider.value;
    const disabled = !providerValue || providerValue === 'claude_desktop';
    model.disabled = disabled;

    if (!providerValue) {
      model.placeholder = 'Select a provider first';
    } else if (providerValue === 'claude_desktop') {
      model.placeholder = 'Not used for Claude Desktop';
    } else if (providerValue === 'codex_local') {
      model.placeholder = 'gpt-5.2-codex / gpt-5.4 / gpt-5-mini';
    } else if (providerValue === 'anthropic_api') {
      model.placeholder = 'claude-3-5-haiku-latest / claude-sonnet-4-6';
    } else if (providerValue === 'openai_api') {
      model.placeholder = 'gpt-5-mini / gpt-5.4 / o4-mini';
    } else if (providerValue === 'openrouter_api') {
      model.placeholder = 'openai/gpt-4o / anthropic/claude-sonnet-4-5 / meta-llama/llama-3.3-70b-instruct';
    } else if (providerValue === 'ollama') {
      model.placeholder = 'llama3.2 / mistral / qwen2.5-coder:7b';
    } else if (providerValue === 'lm_studio') {
      model.placeholder = 'Model name as shown in LM Studio server';
    }
  });
}

function renderExecutionDefaults() {
  const state = getSettingsExecutionState(settingsProject);
  const provider = document.getElementById('settings-execution-provider');
  const providerSecondary = document.getElementById('settings-execution-provider-secondary');
  const providerFallback = document.getElementById('settings-execution-provider-fallback');
  const modelPrimary = document.getElementById('settings-execution-model-primary');
  const modelSecondary = document.getElementById('settings-execution-model-secondary');
  const modelFallback = document.getElementById('settings-execution-model-fallback');
  const fallback = document.getElementById('settings-fallback-policy');
  const tier = document.getElementById('settings-model-tier');
  if (provider) provider.value = state.provider;
  if (providerSecondary) providerSecondary.value = state.provider_secondary;
  if (providerFallback) providerFallback.value = state.provider_fallback;
  if (modelPrimary) modelPrimary.value = state.model_primary;
  if (modelSecondary) modelSecondary.value = state.model_secondary;
  if (modelFallback) modelFallback.value = state.model_fallback;
  if (fallback) fallback.value = normalizeFallbackPolicy(state.fallback_policy);
  if (tier) tier.value = state.model_tier;
  setSettingsStatus('', 'Saved');
  syncSettingsExecutionModelUi();
}

function saveProjectSettings() {
  if (!settingsProject) return;
  const requestId = ++settingsSaveSeq;
  const overrides = {};
  document.querySelectorAll('.color-override-text').forEach(input => {
    overrides[input.dataset.key] = input.value.trim() || null;
  });

  const execution = {
    execution_provider: document.getElementById('settings-execution-provider')?.value || EXECUTION_DEFAULTS.provider,
    execution_provider_secondary: document.getElementById('settings-execution-provider-secondary')?.value || null,
    execution_provider_fallback: document.getElementById('settings-execution-provider-fallback')?.value || null,
    execution_model_primary: document.getElementById('settings-execution-model-primary')?.value.trim() || null,
    execution_model_secondary: document.getElementById('settings-execution-model-secondary')?.value.trim() || null,
    execution_model_fallback: document.getElementById('settings-execution-model-fallback')?.value.trim() || null,
    fallback_policy: normalizeFallbackPolicy(document.getElementById('settings-fallback-policy')?.value) || EXECUTION_DEFAULTS.fallback_policy,
    model_tier: document.getElementById('settings-model-tier')?.value || EXECUTION_DEFAULTS.model_tier,
  };
  if (!execution.execution_provider || execution.execution_provider === 'claude_desktop') execution.execution_model_primary = null;
  if (!execution.execution_provider_secondary || execution.execution_provider_secondary === 'claude_desktop') execution.execution_model_secondary = null;
  if (!execution.execution_provider_fallback || execution.execution_provider_fallback === 'claude_desktop') execution.execution_model_fallback = null;
  execution.execution_model = execution.execution_model_primary;

  setSettingsStatus('saving', 'Saving...');

  fetch(API + '/projects/' + settingsProject.id + '/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_id: settingsProject.theme_id || null, ...overrides, ...execution })
  }).then(r => r.json()).then(saved => {
    if (requestId !== settingsSaveSeq) return;
    if (saved && saved.error) throw new Error(saved.error);
    Object.assign(settingsProject, saved);
    const idx = allProjects.findIndex(p => p.id === settingsProject.id);
    if (idx >= 0) Object.assign(allProjects[idx], saved);
    if (currentProject.id === settingsProject.id) {
      currentProject.settings = saved;
      applyProjectTheme(saved);
    }
    setSettingsStatus('', 'Saved');
  }).catch(err => {
    if (requestId !== settingsSaveSeq) return;
    console.warn('Failed to save settings:', err);
    setSettingsStatus('error', 'Save failed');
  });
}

function resetProjectSettings() {
  if (!settingsProject) return;
  fetch(API + '/projects/' + settingsProject.id + '/settings')
    .then(r => r.json())
    .then(saved => {
      Object.assign(settingsProject, saved || {});
      const idx = allProjects.findIndex(p => p.id === settingsProject.id);
      if (idx >= 0) Object.assign(allProjects[idx], saved || {});
      renderColorOverrides();
      renderExecutionDefaults();
      if (settingsProject.theme_id) {
        const theme = getThemeById(settingsProject.theme_id);
        if (theme) applyThemeToRoot(theme);
      }
    })
    .catch(err => console.warn('Failed to reset settings view:', err));
}


// ============================================================
// OAuth Integration Cards
// ============================================================

async function fetchIntegrationStatus(projectId) {
  if (!projectId) return [];
  try {
    const data = await fetchFromAPI('/api/v1/integrations/status?project_id=' + encodeURIComponent(projectId));
    return (data && Array.isArray(data.integrations)) ? data.integrations : [];
  } catch (e) {
    console.warn('Failed to fetch integration status:', e);
    return [];
  }
}

function renderIntegrationCards(integrations, projectId) {
  const container = document.getElementById('integration-cards');
  if (!container) return;

  while (container.firstChild) container.removeChild(container.firstChild);

  if (!projectId) {
    const msg = document.createElement('p');
    msg.className = 'integration-empty';
    msg.textContent = 'Select a project to manage integrations.';
    container.appendChild(msg);
    return;
  }

  // Always show a Google card -- connected, disconnected, or not yet added
  const services = [{ id: 'google', label: 'Google', icon: 'mail' }];

  for (const svc of services) {
    const existing = integrations.find(i => i.service === svc.id);
    const card = document.createElement('div');
    card.className = 'integration-card';
    if (existing && (existing.status === 'disconnected' || existing.status === 'expired')) {
      card.classList.add('integration-expired');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'integration-header';

    const iconEl = document.createElement('i');
    iconEl.setAttribute('data-lucide', svc.icon);
    iconEl.style.cssText = 'width:16px;height:16px;flex-shrink:0;';
    header.appendChild(iconEl);

    const labelEl = document.createElement('span');
    labelEl.textContent = svc.label;
    header.appendChild(labelEl);

    const dot = document.createElement('span');
    dot.className = 'integration-status-dot ' + (existing && existing.status === 'connected' ? 'connected' : 'disconnected');
    header.appendChild(dot);

    card.appendChild(header);

    if (existing) {
      const accountEl = document.createElement('div');
      accountEl.className = 'integration-account';
      accountEl.textContent = existing.account || '';
      card.appendChild(accountEl);

      if (existing.scopes && existing.scopes.length > 0) {
        const scopesEl = document.createElement('div');
        scopesEl.className = 'integration-scopes';
        const scopeLabels = existing.scopes.map(s => {
          const parts = s.split('/');
          return parts[parts.length - 1] || s;
        });
        scopesEl.textContent = scopeLabels.slice(0, 3).join(', ') + (scopeLabels.length > 3 ? ', ...' : '');
        card.appendChild(scopesEl);
      }

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;';

      if (existing.status === 'connected') {
        const disconnBtn = document.createElement('button');
        disconnBtn.className = 'btn-secondary';
        disconnBtn.style.cssText = 'font-size:12px;padding:4px 10px;';
        disconnBtn.textContent = 'Disconnect';
        disconnBtn.addEventListener('click', () => disconnectIntegration(svc.id, projectId, existing.account));
        btnRow.appendChild(disconnBtn);
      } else {
        const reconnBtn = document.createElement('button');
        reconnBtn.className = 'btn-primary';
        reconnBtn.style.cssText = 'font-size:12px;padding:4px 10px;';
        reconnBtn.textContent = 'Reconnect';
        reconnBtn.addEventListener('click', () => connectIntegration(svc.id, projectId));
        btnRow.appendChild(reconnBtn);
      }

      card.appendChild(btnRow);
    } else {
      const connectBtn = document.createElement('button');
      connectBtn.className = 'btn-primary';
      connectBtn.style.cssText = 'font-size:12px;padding:4px 10px;margin-top:8px;';
      connectBtn.textContent = 'Connect';
      connectBtn.addEventListener('click', () => connectIntegration(svc.id, projectId));
      card.appendChild(connectBtn);
    }

    container.appendChild(card);
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function connectIntegration(service, projectId) {
  const returnUrl = window.location.origin + window.location.pathname + '#settings';
  window.location.href = '/api/v1/integrations/' + encodeURIComponent(service) + '/auth'
    + '?project_id=' + encodeURIComponent(projectId)
    + '&return_url=' + encodeURIComponent(returnUrl);
}

async function disconnectIntegration(service, projectId, account) {
  try {
    await fetchFromAPI(
      '/api/v1/integrations/' + encodeURIComponent(service)
        + '?project_id=' + encodeURIComponent(projectId)
        + (account ? '&account=' + encodeURIComponent(account) : ''),
      { method: 'DELETE' }
    );
  } catch (e) {
    console.warn('Failed to disconnect integration:', e);
  }
  await refreshIntegrations();
}

async function refreshIntegrations() {
  const projectId = currentProject.id;
  if (!projectId) {
    renderIntegrationCards([], '');
    return;
  }
  const integrations = await fetchIntegrationStatus(projectId);
  renderIntegrationCards(integrations, projectId);
}

// --------------- CREDENTIALS PAGE ---------------

const CRED_KEY_SUGGESTIONS = {
  telegram: ['bot_token', 'allowed_chat_ids'],
  twitter: ['api_key', 'api_secret', 'access_token', 'access_secret'],
  linkedin: ['client_id', 'client_secret', 'access_token', 'redirect_uri', 'person_urn'],
  meta: ['app_id', 'app_secret', 'access_token', 'page_id'],
  shopify: ['api_key', 'api_secret', 'access_token', 'store_url'],
  google: ['client_id', 'client_secret'],
  gemini: ['api_key'],
  smtp: ['host', 'port', 'user', 'pass'],
};
const CRED_SERVICES = ['telegram', 'twitter', 'linkedin', 'meta', 'shopify', 'wordpress', 'smtp', 'google', 'gemini', 'custom'];

function refreshCredentialsPage() {
  const container = document.getElementById('cred-container');
  if (!container) return;
  const projectId = currentProject.id; // empty string = all projects
  const credentialsUrl = projectId
    ? '/api/v1/credentials?project_id=' + encodeURIComponent(projectId)
    : '/api/v1/credentials';
  const summaryUrl = projectId
    ? '/api/v1/credentials/summary?project_id=' + encodeURIComponent(projectId)
    : '/api/v1/credentials/summary';
  Promise.all([fetchFromAPI(credentialsUrl), fetchFromAPI(summaryUrl)]).then(([credentialData, summaryData]) => {
    const creds = credentialData?.credentials || [];
    if (projectId) {
      renderCredentialsList(container, creds, projectId, summaryData?.integrations || []);
    } else {
      renderAllProjectsCredentials(container, creds, summaryData?.projects || []);
    }
  }).catch(e => {
    console.warn('Failed to fetch credentials:', e);
    container.textContent = '';
    const msg = document.createElement('p');
    msg.style.color = 'var(--text-muted)';
    msg.textContent = 'Failed to load credentials.';
    container.appendChild(msg);
  });
}

function integrationStatusMeta(status) {
  switch (status) {
    case 'connected': return { label: 'Connected', className: 'connected' };
    case 'configured': return { label: 'Configured', className: 'configured' };
    case 'incomplete': return { label: 'Incomplete', className: 'incomplete' };
    case 'disconnected': return { label: 'Disconnected', className: 'disconnected' };
    default: return { label: 'Unknown', className: 'unknown' };
  }
}

function renderIntegrationSummaryBlock(integrations, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'cred-summary-block';

  const heading = document.createElement('div');
  heading.className = 'cred-summary-header';

  const title = document.createElement('h3');
  title.className = 'cred-summary-title';
  title.textContent = (opts && opts.title) || 'Integration Summary';
  heading.appendChild(title);

  const counts = { connected: 0, configured: 0, incomplete: 0, disconnected: 0 };
  integrations.forEach(item => {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  });
  const badge = document.createElement('span');
  badge.className = 'cred-summary-count';
  badge.textContent = integrations.length + ' integration' + (integrations.length !== 1 ? 's' : '');
  heading.appendChild(badge);
  wrap.appendChild(heading);

  if (!integrations.length) {
    const empty = document.createElement('div');
    empty.className = 'cred-empty';
    empty.textContent = (opts && opts.emptyText) || 'No integrations detected for this scope.';
    wrap.appendChild(empty);
    return wrap;
  }

  const statusRow = document.createElement('div');
  statusRow.className = 'cred-summary-totals';
  ['connected', 'configured', 'incomplete', 'disconnected'].forEach(status => {
    const meta = integrationStatusMeta(status);
    const chip = document.createElement('span');
    chip.className = 'cred-summary-total cred-summary-total--' + meta.className;
    chip.textContent = counts[status] + ' ' + meta.label;
    statusRow.appendChild(chip);
  });
  wrap.appendChild(statusRow);

  const grid = document.createElement('div');
  grid.className = 'cred-summary-grid';

  integrations.forEach(item => {
    const meta = integrationStatusMeta(item.status);
    const card = document.createElement('div');
    card.className = 'cred-summary-card';

    const top = document.createElement('div');
    top.className = 'cred-summary-card-top';

    const name = document.createElement('div');
    name.className = 'cred-summary-service';
    name.textContent = item.base_service;
    top.appendChild(name);

    const pill = document.createElement('span');
    pill.className = 'cred-summary-pill cred-summary-pill--' + meta.className;
    pill.textContent = meta.label;
    top.appendChild(pill);
    card.appendChild(top);

    const detail = document.createElement('div');
    detail.className = 'cred-summary-detail';
    const bits = [];
    if (item.account) bits.push(item.account);
    bits.push(item.key_count + ' key' + (item.key_count !== 1 ? 's' : ''));
    if (item.missing_keys && item.missing_keys.length) bits.push('missing: ' + item.missing_keys.join(', '));
    else if (item.scopes && item.scopes.length) bits.push(item.scopes.slice(0, 2).map(s => s.split('/').pop() || s).join(', '));
    detail.textContent = bits.join(' - ');
    card.appendChild(detail);

    grid.appendChild(card);
  });

  wrap.appendChild(grid);
  return wrap;
}

function renderAllProjectsCredentials(container, credentials, summaries) {
  while (container.firstChild) container.removeChild(container.firstChild);

  if (credentials.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cred-empty';
    empty.textContent = 'No credentials configured across any project.';
    container.appendChild(empty);
    return;
  }

  // Group by project_id
  const byProject = new Map();
  credentials.forEach(c => {
    const pid = c.project_id || 'unknown';
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(c);
  });

  byProject.forEach((creds, pid) => {
    const proj = allProjects.find(p => p.id === pid);
    const projName = proj ? (proj.icon || '') + ' ' + (proj.display_name || proj.name) : pid;
    const projectSummary = Array.isArray(summaries)
      ? (summaries.find(s => s.project_id === pid)?.integrations || [])
      : [];

    const group = document.createElement('div');
    group.className = 'cred-project-group';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'cred-project-group-header';

    const nameEl = document.createElement('h3');
    nameEl.className = 'cred-project-group-name';
    nameEl.textContent = projName;
    groupHeader.appendChild(nameEl);

    const totalKeys = creds.reduce((sum, s) => sum + s.keys.length, 0);
    const badge = document.createElement('span');
    badge.className = 'cred-key-count';
    badge.textContent = creds.length + ' service' + (creds.length !== 1 ? 's' : '') + ', ' + totalKeys + ' key' + (totalKeys !== 1 ? 's' : '');
    groupHeader.appendChild(badge);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'cred-header-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', () => toggleAddCredentialForm(group, pid));
    actionsDiv.appendChild(addBtn);
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-sm btn-ghost';
    importBtn.textContent = 'Import .env';
    importBtn.addEventListener('click', () => openImportModal(pid));
    actionsDiv.appendChild(importBtn);
    groupHeader.appendChild(actionsDiv);

    group.appendChild(groupHeader);

    const formSlot = document.createElement('div');
    formSlot.className = 'cred-add-form-slot';
    group.appendChild(formSlot);

    group.appendChild(renderIntegrationSummaryBlock(projectSummary, {
      title: 'Active Integration View',
      emptyText: 'No integrations detected for this project.',
    }));

    // Render service cards for this project
    creds.forEach(svc => {
      group.appendChild(buildServiceCard(svc, pid));
    });

    container.appendChild(group);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}


function buildServiceCard(svc, projectId) {
  const card = document.createElement('div');
  card.className = 'cred-service-card';

  const svcHeader = document.createElement('div');
  svcHeader.className = 'cred-service-header';
  const nameDiv = document.createElement('div');
  nameDiv.className = 'cred-service-name';
  const dot = document.createElement('span');
  dot.className = 'cred-service-dot';
  nameDiv.appendChild(dot);
  const strong = document.createElement('strong');
  strong.textContent = svc.service;
  nameDiv.appendChild(strong);
  const count = document.createElement('span');
  count.className = 'cred-key-count';
  count.textContent = svc.keys.length + ' key' + (svc.keys.length !== 1 ? 's' : '');
  nameDiv.appendChild(count);
  svcHeader.appendChild(nameDiv);

  const svcActions = document.createElement('div');
  svcActions.className = 'cred-service-actions';
  const delSvcBtn = document.createElement('button');
  delSvcBtn.className = 'btn btn-xs btn-danger-ghost cred-delete-service-btn';
  delSvcBtn.textContent = 'Delete Service';
  svcActions.appendChild(delSvcBtn);
  const chevron = document.createElement('i');
  chevron.setAttribute('data-lucide', 'chevron-down');
  chevron.className = 'cred-chevron';
  chevron.style.cssText = 'width:16px;height:16px;cursor:pointer';
  svcActions.appendChild(chevron);
  svcHeader.appendChild(svcActions);

  const keyListDiv = document.createElement('div');
  keyListDiv.className = 'cred-key-list';

  svc.keys.forEach(k => {
    const row = document.createElement('div');
    row.className = 'cred-key-row';
    const keyName = document.createElement('span');
    keyName.className = 'cred-key-name';
    keyName.textContent = k.key;
    row.appendChild(keyName);
    const masked = document.createElement('span');
    masked.className = 'cred-masked';
    masked.textContent = '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF';
    row.appendChild(masked);
    const time = document.createElement('span');
    time.className = 'cred-time';
    time.textContent = timeAgo(k.updated_at);
    row.appendChild(time);
    const delKeyBtn = document.createElement('button');
    delKeyBtn.className = 'btn btn-xs btn-danger-ghost cred-delete-key-btn';
    const trashIcon = document.createElement('i');
    trashIcon.setAttribute('data-lucide', 'trash-2');
    trashIcon.style.cssText = 'width:14px;height:14px';
    delKeyBtn.appendChild(trashIcon);
    delKeyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteCredKey(delKeyBtn, projectId, svc.service, k.key);
    });
    row.appendChild(delKeyBtn);
    keyListDiv.appendChild(row);
  });

  svcHeader.addEventListener('click', (e) => {
    if (e.target.closest('.cred-delete-service-btn')) return;
    card.classList.toggle('collapsed');
  });
  delSvcBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDeleteCredService(delSvcBtn, projectId, svc.service, svc.keys.length);
  });

  card.appendChild(svcHeader);
  card.appendChild(keyListDiv);
  return card;
}

function renderCredentialsList(container, credentials, projectId, summary) {
  while (container.firstChild) container.removeChild(container.firstChild);

  // Action bar
  const actions = document.createElement('div');
  actions.className = 'cred-header-actions';
  actions.style.marginBottom = '1rem';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-sm btn-primary';
  addBtn.textContent = 'Add Credential';
  addBtn.addEventListener('click', () => toggleAddCredentialForm(container, projectId));
  actions.appendChild(addBtn);
  const importBtn = document.createElement('button');
  importBtn.className = 'btn btn-sm btn-ghost';
  importBtn.textContent = 'Import .env';
  importBtn.addEventListener('click', () => openImportModal(projectId));
  actions.appendChild(importBtn);
  container.appendChild(actions);

  // Add form placeholder
  const formSlot = document.createElement('div');
  formSlot.className = 'cred-add-form-slot';
  container.appendChild(formSlot);

  container.appendChild(renderIntegrationSummaryBlock(summary || [], {
    title: 'Active Integration View',
    emptyText: 'No integrations detected for this project.',
  }));

  if (credentials.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cred-empty';
    empty.textContent = 'No credentials configured for this project.';
    container.appendChild(empty);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  credentials.forEach(svc => {
    container.appendChild(buildServiceCard(svc, projectId));
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toggleAddCredentialForm(container, projectId) {
  const slot = container.querySelector('.cred-add-form-slot');
  if (!slot) return;
  if (slot.firstChild) { while (slot.firstChild) slot.removeChild(slot.firstChild); return; }

  const form = document.createElement('div');
  form.className = 'cred-add-form';

  // Service input with datalist
  const serviceLabel = document.createElement('label');
  serviceLabel.textContent = 'Service';
  form.appendChild(serviceLabel);
  const serviceInput = document.createElement('input');
  serviceInput.type = 'text';
  serviceInput.placeholder = 'e.g. twitter, telegram, custom';
  serviceInput.setAttribute('list', 'cred-service-list');
  serviceInput.id = 'cred-input-service';
  form.appendChild(serviceInput);
  const serviceList = document.createElement('datalist');
  serviceList.id = 'cred-service-list';
  CRED_SERVICES.forEach(s => { const opt = document.createElement('option'); opt.value = s; serviceList.appendChild(opt); });
  form.appendChild(serviceList);

  // Key input with datalist
  const keyLabel = document.createElement('label');
  keyLabel.textContent = 'Key';
  form.appendChild(keyLabel);
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'e.g. api_key, bot_token';
  keyInput.setAttribute('list', 'cred-key-list');
  keyInput.id = 'cred-input-key';
  form.appendChild(keyInput);
  const keyDataList = document.createElement('datalist');
  keyDataList.id = 'cred-key-list';
  form.appendChild(keyDataList);

  // Update key suggestions when service changes
  serviceInput.addEventListener('input', () => {
    while (keyDataList.firstChild) keyDataList.removeChild(keyDataList.firstChild);
    const suggestions = CRED_KEY_SUGGESTIONS[serviceInput.value] || [];
    suggestions.forEach(s => { const opt = document.createElement('option'); opt.value = s; keyDataList.appendChild(opt); });
  });

  // Value input
  const valueLabel = document.createElement('label');
  valueLabel.textContent = 'Value';
  form.appendChild(valueLabel);
  const valueInput = document.createElement('input');
  valueInput.type = 'password';
  valueInput.placeholder = 'Credential value (write-only, never returned)';
  valueInput.id = 'cred-input-value';
  form.appendChild(valueInput);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'cred-form-buttons';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-sm btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => submitCredential(projectId));
  btnRow.appendChild(saveBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-sm btn-ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { while (slot.firstChild) slot.removeChild(slot.firstChild); });
  btnRow.appendChild(cancelBtn);
  form.appendChild(btnRow);

  slot.appendChild(form);
  serviceInput.focus();
}

async function submitCredential(projectId) {
  const service = document.getElementById('cred-input-service')?.value?.trim();
  const key = document.getElementById('cred-input-key')?.value?.trim();
  const value = document.getElementById('cred-input-value')?.value;
  if (!service || !key || !value) return;
  try {
    await fetch(API + '/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, service, key, value })
    });
    // Close any open add forms
    document.querySelectorAll('.cred-add-form-slot').forEach(slot => {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
    });
    refreshCredentialsPage();
  } catch (e) {
    console.warn('Failed to save credential:', e);
  }
}

function confirmDeleteCredKey(btn, projectId, service, key) {
  if (btn.dataset.confirming === 'true') {
    btn.dataset.confirming = 'false';
    deleteCredentialKey(projectId, service, key);
    return;
  }
  btn.dataset.confirming = 'true';
  const origChild = btn.firstChild;
  btn.textContent = 'Confirm?';
  btn.classList.add('confirming');
  setTimeout(() => {
    if (btn.dataset.confirming === 'true') {
      btn.dataset.confirming = 'false';
      btn.textContent = '';
      const icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'trash-2');
      icon.style.cssText = 'width:14px;height:14px';
      btn.appendChild(icon);
      btn.classList.remove('confirming');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }, 3000);
}

async function deleteCredentialKey(projectId, service, key) {
  try {
    await fetch(API + '/credentials', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, service, key })
    });
    refreshCredentialsPage();
  } catch (e) {
    console.warn('Failed to delete credential:', e);
  }
}

function confirmDeleteCredService(btn, projectId, service, keyCount) {
  if (btn.dataset.confirming === 'true') {
    btn.dataset.confirming = 'false';
    deleteCredentialService(projectId, service);
    return;
  }
  btn.dataset.confirming = 'true';
  const orig = btn.textContent;
  btn.textContent = 'Delete ' + keyCount + ' key' + (keyCount !== 1 ? 's' : '') + '?';
  btn.classList.add('confirming');
  setTimeout(() => {
    if (btn.dataset.confirming === 'true') {
      btn.dataset.confirming = 'false';
      btn.textContent = orig;
      btn.classList.remove('confirming');
    }
  }, 3000);
}

async function deleteCredentialService(projectId, service) {
  try {
    await fetch(API + '/credentials', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, service })
    });
    refreshCredentialsPage();
  } catch (e) {
    console.warn('Failed to delete service:', e);
  }
}

function openImportModal(projectId) {
  // Remove existing modal if any
  const existing = document.getElementById('cred-import-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cred-import-modal';
  overlay.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content cred-import-content';

  // Header
  const mHeader = document.createElement('div');
  mHeader.className = 'modal-header';
  const mTitle = document.createElement('h3');
  mTitle.textContent = 'Import .env';
  mHeader.appendChild(mTitle);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => overlay.remove());
  mHeader.appendChild(closeBtn);
  content.appendChild(mHeader);

  const desc = document.createElement('p');
  desc.style.cssText = 'color:var(--text-muted);font-size:13px;margin:0 0 0.75rem';
  desc.textContent = 'Paste .env content or drop a file. Values are encrypted immediately.';
  content.appendChild(desc);

  const textarea = document.createElement('textarea');
  textarea.id = 'cred-import-textarea';
  textarea.className = 'cred-import-textarea';
  textarea.rows = 10;
  textarea.placeholder = 'TWITTER_API_KEY=abc123\nTWITTER_API_SECRET=def456\nGEMINI_API_KEY=xyz789';
  content.appendChild(textarea);

  // File upload
  const fileRow = document.createElement('div');
  fileRow.style.margin = '0.5rem 0';
  const fileLabel = document.createElement('label');
  fileLabel.className = 'btn btn-sm btn-ghost';
  fileLabel.style.cursor = 'pointer';
  fileLabel.textContent = 'Choose file';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.env,.txt';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { textarea.value = ev.target.result; };
    reader.readAsText(file);
  });
  fileLabel.appendChild(fileInput);
  fileRow.appendChild(fileLabel);
  content.appendChild(fileRow);

  // Preview area
  const preview = document.createElement('div');
  preview.id = 'cred-import-preview';
  preview.className = 'cred-import-preview';
  preview.style.display = 'none';
  content.appendChild(preview);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'cred-form-buttons';
  btnRow.style.marginTop = '1rem';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn btn-sm btn-ghost';
  previewBtn.textContent = 'Preview';
  previewBtn.addEventListener('click', () => {
    const raw = textarea.value.trim();
    if (!raw) return;
    const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='));
    if (lines.length === 0) {
      preview.style.display = 'block';
      preview.textContent = 'No valid KEY=VALUE lines found.';
      return;
    }
    // Build preview table
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    const table = document.createElement('table');
    table.className = 'cred-import-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Env Key', 'Service', 'Key'].forEach(h => { const th = document.createElement('th'); th.textContent = h; headRow.appendChild(th); });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    const known = {
      TWITTER_API_KEY:'twitter/api_key', TWITTER_API_SECRET:'twitter/api_secret',
      TWITTER_ACCESS_TOKEN:'twitter/access_token', TWITTER_ACCESS_SECRET:'twitter/access_secret',
      LINKEDIN_CLIENT_ID:'linkedin/client_id', LINKEDIN_CLIENT_SECRET:'linkedin/client_secret',
      LINKEDIN_ACCESS_TOKEN:'linkedin/access_token', LINKEDIN_PERSON_URN:'linkedin/person_urn',
      TELEGRAM_BOT_TOKEN:'telegram/bot_token', TELEGRAM_ALLOWED_CHAT_IDS:'telegram/allowed_chat_ids',
      GEMINI_API_KEY:'gemini/api_key', GOOGLE_CLIENT_ID:'google/client_id', GOOGLE_CLIENT_SECRET:'google/client_secret',
    };

    lines.forEach(line => {
      const eq = line.indexOf('=');
      if (eq < 1) return;
      const envKey = line.substring(0, eq).trim();
      let service = 'custom', key = envKey;
      if (known[envKey]) { const p = known[envKey].split('/'); service = p[0]; key = p[1]; }
      else if (envKey.startsWith('META_') || envKey.startsWith('FACEBOOK_')) { service = 'meta'; key = envKey.replace(/^(META_|FACEBOOK_)/, '').toLowerCase(); }
      else if (envKey.startsWith('SHOPIFY_')) { service = 'shopify'; key = envKey.replace(/^SHOPIFY_/, '').toLowerCase(); }
      else if (envKey.startsWith('WORDPRESS_')) { service = 'wordpress'; key = envKey.replace(/^WORDPRESS_/, '').toLowerCase(); }
      else if (envKey.startsWith('SECURITY_')) { service = 'security'; key = envKey.replace(/^SECURITY_/, '').toLowerCase(); }

      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); const code1 = document.createElement('code'); code1.textContent = envKey; td1.appendChild(code1);
      const td2 = document.createElement('td'); td2.textContent = service;
      const td3 = document.createElement('td'); const code3 = document.createElement('code'); code3.textContent = key; td3.appendChild(code3);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    preview.appendChild(table);
    preview.style.display = 'block';
    submitBtn.disabled = false;
  });
  btnRow.appendChild(previewBtn);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-sm btn-primary';
  submitBtn.textContent = 'Import';
  submitBtn.disabled = true;
  submitBtn.addEventListener('click', async () => {
    const raw = textarea.value.trim();
    if (!raw) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing...';
    try {
      const resp = await fetch(API + '/credentials/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, env_content: raw })
      });
      const result = await resp.json();
      submitBtn.textContent = 'Imported ' + result.imported + ' keys';
      submitBtn.style.background = 'var(--green)';
      setTimeout(() => { overlay.remove(); refreshCredentialsPage(); }, 1200);
    } catch (e) {
      console.warn('Import failed:', e);
      submitBtn.textContent = 'Failed';
      submitBtn.disabled = false;
    }
  });
  btnRow.appendChild(submitBtn);

  const cancelBtn2 = document.createElement('button');
  cancelBtn2.className = 'btn btn-sm btn-ghost';
  cancelBtn2.textContent = 'Cancel';
  cancelBtn2.addEventListener('click', () => overlay.remove());
  btnRow.appendChild(cancelBtn2);

  content.appendChild(btnRow);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ============================================================
// Knowledge Graph (3D Force Graph) v2
// ============================================================

var graphInstance = null;
var graphData = { nodes: [], links: [] };
var graphFilters = { agent: true, project: true, memory: true, task: true, finding: true, projectId: '' };
var graphResizeObserver = null;
var graphMutationObserver = null;
var graphEmojiCache = {};

function initGraphPage() {
  var toolbar = document.getElementById('graph-toolbar');
  if (!toolbar) return;

  toolbar.querySelectorAll('.graph-filter-btn[data-node-type]').forEach(function(btn) {
    btn.onclick = function() {
      btn.classList.toggle('active');
      graphFilters[btn.dataset.nodeType] = btn.classList.contains('active');
      applyGraphFilters();
    };
  });

  var projSelect = document.getElementById('graph-project-filter');
  if (projSelect) {
    projSelect.onchange = function() {
      graphFilters.projectId = projSelect.value;
      applyGraphFilters();
    };
  }

  var resetBtn = document.getElementById('graph-reset-cam');
  if (resetBtn) {
    resetBtn.onclick = function() {
      if (graphInstance) graphZoomToFit(1000);
    };
  }

  var closeBtn = document.getElementById('graph-detail-close');
  if (closeBtn) {
    closeBtn.onclick = function() {
      document.getElementById('graph-detail-panel').setAttribute('hidden', '');
    };
  }

  // Lazy-load via MutationObserver (saved at module scope for cleanup)
  if (graphMutationObserver) graphMutationObserver.disconnect();
  graphMutationObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      if (m.type === 'attributes' && m.attributeName === 'hidden') {
        var page = document.getElementById('page-graph');
        if (page && !page.hasAttribute('hidden') && !graphInstance) {
          fetchGraphData();
        }
      }
    });
  });

  var graphPage = document.getElementById('page-graph');
  if (graphPage) {
    graphMutationObserver.observe(graphPage, { attributes: true });
    if (!graphPage.hasAttribute('hidden')) fetchGraphData();
  }
}

async function initKnowledgePage() {
  try {
    const pq = (currentProject && currentProject.id) ? 'project_id=' + encodeURIComponent(currentProject.id) : '';
    const data = await fetchFromAPI('/api/v1/knowledge/stats' + (pq ? '?' + pq : ''));
    if (!data) return;

    const statsEl = document.getElementById('knowledge-stats');
    if (statsEl) {
      const entityRows = (data.entityCounts || [])
        .map(function(e) { return '<div class="stat-row"><span class="stat-label">' + escapeHtml(String(e.type)) + '</span><span class="stat-value">' + escapeHtml(String(e.count)) + '</span></div>'; })
        .join('');
      statsEl.innerHTML =
        '<div class="card"><h3 style="margin-bottom:10px;">Entities by Type</h3>' + (entityRows || '<div class="empty-state">No entities yet</div>') + '</div>' +
        '<div class="card"><h3 style="margin-bottom:10px;">Observations</h3><div class="stat-value" style="font-size:2rem;font-weight:700;">' + escapeHtml(String(data.totalObservations || 0)) + '</div><div class="stat-label">currently active</div></div>' +
        '<div class="card"><h3 style="margin-bottom:10px;">Relations</h3><div class="stat-value" style="font-size:2rem;font-weight:700;">' + escapeHtml(String(data.totalRelations || 0)) + '</div>' +
        (data.embeddingDimension ? '<div class="stat-label">Embed dims: ' + escapeHtml(String(data.embeddingDimension)) + '</div>' : '<div class="stat-label">Embeddings: not initialized</div>') + '</div>';
    }

    const recentEl = document.getElementById('knowledge-recent');
    if (recentEl) {
      recentEl.innerHTML = (data.recentObservations || [])
        // escapeHtml applied to all API-sourced fields to prevent XSS
        .map(function(o) { return '<div class="feed-item"><strong>' + escapeHtml(String(o.entity_name)) + '</strong>: ' + escapeHtml(String(o.content).slice(0, 120)) + ' <span class="badge">' + escapeHtml(String(o.source)) + '</span></div>'; })
        .join('') || '<div class="empty-state">No observations yet</div>';
    }

    const changesEl = document.getElementById('knowledge-changes');
    if (changesEl) {
      changesEl.innerHTML = (data.recentChanges || [])
        // escapeHtml applied to all API-sourced fields to prevent XSS
        .map(function(o) { return '<div class="feed-item"><strong>' + escapeHtml(String(o.entity_name)) + '</strong>: ' + escapeHtml(String(o.content).slice(0, 100)) + ' <span class="badge">updated</span></div>'; })
        .join('') || '<div class="empty-state">No changes yet</div>';
    }
  } catch (err) {
    console.warn('Knowledge stats unavailable:', err);
  }
}

function fetchGraphData() {
  var gpq = getProjectQueryParam();
  fetch('/api/v1/graph' + (gpq ? '?' + gpq : ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      graphData = data;
      populateProjectFilter(data.nodes);
      updateGraphStats(data);
      renderGraph(data);
    })
    .catch(function(err) { console.error('Graph fetch error:', err); });
}

function populateProjectFilter(nodes) {
  var select = document.getElementById('graph-project-filter');
  if (!select) return;
  while (select.options.length > 1) select.remove(1);
  nodes.filter(function(n) { return n.type === 'project'; }).forEach(function(n) {
    var opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = n.label;
    select.appendChild(opt);
  });
}

function updateGraphStats(data) {
  var el = document.getElementById('graph-stats');
  if (!el) return;
  var types = {};
  data.nodes.forEach(function(n) { types[n.type] = (types[n.type] || 0) + 1; });
  var parts = [];
  if (types.project) parts.push(types.project + ' projects');
  if (types.agent) parts.push(types.agent + ' agents');
  if (types.task) parts.push(types.task + ' tasks');
  if (types.finding) parts.push(types.finding + ' findings');
  if (types.memory) parts.push(types.memory + ' memories');
  el.textContent = data.nodes.length + ' nodes / ' + data.links.length + ' links  --  ' + parts.join(', ');
}

function applyGraphFilters() {
  if (!graphInstance || !graphData.nodes.length) return;
  var visibleIds = new Set();

  // Precompute adjacency map for O(1) neighbor lookups instead of O(n) per node
  var adjacency = new Map();
  graphData.links.forEach(function(l) {
    var src = typeof l.source === 'object' ? l.source.id : l.source;
    var tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (!adjacency.has(src)) adjacency.set(src, new Set());
    if (!adjacency.has(tgt)) adjacency.set(tgt, new Set());
    adjacency.get(src).add(tgt);
    adjacency.get(tgt).add(src);
  });

  var filtered = graphData.nodes.filter(function(n) {
    var typeOk = graphFilters[n.type] !== false;
    var projOk = true;
    if (graphFilters.projectId) {
      if (n.type === 'project') {
        projOk = n.id === graphFilters.projectId;
      } else {
        var projNeighbors = adjacency.get(graphFilters.projectId);
        projOk = !!(projNeighbors && projNeighbors.has(n.id));
        if (!projOk) {
          // Two-hop check: node -> agent neighbor -> project
          var nodeNeighbors = adjacency.get(n.id);
          if (nodeNeighbors) {
            nodeNeighbors.forEach(function(mid) {
              if (projOk) return;
              if (!mid.startsWith('agent:')) return;
              var midNeighbors = adjacency.get(mid);
              if (midNeighbors && midNeighbors.has(graphFilters.projectId)) projOk = true;
            });
          }
        }
      }
    }
    var ok = typeOk && projOk;
    if (ok) visibleIds.add(n.id);
    return ok;
  });

  var filteredLinks = graphData.links.filter(function(l) {
    var src = typeof l.source === 'object' ? l.source.id : l.source;
    var tgt = typeof l.target === 'object' ? l.target.id : l.target;
    return visibleIds.has(src) && visibleIds.has(tgt);
  });

  graphInstance.graphData({ nodes: filtered, links: filteredLinks });
}

function graphZoomToFit(duration) {
  if (!graphInstance) return;
  var nodes = graphInstance.graphData().nodes;
  if (!nodes || nodes.length === 0) return;

  var cx = 0, cy = 0, cz = 0, counted = 0;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.x != null && n.y != null && n.z != null) {
      cx += n.x; cy += n.y; cz += n.z;
      counted++;
    }
  }
  if (counted === 0) return;
  cx /= counted; cy /= counted; cz /= counted;

  var maxDist = 0;
  for (var j = 0; j < nodes.length; j++) {
    var nd = nodes[j];
    if (nd.x == null) continue;
    var dx = nd.x - cx, dy = nd.y - cy, dz = nd.z - cz;
    var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDist) maxDist = dist;
  }

  var fov = 75;
  var camDist = (maxDist + 40) / Math.tan((fov / 2) * Math.PI / 180);
  camDist = Math.max(camDist, 150);

  graphInstance.cameraPosition(
    { x: cx, y: cy, z: cz + camDist },
    { x: cx, y: cy, z: cz },
    duration || 0
  );
}

function renderGraph(data) {
  var container = document.getElementById('graph-3d');
  if (!container || typeof ForceGraph3D === 'undefined') return;

  // Clean up previous instance
  if (graphResizeObserver) { graphResizeObserver.disconnect(); graphResizeObserver = null; }
  if (graphInstance) {
    try {
      var renderer = graphInstance.renderer && graphInstance.renderer();
      if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
      var scene = graphInstance.scene && graphInstance.scene();
      if (scene) scene.clear();
    } catch (e) { /* best-effort cleanup */ }
    if (graphInstance._destructor) graphInstance._destructor();
    graphInstance = null;
    container.textContent = '';
  }
  // Dispose cached textures from previous render
  Object.keys(graphEmojiCache).forEach(function(k) {
    if (graphEmojiCache[k] && graphEmojiCache[k].dispose) graphEmojiCache[k].dispose();
  });
  graphEmojiCache = {};

  var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  var bgColor = isDark ? '#060610' : '#f0f2f5';

  function emojiTex(emoji, sz) {
    var k = emoji + sz;
    if (graphEmojiCache[k]) return graphEmojiCache[k];
    var c = document.createElement('canvas');
    c.width = sz; c.height = sz;
    var x = c.getContext('2d');
    x.font = Math.floor(sz * 0.65) + 'px serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(emoji, sz / 2, sz / 2);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    graphEmojiCache[k] = t;
    return t;
  }

  graphInstance = ForceGraph3D()(container)
    .backgroundColor(bgColor)
    .graphData(data)
    .nodeVal('val')
    .nodeLabel(function(n) {
      var lines = [n.label + ' (' + n.type + ')'];
      if (n.meta) {
        if (n.meta.role) lines.push('Role: ' + n.meta.role);
        if (n.meta.status) lines.push('Status: ' + n.meta.status);
        if (n.meta.schedule) lines.push('Schedule: ' + n.meta.schedule);
        if (n.meta.severity) lines.push('Severity: ' + n.meta.severity);
      }
      return lines.join('\n');
    })
    .nodeColor(function(n) { return n.color; })
    .nodeOpacity(0.95)
    .nodeResolution(16)
    // -- Visible links --
    .linkWidth(function(l) { return l.width || 1; })
    .linkOpacity(0.6)
    .linkColor(function(l) { return l.color || 'rgba(255,255,255,0.15)'; })
    .linkLabel(function(l) { return l.rel || ''; })
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(1.2)
    .linkDirectionalParticleSpeed(0.004)
    .linkDirectionalParticleColor(function(l) { return l.color || 'rgba(0,255,159,0.5)'; })
    // -- Tight clustering forces --
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.35)
    .warmupTicks(120)
    .cooldownTime(5000)
    .onNodeClick(function(node) { showNodeDetail(node); })
    .onBackgroundClick(function() {
      document.getElementById('graph-detail-panel').setAttribute('hidden', '');
    });

  // Configure built-in d3 forces for tighter clustering
  var chargeForce = graphInstance.d3Force('charge');
  if (chargeForce) {
    chargeForce.strength(function(n) {
      if (n.type === 'project') return -350;
      if (n.type === 'agent') return -120;
      return -25;
    });
  }

  var centerForce = graphInstance.d3Force('center');
  if (centerForce) {
    centerForce.strength(0.05);
  }

  var linkForce = graphInstance.d3Force('link');
  if (linkForce) {
    linkForce.distance(function(l) {
      var sType = typeof l.source === 'object' ? l.source.type : '';
      var tType = typeof l.target === 'object' ? l.target.type : '';
      if (sType === 'project' && tType === 'agent') return 100;
      if (sType === 'agent' || tType === 'agent') return 55;
      return 35;
    }).strength(0.8);
  }

  // Custom 3D objects
  graphInstance.nodeThreeObject(function(node) {
    if (node.type === 'agent' && node.emoji) {
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: emojiTex(node.emoji, 128), transparent: true, depthWrite: false
      }));
      var s = Math.sqrt(node.val) * 2.8;
      sprite.scale.set(s, s, 1);
      return sprite;
    }
    if (node.type === 'project') {
      var geo = new THREE.IcosahedronGeometry(Math.cbrt(node.val) * 2.8, 1);
      var mat = new THREE.MeshPhongMaterial({
        color: node.color, transparent: true, opacity: 0.9,
        emissive: node.color, emissiveIntensity: 0.4, shininess: 100
      });
      return new THREE.Mesh(geo, mat);
    }
    var r = Math.cbrt(node.val) * 1.4;
    return new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 12),
      new THREE.MeshPhongMaterial({
        color: node.color, transparent: true, opacity: 0.85,
        emissive: node.color, emissiveIntensity: 0.2
      })
    );
  });

  // Lighting
  var scene = graphInstance.scene();
  scene.add(new THREE.AmbientLight(0x555577, 2));
  var p1 = new THREE.PointLight(0x00ff9f, 0.8, 1200);
  p1.position.set(200, 200, 200);
  scene.add(p1);
  var p2 = new THREE.PointLight(0xff00aa, 0.4, 800);
  p2.position.set(-200, -100, -200);
  scene.add(p2);

  // Set explicit dimensions
  graphInstance.width(container.clientWidth).height(container.clientHeight);

  // After simulation stabilizes, zoom to fit all nodes centered
  graphInstance.onEngineStop(function() { graphZoomToFit(1200); });

  // Initial camera while simulation runs
  graphInstance.cameraPosition({ x: 0, y: 0, z: 500 }, { x: 0, y: 0, z: 0 });

  // Responsive (saved at module scope to prevent accumulation)
  graphResizeObserver = new ResizeObserver(function() {
    if (graphInstance) {
      graphInstance.width(container.clientWidth);
      graphInstance.height(container.clientHeight);
    }
  });
  graphResizeObserver.observe(container);
}

function showNodeDetail(node) {
  var panel = document.getElementById('graph-detail-panel');
  var header = document.getElementById('graph-detail-header');
  var body = document.getElementById('graph-detail-body');
  if (!panel || !header || !body) return;

  var typeColors = { agent: '#00ff9f', project: '#00d4ff', memory: '#a78bfa', task: '#ffaa00', finding: '#ff3355' };
  var color = typeColors[node.type] || '#fff';

  header.textContent = '';
  var h3 = document.createElement('h3');
  h3.textContent = (node.emoji || '') + ' ' + node.label;
  header.appendChild(h3);
  var badge = document.createElement('span');
  badge.className = 'detail-type-badge';
  badge.style.cssText = 'background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44;';
  badge.textContent = node.type;
  header.appendChild(badge);

  body.textContent = '';
  if (node.meta) {
    Object.keys(node.meta).forEach(function(key) {
      var val = node.meta[key];
      if (val === null || val === undefined || val === '') return;
      var row = document.createElement('div');
      row.className = 'detail-row';
      var kSpan = document.createElement('span');
      kSpan.className = 'detail-key';
      kSpan.textContent = key;
      var vSpan = document.createElement('span');
      vSpan.className = 'detail-val';
      vSpan.textContent = String(val);
      vSpan.title = String(val);
      row.appendChild(kSpan);
      row.appendChild(vSpan);
      body.appendChild(row);
    });
  }

  // Connected nodes
  var connected = graphData.links.filter(function(l) {
    var src = typeof l.source === 'object' ? l.source.id : l.source;
    var tgt = typeof l.target === 'object' ? l.target.id : l.target;
    return src === node.id || tgt === node.id;
  });

  var connRow = document.createElement('div');
  connRow.className = 'detail-row';
  var connKey = document.createElement('span');
  connKey.className = 'detail-key';
  connKey.textContent = 'connections';
  var connVal = document.createElement('span');
  connVal.className = 'detail-val';
  connVal.textContent = String(connected.length);
  connRow.appendChild(connKey);
  connRow.appendChild(connVal);
  body.appendChild(connRow);

  // Show relationships
  if (connected.length > 0) {
    var relHeader = document.createElement('div');
    relHeader.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);font-size:0.7rem;color:var(--text-secondary);font-family:var(--font-mono);margin-bottom:4px;';
    relHeader.textContent = 'relationships';
    body.appendChild(relHeader);

    connected.slice(0, 8).forEach(function(l) {
      var src = typeof l.source === 'object' ? l.source : graphData.nodes.find(function(n) { return n.id === l.source; });
      var tgt = typeof l.target === 'object' ? l.target : graphData.nodes.find(function(n) { return n.id === l.target; });
      var other = (src && src.id === node.id) ? tgt : src;
      if (!other) return;

      var relRow = document.createElement('div');
      relRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:0.75rem;';
      var dot = document.createElement('span');
      dot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;background:' + (other.color || '#888');
      var text = document.createElement('span');
      text.style.color = 'var(--text-primary)';
      text.textContent = (l.rel || 'linked') + ' -> ' + (other.emoji || '') + ' ' + other.label;
      relRow.appendChild(dot);
      relRow.appendChild(text);
      body.appendChild(relRow);
    });
    if (connected.length > 8) {
      var more = document.createElement('div');
      more.style.cssText = 'font-size:0.7rem;color:var(--text-secondary);padding:4px 0;';
      more.textContent = '+ ' + (connected.length - 8) + ' more';
      body.appendChild(more);
    }
  }

  panel.removeAttribute('hidden');

  if (graphInstance) {
    var dist = 150;
    graphInstance.cameraPosition(
      { x: node.x + dist, y: node.y + dist / 3, z: node.z + dist },
      { x: node.x, y: node.y, z: node.z }, 1000
    );
  }
}


document.addEventListener('DOMContentLoaded', async () => {
  // Resolve current user FIRST -- if unauthenticated, show auth gate and bail
  const user = await fetchCurrentUser();
  if (!user) {
    showAuthGate();
    return;
  }

  // Show Users nav link for admins only
  applyAdminVisibility();

  // Connect WebSocket FIRST -- init functions must not block this
  connectWebSocket();

  // Initialize Lucide icons (replaces data-lucide attributes with SVGs)
  if (window.lucide) lucide.createIcons();

  buildDashboardAgentCards();
  buildDetailAgentCards();
  buildAgentSelect();

  initClock();
  initThemeToggle();
  initFeedToggle();
  initSidebarToggle();
  initHamburger();
  initNavigation();
  initProjectSelector();

  // Register project change subscribers
  ProjectBus.on(() => refreshWithProjectFilter());
  ProjectBus.on(() => { if (typeof SecurityPage !== 'undefined') SecurityPage.load(); });
  ProjectBus.on(() => fetchProjectOverview());
  ProjectBus.on(() => apRenderHomeSection());

  document.getElementById('header-chip-clear')?.addEventListener('click', () => selectProject(null));

  initAgentCards();
  // NOTE: fetchAgentStatuses() is NOT called here -- it runs inside fetchProjects()
  // after the saved project is restored from localStorage, so agents match the active project.
  addPollingInterval(fetchAgentStatuses, 30000);

  setTimeout(initAllCharts, 300);
  initActivityFeed();
  fetchDashboardSummary();
  // fetchProjectOverview() is called from fetchProjects() after project restore
  fetchProjectIntegrations();
  fetchYouTubeData();
  fetchAnalyticsMetrics();
  fetchSocialMetrics();
  renderPipelinePreview();
  addPollingInterval(fetchProjectIntegrations, 300000);
  addPollingInterval(fetchAnalyticsMetrics, 300000);
  addPollingInterval(fetchSocialMetrics, 300000);

  document.querySelectorAll('button[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('button[data-range]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  initCostsPage();
  apRenderHomeSection();
  initHealthPage();
  initSecurityPage();
  initTestRunner();
  initChatPage();
  initCommsPage();
  initTaskAssignment();
  initPipelinePage();
  initResearchPage();
  renderResearchUpcoming();
  initSOPsPage();
  initBoardPage();
  initPluginsPage();
  initWebhooksPage();
  initSettingsPage();
  initProjectsPage();
  initGraphPage();
  initUsersPage();
  initIntegrationsTabs()
  refreshIntegrationsPage()
  // Integration modal close handlers
  const intClose = document.getElementById('int-modal-close')
  const intBackdrop = document.getElementById('int-modal-backdrop')
  if (intClose) intClose.addEventListener('click', closeInstallModal)
  if (intBackdrop) intBackdrop.addEventListener('click', closeInstallModal)
  fetchSOPs();
  fetchPlugins();
  fetchWebhooks();
  addPollingInterval(fetchSOPs, 60000);
  addPollingInterval(fetchPlugins, 60000);
  addPollingInterval(fetchWebhooks, 60000);

  window.addEventListener('resize', onResize);

  const activePage = document.querySelector('section.page.active');
  if (activePage) animateCardsStaggered(activePage);

  // Update badge + modal
  var updateBadgeEl = document.getElementById('update-badge');
  if (updateBadgeEl) {
    updateBadgeEl.addEventListener('click', openUpgradeModal);
    updateBadgeEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') openUpgradeModal();
    });
  }
  var upgradeCloseEl = document.getElementById('upgrade-modal-close');
  if (upgradeCloseEl) upgradeCloseEl.addEventListener('click', closeUpgradeModal);
  var upgradeModalEl = document.getElementById('upgrade-modal');
  if (upgradeModalEl) upgradeModalEl.addEventListener('click', function(e) {
    if (e.target === upgradeModalEl) closeUpgradeModal();
  });
  var upgradeNowEl = document.getElementById('upgrade-now-btn');
  if (upgradeNowEl) upgradeNowEl.addEventListener('click', triggerUpgrade);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      var m = document.getElementById('upgrade-modal');
      if (m && m.style.display !== 'none') closeUpgradeModal();
    }
  });

  checkForUpdates();

  console.log(
    '%c ClaudePaw %c AI Operations Dashboard',
    'background:#00ff9f;color:#0a0a0f;font-weight:bold;padding:4px 8px;',
    'color:#00ff9f;padding:4px;'
  );
});

// ---------------------------------------------------------------------------
// Action Plan page
// ---------------------------------------------------------------------------

const apState = {
  tab: 'active',
  search: '',
  items: [],
  inited: false,
  chat: {},  // keyed by item id: { open: bool, messages: [], agentRunning: bool }
};

const AP_VALID_TRANSITIONS = {
  proposed: ['approved', 'rejected', 'paused', 'archived'],
  approved: ['in_progress', 'completed', 'paused', 'blocked', 'archived'],
  in_progress: ['completed', 'blocked', 'paused', 'archived'],
  blocked: ['approved', 'in_progress', 'paused', 'rejected', 'archived'],
  paused: ['approved', 'rejected', 'archived'],
  completed: ['archived'],
  rejected: ['archived'],
  archived: [],
};

function apCanTransition(from, to) {
  return !!(AP_VALID_TRANSITIONS[from] || []).includes(to);
}

function apTargetStatus(item, action) {
  if (!item) return null;
  if (action === 'approve') return item.executable_by_agent ? 'in_progress' : 'approved';
  if (action === 'reject') return 'rejected';
  if (action === 'pause') return 'paused';
  if (action === 'complete') return 'completed';
  return null;
}

function apActionButtons(item) {
  const actions = [
    { key: 'approve', label: item && item.executable_by_agent ? 'Approve and Run' : 'Approve' },
    { key: 'reject', label: 'Reject' },
    { key: 'pause', label: 'Pause' },
    { key: 'complete', label: 'Complete' },
  ];
  return actions
    .filter(action => {
      const to = apTargetStatus(item, action.key);
      return to && apCanTransition(item.status, to);
    })
    .map(action => '<button data-action="' + action.key + '" type="button">' + action.label + '</button>')
    .join('');
}

async function apTransitionItem(id, item, action) {
  const to = apTargetStatus(item, action);
  if (!to) return { ok: false, error: 'Unknown action.' };
  if (!apCanTransition(item.status, to)) {
    return { ok: false, error: 'Cannot change item from ' + item.status + ' to ' + to + '.' };
  }
  try {
    const res = await fetch('/api/v1/action-items/' + encodeURIComponent(id) + '/transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, actor: 'human' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText || 'Request failed' }));
      return { ok: false, error: err.error || res.statusText || 'Request failed' };
    }
    return { ok: true, to };
  } catch (e) {
    console.warn('ap transition error:', e);
    return { ok: false, error: 'Network error while updating action item.' };
  }
}

function apCurrentProjectId() {
  // Match the house pattern: currentProject.id is empty string when "All Projects"
  if (typeof currentProject !== 'undefined' && currentProject && currentProject.id) {
    return currentProject.id;
  }
  return '';
}

async function apFetchItems() {
  const projectId = apCurrentProjectId();
  const qs = new URLSearchParams();
  if (projectId) qs.set('project_id', projectId);
  if (apState.tab === 'proposed') qs.set('status', 'proposed');
  if (apState.tab === 'completed') qs.set('status', 'completed');
  if (apState.tab === 'archive') {
    qs.set('status', 'archived');
    qs.set('include_archived', '1');
  }
  try {
    const res = await fetch('/api/v1/action-items?' + qs.toString());
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    console.warn('apFetchItems error:', e);
    return [];
  }
}

function apRenderList(items) {
  const container = document.getElementById('ap-list');
  if (!container) return;
  const isArchiveTab = apState.tab === 'archive';
  // Render purge button in archive tab header
  const purgeContainer = document.getElementById('ap-purge-row');
  if (purgeContainer) {
    purgeContainer.style.display = isArchiveTab ? '' : 'none';
  }
  const q = apState.search.toLowerCase();
  const filtered = q ? items.filter(i =>
    (i.title || '').toLowerCase().includes(q) ||
    (i.description || '').toLowerCase().includes(q)
  ) : items;
  if (filtered.length === 0) {
    setElementHTML(container, '<div class="ap-empty">No items.</div>');
    return;
  }
  const html = filtered.map(i => (
    '<div class="ap-row" data-id="' + escapeHtml(String(i.id)) + '">' +
      '<span class="ap-priority ap-priority--' + escapeHtml(i.priority || 'medium') + '"></span>' +
      '<span class="ap-title">' + escapeHtml(i.title || '') + '</span>' +
      '<span class="ap-status ap-status--' + escapeHtml(i.status || '') + '">' + escapeHtml(i.status || '') + '</span>' +
      '<span class="ap-source">' + escapeHtml(i.source || '') + '</span>' +
      (isArchiveTab
        ? '<button class="btn btn--ghost btn--sm ap-delete-btn" data-id="' + escapeHtml(String(i.id)) + '" type="button" style="color:var(--color-danger,#e55);margin-left:auto;">Delete permanently</button>'
        : '') +
    '</div>'
  )).join('');
  setElementHTML(container, html);
  container.querySelectorAll('.ap-row').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('ap-delete-btn')) return;
      apOpenDrawer(el.dataset.id);
    });
  });
  if (isArchiveTab) {
    container.querySelectorAll('.ap-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('Permanently delete this item? This cannot be undone.')) return;
        try {
          const res = await fetch('/api/v1/action-items/' + encodeURIComponent(id), { method: 'DELETE' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            alert('Delete failed: ' + (err.error || res.statusText));
            return;
          }
        } catch (err) {
          console.warn('ap delete error:', err);
          alert('Delete failed (network error)');
          return;
        }
        apRefreshList();
      });
    });
  }
}

async function apRefreshList() {
  apState.items = await apFetchItems();
  apRenderList(apState.items);
  apUpdateHomeBadge();
}

async function apOpenDrawer(id) {
  try {
    const [itemRes, projectsRes] = await Promise.all([
      fetch('/api/v1/action-items/' + encodeURIComponent(id)),
      fetch('/api/v1/projects'),
    ]);
    if (!itemRes.ok) return;
    const data = await itemRes.json();
    // /api/v1/projects returns an array directly
    const _pData = projectsRes.ok ? await projectsRes.json() : [];
    const drawerProjects = Array.isArray(_pData) ? _pData : (_pData.projects || []);
    const drawer = document.getElementById('ap-drawer');
    if (!drawer) return;
    drawer.dataset.itemId = id;
    drawer.hidden = false;
    const comments = (data.comments || []).map(c =>
      '<div class="ap-comment"><em>' + escapeHtml(c.author || '') + ':</em> ' + escapeHtml(c.body || '') + '</div>'
    ).join('');
    const events = (data.events || []).map(e =>
      '<div class="ap-event">' + escapeHtml(e.actor || '') + ' ' + escapeHtml(e.event_type || '') + ' ' +
      escapeHtml(e.old_value || '') + ' to ' + escapeHtml(e.new_value || '') + '</div>'
    ).join('');
    const item = data.item || {};

    // Build project move dropdown
    const projectOptions = drawerProjects.map(p =>
      '<option value="' + escapeHtml(p.id) + '"' + (p.id === item.project_id ? ' selected' : '') + '>' + escapeHtml(p.name || p.id) + '</option>'
    ).join('');
    const moveSection =
      '<div class="ap-drawer__section">' +
        '<h4>Move to Project</h4>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<select id="ap-move-project" class="input" style="flex:1;">' + projectOptions + '</select>' +
          '<button id="ap-move-save" type="button" class="btn btn--ghost btn--sm">Move</button>' +
        '</div>' +
      '</div>';

    // Build assignment section
    const agentKeys = typeof AGENTS !== 'undefined' ? Object.keys(AGENTS) : [];
    const isAgentAssigned = item.assigned_to && agentKeys.includes(item.assigned_to);
    const assignMode = isAgentAssigned ? 'agent' : 'human';
    const agentOptions = agentKeys.map(a =>
      '<option value="' + escapeHtml(a) + '"' + (item.assigned_to === a ? ' selected' : '') + '>' + escapeHtml(a) + '</option>'
    ).join('');
    const assignSection =
      '<div class="ap-drawer__section">' +
        '<h4>Assignment</h4>' +
        '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
          '<button type="button" class="btn btn--ghost btn--sm ap-assign-mode' + (assignMode === 'human' ? ' ap-tab--active' : '') + '" data-mode="human">Human</button>' +
          '<button type="button" class="btn btn--ghost btn--sm ap-assign-mode' + (assignMode === 'agent' ? ' ap-tab--active' : '') + '" data-mode="agent">Agent</button>' +
        '</div>' +
        '<div id="ap-assign-human"' + (assignMode === 'agent' ? ' hidden' : '') + ' style="display:flex;gap:8px;align-items:center;">' +
          '<input id="ap-assign-human-input" class="input" type="text" placeholder="Name or @handle" value="' + escapeHtml(assignMode === 'human' ? (item.assigned_to || '') : '') + '" style="flex:1;" />' +
          '<button id="ap-assign-human-save" type="button" class="btn btn--ghost btn--sm">Save</button>' +
        '</div>' +
        '<div id="ap-assign-agent"' + (assignMode === 'human' ? ' hidden' : '') + ' style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<select id="ap-assign-agent-select" class="input" style="flex:1;">' +
            '<option value="">-- select agent --</option>' + agentOptions +
          '</select>' +
          '<label style="display:flex;align-items:center;gap:4px;font-size:0.85em;">' +
            '<input id="ap-assign-agent-exec" type="checkbox"' + (item.executable_by_agent ? ' checked' : '') + ' /> Executable by agent' +
          '</label>' +
          '<button id="ap-assign-agent-save" type="button" class="btn btn--ghost btn--sm">Save</button>' +
        '</div>' +
      '</div>';

    const chatPanelHtml =
      '<div id="ap-chat-panel" class="ap-chat-panel" hidden>' +
        '<div class="ap-chat-panel__header">' +
          '<div class="ap-chat-panel__title">' +
            '<div class="ap-chat-panel__dot"></div>' +
            'Claude' +
          '</div>' +
          '<button class="ap-chat-panel__close" type="button">&#x2715; close</button>' +
        '</div>' +
        '<div class="ap-chat-panel__messages"></div>' +
        '<div class="ap-chat-panel__input-row">' +
          '<input class="ap-chat-panel__input" type="text" placeholder="Reply..." />' +
          '<button class="ap-chat-panel__send" type="button">&#x2191;</button>' +
        '</div>' +
      '</div>';

    const html =
      '<button class="ap-drawer__close" aria-label="Close">&times;</button>' +
      '<h3>' + escapeHtml(item.title || '') + '</h3>' +
      '<div class="ap-drawer__meta">Status: <strong>' + escapeHtml(item.status || '') + '</strong> &middot; Priority: ' + escapeHtml(item.priority || '') + '</div>' +
      '<p class="ap-drawer__desc">' + escapeHtml(item.description || '') + '</p>' +
      '<div class="ap-drawer__actions">' + apActionButtons(item) +
        ' <button class="ap-chat-btn" type="button">&#x1F4AC; Ask Claude</button>' +
      '</div>' +
      chatPanelHtml +
      assignSection +
      moveSection +
      '<div class="ap-drawer__section"><h4>Comments</h4>' + (comments || '<div class="ap-empty">No comments.</div>') + '</div>' +
      '<div class="ap-drawer__section"><h4>History</h4>' + (events || '<div class="ap-empty">No history.</div>') + '</div>';
    setElementHTML(drawer, html);

    // If chat was open in a previous visit to this drawer, restore it
    const existingChatState = apState.chat[id];
    if (existingChatState && existingChatState.open) {
      const panel = drawer.querySelector('#ap-chat-panel');
      if (panel) panel.hidden = false;
      const chatBtnEl = drawer.querySelector('.ap-chat-btn');
      if (chatBtnEl) chatBtnEl.classList.add('ap-chat-btn--open');
      apRenderChatPanel(id, drawer);
    }

    drawer.querySelector('.ap-drawer__close').addEventListener('click', () => {
      drawer.hidden = true;
    });

    // Ask Claude button
    const chatBtn = drawer.querySelector('.ap-chat-btn');
    if (chatBtn) {
      chatBtn.addEventListener('click', () => apChatOpen(id, drawer));
    }

    // Chat panel close
    const chatClose = drawer.querySelector('.ap-chat-panel__close');
    if (chatClose) {
      chatClose.addEventListener('click', () => {
        const panel = drawer.querySelector('#ap-chat-panel');
        if (panel) panel.hidden = true;
        const btn = drawer.querySelector('.ap-chat-btn');
        if (btn) btn.classList.remove('ap-chat-btn--open');
        apChatState(id).open = false;
      });
    }

    // Chat send on button click
    const chatSendBtn = drawer.querySelector('.ap-chat-panel__send');
    if (chatSendBtn) {
      chatSendBtn.addEventListener('click', () => {
        const input = drawer.querySelector('.ap-chat-panel__input');
        const msg = input ? input.value.trim() : '';
        if (msg) apChatSend(id, drawer, msg, false);
      });
    }

    // Chat send on Enter key
    const chatInput = drawer.querySelector('.ap-chat-panel__input');
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const msg = chatInput.value.trim();
          if (msg) apChatSend(id, drawer, msg, false);
        }
      });
    }

    drawer.querySelectorAll('.ap-drawer__actions button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const result = await apTransitionItem(id, item, action);
        if (!result.ok) {
          alert('Action item update failed: ' + result.error);
          return;
        }
        drawer.hidden = true;
        apRefreshList();
      });
    });

    // Assignment mode toggle
    drawer.querySelectorAll('.ap-assign-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        drawer.querySelectorAll('.ap-assign-mode').forEach(b => b.classList.remove('ap-tab--active'));
        btn.classList.add('ap-tab--active');
        const mode = btn.dataset.mode;
        const humanDiv = drawer.querySelector('#ap-assign-human');
        const agentDiv = drawer.querySelector('#ap-assign-agent');
        if (humanDiv) humanDiv.hidden = mode !== 'human';
        if (agentDiv) agentDiv.hidden = mode !== 'agent';
      });
    });

    // Auto-check executable_by_agent when an agent is selected
    const agentSelect = drawer.querySelector('#ap-assign-agent-select');
    const execCheck = drawer.querySelector('#ap-assign-agent-exec');
    if (agentSelect && execCheck) {
      agentSelect.addEventListener('change', () => {
        if (agentSelect.value) execCheck.checked = true;
      });
    }

    // Save human assignment
    const humanSaveBtn = drawer.querySelector('#ap-assign-human-save');
    if (humanSaveBtn) {
      humanSaveBtn.addEventListener('click', async () => {
        const input = drawer.querySelector('#ap-assign-human-input');
        const val = input ? input.value : '';
        try {
          const r = await fetch('/api/v1/action-items/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assigned_to: val || null, executable_by_agent: 0 }),
          });
          if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Save failed: ' + (e.error || r.statusText)); return; }
          drawer.hidden = true;
          apRefreshList();
        } catch (e) { alert('Network error'); }
      });
    }

    // Save agent assignment
    const agentSaveBtn = drawer.querySelector('#ap-assign-agent-save');
    if (agentSaveBtn) {
      agentSaveBtn.addEventListener('click', async () => {
        const sel = drawer.querySelector('#ap-assign-agent-select');
        const exec = drawer.querySelector('#ap-assign-agent-exec');
        const agentVal = sel ? sel.value : '';
        const execVal = exec ? (exec.checked ? 1 : 0) : 0;
        if (!agentVal) { alert('Select an agent first.'); return; }
        try {
          const r = await fetch('/api/v1/action-items/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assigned_to: agentVal, executable_by_agent: execVal }),
          });
          if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Save failed: ' + (e.error || r.statusText)); return; }
          drawer.hidden = true;
          apRefreshList();
        } catch (e) { alert('Network error'); }
      });
    }

    // Move to project
    const moveSaveBtn = drawer.querySelector('#ap-move-save');
    if (moveSaveBtn) {
      moveSaveBtn.addEventListener('click', async () => {
        const sel = drawer.querySelector('#ap-move-project');
        const targetId = sel ? sel.value : '';
        if (!targetId || targetId === item.project_id) { alert('Select a different project to move to.'); return; }
        try {
          const r = await fetch('/api/v1/action-items/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: targetId }),
          });
          if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Move failed: ' + (e.error || r.statusText)); return; }
          drawer.hidden = true;
          apRefreshList();
        } catch (e) { alert('Network error'); }
      });
    }
  } catch (e) {
    console.warn('apOpenDrawer error:', e);
  }
}

function apWireTabs() {
  document.querySelectorAll('.ap-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ap-tab').forEach(b => b.classList.remove('ap-tab--active'));
      btn.classList.add('ap-tab--active');
      apState.tab = btn.dataset.tab;
      apRefreshList();
    });
  });
}

function apWireSearch() {
  const input = document.getElementById('ap-search');
  if (!input) return;
  input.addEventListener('input', (e) => {
    apState.search = e.target.value;
    apRenderList(apState.items);
  });
}

function apWireNewButton() {
  const btn = document.getElementById('ap-new-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    let projectId = apCurrentProjectId();
    if (!projectId) {
      alert('Select a specific project first. Action items must belong to one project.');
      return;
    }
    const title = prompt('Action item title?');
    if (!title) return;
    try {
      const res = await fetch('/api/v1/action-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          title,
          proposed_by: 'human',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        alert('Failed to create action item: ' + (err.error || res.statusText));
        return;
      }
    } catch (e) {
      console.warn('ap create error:', e);
      alert('Failed to create action item (network error)');
      return;
    }
    apRefreshList();
  });
}

function apWirePurgeButton() {
  const btn = document.getElementById('ap-purge-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Purge all items archived more than 30 days ago? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/v1/action-items/purge-stale', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert('Purge failed: ' + (err.error || res.statusText));
        return;
      }
      const data = await res.json();
      alert('Purged ' + (data.purged || 0) + ' item(s).');
    } catch (err) {
      console.warn('ap purge error:', err);
      alert('Purge failed (network error)');
      return;
    }
    apRefreshList();
  });
}

// ---------------------------------------------------------------------------
// Action plan chat
// ---------------------------------------------------------------------------

function apChatState(id) {
  if (!apState.chat[id]) {
    apState.chat[id] = { open: false, messages: [], agentRunning: false };
  }
  return apState.chat[id];
}

function apChatMsgHtml(msg) {
  if (!msg) return '';
  const ALLOWED_ROLES = new Set(['user', 'assistant', 'agent']);
  const safeRole = ALLOWED_ROLES.has(msg.role) ? msg.role : 'unknown';
  const roleClass = 'ap-chat-msg--' + safeRole;
  const avatarLabel = msg.role === 'user' ? 'M' : msg.role === 'agent' ? 'A' : 'C';

  if (msg.role === 'agent' && msg._running) {
    return (
      '<div class="ap-chat-msg ap-chat-msg--agent">' +
        '<div class="ap-chat-msg__avatar">' + avatarLabel + '</div>' +
        '<div class="ap-chat-msg__bubble">' +
          '<div class="ap-chat-agent-running">' +
            '<div class="ap-chat-agent-running__dot"></div>' +
            '<span>Agent running...</span>' +
          '</div>' +
          '<div class="ap-chat-agent-steps">' + escapeHtml(msg.body || '') + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  const bubbleContent = (msg.role === 'agent' || msg.role === 'assistant')
    ? renderMarkdown(msg.body || '')
    : escapeHtml(msg.body || '');
  return (
    '<div class="ap-chat-msg ' + roleClass + '">' +
      '<div class="ap-chat-msg__avatar">' + avatarLabel + '</div>' +
      '<div class="ap-chat-msg__bubble">' + bubbleContent + '</div>' +
    '</div>'
  );
}

function apRenderChatPanel(id, drawer) {
  const state = apChatState(id);
  const panel = drawer.querySelector('#ap-chat-panel');
  if (!panel) return;
  const msgList = panel.querySelector('.ap-chat-panel__messages');
  if (msgList) {
    setElementHTML(msgList, state.messages.map(apChatMsgHtml).join(''));
    msgList.scrollTop = msgList.scrollHeight;
  }
}

async function apChatSend(id, drawer, message, init) {
  const state = apChatState(id);
  if (state.agentRunning) return;
  const input = drawer.querySelector('.ap-chat-panel__input');
  const sendBtn = drawer.querySelector('.ap-chat-panel__send');

  if (input) input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  if (!init && message) {
    state.messages.push({ id: '_tmp_user_' + Date.now(), item_id: id, role: 'user', body: message });
    apRenderChatPanel(id, drawer);
  }

  try {
    const res = await fetch('/api/v1/action-items/' + encodeURIComponent(id) + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || '', init: init === true }),
    });
    if (!res.ok) throw new Error('Chat request failed');

    // Agent always runs async -- result comes via WebSocket
    state.messages = state.messages.filter(m => m && !m.id.startsWith('_tmp_'));
    state.agentRunning = true;
    state.messages.push({ id: '_running', item_id: id, role: 'agent', body: 'Executing...', _running: true });
    apRenderChatPanel(id, drawer);

    // Safety net: if no WS response after 3 minutes, unblock the UI
    if (state.agentRunningTimer) clearTimeout(state.agentRunningTimer);
    state.agentRunningTimer = setTimeout(() => {
      if (!state.agentRunning) return;
      state.messages = state.messages.filter(m => m && m.id !== '_running');
      state.messages.push({ id: '_err_timeout_' + Date.now(), item_id: id, role: 'agent', body: 'Agent timed out. Try again.' });
      state.agentRunning = false;
      state.agentRunningTimer = null;
      const timedInput = drawer.querySelector('.ap-chat-panel__input');
      const timedSendBtn = drawer.querySelector('.ap-chat-panel__send');
      if (timedInput) { timedInput.disabled = false; timedInput.focus(); }
      if (timedSendBtn) timedSendBtn.disabled = false;
      apRenderChatPanel(id, drawer);
    }, 3 * 60 * 1000);
  } catch (err) {
    console.warn('apChatSend error:', err);
    state.messages = state.messages.filter(m => m && !m.id.startsWith('_tmp_'));
    state.messages.push({ id: '_err_' + Date.now(), item_id: id, role: 'agent', body: 'Something went wrong. Try again.' });
    apRenderChatPanel(id, drawer);
  } finally {
    if (!state.agentRunning) {
      if (input) { input.disabled = false; input.value = ''; input.focus(); }
      if (sendBtn) sendBtn.disabled = false;
    }
  }
}

async function apChatOpen(id, drawer) {
  const state = apChatState(id);
  if (state.initInProgress) return;
  state.open = true;
  state.initInProgress = true;

  const chatBtn = drawer.querySelector('.ap-chat-btn');
  if (chatBtn) chatBtn.classList.add('ap-chat-btn--open');

  const panel = drawer.querySelector('#ap-chat-panel');
  if (panel) panel.hidden = false;

  try {
    if (state.messages.length === 0) {
      try {
        const res = await fetch('/api/v1/action-items/' + encodeURIComponent(id) + '/chat');
        const data = res.ok ? await res.json() : { messages: [] };
        state.messages = (data.messages || []).filter(Boolean);
      } catch (e) {
        state.messages = [];
      }

      apRenderChatPanel(id, drawer);

      // No history -- trigger Claude's opening analysis
      if (state.messages.length === 0) {
        await apChatSend(id, drawer, '', true);
      }
    } else {
      apRenderChatPanel(id, drawer);
    }
  } finally {
    state.initInProgress = false;
  }
}

function initActionPlanPage() {
  if (!apState.inited) {
    apWireTabs();
    apWireSearch();
    apWireNewButton();
    apWirePurgeButton();
    apState.inited = true;
  }
  apRefreshList();
}

// ---------------------------------------------------------------------------
// Home dashboard "Needs Your Attention" section
// ---------------------------------------------------------------------------

async function apRenderHomeSection() {
  const container = document.getElementById('home-action-list');
  if (!container) return;
  // Clear immediately so stale items from a previous project don't linger
  // while the new project's data is in-flight.
  setElementHTML(container, '');
  const projectId = apCurrentProjectId();
  const qs = new URLSearchParams();
  if (projectId) qs.set('project_id', projectId);
  qs.set('status', 'proposed');
  let items = [];
  try {
    const res = await fetch('/api/v1/action-items?' + qs.toString());
    if (!res.ok) return;
    const data = await res.json();
    items = (data.items || []).slice(0, 5);
  } catch (e) {
    console.warn('apRenderHomeSection error:', e);
    return;
  }
  if (items.length === 0) {
    setElementHTML(container, '<div class="ap-empty">All clear. No pending decisions.</div>');
  } else {
    const html = items.map(i => (
      '<div class="home-ap-row" data-id="' + escapeHtml(String(i.id)) + '">' +
        '<span class="ap-priority ap-priority--' + escapeHtml(i.priority || 'medium') + '"></span>' +
        '<span class="home-ap-title">' + escapeHtml(i.title || '') + '</span>' +
        '<button class="btn btn--ghost btn--sm" data-action="approve" type="button">Approve</button>' +
        '<button class="btn btn--ghost btn--sm" data-action="reject" type="button">Reject</button>' +
      '</div>'
    )).join('');
    setElementHTML(container, html);
    container.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('[data-id]');
        if (!row) return;
        const item = items.find(i => String(i.id) === String(row.dataset.id));
        const result = await apTransitionItem(row.dataset.id, item, btn.dataset.action);
        if (!result.ok) {
          alert('Action item update failed: ' + result.error);
        }
        apRenderHomeSection();
      });
    });
  }
  apUpdateHomeBadge(items.length);
}

function apUpdateHomeBadge(count) {
  const badge = document.getElementById('home-action-count');
  if (!badge) return;
  if (typeof count === 'number') {
    badge.textContent = String(count);
  } else {
    const n = (apState.items || []).filter(i => i.status === 'proposed').length;
    badge.textContent = String(n);
  }
}

// WebSocket: react to action_item_update broadcasts
if (typeof window !== 'undefined') {
  const _apOrigSetup = window.__apWsHooked;
  if (!_apOrigSetup) {
    window.__apWsHooked = true;
    document.addEventListener('action-item-ws-update', () => {
      const visible = document.querySelector('section.page:not([hidden])');
      if (visible && visible.id === 'page-action-plan') apRefreshList();
      apRenderHomeSection();
    });
  }
}

// ---------------------------------------------------------------------------
// Auth Gate
// ---------------------------------------------------------------------------

function showAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.style.display = 'flex';
  const input = document.getElementById('auth-gate-input');
  if (input) setTimeout(() => input.focus(), 50);
}

function hideAuthGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.style.display = 'none';
}

function initAuthGate() {
  const submit = document.getElementById('auth-gate-submit');
  const input = document.getElementById('auth-gate-input');
  const errorEl = document.getElementById('auth-gate-error');

  if (!submit || !input) return;

  async function doLogin() {
    const token = input.value.trim();
    if (!token) return;
    submit.disabled = true;
    if (errorEl) errorEl.style.display = 'none';
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        hideAuthGate();
        window.location.reload();
        return;
      }
      if (errorEl) {
        errorEl.textContent = res.status === 401 ? 'Token not recognized.' : 'Login failed. Try again.';
        errorEl.style.display = 'block';
      }
    } catch (_) {
      if (errorEl) {
        errorEl.textContent = 'Connection error. Check that Tailscale is connected.';
        errorEl.style.display = 'block';
      }
    }
    submit.disabled = false;
  }

  submit.addEventListener('click', doLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

// Call initAuthGate immediately (not gated on user -- the gate itself must
// always be interactive even before auth succeeds)
initAuthGate();

// ---------------------------------------------------------------------------
// Admin visibility helpers
// ---------------------------------------------------------------------------

function applyAdminVisibility() {
  const isAdmin = CURRENT_USER && CURRENT_USER.isAdmin;
  document.querySelectorAll('.sidebar-link--admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

function showToast(msg, type) {
  const el = document.createElement('div');
  el.className = 'cp-toast' + (type ? ' cp-toast--' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 320);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

function showConfirm(title, body, onOk) {
  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-modal-title');
  const bodyEl = document.getElementById('confirm-modal-body');
  const okBtn = document.getElementById('confirm-modal-ok');
  const cancelBtn = document.getElementById('confirm-modal-cancel');
  if (!modal) { if (confirm(body)) onOk(); return; }
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.textContent = body;
  modal.style.display = 'flex';
  function cleanup() { modal.style.display = 'none'; okBtn.onclick = null; cancelBtn.onclick = null; }
  okBtn.onclick = () => { cleanup(); onOk(); };
  cancelBtn.onclick = cleanup;
}

// ---------------------------------------------------------------------------
// Raw token reveal modal
// ---------------------------------------------------------------------------

function showTokenReveal(rawToken) {
  const modal = document.getElementById('token-reveal-modal');
  const valueEl = document.getElementById('token-reveal-value');
  const copyBtn = document.getElementById('token-reveal-copy');
  const closeBtn = document.getElementById('token-reveal-close');
  if (!modal) return;
  if (valueEl) valueEl.textContent = rawToken;
  modal.style.display = 'flex';
  function close() {
    modal.style.display = 'none';
    if (valueEl) valueEl.textContent = '';
    if (copyBtn) copyBtn.onclick = null;
  }
  if (closeBtn) closeBtn.onclick = close;
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(rawToken).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 2000);
      }).catch(() => showToast('Copy failed -- paste manually', 'error'));
    };
  }
}

// ---------------------------------------------------------------------------
// Users Admin Page
// ---------------------------------------------------------------------------

function initUsersPage() {
  const addBtn = document.getElementById('users-add-btn');
  if (addBtn) addBtn.addEventListener('click', () => openAddUserModal());
  // Wire up modal close
  const closeBtn = document.getElementById('users-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { document.getElementById('users-modal').style.display = 'none'; });
}

async function fetchUsers() {
  const data = await fetchFromAPI('/api/v1/users');
  return data ? (data.users || data) : [];
}

async function renderUsersPage() {
  if (!CURRENT_USER || !CURRENT_USER.isAdmin) return;
  const container = document.getElementById('users-list');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  const loadingEl = document.createElement('p');
  loadingEl.style.color = 'var(--text-muted)';
  loadingEl.style.fontSize = '13px';
  loadingEl.textContent = 'Loading...';
  container.appendChild(loadingEl);

  const users = await fetchUsers();
  container.removeChild(loadingEl);

  if (!users.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:var(--text-muted);font-size:13px;';
    empty.textContent = 'No users yet.';
    container.appendChild(empty);
    return;
  }

  for (const u of users) {
    container.appendChild(buildUserRow(u));
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function buildUserRow(u) {
  const row = document.createElement('div');
  row.className = 'user-row';
  row.dataset.userId = u.id;

  // Header
  const header = document.createElement('div');
  header.className = 'user-row__header';

  const nameEl = document.createElement('span');
  nameEl.className = 'user-row__name';
  nameEl.textContent = u.name || u.email;

  const roleBadge = document.createElement('span');
  roleBadge.className = 'user-row__role-badge' + (u.global_role === 'admin' ? '' : ' user-row__role-badge--member');
  roleBadge.textContent = u.global_role || 'member';

  const emailEl = document.createElement('span');
  emailEl.style.cssText = 'font-size:11px;color:var(--text-muted);';
  emailEl.textContent = u.email;

  const meta = document.createElement('span');
  meta.className = 'user-row__meta';
  meta.textContent = u.last_seen ? 'last seen ' + timeAgo(u.last_seen) : 'never seen';

  header.appendChild(nameEl);
  header.appendChild(roleBadge);
  header.appendChild(emailEl);
  header.appendChild(meta);
  row.appendChild(header);

  // Memberships
  const memberships = u.memberships || [];
  if (memberships.length > 0) {
    const mList = document.createElement('div');
    mList.className = 'user-row__memberships';
    for (const m of memberships) {
      const mRow = buildMembershipRow(u, m);
      mList.appendChild(mRow);
    }
    row.appendChild(mList);
  }

  // Actions row
  const actions = document.createElement('div');
  actions.className = 'user-row__actions';

  // Tokens button
  const tokenCount = (u.tokens || []).length;
  const tokensBtn = document.createElement('button');
  tokensBtn.className = 'btn btn--ghost btn--sm';
  tokensBtn.type = 'button';
  tokensBtn.textContent = 'Tokens (' + tokenCount + ')';

  // Token drawer (hidden by default)
  const tokenDrawer = document.createElement('div');
  tokenDrawer.className = 'user-row__token-drawer';
  tokenDrawer.style.display = 'none';
  renderTokenDrawer(tokenDrawer, u);

  tokensBtn.addEventListener('click', () => {
    const hidden = tokenDrawer.style.display === 'none';
    tokenDrawer.style.display = hidden ? 'block' : 'none';
  });

  // Grant project button
  const grantBtn = document.createElement('button');
  grantBtn.className = 'btn btn--ghost btn--sm';
  grantBtn.type = 'button';
  grantBtn.textContent = '+ Grant project';
  grantBtn.addEventListener('click', () => openGrantProjectModal(u, row));

  actions.appendChild(tokensBtn);
  actions.appendChild(grantBtn);

  // Delete user (not self)
  if (CURRENT_USER && String(u.id) !== String(CURRENT_USER.id)) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn--ghost btn--sm';
    deleteBtn.type = 'button';
    deleteBtn.style.cssText = 'color:var(--red);margin-left:auto;';
    deleteBtn.textContent = 'Delete user';
    deleteBtn.addEventListener('click', () => {
      showConfirm(
        'Delete user',
        'Delete ' + (u.name || u.email) + '? This cascades to tokens and memberships. Non-reversible.',
        async () => {
          const result = await apiFetch('/api/v1/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
          if (result.ok) {
            showToast('User deleted', 'success');
            renderUsersPage();
          } else {
            showToast((result.data && result.data.error) || 'Delete failed', 'error');
          }
        }
      );
    });
    actions.appendChild(deleteBtn);
  }

  row.appendChild(actions);
  row.appendChild(tokenDrawer);

  return row;
}

function buildMembershipRow(u, m) {
  const mRow = document.createElement('div');
  mRow.className = 'user-row__membership';
  mRow.dataset.projectId = m.project_id;

  const projName = document.createElement('span');
  projName.className = 'user-row__membership-project';
  projName.textContent = m.project_name || m.project_id;

  const roleSelect = document.createElement('select');
  roleSelect.style.cssText = 'font-size:11px;background:var(--bg-base);border:1px solid var(--border-subtle);color:var(--text-primary);border-radius:4px;padding:2px 6px;';
  ['owner', 'editor', 'viewer'].forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === m.role) opt.selected = true;
    roleSelect.appendChild(opt);
  });
  roleSelect.addEventListener('change', async () => {
    const result = await apiFetch('/api/v1/users/' + encodeURIComponent(u.id) + '/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: m.project_id, role: roleSelect.value }),
    });
    if (!result.ok) {
      showToast((result.data && result.data.error) || 'Role update failed', 'error');
      roleSelect.value = m.role; // revert
    } else {
      showToast('Role updated', 'success');
    }
  });

  const revokeBtn = document.createElement('button');
  revokeBtn.className = 'btn btn--ghost btn--sm';
  revokeBtn.type = 'button';
  revokeBtn.style.cssText = 'font-size:11px;color:var(--red);';
  revokeBtn.textContent = 'Revoke';
  revokeBtn.addEventListener('click', () => {
    showConfirm(
      'Revoke access',
      'Remove ' + (u.name || u.email) + ' from ' + (m.project_name || m.project_id) + '?',
      async () => {
        const result = await apiFetch('/api/v1/users/' + encodeURIComponent(u.id) + '/memberships/' + encodeURIComponent(m.project_id), {
          method: 'DELETE',
        });
        if (result.ok) {
          showToast('Access revoked', 'success');
          renderUsersPage();
        } else {
          showToast((result.data && result.data.error) || 'Revoke failed', 'error');
        }
      }
    );
  });

  mRow.appendChild(projName);
  mRow.appendChild(roleSelect);
  mRow.appendChild(revokeBtn);
  return mRow;
}

function renderTokenDrawer(drawer, u) {
  while (drawer.firstChild) drawer.removeChild(drawer.firstChild);
  const tokens = u.tokens || [];
  for (const t of tokens) {
    const item = document.createElement('div');
    item.className = 'user-row__token-item';
    const label = document.createElement('span');
    label.className = 'user-row__token-label';
    label.textContent = t.label || 'token';
    const created = document.createElement('span');
    created.textContent = 'created ' + (t.created_at ? new Date(t.created_at).toLocaleDateString() : '--');
    const lastUsed = document.createElement('span');
    lastUsed.textContent = t.last_used ? 'last used ' + timeAgo(t.last_used) : 'never used';
    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn btn--ghost btn--sm';
    revokeBtn.type = 'button';
    revokeBtn.style.cssText = 'font-size:11px;color:var(--red);margin-left:auto;';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', () => {
      showConfirm('Revoke token', 'Revoke token "' + (t.label || 'token') + '"? Non-reversible.', async () => {
        const result = await apiFetch('/api/v1/users/' + encodeURIComponent(u.id) + '/tokens/' + encodeURIComponent(t.id), { method: 'DELETE' });
        if (result.ok) {
          showToast('Token revoked', 'success');
          renderUsersPage();
        } else {
          showToast((result.data && result.data.error) || 'Revoke failed', 'error');
        }
      });
    });
    item.appendChild(label);
    item.appendChild(created);
    item.appendChild(lastUsed);
    item.appendChild(revokeBtn);
    drawer.appendChild(item);
  }
  // New token button
  const newTokenBtn = document.createElement('button');
  newTokenBtn.className = 'btn btn--ghost btn--sm';
  newTokenBtn.type = 'button';
  newTokenBtn.style.marginTop = '6px';
  newTokenBtn.textContent = '+ New token';
  newTokenBtn.addEventListener('click', () => issueToken(u));
  drawer.appendChild(newTokenBtn);
}

async function issueToken(u, label) {
  const lbl = label || (u.name || u.email) + ' token';
  const result = await apiFetch('/api/v1/users/' + encodeURIComponent(u.id) + '/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: lbl }),
  });
  if (result.ok && result.data && result.data.token) {
    showTokenReveal(result.data.token);
    renderUsersPage();
  } else {
    showToast((result.data && result.data.error) || 'Token creation failed', 'error');
  }
}

function openAddUserModal() {
  const modal = document.getElementById('users-modal');
  const titleEl = document.getElementById('users-modal-title');
  const body = document.getElementById('users-modal-body');
  if (!modal || !body) return;
  if (titleEl) titleEl.textContent = 'Add User';

  // Build form using DOM methods to avoid innerHTML with user content
  while (body.firstChild) body.removeChild(body.firstChild);

  const form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  function makeField(labelText, input) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-form__field';
    const lbl = document.createElement('label');
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    return wrap;
  }

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Name';
  nameInput.required = true;

  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.placeholder = 'Email';
  emailInput.required = true;

  const roleSelect = document.createElement('select');
  ['member', 'admin'].forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    roleSelect.appendChild(opt);
  });

  const errorEl = document.createElement('p');
  errorEl.style.cssText = 'color:var(--red);font-size:12px;margin:0;display:none;';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn--primary';
  submitBtn.type = 'button';
  submitBtn.textContent = 'Create user';

  form.appendChild(makeField('Name', nameInput));
  form.appendChild(makeField('Email', emailInput));
  form.appendChild(makeField('Role', roleSelect));
  form.appendChild(errorEl);
  form.appendChild(submitBtn);
  body.appendChild(form);

  modal.style.display = 'flex';
  nameInput.focus();

  submitBtn.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const role = roleSelect.value;
    if (!name || !email) { errorEl.textContent = 'Name and email are required.'; errorEl.style.display = 'block'; return; }
    submitBtn.disabled = true;
    const result = await apiFetch('/api/v1/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, global_role: role }),
    });
    submitBtn.disabled = false;
    if (!result.ok) {
      errorEl.textContent = (result.data && result.data.error) || 'Failed to create user.';
      errorEl.style.display = 'block';
      return;
    }
    modal.style.display = 'none';
    const newUser = result.data.user || result.data;
    renderUsersPage();
    // Prompt to grant first project
    openGrantProjectModal(newUser, null, () => {
      // After granting, prompt to issue token
      showConfirm('Issue initial token?', 'Issue an access token for ' + (newUser.name || newUser.email) + ' now?', () => {
        issueToken(newUser);
      });
    });
  });
}

function openGrantProjectModal(u, rowEl, onDone) {
  const modal = document.getElementById('users-modal');
  const titleEl = document.getElementById('users-modal-title');
  const body = document.getElementById('users-modal-body');
  if (!modal || !body) return;
  if (titleEl) titleEl.textContent = 'Grant project access';

  while (body.firstChild) body.removeChild(body.firstChild);

  const form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  function makeField(labelText, input) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-form__field';
    const lbl = document.createElement('label');
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    return wrap;
  }

  const projectSelect = document.createElement('select');
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Select project...';
  projectSelect.appendChild(defaultOpt);
  for (const p of allProjects.filter(p => p.status !== 'archived')) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.display_name;
    projectSelect.appendChild(opt);
  }

  const roleSelect = document.createElement('select');
  ['owner', 'editor', 'viewer'].forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === 'editor') opt.selected = true;
    roleSelect.appendChild(opt);
  });

  const errorEl = document.createElement('p');
  errorEl.style.cssText = 'color:var(--red);font-size:12px;margin:0;display:none;';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn--primary';
  submitBtn.type = 'button';
  submitBtn.textContent = 'Grant access';

  form.appendChild(makeField('Project', projectSelect));
  form.appendChild(makeField('Role', roleSelect));
  form.appendChild(errorEl);
  form.appendChild(submitBtn);
  body.appendChild(form);

  modal.style.display = 'flex';

  submitBtn.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    const projectId = projectSelect.value;
    const role = roleSelect.value;
    if (!projectId) { errorEl.textContent = 'Select a project.'; errorEl.style.display = 'block'; return; }
    submitBtn.disabled = true;
    const result = await apiFetch('/api/v1/users/' + encodeURIComponent(u.id) + '/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, role }),
    });
    submitBtn.disabled = false;
    if (!result.ok) {
      errorEl.textContent = (result.data && result.data.error) || 'Failed to grant access.';
      errorEl.style.display = 'block';
      return;
    }
    modal.style.display = 'none';
    showToast('Access granted', 'success');
    renderUsersPage();
    if (typeof onDone === 'function') onDone();
  });
}

// Wire page nav to load users on demand
ProjectBus.on(() => {
  const page = document.querySelector('section.page.active');
  if (page && page.id === 'page-users') renderUsersPage();
});
