import { useState } from 'react';
import { Collapse, Stack, Tooltip } from '@mantine/core';
import { IconChevronRight, IconServer, IconShieldCheck, IconTerminal2 } from '@tabler/icons-react';
import { t } from './i18n';

type OperationsView = 'firewall' | 'operations';

export default function OperationsNav({ compact, view, navigate, expandSidebar }: {
  compact: boolean; view: string; navigate: (view: OperationsView) => void; expandSidebar: () => void;
}) {
  const [opened, setOpened] = useState(true);
  const active = view === 'firewall' || view === 'operations';
  return <>
    <Tooltip label={t('Operations')} position="right" disabled={!compact} events={{ hover: true, focus: true, touch: false }}>
      <button type="button" className={`nav-button ${active ? 'section-active' : ''}`} aria-label={t('Operations')}
        aria-expanded={!compact && opened} aria-controls="operations-navigation" onClick={() => {
          if (compact) { expandSidebar(); setOpened(true); }
          else setOpened(value => !value);
        }}>
        <span className="nav-icon"><IconServer size={19} /></span>
        <span className="nav-label" aria-hidden={compact}>{t('Operations')}</span>
        <IconChevronRight size={16} aria-hidden="true" className={`nav-chevron ${opened ? 'opened' : ''}`} />
      </button>
    </Tooltip>
    <Collapse expanded={!compact && opened}>
      <Stack id="operations-navigation" className="nav-submenu" gap={5}>
        {([
          { id: 'firewall', label: t('Firewall'), icon: <IconShieldCheck size={17} /> },
          { id: 'operations', label: t('Execute commands'), icon: <IconTerminal2 size={17} /> },
        ] as const).map(item => <button key={item.id} type="button" className={`nav-button ${view === item.id ? 'active' : ''}`}
          aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
          <span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span>
        </button>)}
      </Stack>
    </Collapse>
  </>;
}
