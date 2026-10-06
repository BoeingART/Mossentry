import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import App from './App';

const fontFamily = '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
const theme = createTheme({
  primaryColor: 'lemon',
  primaryShade: 5,
  autoContrast: true,
  black: '#191a20',
  fontFamily,
  headings: { fontFamily, fontWeight: '500' },
  defaultRadius: 'lg',
  colors: {
    lemon: ['#fffdeb', '#fffbc9', '#fff89b', '#fff577', '#fff263', '#f4ed57', '#ded747', '#beb736', '#98922a', '#716d23'],
    blue: ['#f2f1fc', '#e9e7fa', '#d5d1f5', '#bdb6ed', '#a398e0', '#8c7dce', '#7566b5', '#605297', '#4e437b', '#403762'],
    teal: ['#f1f7ed', '#e2efd9', '#c9dfba', '#accb96', '#8fb774', '#769f5d', '#60864a', '#4d6e3b', '#405931', '#344929'],
  },
  components: {
    Button: { defaultProps: { radius: 'xl', size: 'sm' } },
    ActionIcon: { defaultProps: { radius: 'xl' } },
    Badge: { defaultProps: { radius: 'xl', fw: 500, tt: 'none' } },
    Card: { defaultProps: { radius: 'xl' } },
    Modal: { defaultProps: { radius: 'xl', overlayProps: { backgroundOpacity: 0.2, blur: 6 } } },
    TextInput: { defaultProps: { radius: 'xl' } },
    Select: { defaultProps: { radius: 'xl' } },
    MultiSelect: { defaultProps: { radius: 'xl' } },
    SegmentedControl: { defaultProps: { radius: 'xl' } },
    Tooltip: { defaultProps: { radius: 'md', withArrow: true } },
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
