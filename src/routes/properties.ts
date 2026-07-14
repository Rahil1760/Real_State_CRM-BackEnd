import { Router } from 'express';
import { getProperties, getPropertyById, createProperty, updateProperty, deleteProperty, uploadBrochure, deleteBrochure } from '../controllers/propertyController';
import { uploadProjectDocument, listProjectDocuments, deleteProjectDocument } from '../controllers/documentController';
import { authenticateToken, requireRole } from '../middleware/auth';
import { checkPropertyLimit } from '../middleware/planGuard';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Publicly readable for authenticated users, modifiable by Admin and Sales Manager
router.get('/', authenticateToken as any, getProperties as any);
router.get('/:id', authenticateToken as any, getPropertyById as any);

router.post('/', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, checkPropertyLimit as any, createProperty as any);
router.put('/:id', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, updateProperty as any);
router.delete('/:id', authenticateToken as any, requireRole(['Admin']) as any, deleteProperty as any);

// Property document endpoints
router.post('/:propertyId/documents', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, upload.single('file'), uploadProjectDocument as any);
router.get('/:propertyId/documents', authenticateToken as any, listProjectDocuments as any);
router.delete('/:propertyId/documents/:docId', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, deleteProjectDocument as any);

// Property brochure endpoints
router.post('/:id/brochure', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, upload.single('file'), uploadBrochure as any);
router.delete('/:id/brochure', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, deleteBrochure as any);

export default router;
