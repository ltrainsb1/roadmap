import { PROJECT_STATUSES, type Project, type ProjectStatus } from '@roadmap/shared';
import { Menu } from '../ui/Menu.tsx';
import { statusName } from './names.ts';

export const statusButtonId = (itemId: string) => `status-${itemId}`;

/** An item's status as a pill: a button that opens the five statuses when the person may change it, otherwise plain text. */
export function StatusMenu({ item, editable, onChange }: { item: Project; editable: boolean; onChange: (status: ProjectStatus) => void }) {
  if (!editable) return <span className="pill">{statusName(item.status)}</span>;
  return (
    <Menu
      label={`Status of ${item.title}: ${statusName(item.status)}`}
      buttonId={statusButtonId(item.id)}
      triggerClassName="pill-button"
      trigger={<span className="pill">{statusName(item.status)}</span>}
      items={PROJECT_STATUSES.map((status) => ({
        label: statusName(status),
        checked: status === item.status,
        onSelect: () => onChange(status),
      }))}
    />
  );
}
