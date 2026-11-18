import React, { useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Search, Menu } from 'lucide-react';
import './theme.css';
import { NEXARCH_NAV, NEXARCH_FOOT, visibleFor, type NavLeaf } from './nav';
import { useCurrentUser } from './useCurrentUser';
import { Badge, Drawer, useNarrow } from './ui';

/**
 * NexArch Lab shell — the feature-flagged redesign, mounted only under /nexarch/*.
 * Lives entirely beside the existing teal Shell in App.tsx; nothing here is reachable
 * unless a user navigates to /nexarch, and nothing in the existing NAV/Shell changed.
 * See docs/NAV-REDESIGN-ROUTE-MAP.md for the nav structure this follows.
 *
 * Responsive: below 1180px (the same breakpoint ResearchStudioPage.tsx uses for its own
 * narrow layout, via the shared `useNarrow` hook) the permanent 234px sidebar is replaced
 * by a menu button in the topbar that opens the identical nav content in an overlay Drawer.
 * The nav item list/role-filtering/preview-badge logic lives in one place (`NavContent`,
 * `NavItem`) and is shared between the two renderings so they cannot drift apart.
 */
export default function NexArchShell() {
  const { user } = useCurrentUser();
  const location = useLocation();
  const narrow = useNarrow(1180);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);

  const logo = (
    <div style={{ padding: '16px 18px 15px', borderBottom: '1px solid var(--nx-hairline)', display: 'flex', alignItems: 'center', gap: 11 }}>
      <div
        aria-hidden
        style={{
          width: 26, height: 35, flex: 'none',
          background: "url('/nexarch/emblem.png') -20px -9px/64px 64px no-repeat",
          filter: 'brightness(1.8) contrast(1.06) saturate(1.1)',
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ font: '600 14px/1.15 Inter,sans-serif', color: 'var(--nx-text)' }}>NexArch Lab</div>
        <div style={{ marginTop: 3, font: "500 8.5px/1.2 'IBM Plex Mono',monospace", letterSpacing: '.16em', color: 'var(--nx-gold-dim)', textTransform: 'uppercase' }}>
          Applied Minds<br />Intelligence Lab
        </div>
      </div>
    </div>
  );

  const navBody = (
    <NavContent
      role={user?.role}
      pathname={location.pathname}
      onNavigate={narrow ? () => setMenuOpen(false) : undefined}
    />
  );

  return (
    <div className="nx-root" style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {!narrow && (
        <nav aria-label="Primary" style={{ width: 234, flex: 'none', background: 'var(--nx-panel)', borderRight: '1px solid var(--nx-border)', display: 'flex', flexDirection: 'column' }}>
          {logo}
          {navBody}
        </nav>
      )}

      {narrow && (
        <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Navigation" returnFocusRef={menuBtnRef}>
          <nav aria-label="Primary" style={{ margin: '-14px -16px' }}>
            {logo}
            {navBody}
          </nav>
        </Drawer>
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ height: 44, flex: 'none', background: 'var(--nx-panel)', borderBottom: '1px solid var(--nx-border)', display: 'flex', alignItems: 'center', padding: '0 18px', whiteSpace: 'nowrap' }}>
          {narrow && (
            <button
              ref={menuBtnRef}
              type="button"
              aria-label="Open navigation"
              onClick={() => setMenuOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 12, padding: '6px 8px', border: '1px solid var(--nx-border)', borderRadius: 5, background: 'var(--nx-panel-alt)', color: 'var(--nx-text-soft)', cursor: 'pointer' }}
            >
              <Menu size={15} strokeWidth={1.8} />
            </button>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', border: '1px solid var(--nx-border)', borderRadius: 5, font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--nx-text-muted)' }}>
            <Search size={12} strokeWidth={1.6} />⌘K
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 24, height: 24, borderRadius: 4, border: '1px solid var(--nx-border-strong)', background: 'var(--nx-active)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "600 10px 'IBM Plex Mono',monospace", color: 'var(--nx-gold)' }}>
              {(user?.name ?? 'U').slice(0, 2).toUpperCase()}
            </span>
            <span style={{ font: '500 12px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{user?.name ?? 'Signed in'}</span>
          </div>
        </header>

        <main className="nx-scroll" style={{ flex: 1, overflowY: 'auto', background: 'var(--nx-bg)' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Shared nav body (groups + footer), rendered identically inside the permanent desktop
 * `<nav>` and inside the narrow-layout overlay Drawer — one implementation, one source of
 * truth for role filtering and preview-item behavior, so the two can't drift apart. */
function NavContent({ role, pathname, onNavigate }: { role: string | undefined; pathname: string; onNavigate?: () => void }) {
  return (
    <>
      <div className="nx-scroll" style={{ flex: 1, padding: '10px 10px 0', overflowY: 'auto' }}>
        {NEXARCH_NAV.map((section) => {
          const items = visibleFor(role as any, section.items);
          if (items.length === 0) return null;
          return (
            <div key={section.group}>
              <div className="nx-nav-group">{section.group}</div>
              {items.map((item) => (
                <NavItem
                  key={item.label}
                  item={item}
                  active={pathname === item.to || (item.to !== '/nexarch' && pathname.startsWith(item.to))}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ padding: '10px 10px 12px', borderTop: '1px solid var(--nx-hairline)' }}>
        {visibleFor(role as any, NEXARCH_FOOT).map((item) => (
          <NavItem key={item.label} item={item} active={pathname.startsWith(item.to)} onNavigate={onNavigate} />
        ))}
        <div style={{ marginTop: 8, padding: '9px 11px', border: '1px solid var(--nx-border)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="nx-label">PREVIEW</span>
          <NavLink to="/" className="nx-mono" style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--nx-text-muted)', textDecoration: 'none' }}>
            EXIT TO ANUCLAW →
          </NavLink>
        </div>
      </div>
    </>
  );
}

/**
 * `status: 'preview'` items are a preview-build-only allowance: visible so reviewers can
 * see the target 13-item structure, but deliberately not a real link anywhere. They carry
 * a persistent "Preview" badge (not just a hover tooltip, so keyboard/screen-reader users
 * get the same signal as sighted mouse users) and are `aria-disabled` rather than removed
 * from the tab order, so they're discoverable but never actually navigate.
 *
 * No aria-label override: the accessible name is computed from this element's own visible
 * content (icon + label + the "PREVIEW" badge text), which is what axe's
 * label-content-name-mismatch / WCAG 2.5.3 Label in Name require — an override here would
 * exclude the badge's visible text from the accessible name. Dimming is done with an
 * explicit (contrast-checked) text color, not CSS `opacity`, because `opacity` also
 * multiplies the *rendered* contrast ratio against the background and was previously
 * failing WCAG AA once blended.
 *
 * Production migration must NOT ship this pattern: unbuilt sections must instead be hidden
 * entirely by role/capability (per docs/NAV-REDESIGN-ROUTE-MAP.md) or routed to a real,
 * honest "not yet available" landing page — not left as a permanently-disabled nav item.
 */
function NavItem({ item, active, onNavigate }: { item: NavLeaf; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  if (item.status === 'preview') {
    return (
      <div
        className="nx-nav-item"
        style={{ color: 'var(--nx-text-dim)', cursor: 'default', justifyContent: 'space-between' }}
        role="link"
        aria-disabled="true"
        tabIndex={0}
        data-nx-tooltip="Preview — route not built yet"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <Icon size={15} strokeWidth={1.5} />
          {item.label}
        </span>
        <Badge tone="disabled">PREVIEW</Badge>
      </div>
    );
  }
  return (
    <NavLink to={item.to} end={item.to === '/nexarch'} className={`nx-nav-item${active ? ' active' : ''}`} onClick={onNavigate}>
      <Icon size={15} strokeWidth={active ? 1.7 : 1.5} />
      {item.label}
    </NavLink>
  );
}
