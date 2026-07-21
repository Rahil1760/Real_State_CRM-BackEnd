import { Request, Response } from 'express';
import {
  createOpenWASession,
  getOpenWAQRCode,
  getOpenWAStatus,
  reconnectOpenWA,
  logoutOpenWA,
  requestOpenWAPairingCode,
  processNormalizedInboundMessage,
} from '../services/whatsapp/openwaService';
import Tenant from '../models/Tenant';

export const handleCreateSession = async (req: any, res: Response) => {
  try {
    const tenantId = req.tenant?._id?.toString() || req.body.tenantId;
    console.log(`[OpenWA API] POST /api/openwa/create-session for tenantId: ${tenantId}`);
    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant ID is required' });
    }

    const session = await createOpenWASession(tenantId);
    console.log(`[OpenWA API] Created session successfully for tenantId: ${tenantId}`);
    return res.status(200).json({
      status: 'success',
      session,
    });
  } catch (error: any) {
    console.error(`[OpenWA API Error] handleCreateSession failed:`, error);
    return res.status(500).json({ message: error.message || 'Error creating OpenWA session' });
  }
};

export const handleGetQR = async (req: any, res: Response) => {
  try {
    const tenantId = req.params.tenantId || req.tenant?._id?.toString();
    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant ID parameter is required' });
    }

    const qrCode = await getOpenWAQRCode(tenantId);
    return res.status(200).json({
      status: 'success',
      tenantId,
      qrCode,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error fetching QR Code' });
  }
};

export const handleGetStatus = async (req: any, res: Response) => {
  try {
    const tenantId = req.params.tenantId || req.tenant?._id?.toString();
    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant ID parameter is required' });
    }

    const status = await getOpenWAStatus(tenantId);
    return res.status(200).json({
      status: 'success',
      tenantId,
      ...status,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error fetching status' });
  }
};

export const handleReconnect = async (req: any, res: Response) => {
  try {
    const tenantId = req.params.tenantId || req.tenant?._id?.toString();
    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant ID parameter is required' });
    }

    const result = await reconnectOpenWA(tenantId);
    return res.status(200).json({
      status: 'success',
      ...result,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error reconnecting OpenWA session' });
  }
};

export const handlePairingCode = async (req: any, res: Response) => {
  try {
    const tenantId = req.params.tenantId || req.tenant?._id?.toString() || req.body.tenantId;
    const { phoneNum } = req.body;
    if (!tenantId || !phoneNum) {
      return res.status(400).json({ message: 'tenantId and phoneNum are required' });
    }

    const pairingCode = await requestOpenWAPairingCode(tenantId, phoneNum);
    return res.status(200).json({
      status: 'success',
      tenantId,
      pairingCode,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error generating pairing code' });
  }
};

export const handleLogout = async (req: any, res: Response) => {
  try {
    const tenantId = req.params.tenantId || req.tenant?._id?.toString();
    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant ID parameter is required' });
    }

    const result = await logoutOpenWA(tenantId);
    return res.status(200).json({
      status: 'success',
      ...result,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error logging out OpenWA session' });
  }
};

export const handleOpenWAWebhook = async (req: Request, res: Response) => {
  try {
    const { tenantId, leadPhone, leadName, message, timestamp } = req.body;
    if (!tenantId || !leadPhone || !message) {
      return res.status(400).json({ message: 'tenantId, leadPhone, and message are required' });
    }

    const result = await processNormalizedInboundMessage({
      tenantId,
      leadPhone,
      leadName,
      message,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      source: 'openwa',
    });

    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error handling OpenWA webhook' });
  }
};
