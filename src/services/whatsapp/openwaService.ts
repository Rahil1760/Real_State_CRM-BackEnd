import OpenWASession from '../../models/OpenWASession';
import Tenant from '../../models/Tenant';
import { formatWhatsAppNumber } from './whatsappService';
import { getIO } from '../socket/socketService';
import Lead from '../../models/Lead';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';

// In-memory registry of active OpenWA session states
const activeSessions: Map<
  string,
  {
    tenantId: string;
    sessionId: string;
    status: 'disconnected' | 'pending_scan' | 'connected' | 'expired';
    qrCode: string;
    lastSeen: Date;
  }
> = new Map();

// Active Baileys sockets per tenant
const socketsMap = new Map<string, any>();

// Connection promises guard to prevent duplicate concurrent socket creations
const connectingPromises = new Map<string, Promise<any>>();

// QR Code promise resolvers for REST endpoint sync
const pendingQRResolvers = new Map<string, Array<(qr: string) => void>>();

/**
 * Initialize or return a Baileys socket session for a given tenant.
 * Uses latest WhatsApp Web protocol, Ubuntu Chrome browser string, and cached signal key store.
 */
export const initBaileysSession = async (tenantId: string, forceFresh: boolean = false): Promise<any> => {
  if (connectingPromises.has(tenantId) && !forceFresh) {
    console.log(`[Baileys Guard] Reusing in-flight connection promise for tenant: ${tenantId}`);
    return connectingPromises.get(tenantId);
  }

  const promise = (async () => {
    try {
      if (forceFresh && socketsMap.has(tenantId)) {
        console.log(`[Baileys Session Init] Force fresh requested. Closing active socket for tenant: ${tenantId}`);
        const existingSock = socketsMap.get(tenantId);
        try {
          existingSock.ev.removeAllListeners('connection.update');
          existingSock.ev.removeAllListeners('creds.update');
          existingSock.end(undefined);
        } catch (e) {}
        socketsMap.delete(tenantId);
      }

      console.log(`[Baileys Session Init] Starting socket initialization for tenant: ${tenantId}...`);
      const authDir = path.join(__dirname, `../../../baileys_auth/tenant_${tenantId}`);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const logger = pino({ level: 'silent' });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      
      const versionInfo = await fetchLatestBaileysVersion().catch((e: any) => {
        console.warn('[Baileys Version Fetch Warning]:', e.message);
        return { version: [2, 3000, 1015901307] as any, isLatest: false };
      });
      console.log(`[Baileys Version Selected] Version: ${versionInfo.version.join('.')}, isLatest: ${versionInfo.isLatest}`);

      const sock = makeWASocket({
        version: versionInfo.version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        printQRInTerminal: true,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        generateHighQualityLinkPreview: true,
      });

      socketsMap.set(tenantId, sock);

      sock.ev.on('creds.update', async () => {
        console.log(`[Baileys creds.update] Authentication state updated & credentials saved for tenant: ${tenantId}`);
        await saveCreds();
      });

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
        
        console.log(`[Baileys connection.update Payload] Tenant: ${tenantId}:`, JSON.stringify({
          connection: connection || 'unchanged',
          qrPresent: Boolean(qr),
          receivedPendingNotifications: Boolean(receivedPendingNotifications),
          lastDisconnect: lastDisconnect ? {
            error: (lastDisconnect.error as any)?.message || lastDisconnect.error,
            statusCode: (lastDisconnect.error as any)?.output?.statusCode,
            stack: (lastDisconnect.error as any)?.stack,
          } : undefined,
        }, null, 2));

        if (qr) {
          console.log(`[Baileys QR Generated] Tenant ${tenantId} -> Raw QR Challenge: "${qr.substring(0, 30)}..."`);
          const realQrDataURL = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });

          activeSessions.set(tenantId, {
            tenantId,
            sessionId: `openwa_baileys_${tenantId}`,
            status: 'pending_scan',
            qrCode: realQrDataURL,
            lastSeen: new Date(),
          });

          await OpenWASession.findOneAndUpdate(
            { tenantId },
            {
              $set: {
                sessionId: `openwa_baileys_${tenantId}`,
                qrCode: realQrDataURL,
                status: 'pending_scan',
                lastSeen: new Date(),
              },
            },
            { upsert: true }
          );

          // Resolve pending REST createSession promises
          const resolvers = pendingQRResolvers.get(tenantId);
          if (resolvers && resolvers.length > 0) {
            resolvers.forEach((resolve) => resolve(realQrDataURL));
            pendingQRResolvers.delete(tenantId);
          }

          // Emit QR to frontend via Socket.IO
          const io = getIO();
          if (io) {
            console.log(`[Baileys QR Delivery] Emitting openwa:status to /crm socket for tenant: ${tenantId}`);
            io.to('/crm').emit('openwa:status', { tenantId, status: 'pending_scan', qrCode: realQrDataURL });
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const errorMsg = (lastDisconnect?.error as any)?.message || (lastDisconnect?.error as any)?.toString() || 'Unknown disconnect error';
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          
          console.error(`[Baileys Connection Closed Details] Tenant: ${tenantId} -> StatusCode: ${statusCode}, Reason/Error: "${errorMsg}"`);

          if (isLoggedOut || statusCode === 401 || statusCode === 408) {
            console.log(`[Baileys Session Invalidation] Invalidation code ${statusCode} detected. Purging auth files for tenant: ${tenantId}`);
            await logoutOpenWA(tenantId);
          } else if (statusCode === 515) {
            console.log(`[Baileys Restart Required] Status 515 received. Re-initializing session for tenant: ${tenantId}...`);
            setTimeout(() => initBaileysSession(tenantId, false), 2000);
          } else {
            console.log(`[Baileys Transient Reconnect] Tenant: ${tenantId} reconnecting in 3 seconds...`);
            setTimeout(() => initBaileysSession(tenantId, false), 3000);
          }

          const io = getIO();
          if (io) {
            io.to('/crm').emit('openwa:status', { tenantId, status: 'disconnected', reason: errorMsg });
          }
        } else if (connection === 'open') {
          const rawId = sock.user?.id || '';
          const phoneNum = rawId ? rawId.split(':')[0].split('@')[0] : 'WhatsApp Device';
          console.log(`[Baileys Connection Open] Tenant ${tenantId} SUCCESSFULLY LINKED & AUTHENTICATED! Phone: ${phoneNum}`);

          const phoneInfo = { wid: `${phoneNum}@c.us`, pushname: sock.user?.name || 'Linked WhatsApp Device' };

          activeSessions.set(tenantId, {
            tenantId,
            sessionId: `openwa_baileys_${tenantId}`,
            status: 'connected',
            qrCode: '',
            lastSeen: new Date(),
          });

          await OpenWASession.findOneAndUpdate(
            { tenantId },
            {
              $set: {
                status: 'connected',
                lastSeen: new Date(),
                phoneInfo,
                qrCode: '',
              },
            },
            { upsert: true }
          );

          await Tenant.findByIdAndUpdate(tenantId, {
            whatsappProvider: 'openwa',
            'openwaConfig.isConnected': true,
            'openwaConfig.qrCode': '',
            'openwaConfig.lastSeen': new Date(),
          });

          const io = getIO();
          if (io) {
            io.to('/crm').emit('openwa:status', { tenantId, status: 'connected', phoneInfo, qrCode: '' });
          }
        }
      });

      // Inbound message listener
      sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type === 'notify') {
          for (const msg of m.messages) {
            if (!msg.key.fromMe && msg.message) {
              const fromJid = msg.key.remoteJid || '';
              const participantJid = msg.key.participant || (msg.key as any).remoteJidAlt || '';

              // Ignore group messages and broadcast status updates
              if (fromJid.endsWith('@g.us') || fromJid.includes('broadcast') || fromJid.includes('status')) {
                continue;
              }

              // Determine primary phone/LID JID
              const primaryJid = fromJid.endsWith('@s.whatsapp.net')
                ? fromJid
                : (participantJid.endsWith('@s.whatsapp.net') ? participantJid : fromJid);

              const rawPhone = primaryJid.split('@')[0].split(':')[0];
              const cleanPhone = formatWhatsAppNumber(rawPhone);
              const text =
                // Plain text messages
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                // Ephemeral (disappearing) messages
                msg.message.ephemeralMessage?.message?.conversation ||
                msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
                // Button responses (legacy)
                msg.message.buttonsResponseMessage?.selectedButtonId ||
                msg.message.buttonsResponseMessage?.selectedDisplayText ||
                // List responses
                msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
                msg.message.listResponseMessage?.title ||
                // Template reply buttons — fired when lead taps a button on a template message
                msg.message.templateButtonReplyMessage?.selectedId ||
                msg.message.templateButtonReplyMessage?.selectedDisplayText ||
                // Interactive messages (newer Baileys / WhatsApp Business API)
                msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
                msg.message.interactiveResponseMessage?.body?.text ||
                // Media captions
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                '';
              const pushName = msg.pushName || 'WhatsApp User';

              if (text && (cleanPhone || primaryJid)) {
                console.log(`[Baileys Inbound Message] Tenant ${tenantId} -> JID: ${primaryJid}, Phone: ${cleanPhone}, PushName: "${pushName}", Text: "${text}"`);
                await processNormalizedInboundMessage({
                  tenantId,
                  leadPhone: cleanPhone || rawPhone,
                  rawJid: primaryJid,
                  leadName: pushName,
                  message: text,
                  timestamp: new Date(Number(msg.messageTimestamp) * 1000 || Date.now()),
                  source: 'openwa',
                });
              }
            }
          }
        }
      });

      return sock;
    } catch (err: any) {
      console.error(`[Baileys Session Init Critical Error] Tenant ${tenantId}:`, err.stack || err.message);
    } finally {
      connectingPromises.delete(tenantId);
    }
  })();

  connectingPromises.set(tenantId, promise);
  return promise;
};

