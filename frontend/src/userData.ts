import type { User } from './types.ts';

export type UserFilter = 'enabled' | 'sudo' | 'disabled' | 'all';
export function filteredAccounts(users: User[], filter: UserFilter, host: string | null) {
  return users.filter(user => (host === 'all' || user.server === host) && (
    filter === 'all' || (filter === 'sudo' ? !!user.is_sudo : filter === 'disabled' ? !!user.is_disabled : !user.is_disabled)
  ));
}
