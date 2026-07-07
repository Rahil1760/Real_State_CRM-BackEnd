import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Parse redis URL safely
let connectionOpts: any = {};
try {
  let normalizedUrlStr = REDIS_URL;
  if (normalizedUrlStr.startsWith('https://')) {
    console.warn('[Queue] Warning: REDIS_URL starts with https://. Replacing with rediss:// for Redis connection.');
    normalizedUrlStr = normalizedUrlStr.replace(/^https:\/\//, 'rediss://');
  }

  const url = new URL(normalizedUrlStr);
  connectionOpts = {
    host: url.hostname || 'localhost',
    port: Number(url.port) || (url.protocol === 'rediss:' ? 6379 : 6379),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    maxRetriesPerRequest: null,
  };

  if (url.protocol === 'rediss:') {
    connectionOpts.tls = {
      rejectUnauthorized: false
    };
  }
} catch (err) {
  console.error('[Queue] Error parsing REDIS_URL, falling back to localhost:', err);
  // fallback if URL parsing fails
  connectionOpts = {
    host: 'localhost',
    port: 6379,
    maxRetriesPerRequest: null,
  };
}

const queues: { [key: string]: Queue } = {};

const queueNames = [
  'qualify-lead',
  'send-whatsapp',
  'send-email',
  'send-sms',
  'follow-up',
  'score-lead',
  'lead-import',
  'pdf-ingestion',
];

export const initQueues = () => {
  queueNames.forEach((name) => {
    queues[name] = new Queue(name, { connection: connectionOpts });
    console.log(`[Queue] Queue initialized: ${name}`);
  });
};

export const getQueue = (name: string): Queue | undefined => {
  return queues[name];
};

export const getConnection = () => connectionOpts;

