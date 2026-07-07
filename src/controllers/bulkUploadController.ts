import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import LeadImportBatch from '../models/LeadImportBatch';
import { getQueue } from '../services/queue/queueConfig';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import XLSX from 'xlsx';

// Helper to ensure directory exists
const ensureDir = (dirPath: string) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// 1. Preview file headers and first few rows
export const previewImportFile = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase();
    
    let rows: any[][] = [];

    if (ext === '.csv') {
      const fileContent = fileBuffer.toString('utf8');
      const parseResult = Papa.parse(fileContent, { header: false, skipEmptyLines: true });
      rows = parseResult.data as any[][];
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
    } else {
      return res.status(400).json({ message: 'Unsupported file format. Please upload a .csv or .xlsx file.' });
    }

    if (rows.length === 0) {
      return res.status(400).json({ message: 'The uploaded file is empty.' });
    }

    const headers = rows[0].map(h => String(h || '').trim());
    const previewRows = rows.slice(1, 6); // returns up to 5 preview rows

    return res.status(200).json({
      fileName: originalName,
      headers,
      previewRows,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// 2. Submit Import Job
export const submitImportJob = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const mappingStr = req.body.mapping;
    if (!mappingStr) {
      return res.status(400).json({ message: 'Column mapping configuration is required' });
    }

    let mapping: any;
    try {
      mapping = typeof mappingStr === 'string' ? JSON.parse(mappingStr) : mappingStr;
    } catch (e) {
      return res.status(400).json({ message: 'Invalid column mapping JSON format' });
    }

    const dedupeMode = req.body.dedupeMode || 'skip'; // skip | update | flag
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Save raw file to a local path (simulated S3 / raw uploads audit trail)
    const uploadDir = path.join(__dirname, '../../uploads/imports', String(tenantId));
    ensureDir(uploadDir);

    const ext = path.extname(req.file.originalname).toLowerCase();
    const filePath = path.join(uploadDir, `${batchId}${ext}`);
    fs.writeFileSync(filePath, req.file.buffer);

    // Create the batch job tracking record in DB
    const batch = new LeadImportBatch({
      batchId,
      tenantId,
      status: 'processing',
      total: 0,
      success: 0,
      failed: 0,
      rowErrors: [],
    });
    await batch.save();

    // Enqueue the background processing job
    const importQueue = getQueue('lead-import');
    if (!importQueue) {
      return res.status(500).json({ message: 'Lead import queue is not initialized' });
    }

    await importQueue.add('process-import', {
      batchId,
      tenantId: String(tenantId),
      filePath,
      mapping,
      dedupeMode,
    });

    return res.status(202).json({
      message: 'Import job submitted successfully',
      batchId,
      status: 'processing',
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// 3. Get Import Job Status
export const getImportJobStatus = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { batchId } = req.params;
    const batch = await LeadImportBatch.findOne({ batchId, tenantId });
    if (!batch) {
      return res.status(404).json({ message: 'Import batch job not found' });
    }

    return res.status(200).json(batch);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
