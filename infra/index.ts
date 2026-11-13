import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { API, deployApi, type Profile } from './api';
import { DB_SERVICE, REDIS_SERVICE, deployBacking } from './backing';
import { readVault } from './vault';

// ── 1. Сховище — ПЕРШОЮ дією, до будь-якого ресурсу ─────────────────────────
// Немає змінної — програма падає тут і називає її, не дійшовши до кластера.
const vault = readVault(process.env);

// ── 2. Конфіг стеку. Типи й дефолти — у Pulumi.yaml (config:) ───────────────
const cfg = new pulumi.Config();
const kubeContext = cfg.require('kubeContext');
const namespaceName = cfg.require('namespace');
const image = cfg.require('image');
const replicas = cfg.requireNumber('replicas');
const nodePort = cfg.requireNumber('nodePort');
const rev = cfg.require('rev');
const profile = parseProfile(cfg.require('profile'));

// Postgres і Redis піднімає ця ж програма, тож адреси зі сховища мусять
// вказувати саме на них. Інакше под стартував би й годинами стукав у порожнечу.
const topology: string[] = [];
if (vault.db.host !== DB_SERVICE) topology.push(`DB_URL: хост ${vault.db.host}, а Postgres у кластері — сервіс ${DB_SERVICE}`);
if (vault.redis.host !== REDIS_SERVICE) topology.push(`REDIS_QUEUE_URL: хост ${vault.redis.host}, а Redis у кластері — сервіс ${REDIS_SERVICE}`);
if (topology.length > 0) throw new Error(`Адреси зі сховища не збігаються з кластером:\n  ${topology.join('\n  ')}`);

// ── 3. Кластер ───────────────────────────────────────────────────────────────
// Контекст явно: провайдер без нього взяв би поточний контекст kubeconfig —
// тобто той кластер, у який людина ходила останнім.
const provider = new k8s.Provider('kind', { context: kubeContext });
const opts: pulumi.CustomResourceOptions = { provider };

const ns = new k8s.core.v1.Namespace(namespaceName, { metadata: { name: namespaceName } }, opts);
const namespace = ns.metadata.name;

const backing = deployBacking({ namespace, image, vault }, opts);
const api = deployApi({ namespace, image, replicas, profile, rev, nodePort, vault, backing }, opts);

export const ns_ = namespace;
export const deployment = api.deployment.metadata.name;
export const pdb = api.pdb.metadata.name;
export const hpa = api.hpa.metadata.name;
export const url = `http://127.0.0.1:22880/v1 (NodePort ${nodePort})`;
export const activeProfile = profile;
export const revision = rev;
export const apiName = API;

function parseProfile(value: string): Profile {
  if (value === 'good' || value === 'bad') return value;
  throw new Error(`profile: '${value}', очікується good або bad`);
}