/**
 * Creates a fresh OpenWA session, purging old auth credentials and returning real Baileys QR code.
 */
export const createOpenWASession = async (tenantId: string): Promise<any> => {
  const sessionId = `openwa_sess_${tenantId}_${Date.now()}`;
  console.log(`[OpenWA Service] Creating fresh session for tenant: ${tenantId}...`);

  // 1. Close existing socket cleanly
  if (socketsMap.has(tenantId)) {
    const oldSock = socketsMap.get(tenantId);
    try {
      oldSock.ev.removeAllListeners('connection.update');
      oldSock.ev.removeAllListeners('creds.update');
      oldSock.end(undefined);
    } catch (e) {}
    socketsMap.delete(tenantId);
  }

  // 2. Clear stale auth directory
  const authDir = path.join(__dirname, `../../../baileys_auth/tenant_${tenantId}`);
  if (fs.existsSync(authDir)) {
    try {
      console.log(`[OpenWA Auth Cleanup] Purging stale auth directory: ${authDir}`);
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (e) {
      console.error('[OpenWA Auth Cleanup Error]:', e);
    }
  }

  // 3. Reset session state in DB
  await OpenWASession.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        sessionId,
        qrCode: '',
        status: 'pending_scan',
        lastSeen: new Date(),
      },
    },
    { upsert: true }
  );

  activeSessions.set(tenantId, {
    tenantId,
    sessionId,
    status: 'pending_scan',
    qrCode: '',
    lastSeen: new Date(),
  });

  await Tenant.findByIdAndUpdate(tenantId, {
    whatsappProvider: 'openwa',
    'openwaConfig.sessionId': sessionId,
    'openwaConfig.qrCode': '',
    'openwaConfig.isConnected': false,
    'openwaConfig.lastSeen': new Date(),
  });

  // 4. Create promise to wait for real Baileys QR code (up to 10 seconds)
  const qrPromise = new Promise<string>((resolve: any) => {
    if (!pendingQRResolvers.has(tenantId)) {
      pendingQRResolvers.set(tenantId, []);
    }
    pendingQRResolvers.get(tenantId)!.push(resolve);

    setTimeout(() => {
      resolve('');
    }, 10000);
  });

  // 5. Trigger Baileys session handshake
  initBaileysSession(tenantId, true).catch((e) => console.error('[Baileys Init Trigger Error]:', e.message));

  // 6. Await real Baileys QR code
  const realQrCode = await qrPromise;

  return {
    sessionId,
    qrCode: realQrCode,
    status: 'pending_scan',
  };
};

