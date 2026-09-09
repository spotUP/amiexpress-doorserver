/** Card-per-integration management: toggles, keys, settings, Test. */
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { PlugZap } from 'lucide-react';
import {
  useIntegrations, useIntegrationHealth, useIntegrationToggle,
  useIntegrationSettings, useIntegrationCreate, useIntegrationDelete,
  useSecretStore, useSecretDelete, useIntegrationTest,
  useDemozooImportCard, useReleasesCard,
  type IntegrationSource,
} from '../api/queries';
import { Button, Input, Textarea } from '../components/ui';

function HealthDot({ id, health }: { id: string; health?: { ok: boolean; latencyMs: number; detail?: string } }) {
  if (!health) return <span className="text-muted" title="no health yet">○</span>;
  const color = health.ok ? 'text-ok' : 'text-danger';
  const title = health.ok ? `${health.latencyMs} ms` : (health.detail ?? 'down');
  return <span className={color} title={`${id}: ${title}`}>●</span>;
}

function SourceCard({ source, health }: {
  source: IntegrationSource;
  health?: { ok: boolean; latencyMs: number; detail?: string };
}) {
  const toggle = useIntegrationToggle();
  const settings = useIntegrationSettings();
  const secrets = useSecretStore();
  const unsecret = useSecretDelete();
  const test = useIntegrationTest();
  const [key, setKey] = useState('');
  const [ttl, setTtl] = useState(
    typeof source.settings.ttlSeconds === 'number' ? String(source.settings.ttlSeconds) : ''
  );
  const [stationUrl, setStationUrl] = useState(
    typeof source.settings.stationUrl === 'string' ? source.settings.stationUrl : ''
  );
  const [query, setQuery] = useState('demo');
  const busy = toggle.isPending || settings.isPending || secrets.isPending;

  const saveTtl = () => {
    const n = Number(ttl);
    if (!Number.isFinite(n)) return;
    settings.mutate({ id: source.id, settings: { ...source.settings, ttlSeconds: n } });
  };
  const saveStation = () => {
    settings.mutate({ id: source.id, settings: { ...source.settings, stationUrl } });
  };

  return (
    <li className="rounded-md border border-line bg-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          <HealthDot id={source.id} health={health} /> {source.name}
        </span>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={source.enabled}
            disabled={busy}
            onChange={(e) => toggle.mutate({ id: source.id, enabled: e.target.checked })}
          />
          {source.enabled ? 'on' : 'off'}
        </label>
      </div>
      {health && !health.ok && (
        <p className="mt-1 text-xs text-danger">{health.detail ?? 'down'}</p>
      )}
      {source.errors && source.errors.length > 0 && (
        <p className="mt-1 text-xs text-danger">{source.errors[0]}</p>
      )}
      {source.needsKey && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="password"
            placeholder={source.secretNames.length ? 'saved ●●● - paste to rotate' : 'paste API key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="font-mono text-xs"
            autoComplete="off"
          />
          <Button
            variant="default"
            disabled={busy || !key}
            onClick={() => { secrets.mutate({ id: source.id, secret: key }); setKey(''); }}
          >
            Save
          </Button>
          {source.secretNames.map((name) => (
            <Button
              key={name}
              variant="ghost"
              title={`forget ${name}`}
              onClick={() => unsecret.mutate({ id: source.id, keyName: name })}
            >
              forget {name} ×
            </Button>
          ))}
        </div>
      )}
      {source.id === 'radio' && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            placeholder="status-json.xsl URL"
            value={stationUrl}
            onChange={(e) => setStationUrl(e.target.value)}
            className="font-mono text-xs"
          />
          <Button variant="default" disabled={busy} onClick={saveStation}>Save</Button>
        </div>
      )}
      {!source.builtin && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            placeholder="cache TTL seconds"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            className="w-32 font-mono text-xs"
          />
          <Button variant="default" disabled={busy} onClick={saveTtl}>Save</Button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Input
          placeholder="canned query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="font-mono text-xs"
        />
        <Button
          variant="default"
          disabled={test.isPending}
          onClick={() => test.mutate({ id: source.id, q: query || 'demo' })}
        >
          Test
        </Button>
      </div>
      {test.data && (
        <div className="mt-2 rounded border border-line bg-surface px-2 py-1 text-xs">
          {test.data.error && <p className="text-danger">{test.data.error}</p>}
          {(test.data.mapped ?? []).slice(0, 3).map((m, i) => (
            <p key={i} className="truncate">
              <span className="text-accent">{m.title}</span>
              <span className="text-muted"> - {m.detail}</span>
            </p>
          ))}
          {test.data.raw !== undefined && (
            <details className="mt-1">
              <summary className="cursor-pointer text-muted">raw JSON</summary>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                {JSON.stringify(test.data.raw, null, 1).slice(0, 2000)}
              </pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

function AddSourceForm({ onDone }: { onDone: () => void }) {
  const create = useIntegrationCreate();
  const remove = useIntegrationDelete();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authMode, setAuthMode] = useState('none');
  const [endpoints, setEndpoints] = useState(
    '{"search":{"path":"/search","params":{"q":"{q}"},"items":"results","title":"title","detail":"overview","url":"link"}}'
  );
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(endpoints);
    } catch {
      setError('endpoints is not JSON');
      return;
    }
    create.mutate(
      { name, baseUrl, authMode, endpoints: parsed },
      {
        onSuccess: (data: unknown) => {
          const id = (data as { source?: { source?: string } })?.source?.source;
          if (id) setCreatedId(id);
          onDone();
        },
        onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      }
    );
  };

  return (
    <div className="rounded-md border border-line bg-bg px-3 py-2">
      <p className="font-medium">Add an API (generic JSON-REST, GET only)</p>
      <div className="mt-2 grid gap-2">
        <Input placeholder="name (a-z, 0-9, -)" value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" />
        <Input placeholder="https:// base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-xs" />
        <div className="flex gap-2 text-xs">
          {(['none', 'query', 'bearer', 'header'] as const).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" checked={authMode === m} onChange={() => setAuthMode(m)} /> {m}
            </label>
          ))}
        </div>
        <Textarea
          rows={4}
          value={endpoints}
          onChange={(e) => setEndpoints(e.target.value)}
          className="font-mono text-xs"
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button variant="primary" disabled={create.isPending} onClick={submit}>Add</Button>
          {createdId && (
            <Button variant="danger" onClick={() => { remove.mutate(createdId); setCreatedId(null); }}>
              Delete {createdId}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function IntegrationsPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const { data } = useIntegrations(enabled && open);
  const health = useIntegrationHealth(enabled && open);
  const demozoo = useDemozooImportCard(enabled && open);
  const releases = useReleasesCard(enabled && open);
  const healthById = new Map((health.data?.sources ?? []).map((h) => [h.id, h]));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(38rem,96vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <div className="border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">Chat integrations</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              External scene APIs the operator chats answer from. Keys never leave the server.
            </Dialog.Description>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
            <ul className="space-y-2">
              {(data?.sources ?? []).map((s) => (
                <SourceCard key={s.id} source={s} health={healthById.get(s.id)} />
              ))}
            </ul>
            <AddSourceForm onDone={() => undefined} />
            <div className="rounded-md border border-line bg-bg px-3 py-2">
              <p className="font-medium">Demozoo enrichment (offline import)</p>
              <p className="mt-1 text-xs text-muted">
                {demozoo.data
                  ? `${demozoo.data.processed} processed, ${demozoo.data.rowsEnriched} rows enriched`
                  : 'loading...'}
              </p>
              {demozoo.data && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-muted">
                  {demozoo.data.rerun}
                </pre>
              )}
            </div>
            <div className="rounded-md border border-line bg-bg px-3 py-2">
              <p className="font-medium">Releases listing (health signals)</p>
              <p className="mt-1 text-xs text-muted">
                {releases.data
                  ? `revision ${releases.data.revision}, ${releases.data.rows} rows`
                  : releases.isError ? 'surface not configured' : 'loading...'}
              </p>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function IntegrationsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} className="hidden sm:inline-flex">
      <PlugZap size={14} /> Integrations
    </Button>
  );
}
