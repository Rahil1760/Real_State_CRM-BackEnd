import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Property from '../models/Property';
import ProjectDocument from '../models/ProjectDocument';
import DocumentChunk from '../models/DocumentChunk';
import { getQueue } from '../services/queue/queueConfig';
import fs from 'fs';
import path from 'path';

// Helper to ensure directories exist
const ensureDir = (dirPath: string) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// 1. Upload Project Document
export const uploadProjectDocument = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { propertyId } = req.params;
    if (!propertyId) return res.status(400).json({ message: 'Property ID parameter is required' });

    // Validate that the property exists and belongs to the tenant
    const property = await Property.findOne({ _id: propertyId, tenantId });
    if (!property) {
      return res.status(404).json({ message: 'Property not found or access denied.' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No document file uploaded.' });
    }

    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.pdf') {
      return res.status(400).json({ message: 'Only PDF documents are supported for chat RAG.' });
    }
    
    // Save locally under server static path
    const docDir = path.join(__dirname, '../../uploads/documents', String(tenantId), String(propertyId));
    ensureDir(docDir);
    
    const uniqueFileName = `${Date.now()}_${originalName.replace(/\s+/g, '_')}`;
    const filePath = path.join(docDir, uniqueFileName);
    fs.writeFileSync(filePath, req.file.buffer);

    // Mock S3 Url or relative path
    const relativeUrl = `/uploads/documents/${tenantId}/${propertyId}/${uniqueFileName}`;
    const s3Url = process.env.AWS_S3_BUCKET 
      ? `https://${process.env.AWS_S3_BUCKET}.s3.amazonaws.com/uploads/${tenantId}/${propertyId}/${uniqueFileName}`
      : relativeUrl;

    const uploadedBy = (req as any).user?.id;

    // Create the ProjectDocument record in DB
    const projectDoc = new ProjectDocument({
      tenantId,
      propertyId,
      fileName: originalName,
      s3Url,
      uploadedBy,
      status: 'processing',
    });
    await projectDoc.save();

    // Enqueue document chunking/embedding pipeline
    const pdfQueue = getQueue('pdf-ingestion');
    if (!pdfQueue) {
      return res.status(500).json({ message: 'PDF Ingestion queue not initialized' });
    }

    await pdfQueue.add('ingest-pdf', {
      documentId: projectDoc._id.toString(),
      tenantId: String(tenantId),
      propertyId: String(propertyId),
      filePath,
    });

    return res.status(201).json(projectDoc);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// 2. List Project Documents
export const listProjectDocuments = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { propertyId } = req.params;
    const documents = await ProjectDocument.find({ tenantId, propertyId })
      .populate('uploadedBy', 'name email role')
      .sort({ createdAt: -1 });

    return res.status(200).json(documents);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// 3. Delete Project Document (and cascade chunks)
export const deleteProjectDocument = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { propertyId, docId } = req.params;

    const document = await ProjectDocument.findOne({ _id: docId, tenantId, propertyId });
    if (!document) {
      return res.status(404).json({ message: 'Document not found or access denied.' });
    }

    // Try deleting from filesystem if it is a local upload path
    if (document.s3Url.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '../..', document.s3Url);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Cascade delete DocumentChunks from DB
    await DocumentChunk.deleteMany({ tenantId, propertyId, documentId: docId });
    
    // Delete ProjectDocument record
    await ProjectDocument.findByIdAndDelete(docId);

    return res.status(200).json({ message: 'Document and its vector embeddings deleted successfully.' });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