/**
 * Requests an 8-digit WhatsApp Pairing Code for phone number linking (alternative to QR code scan).
 */
export const requestOpenWAPairingCode = async (tenantId: string, phoneNum: string): Promise<string> => {
  const cleanPhone = phoneNum.replace(/[^0-9]/g, '');
  console.log(`[Baileys Pairing Code Request] Tenant: ${tenantId}, Phone: ${cleanPhone}`);

  let sock = socketsMap.get(tenantId);
  if (!sock) {
    sock = await initBaileysSession(tenantId, true);
  }

  // Wait short moment for socket to initialize connection
  await new Promise((r) => setTimeout(r, 2000));

  const code = await sock.requestPairingCode(cleanPhone);
  console.log(`[Baileys Pairing Code Response] Generated pairing code for ${cleanPhone}: ${code}`);
  return code;
};

export const getOpenWAQRCode = async (tenantId: string): Promise<string> => {
  const sessionDoc = await OpenWASession.findOne({ tenantId });
  if (sessionDoc && sessionDoc.qrCode) {
    return sessionDoc.qrCode;
  }
  const session = await createOpenWASession(tenantId);
  return session.qrCode;
};

export const getOpenWAStatus = async (tenantId: string): Promise<any> => {
  let sessionDoc = await OpenWASession.findOne({ tenantId });
  if (!sessionDoc) {
    return {
      status: 'disconnected',
      isConnected: false,
      tenantId,
    };
  }

  // Sanitize legacy fake simulation data if present
  if (sessionDoc.phoneInfo?.wid?.includes('919876543210') || sessionDoc.phoneInfo?.wid?.includes('917020471065')) {
    console.log(`[OpenWA Audit Purge] Clearing fake simulated connection state for tenant: ${tenantId}`);
    sessionDoc.status = 'disconnected';
    sessionDoc.phoneInfo = undefined;
    sessionDoc.qrCode = '';
    await sessionDoc.save();
    await Tenant.findByIdAndUpdate(tenantId, { 'openwaConfig.isConnected': false, 'openwaConfig.lastSeen': new Date() });
  }

  const inMemory = activeSessions.get(tenantId);
  if (inMemory) {
    sessionDoc.status = inMemory.status;
  }

  return {
    sessionId: sessionDoc.sessionId,
    status: sessionDoc.status,
    isConnected: sessionDoc.status === 'connected',
    qrCode: sessionDoc.status === 'pending_scan' ? sessionDoc.qrCode : '',
    phoneInfo: sessionDoc.phoneInfo,
    lastSeen: sessionDoc.lastSeen,
  };
};

