import { Router } from 'express';
import { getLeads, getLeadById, createLead, updateLead, deleteLead, importLeads } from '../controllers/leadController';
import { previewImportFile, submitImportJob, getImportJobStatus } from '../controllers/bulkUploadController';
import { authenticateToken } from '../middleware/auth';
import { checkLeadLimit } from '../middleware/planGuard';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken as any);

router.get('/', getLeads as any);
router.get('/:id', getLeadById as any);
router.post('/', checkLeadLimit as any, createLead as any);
router.put('/:id', updateLead as any);
router.delete('/:id', deleteLead as any);
router.post('/import', checkLeadLimit as any, importLeads as any);

// Bulk upload routes
router.post('/bulk-upload/preview', upload.single('file'), previewImportFile as any);
router.post('/bulk-upload', checkLeadLimit as any, upload.single('file'), submitImportJob as any);
router.get('/bulk-upload/:batchId/status', getImportJobStatus as any);

export default router;
