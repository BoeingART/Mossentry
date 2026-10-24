import { Fragment, useId, useState } from 'react';
import { ActionIcon, Badge, Button, Code, Paper, ScrollArea, Table, Text, VisuallyHidden } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { summarizeFirewallRule } from './firewallRuleSummary';
import { t } from './i18n';
import type { FirewallStatus } from './types';

type Rule = Extract<FirewallStatus, { available: true }>['rules'][number];

function RuleRow({ rule, busy, remove }: { rule: Rule; busy: boolean; remove: (rule: Rule) => void }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { type, ports } = summarizeFirewallRule(rule.description);
  const color = type?.endsWith('allow') ? 'teal' : type?.endsWith('deny') || type?.endsWith('reject') ? 'red' : 'gray';
  return <Fragment>
    <Table.Tr>
      <Table.Td w={44}>
        <ActionIcon className="firewall-rule-toggle" variant="subtle" color="gray" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined}
          aria-label={t(expanded ? 'Hide original rule {0}' : 'Show original rule {0}', { 0: rule.id + 1 })}
          onClick={() => setExpanded(value => !value)}><IconChevronRight size={17} aria-hidden="true" /></ActionIcon>
      </Table.Td>
      <Table.Td><Badge variant="light" color={color} tt="none">{type ?? t('Unknown')}</Badge></Table.Td>
      <Table.Td><Text size="sm" className="firewall-rule-ports">{ports === 'all' ? t('All ports') : ports ?? t('See original rule')}</Text></Table.Td>
      <Table.Td ta="right"><Button size="compact-xs" color="red" variant="subtle" disabled={busy}
        onClick={() => remove(rule)}>{t('Delete')}</Button></Table.Td>
    </Table.Tr>
    {expanded && <Table.Tr className="firewall-rule-details"><Table.Td colSpan={4} id={detailsId}>
      <Text size="xs" c="dimmed" mb="xs">{t('Original firewall rule')}</Text>
      <Code block className="firewall-original-rule">{rule.description}</Code>
    </Table.Td></Table.Tr>}
  </Fragment>;
}

export default function FirewallRules({ rules, revision, busy, remove }: {
  rules: Rule[]; revision: string; busy: boolean; remove: (rule: Rule) => void;
}) {
  return <Paper withBorder radius="md" className="firewall-rules-table"><ScrollArea>
    <Table horizontalSpacing="md" verticalSpacing="sm" miw={440}>
      <Table.Thead><Table.Tr>
        <Table.Th w={44}><VisuallyHidden>{t('Rule details')}</VisuallyHidden></Table.Th>
        <Table.Th>{t('Type')}</Table.Th><Table.Th>{t('Ports / range')}</Table.Th>
        <Table.Th ta="right">{t('Actions')}</Table.Th>
      </Table.Tr></Table.Thead>
      <Table.Tbody>{rules.length ? rules.map(rule => <RuleRow key={`${revision}:${rule.id}`} rule={rule} busy={busy} remove={remove} />)
        : <Table.Tr><Table.Td colSpan={4}><Text size="sm" c="dimmed" ta="center" py="md">{t('No saved firewall rules.')}</Text></Table.Td></Table.Tr>}</Table.Tbody>
    </Table>
  </ScrollArea></Paper>;
}