export const reconnectOpenWA = async (tenantId: string): Promise<any> => {
  const sessionDoc = await OpenWASession.findOne({ tenantId });
  if (!sessionDoc) {
    return createOpenWASession(tenantId);
  }

  initBaileysSession(tenantId, true).catch((e) => console.error(e.message));

  activeSessions.set(tenantId, {
    tenantId,
    sessionId: sessionDoc.sessionId,
    status: 'pending_scan',
    qrCode: sessionDoc.qrCode,
    lastSeen: new Date(),
  });

  await Tenant.findByIdAndUpdate(tenantId, {
    'openwaConfig.isConnected': false,
    'openwaConfig.lastSeen': new Date(),
  });

  return {
    message: 'Reconnected OpenWA session successfully',
    status: 'pending_scan',
    isConnected: false,
  };
};

export const logoutOpenWA = async (tenantId: string): Promise<any> => {
  if (socketsMap.has(tenantId)) {
    const oldSock = socketsMap.get(tenantId);
    try {
      oldSock.ev.removeAllListeners('connection.update');
      oldSock.ev.removeAllListeners('creds.update');
      oldSock.end(undefined);
    } catch (e) {}
    socketsMap.delete(tenantId);
  }

  const authDir = path.join(__dirname, `../../../baileys_auth/tenant_${tenantId}`);
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (e) {}
  }

  activeSessions.delete(tenantId);
  await OpenWASession.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        status: 'disconnected',
        qrCode: '',
        lastSeen: new Date(),
      },
    }
  );

  await Tenant.findByIdAndUpdate(tenantId, {
    'openwaConfig.isConnected': false,
    'openwaConfig.sessionId': '',
    'openwaConfig.qrCode': '',
    'openwaConfig.lastSeen': new Date(),
  });

  const io = getIO();
  if (io) {
    io.to('/crm').emit('openwa:status', { tenantId, status: 'disconnected', qrCode: '' });
  }

  return { message: 'OpenWA session logged out successfully', status: 'disconnected' };
};

