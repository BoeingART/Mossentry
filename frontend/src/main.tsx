import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, ScrollArea, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import App from './App';
import ScrollShadows from './ScrollShadows';

const fontFamily = '"Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif';
const theme = createTheme({
  primaryColor: 'teal',
  primaryShade: 7,
  autoContrast: true,
  black: '#182c32',
  fontFamily,
  fontSizes: { xs: '0.75rem', sm: '0.8125rem', md: '0.875rem', lg: '1rem', xl: '1.125rem' },
  headings: { fontFamily, fontWeight: '600', sizes: {
    h1: { fontSize: '1.875rem', lineHeight: '1.3' },
    h2: { fontSize: '1.5rem', lineHeight: '1.4' },
    h3: { fontSize: '1.0625rem', lineHeight: '1.5' },
    h4: { fontSize: '1rem', lineHeight: '1.5' },
    h5: { fontSize: '0.9375rem' },
    h6: { fontSize: '0.875rem' },
  } },
  defaultRadius: 'sm',
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '20px' },
  colors: {
    blue: ['#e1f5fe', '#b3e5fc', '#81d4fa', '#4fc3f7', '#29b6f6', '#03a9f4', '#039be5', '#0288d1', '#0277bd', '#01579b'],
    cyan: ['#e0f7fa', '#b2ebf2', '#80deea', '#4dd0e1', '#26c6da', '#00bcd4', '#00acc1', '#0097a7', '#00838f', '#006064'],
    teal: ['#e0f2f1', '#b2dfdb', '#80cbc4', '#4db6ac', '#26a69a', '#009688', '#00897b', '#00796b', '#00695c', '#004d40'],
    gray: ['#f7f9fa', '#eff3f4', '#e5ecee', '#d3dee1', '#b1c0c5', '#889ba2', '#647880', '#4a6068', '#30484f', '#182c32'],
  },
  components: {
    Text: { defaultProps: { fw: 400 } },
    Button: { defaultProps: { radius: 'sm', fw: 500 } },
    ActionIcon: { defaultProps: { radius: 'sm' } },
    Badge: { defaultProps: { radius: 'sm', fw: 500, tt: 'none' } },
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
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" />
      <ScrollShadows />
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
