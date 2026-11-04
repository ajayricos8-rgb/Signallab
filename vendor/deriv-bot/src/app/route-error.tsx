// Fallback for a route that throws while the workspace is opening.
//
// Without this, React Router renders its default "Unexpected Application Error"
// with a raw stack trace — which is what a stale chunk looked like to the
// operator: a broken workspace. This component keeps the frame usable: it
// retries a chunk failure once automatically and offers a manual reload in every
// other case.
import React from 'react';
import { useRouteError } from 'react-router-dom';
import { isChunkLoadFailure, messageOfError, recoverFromChunkFailure } from '@/services/chunk-recovery';

const card: React.CSSProperties = {
  alignItems: 'center',
  color: 'var(--text-general, #333)',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  gap: '12px',
  inset: '0',
  justifyContent: 'center',
  padding: '24px',
  position: 'fixed',
  textAlign: 'center',
};

const title: React.CSSProperties = { fontSize: '16px', fontWeight: 700, margin: 0 };
const note: React.CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.5,
  margin: 0,
  maxWidth: '520px',
  opacity: 0.8,
};
const button: React.CSSProperties = {
  background: 'var(--brand-primary, #ff444f)',
  border: 0,
  borderRadius: '6px',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 700,
  padding: '10px 18px',
};
const details: React.CSSProperties = {
  fontSize: '11px',
  marginTop: '8px',
  maxWidth: '520px',
  opacity: 0.6,
  overflowWrap: 'anywhere',
  textAlign: 'left',
  whiteSpace: 'pre-wrap',
};

const RouteError = () => {
  const error = useRouteError();
  const chunk_failure = isChunkLoadFailure(error);

  React.useEffect(() => {
    // A chunk from the previous deployment heals itself on the next load; ask
    // for that once, and let the button below handle a real outage.
    if (chunk_failure) recoverFromChunkFailure();
  }, [chunk_failure]);

  return (
    <div style={card} role='alert' data-testid='dbot-route-error'>
      <h2 style={title}>The bot workspace could not finish loading.</h2>
      <p style={note}>
        {chunk_failure
          ? 'The workspace was updated while it was opening. Reload it to pick up the new version — your saved bots are not affected.'
          : 'Reload the workspace to try again. Your saved bots are not affected.'}
      </p>
      <button type='button' style={button} onClick={() => window.location.reload()}>
        Reload workspace
      </button>
      <details style={details}>
        <summary>Technical details</summary>
        {messageOfError(error)}
      </details>
    </div>
  );
};

export default RouteError;
