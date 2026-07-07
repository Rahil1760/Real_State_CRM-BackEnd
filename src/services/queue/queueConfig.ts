import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Parse redis URL safely
let connectionOpts: any = {};
try {
  const url = new URL(REDIS_URL);
  connectionOpts = {
    host: url.hostname || 'localhost',
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null,
  };
} catch (err) {
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

