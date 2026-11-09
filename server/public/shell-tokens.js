// Shell v2: one palette for every workspace. A workspace contributes an
// accent colour and nothing else. Backgrounds, text, borders, radii, fonts,
// gradients and shadows come from the ClaudePaw base in style.css and never
// change when the operator switches project.
//
// Loaded as a classic script before app.js. server/src/shell-tokens.test.ts
// evaluates this same file, so keep it free of DOM access and of imports.

function shellHexToRgb(hex) {
  var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// The complete set of custom properties a workspace may override.
// Anything not in this object is shell-owned.
function shellAccentTokens(accentHex) {
  var rgb = shellHexToRgb(accentHex);
  if (!rgb) return {};
  var r = rgb.r, g = rgb.g, b = rgb.b;
  return {
    '--accent': accentHex,
    '--accent-dim': 'rgba(' + r + ',' + g + ',' + b + ',0.13)',
    '--accent-glow': 'rgba(' + r + ',' + g + ',' + b + ',0.32)',
    '--accent-soft': 'rgba(' + r + ',' + g + ',' + b + ',0.07)',
    '--accent-faint': 'rgba(' + r + ',' + g + ',' + b + ',0.03)',
    '--accent-subtle': 'rgba(' + r + ',' + g + ',' + b + ',0.10)',
    '--accent-medium': 'rgba(' + r + ',' + g + ',' + b + ',0.28)',
    '--accent-strong': 'rgba(' + r + ',' + g + ',' + b + ',0.60)',
    '--accent-grid': 'rgba(' + r + ',' + g + ',' + b + ',0.010)'
  };
}

// project_settings.primary_color wins, then the theme's accent, then the
// ClaudePaw orange. theme_id survives in the DB as the accent source; the
// rest of a theme file is ignored by the shell.
function shellAccentFor(settings, theme) {
  return (settings && settings.primary_color)
    || (theme && theme.colors && theme.colors.accent)
    || '#f97316';
}

if (typeof globalThis !== 'undefined') {
  globalThis.shellAccentTokens = shellAccentTokens;
  globalThis.shellAccentFor = shellAccentFor;
}
