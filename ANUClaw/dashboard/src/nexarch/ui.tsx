// NexArch design-system primitives (mockup screen 05: "Components & interaction states").
// Kept in one file deliberately — small, shared, no sub-variants deep enough to earn their own files.
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Visually-hidden but screen-reader-visible — for context text that should be part of an
 * element's computed accessible name without being an aria-label override (which would
 * exclude the element's other visible text from the accessible name; see axe's
 * label-content-name-mismatch / WCAG 2.5.3 Label in Name). */
export const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', whiteSpace: 'nowrap', border: 0, clip: 'rect(0,0,0,0)',
};

/** Shared responsive breakpoint hook — same pattern ResearchStudioPage.tsx used inline,
 * extracted so NexArchShell's outer-sidebar collapse and any other narrow-layout logic
 * stay in sync with a single source of truth instead of independently-tuned breakpoints. */
export function useNarrow(breakpoint = 1180): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return narrow;
}

export type BadgeTone = 'neutral' | 'gold' | 'green' | 'amber' | 'red' | 'purple' | 'blue' | 'disabled';

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: '', gold: 'nx-badge-gold', green: 'nx-badge-green', amber: 'nx-badge-amber',
  red: 'nx-badge-red', purple: 'nx-badge-purple', blue: 'nx-badge-blue', disabled: 'nx-badge-disabled',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={`nx-badge ${BADGE_TONE_CLASS[tone]}`}>{children}</span>;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export function Button({
  variant = 'secondary', icon, loading, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: React.ReactNode; loading?: boolean }) {
  const cls = variant === 'primary' ? 'nx-btn-primary' : variant === 'ghost' ? 'nx-btn-ghost' : variant === 'destructive' ? 'nx-btn-destructive' : '';
  return (
    <button className={`nx-btn ${cls}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 11, height: 11, borderRadius: '50%',
        border: '1.6px solid var(--nx-border-strong)', borderTopColor: 'var(--nx-gold)',
        display: 'inline-block', animation: 'nx-spin .7s linear infinite',
      }}
    />
  );
}

export function Input({ error, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return <input className={`nx-input ${error ? 'nx-input-error' : ''}`} {...rest} />;
}

export function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  // Programmatically associates the visible caption with its control (real <label htmlFor>,
  // not just a styled div next to it) — the control is the single child passed in, cloned
  // with the generated id/aria-describedby rather than requiring every caller to wire it up.
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, { id, 'aria-describedby': errorId })
    : children;
  return (
    <div>
      <label htmlFor={id} className="nx-label">{label}</label>
      <div style={{ marginTop: 5 }}>{control}</div>
      {error && <div id={errorId} style={{ marginTop: 4, font: '400 11px Inter,sans-serif', color: 'var(--nx-red)' }}>{error}</div>}
    </div>
  );
}

export function EmptyState({
  icon, title, description, action,
}: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="nx-empty">
      {icon}
      <div style={{ marginTop: 11, font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>{title}</div>
      <p style={{ margin: '6px 0 0', maxWidth: 320, font: '400 11.5px/1.55 Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{description}</p>
      {action && <div style={{ marginTop: 13, display: 'flex', gap: 8 }}>{action}</div>}
    </div>
  );
}

/** Honest "not available yet" panel — used wherever the backend gap table in
 * docs/NAV-REDESIGN-ROUTE-MAP.md says the data this card would show doesn't exist.
 * Never render a plausible-looking number in its place.
 *
 * User-facing copy is deliberately short (one title, one sentence, one optional safe
 * action) — no doc paths, route names or implementation detail. That detail, if worth
 * keeping, goes in `technicalDetail`, shown only behind a collapsed native <details>
 * disclosure so a developer can still find it without it cluttering the card for
 * everyone else. */
export function NotAvailableYet({
  title, description, action, technicalDetail,
}: { title: string; description: string; action?: React.ReactNode; technicalDetail?: string }) {
  return (
    <div className="nx-panel" style={{ padding: '12px 14px' }}>
      <div style={{ font: '600 12px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{title}</div>
      <p style={{ margin: '4px 0 0', font: '400 11.5px/1.5 Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{description}</p>
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
      {technicalDetail && (
        <details style={{ marginTop: 10 }}>
          <summary className="nx-mono" style={{ cursor: 'pointer', fontSize: 10.5, letterSpacing: '.08em', color: 'var(--nx-text-dim)' }}>
            TECHNICAL DETAILS
          </summary>
          <p className="nx-mono" style={{ margin: '6px 0 0', fontSize: 11, lineHeight: 1.6, color: 'var(--nx-text-dim)' }}>{technicalDetail}</p>
        </details>
      )}
    </div>
  );
}

export function Dialog({
  open, onClose, icon, title, children, footer,
}: { open: boolean; onClose: () => void; icon?: React.ReactNode; title: string; children: React.ReactNode; footer: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="nx-dialog-backdrop" onClick={onClose}>
      <div className="nx-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--nx-border)', display: 'flex', alignItems: 'center', gap: 9 }}>
          {icon}
          <span style={{ font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>{title}</span>
        </div>
        <div style={{ padding: '14px 16px' }}>{children}</div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--nx-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>
      </div>
    </div>
  );
}

/** Destructive confirm — requires typing the exact name back, matching the mockup's
 * "revoke profile permanently" dialog pattern. */
export function DestructiveConfirmDialog({
  open, onClose, onConfirm, resourceLabel, description,
}: { open: boolean; onClose: () => void; onConfirm: () => void; resourceLabel: string; description: string }) {
  const [typed, setTyped] = useState('');
  if (!open) return null;
  const match = typed.trim() === resourceLabel;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Revoke ${resourceLabel} permanently?`}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!match} onClick={() => { onConfirm(); setTyped(''); }}>Revoke</Button>
        </>
      )}
    >
      <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{description}</p>
      <div style={{ marginTop: 12 }}>
        <Field label="TYPE THE NAME TO CONFIRM">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={resourceLabel} />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Accessible overlay drawer. Portaled to document.body (not rendered in place) so it can
 * sit outside #root and make the rest of the app `inert` while open, rather than merely
 * drawing a visual scrim over it. Handles, generically, so every caller gets this for free:
 *  - Escape closes it
 *  - focus moves to the close button the instant it opens
 *  - Tab/Shift+Tab are trapped inside the drawer while open
 *  - closing it (Escape, close button or backdrop) returns focus to `returnFocusRef`'s
 *    current element if the caller passed one, else to whatever had focus when it opened
 *  - the background (#root) is aria-hidden + inert while open
 * The close control is a real <button> with an aria-label, not a bare icon.
 */
export function Drawer({
  open, onClose, title, children, returnFocusRef,
}: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode;
  /** Optional: the element focus should return to on close. If omitted, falls back to
   * document.activeElement captured at the moment the drawer opened. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const capturedFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    capturedFocusRef.current = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    root?.setAttribute('aria-hidden', 'true');
    const toFocus = closeBtnRef.current;
    toFocus?.focus();
    return () => {
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
      const restoreTo = returnFocusRef?.current ?? capturedFocusRef.current;
      restoreTo?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const node = drawerRef.current;
        if (!node) return;
        const focusables = Array.from(
          node.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    // The portal renders this subtree as a sibling of .nx-root (outside it in the DOM), so the
    // --nx-* custom properties defined only on .nx-root would not otherwise cascade here — without
    // this wrapper every nx-* color resolves to transparent/unset (confirmed: computed
    // background-color was rgba(0,0,0,0)). `display: contents` re-establishes the token scope
    // without adding a layout box or changing anything visually beyond fixing that.
    <div className="nx-root" style={{ display: 'contents' }}>
      <div className="nx-drawer-scrim" onClick={onClose} />
      <aside
        ref={drawerRef as React.RefObject<HTMLElement>}
        className="nx-drawer"
        style={{ width: 352 }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--nx-hairline)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="nx-label">{title}</span>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            style={{ background: 'none', border: 'none', padding: 4, display: 'flex', cursor: 'pointer' }}
          >
            <X size={15} strokeWidth={1.8} color="var(--nx-text-muted)" />
          </button>
        </div>
        <div className="nx-scroll" style={{ padding: '14px 16px', overflowY: 'auto', flex: 1 }}>{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return <span data-nx-tooltip={label} style={{ position: 'relative' }}>{children}</span>;
}

/** Per-page badge strip (Programme/Env/Evidence/Review/Provider, or whatever that page's
 * mockup screen shows) — rendered by each page itself since the badge set differs per screen. */
export function WorkspaceBar({ title, badges }: { title?: React.ReactNode; badges: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Workspace status"
      style={{ display: 'flex', alignItems: 'center', height: 44, padding: '0 20px', borderBottom: '1px solid var(--nx-border)', background: 'var(--nx-panel)', overflowX: 'auto', whiteSpace: 'nowrap' }}>
      {title}
      {badges.map((b) => (
        <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderRight: '1px solid var(--nx-border)' }}>
          <span className="nx-label">{b.label}</span>
          {b.value}
        </div>
      ))}
    </div>
  );
}
