import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Dialog } from '../../ui';

/** An API key is shown exactly once. The dialog cannot be dismissed until the administrator says they have stored it. */
export function KeyOnceDialog({ shown, onDone }: { shown: { tenant: string; key: string } | null; onDone: () => void }) {
  const [stored, setStored] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => { setStored(false); setCopied(false); }, [shown?.key]);
  if (!shown) return null;
  return (
    <Dialog open onClose={() => {}} icon={<KeyRound size={15} aria-hidden="true" />} title={`API key for ${shown.tenant}`}
      footer={<Button variant="primary" disabled={!stored} onClick={onDone}>Done</Button>}>
      <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>This key is shown once and cannot be recovered. If it is lost, rotate it.</p>
      <p className="nx-mono" data-testid="api-key" style={{ margin: '10px 0', padding: '8px 10px', border: '1px solid var(--nx-border-strong)', borderRadius: 6, fontSize: 12, wordBreak: 'break-all', color: 'var(--nx-text)' }}>{shown.key}</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button onClick={() => { void navigator.clipboard?.writeText(shown.key).then(() => setCopied(true)).catch(() => {}); }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, font: '400 12px/1.5 Inter,sans-serif', color: 'var(--nx-text)' }}>
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} style={{ marginTop: 3 }} /> <span>I have stored this key securely.</span>
      </label>
    </Dialog>
  );
}

export function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="nx-panel" style={{ padding: 14, marginBottom: 14 }}>
      <h2 style={{ margin: 0, font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>{title}</h2>
      {note && <p style={{ margin: '4px 0 0', font: '400 11.5px/1.5 Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{note}</p>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  );
}
