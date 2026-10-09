import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, ScrollArea, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import App from './App';
import { colorSchemeManager } from './preferences';
import ScrollShadows from './ScrollShadows';

const fontFamily = 'var(--font-body)';
const theme = createTheme({
  primaryColor: 'teal',
  primaryShade: 7,
  autoContrast: true,
  black: '#182c32',
  fontFamily,
  fontFamilyMonospace: fontFamily,
  fontSizes: { xs: 'var(--text-caption)', sm: 'var(--text-control)', md: 'var(--text-body)', lg: 'var(--text-emphasis)', xl: 'var(--title-compact)' },
  lineHeights: { xs: '1.4', sm: '1.45', md: 'var(--leading-body)', lg: '1.6', xl: '1.65' },
  headings: { fontFamily: 'var(--font-heading)', fontWeight: '600', sizes: {
    h1: { fontSize: 'var(--text-display)', lineHeight: 'var(--leading-heading)' },
    h2: { fontSize: 'var(--title-page)', lineHeight: 'var(--leading-heading)' },
    h3: { fontSize: 'var(--title-section)', lineHeight: 'var(--leading-heading)' },
    h4: { fontSize: 'var(--title-compact)', lineHeight: 'var(--leading-heading)' },
    h5: { fontSize: 'var(--text-emphasis)', lineHeight: 'var(--leading-heading)' },
    h6: { fontSize: 'var(--text-body)', lineHeight: 'var(--leading-heading)' },
  } },
  defaultRadius: 'sm',
  radius: { xs: '8px', sm: '12px', md: '16px', lg: '20px', xl: '28px' },
  colors: {
    dark: ['#e5e7eb', '#c4c9d1', '#9da4ae', '#777f8b', '#4a515b', '#343a43', '#2a2e34', '#22252a', '#17191d', '#111216'],
    blue: ['#e1f5fe', '#b3e5fc', '#81d4fa', '#4fc3f7', '#29b6f6', '#03a9f4', '#039be5', '#0288d1', '#0277bd', '#01579b'],
    cyan: ['#e0f7fa', '#b2ebf2', '#80deea', '#4dd0e1', '#26c6da', '#00bcd4', '#00acc1', '#0097a7', '#00838f', '#006064'],
    teal: ['#e0f2f1', '#b2dfdb', '#80cbc4', '#4db6ac', '#26a69a', '#009688', '#00897b', '#00796b', '#00695c', '#004d40'],
    gray: ['#f7f9fa', '#eff3f4', '#e5ecee', '#d3dee1', '#b1c0c5', '#889ba2', '#647880', '#4a6068', '#30484f', '#182c32'],
  },
  components: {
    Card: { defaultProps: { radius: 'lg' } },
    Paper: { defaultProps: { radius: 'md' } },
    Text: { defaultProps: { fw: 400 } },
    Button: { defaultProps: { radius: 'sm', fw: 500 } },
    ActionIcon: { defaultProps: { radius: 'sm' } },
    Badge: { defaultProps: { radius: 'xl', fw: 500, tt: 'none' } },
    ThemeIcon: { defaultProps: { radius: 'md', variant: 'light' } },
    TextInput: { defaultProps: { radius: 'sm' } },
    Select: { defaultProps: { radius: 'sm' } },
    MultiSelect: { defaultProps: { radius: 'sm' } },
    SegmentedControl: { defaultProps: { radius: 'sm' } },
    ScrollArea: { defaultProps: { type: 'never', scrollbarSize: 0, viewportProps: { tabIndex: 0 } } },
    ScrollAreaAutosize: { defaultProps: { type: 'never', scrollbarSize: 0, viewportProps: { tabIndex: 0 } } },
    Modal: { defaultProps: { radius: 'lg', scrollAreaComponent: ScrollArea.Autosize, overlayProps: { backgroundOpacity: 0.2, blur: 3 } } },
  },
});

if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add(navigator.platform.startsWith('Mac') ? 'electron-mac' : 'electron-other');
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light" colorSchemeManager={colorSchemeManager}>
      <Notifications position="top-right" />
      <ScrollShadows />
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
