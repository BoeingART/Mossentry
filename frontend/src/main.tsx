import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import App from './App';

const fontFamily = 'Poppins, "PingFang SC", "Microsoft YaHei", sans-serif';
const theme = createTheme({
  primaryColor: 'blue',
  primaryShade: 3,
  autoContrast: true,
  black: '#101322',
  fontFamily,
  fontSizes: { xs: '0.6875rem', sm: '0.75rem', md: '0.8125rem', lg: '0.9375rem', xl: '1.125rem' },
  headings: { fontFamily, fontWeight: '600', sizes: {
    h2: { fontSize: '1.625rem', lineHeight: '1.35' },
    h3: { fontSize: '1rem', lineHeight: '1.5' },
    h4: { fontSize: '0.9375rem', lineHeight: '1.5' },
  } },
  defaultRadius: 'md',
  colors: {
    blue: ['#f2f8fc', '#e3f0fa', '#cee5f6', '#b2d7f3', '#8abfe4', '#64a3d0', '#4586b5', '#356b92', '#2b5574', '#24465f'],
    teal: ['#f0faf7', '#def3eb', '#c3e8da', '#9ad8c1', '#76c9ad', '#50af91', '#348c72', '#286f5b', '#22594b', '#1b493d'],
    orange: ['#fff8ed', '#faecd8', '#f5dbb8', '#f0c68f', '#e8ad69', '#da9147', '#bf742e', '#9c5c23', '#7e4b21', '#663e1e'],
    gray: ['#fafafa', '#f4f4f5', '#ececee', '#dedee2', '#bcbec4', '#9698a0', '#777b85', '#5b5f6a', '#373c48', '#181e2b'],
  },
  components: {
    Button: { defaultProps: { radius: 'xl', fw: 500 } },
    ActionIcon: { defaultProps: { radius: 'xl' } },
    Badge: { defaultProps: { radius: 'xl', fw: 400, tt: 'none' } },
    ThemeIcon: { defaultProps: { radius: 'xl' } },
    TextInput: { defaultProps: { radius: 'xl' } },
    Select: { defaultProps: { radius: 'xl' } },
    MultiSelect: { defaultProps: { radius: 'lg' } },
    SegmentedControl: { defaultProps: { radius: 'xl' } },
    Modal: { defaultProps: { radius: 'lg', overlayProps: { backgroundOpacity: 0.18, blur: 2 } } },
  },
});

if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add(navigator.platform.startsWith('Mac') ? 'electron-mac' : 'electron-other');
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" />
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