import { getQueue } from '../queue/queueConfig';
import { processIncomingMessage } from '../ai/aiService';

export const sendOpenWAText = async (tenantId: string, to: string, message: string): Promise<any> => {
  const formattedTo = formatWhatsAppNumber(to);
  const status = await getOpenWAStatus(tenantId);

  // Construct target JID handling both standard phone numbers and WhatsApp LID accounts.
  // Standard international numbers are at most 15 digits (E.164); LIDs issued by WhatsApp
  // are typically 14+ digit numeric identifiers that must use the @lid suffix.
  // We treat anything > 15 digits (after stripping non-digits) as a LID.
  let jid = '';
  if (to.includes('@')) {
    // Already a fully-qualified JID — use as-is
    jid = to;
  } else {
    const digitsOnly = to.replace(/\D/g, '');
    if (digitsOnly.length > 15) {
      // LID-style identifier
      jid = `${digitsOnly}@lid`;
    } else {
      // Normal E.164 phone number
      jid = `${formattedTo || digitsOnly}@s.whatsapp.net`;
    }
  }

  console.log(`[OpenWA Dispatch] Tenant ${tenantId} -> Target JID: ${jid} (raw: ${to}), Msg: "${message}" (Status: ${status.status})`);

  let sock = socketsMap.get(tenantId);
  if (!sock || !sock.ws || sock.ws.readyState !== 1) {
    console.log(`[OpenWA Dispatch] Socket not active for tenant ${tenantId}. Attempting re-initialization...`);
    try {
      sock = await initBaileysSession(tenantId, false);
    } catch (e: any) {
      console.error(`[OpenWA Dispatch Error] Failed to restore socket for tenant ${tenantId}:`, e.message);
    }
  }

  if (!sock) {
    throw new Error(`[OpenWA Dispatch Error] Socket unavailable for tenant ${tenantId}. Message could not be sent to ${to}.`);
  }

  const result = await sock.sendMessage(jid, { text: message });
  console.log(`[OpenWA Send Success] Delivered text to ${jid}`);

  return {
    success: true,
    provider: 'openwa',
    to: formattedTo || to,
    messageId: result?.key?.id,
    status: status.status,
  };
};

