import { useEffect } from 'react';
import { ActionIcon, Menu, useMantineColorScheme } from '@mantine/core';
import { IconCheck, IconLanguage, IconMoon, IconSun, IconSunMoon } from '@tabler/icons-react';
import { setLanguage, t, useLanguage } from './i18n';

const modes = {
  auto: { label: 'Follow computer settings', next: 'light', icon: IconSunMoon },
  light: { label: 'Day mode', next: 'dark', icon: IconSun },
  dark: { label: 'Night mode', next: 'auto', icon: IconMoon },
} as const;

export default function AppearanceControls() {
  const language = useLanguage();
  const { colorScheme, setColorScheme } = useMantineColorScheme({ keepTransitions: true });
  const mode = modes[colorScheme];
  const ThemeIcon = mode.icon;
  const themeLabel = t('Appearance: {0}. Click to switch to {1}.', { 0: t(mode.label), 1: t(modes[mode.next].label) });

  useEffect(() => {
    const root = document.documentElement;
    // Enable transitions after the saved theme is restored, including computer-setting changes.
    root.setAttribute('data-theme-ready', '');
    return () => root.removeAttribute('data-theme-ready');
  }, []);

  return <>
    <ActionIcon className="theme-toggle" variant="subtle" color="gray" size="lg" aria-label={themeLabel}
      onClick={() => setColorScheme(mode.next)}>
      <span className="theme-mode-icon" key={colorScheme}><ThemeIcon size={21} stroke={1.6} /></span>
    </ActionIcon>
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon className="language-toggle" variant="subtle" color="gray" size="lg" aria-label={t('Switch language')} title={t('Switch language')}>
          <IconLanguage size={21} stroke={1.6} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown miw={150}>
        <Menu.Label>{t('Language')}</Menu.Label>
        <Menu.Item lang="zh-CN" rightSection={language === 'zh' ? <IconCheck size={15} aria-hidden="true" /> : null}
          aria-current={language === 'zh' ? 'true' : undefined} onClick={() => setLanguage('zh')}>简体中文</Menu.Item>
        <Menu.Item lang="en" rightSection={language === 'en' ? <IconCheck size={15} aria-hidden="true" /> : null}
          aria-current={language === 'en' ? 'true' : undefined} onClick={() => setLanguage('en')}>English</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  </>;
}
