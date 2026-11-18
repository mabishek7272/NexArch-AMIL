// Nav structure ported verbatim from the approved mockup's embedded
// `class Component extends DCLogic { static ITEMS = [...] }` block, cross-checked
// against docs/NAV-REDESIGN-ROUTE-MAP.md's 13-item nav + role table. Icon names
// are lucide-react component keys (not plain strings — DCLogic used the lucide
// web-components runtime; React uses lucide-react imports instead).
import {
  LayoutDashboard, Microscope, Library, FileText, Beaker, Dna, PersonStanding,
  Activity, ShieldCheck, GitBranch, Plug, Scale, Settings, type LucideIcon,
} from 'lucide-react';

export type DashRole = 'admin' | 'operator' | 'clinician' | 'compliance' | 'auditor' | 'viewer';

export interface NavLeaf {
  label: string;
  icon: LucideIcon;
  to: string;
  /** Roles that can see this item. Matches docs/NAV-REDESIGN-ROUTE-MAP.md's Role visibility column. */
  roles: DashRole[];
  /** Not every section has a real page yet — unbuilt items render disabled, never hidden-as-if-missing. */
  status: 'live' | 'preview';
}

export interface NavGroup {
  group: string;
  items: NavLeaf[];
}

const ALL: DashRole[] = ['admin', 'operator', 'clinician', 'compliance', 'auditor', 'viewer'];

export const NEXARCH_NAV: NavGroup[] = [
  {
    group: 'Research',
    items: [
      { label: 'Overview', icon: LayoutDashboard, to: '/nexarch', roles: ALL, status: 'live' },
      { label: 'Research Studio', icon: Microscope, to: '/nexarch/research-studio', roles: ['admin', 'operator'], status: 'live' },
      { label: 'Evidence Library', icon: Library, to: '/nexarch/evidence-library', roles: ['admin', 'operator'], status: 'preview' },
      { label: 'Manuscripts', icon: FileText, to: '/nexarch/manuscripts', roles: ['admin', 'operator'], status: 'preview' },
    ],
  },
  {
    group: 'Laboratory',
    items: [
      { label: 'Dry Lab', icon: Beaker, to: '/nexarch/dry-lab', roles: ['admin', 'operator'], status: 'preview' },
      { label: 'Bioinformatics', icon: Dna, to: '/nexarch/bioinformatics', roles: ['admin', 'operator'], status: 'preview' },
      { label: 'Posture Analysis', icon: PersonStanding, to: '/nexarch/posture-analysis', roles: ['admin', 'operator', 'clinician'], status: 'preview' },
      { label: 'Monitoring', icon: Activity, to: '/nexarch/monitoring', roles: ['admin', 'operator', 'clinician'], status: 'preview' },
    ],
  },
  {
    group: 'Assurance',
    items: [
      { label: 'Validation', icon: ShieldCheck, to: '/nexarch/validation', roles: ['admin', 'clinician', 'compliance'], status: 'preview' },
      { label: 'Pipelines', icon: GitBranch, to: '/nexarch/pipelines', roles: ['admin', 'operator'], status: 'preview' },
      { label: 'AI Connections', icon: Plug, to: '/nexarch/connections', roles: ['admin', 'operator'], status: 'live' },
    ],
  },
];

export const NEXARCH_FOOT: NavLeaf[] = [
  { label: 'Governance', icon: Scale, to: '/nexarch/governance', roles: ['admin', 'auditor', 'compliance'], status: 'preview' },
  { label: 'Administration', icon: Settings, to: '/nexarch/administration', roles: ['admin'], status: 'preview' },
];

export function visibleFor(role: DashRole | undefined, items: NavLeaf[]): NavLeaf[] {
  if (!role) return [];
  return items.filter((it) => it.roles.includes(role));
}
