import { useId, useState } from 'react';
import { Badge, Collapse, Menu, Stack, Tooltip } from '@mantine/core';
import {
  IconCalendarClock, IconChevronRight, IconHistory, IconLayoutDashboard,
  IconServer, IconSettings, IconShieldCheck, IconShieldLock, IconTerminal2,
  IconActivity, IconUsers,
} from '@tabler/icons-react';
import { t } from './i18n';

export type View = 'operations' | 'firewall' | 'dashboard' | 'overview' | 'monitor' | 'users' | 'approvals' | 'audit';

export default function SidebarNavigation({ view, compact, pending, navigate }: {
  view: View; compact: boolean; pending: number; navigate: (view: View) => void;
}) {
  const [operationsOpened, setOperationsOpened] = useState(false);
  const submenuId = useId();
  const operationsActive = view === 'operations' || view === 'firewall';
  const tasks = [
    { id: 'firewall', label: t('Firewall'), icon: IconShieldLock },
    { id: 'scheduled', label: t('Scheduled tasks'), icon: IconCalendarClock },
    { id: 'processes', label: t('Background processes'), icon: IconActivity },
    { id: 'operations', label: t('Execute commands'), icon: IconTerminal2 },
  ] as const;
  const nav = [
    { id: 'dashboard', label: t('Dashboard'), icon: IconLayoutDashboard },
    { id: 'overview', label: t('Servers'), icon: IconServer },
    { id: 'users', label: t('Users & access'), icon: IconUsers },
    { id: 'maintenance', label: t('Operations'), icon: IconSettings },
    { id: 'approvals', label: t('Approvals'), icon: IconShieldCheck },
    { id: 'audit', label: t('Activity log'), icon: IconHistory },
  ] as const;

  return <Stack component="nav" aria-label={t('Main navigation')} gap={7}>
    {nav.map(item => {
      const Icon = item.icon;
      if (item.id === 'maintenance') {
        if (compact) return <Menu key={item.id} position="right-start" offset={12} width={260}>
          <Menu.Target><button type="button" className={`nav-button ${operationsActive ? 'active' : ''}`} aria-label={t('Operations')} title={t('Operations')}>
            <span className="nav-icon"><Icon size={19} /></span>
          </button></Menu.Target>
          <Menu.Dropdown><Menu.Label>{t('Operations')}</Menu.Label>{tasks.map(task => {
            const TaskIcon = task.icon;
            const unfinished = task.id === 'scheduled' || task.id === 'processes';
            return <Menu.Item key={task.id} leftSection={<TaskIcon size={17} />} disabled={unfinished}
              aria-current={view === task.id ? 'page' : undefined}
              color={view === task.id ? 'teal' : undefined}
              rightSection={unfinished ? <Badge size="xs" color="gray" variant="light">{t('Unfinished')}</Badge> : undefined}
              onClick={() => { if (!unfinished) { setOperationsOpened(true); navigate(task.id); } }}>
              {task.label}
            </Menu.Item>;
          })}</Menu.Dropdown>
        </Menu>;
        return <div key={item.id}>
          <button type="button" className={`nav-button ${operationsActive && !operationsOpened ? 'active' : ''}`}
            aria-expanded={operationsOpened} aria-controls={submenuId} onClick={() => setOperationsOpened(opened => !opened)}>
            <span className="nav-icon"><Icon size={19} /></span><span className="nav-label">{item.label}</span>
            <IconChevronRight size={16} className={`nav-chevron ${operationsOpened ? 'opened' : ''}`} />
          </button>
          <Collapse expanded={operationsOpened} id={submenuId}>
            <Stack className="nav-children" gap={4}>{tasks.map(task => {
              const TaskIcon = task.icon;
              const unfinished = task.id === 'scheduled' || task.id === 'processes';
              return <button key={task.id} type="button" disabled={unfinished}
                className={`nav-button nav-child ${view === task.id ? 'active' : ''}`}
                aria-current={view === task.id ? 'page' : undefined}
                onClick={() => { if (!unfinished) navigate(task.id); }}>
                <span className="nav-icon"><TaskIcon size={17} /></span>
                <span className="nav-child-label">{task.label}{unfinished && <Badge size="xs" color="gray" variant="light">{t('Unfinished')}</Badge>}</span>
              </button>;
            })}</Stack>
          </Collapse>
        </div>;
      }
      const active = view === item.id || (view === 'monitor' && item.id === 'overview');
      const label = item.id === 'approvals' && pending > 0 ? `${item.label} · ${t('{0} requests awaiting approval', { 0: pending })}` : item.label;
      return <Tooltip key={item.id} label={label} position="right" disabled={!compact} events={{ hover: true, focus: true, touch: false }}>
        <button type="button" data-approval-target={item.id === 'approvals' || undefined} aria-label={label}
          aria-current={active ? 'page' : undefined} className={`nav-button ${active ? 'active' : ''}`} onClick={() => navigate(item.id)}>
          <span className="nav-icon"><Icon size={19} /></span><span className="nav-label" aria-hidden={compact}>{item.label}</span>
          {item.id === 'approvals' && pending > 0 && <Badge className="nav-badge" aria-hidden size="sm" color={active ? 'gray' : 'teal'} variant="light" circle ml="auto">{pending}</Badge>}
        </button>
      </Tooltip>;
    })}
  </Stack>;
}
