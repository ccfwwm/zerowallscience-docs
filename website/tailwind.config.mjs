/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        border: 'var(--border)',
        'border-faint': 'var(--border-faint)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
        'accent-glow': 'var(--accent-glow)',
        link: 'var(--link)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ["'Source Serif 4'", 'Georgia', 'serif'],
        mono: ["'JetBrains Mono'", 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '14px',
        input: '10px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(40,39,35,0.04), 0 4px 16px rgba(40,39,35,0.05)',
        pop: '0 8px 30px rgba(40,39,35,0.14)',
      },
    },
  },
  plugins: [],
};