export const sendOpenWADocument = async (
  tenantId: string,
  to: string,
  documentUrl: string,
  filename: string,
  caption?: string
): Promise<any> => {
  const formattedTo = formatWhatsAppNumber(to);
  const docDigitsOnly = to.replace(/\D/g, '');
  let jid = to.includes('@') ? to : (docDigitsOnly.length > 15 ? `${docDigitsOnly}@lid` : `${formattedTo || docDigitsOnly}@s.whatsapp.net`);
  console.log(`[OpenWA Document Dispatch] Tenant ${tenantId} -> Target JID: ${jid}, Document: ${filename} (${documentUrl})`);

  let sock = socketsMap.get(tenantId);
  if (!sock || !sock.ws || sock.ws.readyState !== 1) {
    try {
      sock = await initBaileysSession(tenantId, false);
    } catch (e: any) {}
  }

  if (!sock) {
    throw new Error(`[OpenWA Document Error] Socket unavailable for tenant ${tenantId}`);
  }

  const result = await sock.sendMessage(jid, {
    document: { url: documentUrl },
    fileName: filename,
    caption: caption || '',
  });

  return {
    success: true,
    provider: 'openwa',
    to: formattedTo || to,
    messageId: result?.key?.id,
    filename,
    documentUrl,
    caption,
  };
};

export const sendOpenWAImage = async (tenantId: string, to: string, imageUrl: string, caption?: string): Promise<any> => {
  const formattedTo = formatWhatsAppNumber(to);
  const imgDigitsOnly = to.replace(/\D/g, '');
  let jid = to.includes('@') ? to : (imgDigitsOnly.length > 15 ? `${imgDigitsOnly}@lid` : `${formattedTo || imgDigitsOnly}@s.whatsapp.net`);
  console.log(`[OpenWA Image Dispatch] Tenant ${tenantId} -> Target JID: ${jid}, Image: ${imageUrl}`);

  let sock = socketsMap.get(tenantId);
  if (!sock || !sock.ws || sock.ws.readyState !== 1) {
    try {
      sock = await initBaileysSession(tenantId, false);
    } catch (e: any) {}
  }

  if (!sock) {
    throw new Error(`[OpenWA Image Error] Socket unavailable for tenant ${tenantId}`);
  }

  const result = await sock.sendMessage(jid, {
    image: { url: imageUrl },
    caption: caption || '',
  });

  return {
    success: true,
    provider: 'openwa',
    to: formattedTo || to,
    messageId: result?.key?.id,
    imageUrl,
    caption,
  };
};

