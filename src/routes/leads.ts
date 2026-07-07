import { Router } from 'express';
import { getLeads, getLeadById, createLead, updateLead, deleteLead, importLeads } from '../controllers/leadController';
import { previewImportFile, submitImportJob, getImportJobStatus } from '../controllers/bulkUploadController';
import { authenticateToken } from '../middleware/auth';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken as any);

router.get('/', getLeads as any);
router.get('/:id', getLeadById as any);
router.post('/', createLead as any);
router.put('/:id', updateLead as any);
router.delete('/:id', deleteLead as any);
router.post('/import', importLeads as any);

// Bulk upload routes
router.post('/bulk-upload/preview', upload.single('file'), previewImportFile as any);
router.post('/bulk-upload', upload.single('file'), submitImportJob as any);
router.get('/bulk-upload/:batchId/status', getImportJobStatus as any);

export default router;
