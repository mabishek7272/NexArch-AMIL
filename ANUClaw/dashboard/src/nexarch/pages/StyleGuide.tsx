import React, { useState } from 'react';
import { Microscope, Library, FileText, Beaker, PlugZap, OctagonAlert, LibraryBig, ShieldX } from 'lucide-react';
import { Badge, Button, Input, Field, EmptyState, Dialog, Drawer, Tooltip } from '../ui';

/**
 * Components & interaction states — screen 05. Pure style-guide / design-system reference,
 * no data wiring (nothing here claims to represent real state).
 */
export default function StyleGuide() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmTyped, setConfirmTyped] = useState('');

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ margin: '0 0 16px', font: '600 16px Inter,sans-serif', color: 'var(--nx-text)' }}>Components &amp; interaction states</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>

        <Card title="NAVIGATION — SELECTED / REST / HOVER">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 180 }}>
            <div className="nx-nav-item active"><Microscope size={14} strokeWidth={1.7} />Research Studio</div>
            <div className="nx-nav-item"><Library size={14} strokeWidth={1.5} />Evidence Library</div>
            <div className="nx-nav-item" style={{ outline: '2px solid var(--nx-gold)', outlineOffset: 1 }}><FileText size={14} strokeWidth={1.5} />Manuscripts</div>
            <div className="nx-nav-item" style={{ color: 'var(--nx-text-dim)' }}><Beaker size={14} strokeWidth={1.5} />Dry Lab (preview)</div>
          </div>
        </Card>

        <Card title="BUTTONS">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Working…</Button>
          </div>
        </Card>

        <Card title="INPUTS & SELECT">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <Field label="DOI"><Input placeholder="10.xxxx/xxxxx" /></Field>
            <Field label="TITLE · FOCUSED"><Input defaultValue="Homologous recombination fidelity" autoFocus /></Field>
            <Field label="YEAR · ERROR" error="Four digits expected."><Input defaultValue="20244" error /></Field>
          </div>
        </Card>

        <Card title="BADGES — STATUS VOCABULARY">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <Badge>DRAFT</Badge>
            <Badge tone="purple">SYNTHETIC</Badge>
            <Badge>UNVERIFIED</Badge>
            <Badge tone="green">EVIDENCE LINKED</Badge>
            <Badge tone="amber">HUMAN REVIEW REQUIRED</Badge>
            <Badge tone="green">VERIFIED IDENTIFIER</Badge>
            <Badge tone="red">UNSUPPORTED CLAIM</Badge>
            <Badge tone="amber">STALE</Badge>
            <Badge tone="green">EXPORT READY</Badge>
            <Badge tone="red">PROVIDER DISCONNECTED</Badge>
            <Badge tone="blue">INFORMATION</Badge>
            <Badge tone="disabled">DISABLED</Badge>
          </div>
        </Card>

        <Card title="LOADING & UNAVAILABLE">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            <div className="nx-skel" style={{ height: 11, width: '70%' }} />
            <div className="nx-skel" style={{ height: 11, width: '92%' }} />
            <div className="nx-skel" style={{ height: 11, width: '54%' }} />
          </div>
          <div style={{ padding: '12px 14px', border: '1px solid var(--nx-border)', borderRadius: 6, background: 'var(--nx-panel)', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <PlugZap size={15} strokeWidth={1.6} color="var(--nx-text-dim)" style={{ flex: 'none', marginTop: 1 }} />
            <div><div style={{ font: '600 12px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Service unavailable</div><p style={{ margin: '3px 0 0', font: '400 11.5px/1.5 Inter,sans-serif', color: 'var(--nx-text-muted)' }}>The container runtime is not reachable. Runs stay queued; nothing is estimated or substituted.</p></div>
          </div>
          <div style={{ marginTop: 10, padding: '12px 14px', border: '1px solid var(--nx-red-border)', borderRadius: 6, background: 'var(--nx-red-bg)', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <OctagonAlert size={15} strokeWidth={1.7} color="var(--nx-red)" style={{ flex: 'none', marginTop: 1 }} />
            <div><div style={{ font: '600 12px Inter,sans-serif', color: 'var(--nx-text)' }}>Request failed — 502 from gateway</div><p style={{ margin: '3px 0 0', font: '400 11.5px/1.5 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Nothing was written. Retry is safe.</p></div>
          </div>
        </Card>

        <Card title="EMPTY STATE">
          <EmptyState
            icon={<LibraryBig size={22} strokeWidth={1.4} color="var(--nx-text-dim)" />}
            title="No sources imported yet"
            description="Import an RIS or BibTeX file, or record a source manually. Records that fail to parse are reported, never silently dropped."
            action={<><Button variant="primary">Import file</Button><Button>Add manually</Button></>}
          />
        </Card>

        <Card title="DIALOG — DESTRUCTIVE">
          <Button variant="destructive" onClick={() => setDialogOpen(true)}>Open revoke dialog</Button>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            icon={<ShieldX size={15} strokeWidth={1.7} color="var(--nx-red)" />}
            title="Revoke profile permanently?"
            footer={<><Button onClick={() => setDialogOpen(false)}>Cancel</Button><Button variant="destructive" disabled={confirmTyped !== 'Literature search'} onClick={() => setDialogOpen(false)}>Revoke</Button></>}
          >
            <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>
              Revoking <span className="nx-mono" style={{ color: 'var(--nx-text)' }}>Literature search</span> releases its session lock and prevents reconnection. This cannot be undone.
            </p>
            <div style={{ marginTop: 12 }}>
              <Field label="TYPE THE PROFILE NAME TO CONFIRM">
                <Input value={confirmTyped} onChange={(e) => setConfirmTyped(e.target.value)} placeholder="Literature search" />
              </Field>
            </div>
          </Dialog>
        </Card>

        <Card title="DRAWER & TOOLTIP">
          <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
          <div style={{ marginTop: 10 }}>
            <Tooltip label="Stale since source correction 13:58">
              <Badge tone="amber">Hover me — tooltip</Badge>
            </Tooltip>
          </div>
          {drawerOpen && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 70 }}>
              <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="PROVENANCE">
                <div style={{ font: '600 11.5px/1.4 Inter,sans-serif', color: 'var(--nx-text)' }}>Excerpt p.4 §Results</div>
                <p style={{ margin: '7px 0 0', padding: '9px 10px', borderLeft: '2px solid var(--nx-gold)', background: 'var(--nx-panel-alt)', font: '400 11px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Fidelity fell from 0.94 to 0.61…</p>
              </Drawer>
            </div>
          )}
        </Card>

      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="nx-panel" style={{ padding: 16 }}>
      <div style={{ font: "600 9.5px 'IBM Plex Mono',monospace", letterSpacing: '.16em', color: 'var(--nx-gold-dim)' }}>{title}</div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}