export const processNormalizedInboundMessage = async (payload: {
  tenantId: string;
  leadPhone: string;
  rawJid?: string;
  leadName?: string;
  message: string;
  timestamp: Date;
  source: 'meta' | 'openwa';
}): Promise<any> => {
  const { leadName, message, timestamp, source, rawJid } = payload;
  let tenantId = payload.tenantId;

  const cleanPhone = formatWhatsAppNumber(payload.leadPhone) || payload.leadPhone.replace(/\D/g, '');
  if (!cleanPhone && !rawJid) {
    console.warn(`[Normalized Inbound WhatsApp] Empty phone & rawJid: "${payload.leadPhone}". Skipping.`);
    return { success: false, reason: 'Invalid phone number' };
  }

  const last10 = cleanPhone ? cleanPhone.slice(-10) : '';
  const phoneRegex = last10 ? new RegExp(`${last10}$`) : null;

  const mobileOrQuery: any[] = [
    { mobile: cleanPhone },
    { mobile: last10 },
    { mobile: `+${cleanPhone}` },
    { mobile: `0${last10}` },
    { mobile: `91${last10}` },
  ];
  if (phoneRegex) {
    mobileOrQuery.push({ mobile: { $regex: phoneRegex } });
  }

  if (rawJid) {
    mobileOrQuery.push({ 'aiContext.whatsappLid': rawJid });
  }
  if (cleanPhone) {
    mobileOrQuery.push({ 'aiContext.whatsappLid': cleanPhone });
  }

  console.log(`[Normalized Inbound WhatsApp] Tenant: ${tenantId}, Lead: ${cleanPhone} (rawJid: ${rawJid}), PushName: "${leadName}", Source: ${source}, Text: "${message}"`);

  // 1. Search for lead by phone / LID within requested tenant
  let lead = await Lead.findOne({
    tenantId,
    $or: mobileOrQuery,
  }).sort({ updatedAt: -1 });

  // 2. If not found by phone/LID, search by pushName/name within requested tenant
  if (!lead && leadName && leadName !== 'WhatsApp User' && leadName !== 'Anonymous') {
    lead = await Lead.findOne({
      tenantId,
      name: { $regex: new RegExp(`^${leadName.trim()}$`, 'i') },
    }).sort({ updatedAt: -1 });
    if (lead) {
      console.log(`[Normalized Inbound WhatsApp] Matched lead (${lead._id}) by name "${leadName}" in tenant (${tenantId})`);
    }
  }

  // 3. Search across ALL tenants if not found in requested tenant
  if (!lead) {
    lead = await Lead.findOne({ $or: mobileOrQuery }).sort({ updatedAt: -1 });
    if (lead) {
      console.log(`[Normalized Inbound WhatsApp] Matched lead (${lead._id}) in tenant (${lead.tenantId}) for phone ${cleanPhone}`);
      tenantId = lead.tenantId.toString();
    }
  }

  if (!lead) {
    // Create new lead with cleanPhone or rawJid
    lead = new Lead({
      tenantId,
      name: leadName || `WhatsApp Lead (${cleanPhone || rawJid})`,
      mobile: cleanPhone || rawJid || payload.leadPhone,
      source: `WhatsApp (${source.toUpperCase()})`,
      status: 'New',
      chatHistory: [],
      aiContext: {
        whatsappLid: rawJid || cleanPhone,
      },
    });
  } else {
    // Update existing lead with LID JID and pushName if relevant
    if (!lead.aiContext) lead.aiContext = {};
    if (rawJid) {
      lead.aiContext.whatsappLid = rawJid;
    }
    if (cleanPhone && cleanPhone.length >= 10 && cleanPhone.length <= 12 && lead.mobile.length > 12) {
      lead.mobile = cleanPhone; // Replace 14-digit LID stored as mobile with clean phone if available
    }
    if (leadName && (!lead.name || lead.name === 'Anonymous' || lead.name.startsWith('WhatsApp Lead'))) {
      lead.name = leadName;
    }
  }

  lead.chatHistory.push({
    role: 'user',
    text: message,
  });

  await lead.save();

  const io = getIO();
  if (io) {
    io.to('/crm').emit('lead:updated', lead);
    io.to('/crm').emit('whatsapp:message', {
      leadId: lead._id.toString(),
      direction: 'inbound',
      channel: 'WhatsApp',
      status: 'received',
      text: message,
      timestamp: timestamp || new Date(),
    });
  }

  let queueSuccess = false;
  try {
    const qualifyQueue = getQueue('qualify-lead');
    if (qualifyQueue) {
      await qualifyQueue.add('conversation-turn', {
        leadId: lead._id.toString(),
        message,
        tenantId,
        source,
      });
      queueSuccess = true;
    }
  } catch (err: any) {
    console.warn(`[Inbound Processing] Queue error for tenant ${tenantId} (Redis issue?):`, err.message);
  }

  // Direct execution fallback if queue fails or is offline
  if (!queueSuccess) {
    const capturedLeadId = lead._id.toString();
    const capturedMessage = message;
    setImmediate(async () => {
      try {
        console.log(`[Direct Fallback] Processing AI response directly for lead ${capturedLeadId}...`);
        await processIncomingMessage(capturedLeadId, capturedMessage);
      } catch (directErr: any) {
        console.error(`[Direct Fallback Error] AI process failed:`, directErr.message);
      }
    });
  }

  return { success: true, leadId: lead._id };
};
