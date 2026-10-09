import { ActionIcon, Menu, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { IconCheck, IconLanguage, IconMoon, IconSun } from '@tabler/icons-react';
import { setLanguage, t, useLanguage } from './i18n';

export default function AppearanceControls() {
  const language = useLanguage();
  const scheme = useComputedColorScheme('light');
  const { setColorScheme } = useMantineColorScheme();
  const dark = scheme === 'dark';
  const themeLabel = t(dark ? 'Switch to day mode' : 'Switch to night mode');
  return <>
    <Tooltip label={themeLabel}>
      <ActionIcon className="theme-toggle" variant="subtle" color="gray" size="lg"
        aria-label={themeLabel} aria-pressed={dark} onClick={() => setColorScheme(dark ? 'light' : 'dark')}>
        {dark ? <IconSun size={21} stroke={1.6} /> : <IconMoon size={21} stroke={1.6} />}
      </ActionIcon>
    </Tooltip>
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
