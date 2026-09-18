/**
 * Light/dark toggle. Without a stored preference <html> has no data-theme and
 * `prefers-color-scheme` rules; choosing one sets data-theme and persists it.
 * The initial application happens in the inline theme-init.js script in <head>.
 */
export const THEME_STORAGE_KEY = 'rukh:theme';

const themes = ['light', 'dark'] as const;
type Theme = (typeof themes)[number];

const themeColors: Record<Theme, string> = {
  light: '#f4f6f9',
  dark: '#0e1622',
};

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (themes as readonly string[]).includes(value);
}

const root = document.documentElement;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-theme-option]'));

function resolvedTheme(): Theme {
  const explicit = root.dataset.theme;
  if (isTheme(explicit)) return explicit;
  return systemDark.matches ? 'dark' : 'light';
}

function syncControls() {
  const current = resolvedTheme();
  for (const button of buttons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === current));
  }
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', themeColors[current]);
}

function applyTheme(theme: Theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* localStorage unavailable: the theme applies to this page only */
  }
  syncControls();
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    const theme = button.dataset.themeOption;
    if (isTheme(theme)) applyTheme(theme);
  });
}

systemDark.addEventListener('change', syncControls);
syncControls();
